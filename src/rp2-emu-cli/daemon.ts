/**
 * rp2_emu daemon — long-lived background process that owns an
 * EmulatorController instance and serves tool calls over a unix socket.
 *
 * Protocol: line-delimited JSON. One request per connection (see protocol.ts).
 *
 * Lifecycle:
 *   - Started by `rp2_emu start` (typically detached) or auto-started by a
 *     tool subcommand when no socket is reachable.
 *   - Writes a state file ({pid, socketPath, startedAt, ...}) on startup.
 *   - Cleans up socket + state file on SIGTERM / SIGINT.
 *
 * Options (--foreground is honoured by the test harness; production runs are
 * detached from the controlling terminal by the parent CLI before exec'ing):
 *   --bootrom <rp2350-a2|rp2040-b1|none|<path>>   default: rp2350-a2
 *   --firmware <path>                             optional, loaded on startup
 *   --firmware-arch <riscv|arm>                   optional, passed to load_firmware
 *   --foreground                                  don't detach stdio (default off)
 */

import { Server, Socket } from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { EmulatorController } from '../utils/emulator-controller';
import { bootrom_rp2350_A2, bootromB1 } from '../bootroms';
import {
  DaemonState,
  DaemonStatus,
  RpcRequest,
  RpcResponse,
  encodeLine,
  socketPath,
  stateFilePath,
} from './protocol';

export interface DaemonOptions {
  bootrom: 'rp2350-a2' | 'rp2040-b1' | 'none' | string;
  firmware?: string;
  firmwareArch?: 'riscv' | 'arm';
  /** When true, do not suppress stdio. Used by tests and `start --foreground`. */
  foreground?: boolean;
  /** Override socket path (used by tests to avoid the per-user default). */
  socketOverride?: string;
  /** Override state-file path (used by tests). */
  stateOverride?: string;
}

/** A running daemon handle. Returned from start() for in-process callers/tests. */
export interface RunningDaemon {
  server: Server;
  socketPath: string;
  mcp: EmulatorController;
  close(): Promise<void>;
}

/** Resolve a bootrom option into a Uint32Array (or null for "none"/"default"). */
function resolveBootrom(spec: string): { data: Uint32Array | null; label: string } {
  // The bundled RP2350 A2 bootrom is now auto-loaded by the RP2350
  // constructor, so "rp2350-a2" (the default) means "use what's built in".
  if (spec === 'rp2350-a2') return { data: null, label: 'rp2350-a2' };
  if (spec === 'rp2040-b1') return { data: bootromB1, label: 'rp2040-b1' };
  if (spec === 'none') return { data: null, label: 'none' };
  // Otherwise treat as path to a .bin file. Read 32-bit little-endian words.
  const buf = fs.readFileSync(spec);
  const words = new Uint32Array(buf.length / 4);
  for (let i = 0; i < words.length; i++) {
    words[i] = buf.readUInt32LE(i * 4);
  }
  return { data: words, label: `file:${path.basename(spec)}` };
}

/**
 * Start the daemon in-process. Does NOT detach — the caller (CLI front-end or
 * test) is responsible for forking/detaching if desired. Returns once the
 * socket is listening.
 */
export async function startDaemon(opts: DaemonOptions): Promise<RunningDaemon> {
  const sockPath = opts.socketOverride ?? socketPath();
  const statePath = opts.stateOverride ?? stateFilePath();

  // Clean up any stale socket file.
  try {
    fs.unlinkSync(sockPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  const { data: bootromData, label: bootromLabel } = resolveBootrom(opts.bootrom);
  const mcp = new EmulatorController();
  // Honor an explicit non-default bootrom override by overwriting the
  // constructor's auto-load. The default ("rp2350-a2") is already loaded.
  if (bootromData) {
    mcp.chip.loadBootrom(bootromData);
  }

  // Optionally load firmware at startup via the MCP tool, so we share the
  // exact code path with runtime load_firmware calls.
  if (opts.firmware) {
    const loadArgs: Record<string, unknown> = { path: opts.firmware };
    if (opts.firmwareArch) loadArgs.arch = opts.firmwareArch;
    const res = mcp.handleToolCall('load_firmware', loadArgs);
    if ('isError' in res && res.isError) {
      const text = res.content[0]?.text ?? 'unknown load_firmware error';
      throw new Error(`failed to load firmware ${opts.firmware}: ${text}`);
    }
  }

  const server = new Server((conn: Socket) => handleConnection(conn, mcp));

  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(sockPath, () => {
      // Restrict to owner read/write — socket may live in a shared /tmp.
      try {
        fs.chmodSync(sockPath, 0o600);
      } catch {
        /* best effort */
      }
      resolve();
    });
  });

  const state: DaemonState = {
    pid: process.pid,
    socketPath: sockPath,
    startedAt: Date.now(),
    fwPath: opts.firmware ?? null,
    fwArch: opts.firmwareArch ?? 'riscv',
    bootrom: bootromLabel,
  };
  try {
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch {
    /* state file is best-effort */
  }

  if (opts.foreground) {
    process.stderr.write(`rp2_emu daemon: listening on ${sockPath} (pid ${process.pid})\n`);
  }

  const cleanup = async () => {
    try {
      await new Promise<void>((r) => server.close(() => r()));
    } catch {
      /* ignore */
    }
    for (const p of [sockPath, statePath]) {
      try {
        fs.unlinkSync(p);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          /* ignore */
        }
      }
    }
  };

  // Cleanup on signals. Process exit alone does not unlink the socket file.
  const signalCleanup = () => {
    void cleanup().then(() => process.exit(0));
  };
  process.on('SIGTERM', signalCleanup);
  process.on('SIGINT', signalCleanup);

  return { server, socketPath: sockPath, mcp, close: cleanup };
}

/** Per-connection handler. Reads exactly one JSON line, dispatches, replies. */
function handleConnection(conn: Socket, mcp: EmulatorController): void {
  let buffer = '';
  conn.setEncoding('utf-8');
  conn.on('data', (chunk: string) => {
    buffer += chunk;
    const nl = buffer.indexOf('\n');
    if (nl === -1) return;
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);

    let req: RpcRequest;
    try {
      req = JSON.parse(line) as RpcRequest;
    } catch (e) {
      const resp: RpcResponse = {
        id: -1,
        ok: false,
        error: `daemon: bad JSON (${(e as Error).message})`,
      };
      conn.end(encodeLine(resp));
      return;
    }

    // Built-in pseudo-tool: daemon status (cheaper than get_status for the
    // CLI's stop/status commands — doesn't require emulator state inspection).
    if (req.tool === '__status') {
      const status: DaemonStatus = buildStatus(mcp, process.pid);
      const resp: RpcResponse = {
        id: req.id,
        ok: true,
        content: [{ type: 'text', text: JSON.stringify(status, null, 2) }],
        isError: false,
      };
      conn.end(encodeLine(resp));
      return;
    }

    // All real tools go through handleToolCall, which already shapes the
    // { content, isError } contract exactly like an MCP tool result.
    let resp: RpcResponse;
    try {
      const result = mcp.handleToolCall(req.tool, req.args) as {
        content?: { type: 'text'; text: string }[];
        isError?: boolean;
      };
      resp = {
        id: req.id,
        ok: true,
        content: result.content ?? [],
        isError: !!result.isError,
      };
    } catch (e) {
      // handleToolCall itself shouldn't throw (it has an internal try/catch),
      // but be defensive — a throw here is a daemon-level bug.
      resp = { id: req.id, ok: false, error: `daemon: ${(e as Error).message}` };
    }
    conn.end(encodeLine(resp));
  });
  conn.on('error', () => {
    /* client hung up; ignore */
  });
}

/** Build a DaemonStatus snapshot from the live MCP server. */
function buildStatus(mcp: EmulatorController, pid: number): DaemonStatus {
  // Use the existing get_status tool to extract emulator-side fields without
  // reaching into private state.
  const result = mcp.handleToolCall('get_status', {});
  const text = result.content[0]?.text ?? '{}';
  const parsed = JSON.parse(text) as {
    arch?: 'riscv' | 'arm';
    breakpoints?: string[];
    tracepoints?: { label: string; address: string }[];
    disassembly_loaded?: boolean;
  };
  return {
    running: true,
    pid,
    socketPath: socketPath(),
    startedAt: 0,
    uptimeMs: 0,
    fwPath: null,
    fwArch: parsed.arch ?? 'riscv',
    bootrom: 'unknown',
    disassemblyLoaded: !!parsed.disassembly_loaded,
    breakpoints: parsed.breakpoints ?? [],
    tracepoints: parsed.tracepoints ?? [],
  };
}
