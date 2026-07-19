/**
 * Shared protocol and discovery helpers for the rp2_emu daemon/CLI.
 *
 * Wire format over the unix socket: one JSON object per line in each
 * direction. Each connection handles exactly one request (this keeps the
 * protocol trivial and means a crashed tool call can never corrupt a
 * subsequent one).
 *
 * Request (CLI → daemon):
 *   {"id":1,"tool":"write_register","args":{"core":0,"register":"ra","value":"0x10"}}
 *
 * Response (daemon → CLI). Two shapes:
 *   - tool ran:        {"id":1,"ok":true,"content":[{"type":"text","text":"..."}],"isError":false}
 *   - daemon-level:    {"id":1,"ok":false,"error":"daemon: not loaded"}
 *
 * A tool-level failure (e.g. unknown register) is reported with ok=true and
 * isError=true — the content field carries the human-readable error text,
 * matching EmulatorController.handleToolCall's existing contract.
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

/** RPC request from the CLI to the daemon. */
export interface RpcRequest {
  id: number;
  tool: string;
  args: Record<string, unknown>;
}

/** Tool-ran response (matches MCP tool result shape). */
export interface RpcToolResponse {
  id: number;
  ok: true;
  content: { type: 'text'; text: string }[];
  isError: boolean;
}

/** Daemon-level error response (transport / lifecycle failures). */
export interface RpcErrorResponse {
  id: number;
  ok: false;
  error: string;
}

export type RpcResponse = RpcToolResponse | RpcErrorResponse;

/** State file written by the daemon and read by every CLI invocation. */
export interface DaemonState {
  pid: number;
  socketPath: string;
  startedAt: number;
  /** Firmware path if one was loaded at startup, else null. */
  fwPath: string | null;
  fwArch: 'riscv' | 'arm';
  /** Bootrom source description, for status output. */
  bootrom: 'rp2350-a2' | 'rp2040-b1' | 'none' | string;
}

/** Status reported by the daemon's internal "status" pseudo-tool. */
export interface DaemonStatus {
  running: true;
  pid: number;
  socketPath: string;
  startedAt: number;
  uptimeMs: number;
  fwPath: string | null;
  fwArch: 'riscv' | 'arm';
  bootrom: string;
  disassemblyLoaded: boolean;
  breakpoints: string[];
  tracepoints: { label: string; address: string }[];
}

/** Compute the per-user runtime directory for socket + state file. */
export function runtimeDir(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg && xdg.length > 0) return xdg;
  // Fallback: /tmp — XDG_RUNTIME_DIR is missing on macOS and some CI setups.
  return os.tmpdir();
}

/** Per-user socket path. Suffix with uid to avoid collisions on shared /tmp. */
export function socketPath(): string {
  const uid = os.userInfo().uid;
  return path.join(runtimeDir(), `rp2-emu-${uid}.sock`);
}

/** Per-user state file (JSON-encoded DaemonState). */
export function stateFilePath(): string {
  const uid = os.userInfo().uid;
  return path.join(runtimeDir(), `rp2-emu-${uid}.state.json`);
}

/** Test whether a PID is currently alive (process.signal 0 probe). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // EPERM means the process exists but is owned by someone else — still alive.
    return code === 'EPERM';
  }
}

/** Read+parse the state file. Returns null if missing or unparseable. */
export function readState(): DaemonState | null {
  let raw: string;
  try {
    raw = fs.readFileSync(stateFilePath(), 'utf-8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw) as DaemonState;
  } catch {
    return null;
  }
}

/** Serialize one RPC message as a single newline-terminated JSON line. */
export function encodeLine(obj: unknown): string {
  return JSON.stringify(obj) + '\n';
}

/** Type guard: did the daemon run the tool successfully (ok:true shape)? */
export function isToolResponse(r: RpcResponse): r is RpcToolResponse {
  return r.ok;
}
