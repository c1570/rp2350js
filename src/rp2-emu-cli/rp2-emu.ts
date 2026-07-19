#!/usr/bin/env node
/**
 * rp2_emu — CLI front-end for the RP2350 emulator skill.
 *
 * Two halves:
 *   1. Daemon control: `start`, `stop`, `status`, `restart`.
 *   2. Tool parity: one subcommand per EmulatorController tool, with flags
 *      that mirror the tool's args (hex/decimal accepted everywhere).
 *
 * Tool subcommands talk to the background daemon over a unix socket using
 * line-delimited JSON (see src/rp2-emu-cli/protocol.ts). Each invocation is one
 * short-lived process: connect, send one request, read one response, print
 * the result, exit.
 *
 * Auto-start: if a tool subcommand is issued and no daemon is reachable, the
 * CLI spawns `rp2_emu start` detached, waits for the socket, then retries.
 * Pass --no-autostart to disable.
 */

import { spawn } from 'child_process';
import * as net from 'net';
import * as fs from 'fs';
import { startDaemon, RunningDaemon } from './daemon';
import {
  RpcResponse,
  encodeLine,
  pidAlive,
  readState,
  socketPath,
  stateFilePath,
} from './protocol';
import { TOOL_DESCRIPTIONS } from '../utils/emulator-controller';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

/** Parsed argv shape for a single subcommand. */
export interface ParsedArgs {
  /** Subcommand name, e.g. "read_registers" or "start". */
  command: string;
  /** Named flags (--foo bar → flags.foo = "bar"). Keys present without a value get "true". */
  flags: Record<string, string | boolean>;
  /** Whether --no-autostart was passed (also lifted into flags for convenience). */
  noAutostart: boolean;
  /** Whether --help/-h was passed. */
  help: boolean;
}

/** Parse raw argv (post-binary-name) into a ParsedArgs. */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  let command = '';
  let noAutostart = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      // remainder are positional — we don't accept any, ignore.
      continue;
    }
    if (a === '-h' || a === '--help') {
      help = true;
      continue;
    }
    if (a === '--no-autostart') {
      noAutostart = true;
      continue;
    }
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const next = argv[i + 1];
      // If next looks like a flag or is absent, treat as boolean.
      if (next === undefined || next.startsWith('--') || next === '-h') {
        flags[name] = true;
      } else {
        flags[name] = next;
        i++;
      }
      continue;
    }
    // First non-flag token is the command; subsequent ones are ignored
    // (rp2_emu subcommands take flags only — no positionals — for consistency
    // with the MCP tool interface).
    if (command === '') command = a;
  }

  return { command, flags, noAutostart, help };
}

/**
 * Definition of a tool-mirroring subcommand. Maps flag names to MCP tool arg
 * names so the surface is explicit (and --help can list them). The order of
 * keys determines help-text ordering.
 */
interface ToolDef {
  /** MCP tool name to invoke. */
  tool: string;
  /** Short description for help. */
  help: string;
  /** Map of flag-name → arg-name. Required flags list themselves in `required`. */
  args?: Record<string, string>;
  /** Required flag names (must also appear in args). */
  required?: string[];
}

/**
 * Canonical subcommand definitions. Daemon control commands (start/stop/...)
 * are handled separately; this map covers every MCP tool.
 */
export const TOOL_SUBCOMMANDS: Record<string, ToolDef> = {
  get_status: {
    tool: 'get_status',
    help: 'Show emulator status (core PCs, WFI state, breakpoints).',
  },
  read_registers: {
    tool: 'read_registers',
    help: 'Read all registers (x0-x31, pc, CSRs) for a core.',
    args: { core: 'core' },
  },
  write_register: {
    tool: 'write_register',
    help: 'Write a single register by name (e.g. "x5", "pc", "mstatus").',
    args: { register: 'register', value: 'value', core: 'core' },
    required: ['register', 'value'],
  },
  read_memory: {
    tool: 'read_memory',
    help: 'Read memory as a hex dump (with ASCII column).',
    args: { address: 'address', length: 'length' },
    required: ['address'],
  },
  write_memory: {
    tool: 'write_memory',
    help: 'Write raw bytes to memory (hex-encoded, e.g. "efbeadde").',
    args: { address: 'address', hex: 'hex' },
    required: ['address', 'hex'],
  },
  single_step: {
    tool: 'single_step',
    help: 'Execute one instruction on the specified core.',
    args: { core: 'core' },
  },
  run: {
    tool: 'run',
    help: 'Run up to --max_instructions, stopping at breakpoints.',
    args: { max_instructions: 'max_instructions' },
  },
  set_breakpoint: {
    tool: 'set_breakpoint',
    help: 'Set a software breakpoint at an address.',
    args: { address: 'address' },
    required: ['address'],
  },
  clear_breakpoint: {
    tool: 'clear_breakpoint',
    help: 'Remove a breakpoint.',
    args: { address: 'address' },
    required: ['address'],
  },
  list_breakpoints: {
    tool: 'list_breakpoints',
    help: 'List all active breakpoints.',
  },
  set_tracepoint: {
    tool: 'set_tracepoint',
    help: 'Set a named tracepoint at an address.',
    args: { label: 'label', address: 'address' },
    required: ['label', 'address'],
  },
  clear_tracepoint: {
    tool: 'clear_tracepoint',
    help: 'Remove a tracepoint by label.',
    args: { label: 'label' },
    required: ['label'],
  },
  list_tracepoints: {
    tool: 'list_tracepoints',
    help: 'List all tracepoints (label → address).',
  },
  dump_pio: {
    tool: 'dump_pio',
    help: 'Dump PIO state machine registers (pc, x, y, ISR, OSR, FIFOs).',
    args: { instance: 'instance' },
  },
  dump_gpio: {
    tool: 'dump_gpio',
    help: 'Dump all GPIO pin states (function, in/out values, pullups).',
  },
  load_firmware: {
    tool: 'load_firmware',
    help: 'Load an Intel HEX (.hex) or UF2 (.uf2) firmware file.',
    args: {
      path: 'path',
      entry_pc: 'entry_pc',
      use_sram: 'use_sram',
      disassembly_path: 'disassembly_path',
      arch: 'arch',
    },
    required: ['path'],
  },
  reset: {
    tool: 'reset',
    help: 'Reset the chip: re-instantiate RP2350, reload bootrom + firmware.',
    args: { keep_breakpoints: 'keep_breakpoints' },
  },
  convert_number: {
    tool: 'convert_number',
    help: 'Convert a value between decimal and hex (auto-detected).',
    args: { value: 'value' },
    required: ['value'],
  },
  dump_memory: {
    tool: 'dump_memory',
    help: 'Dump a range of flash or SRAM to a temp file (ihex or text).',
    args: { region: 'region', address: 'address', length: 'length', format: 'format' },
    required: ['region', 'address', 'length'],
  },
};

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const USAGE = `rp2_emu — RP2350 emulator CLI / opencode skill helper

Usage:
  rp2_emu <command> [flags]
  rp2_emu <tool-subcommand> [flags]    (auto-starts the daemon if needed)

Daemon control:
  start [--bootrom <rp2350-a2|rp2040-b1|none|path>]
        [--firmware <path>] [--firmware-arch <riscv|arm>]
        [--foreground]
        [--no-autostart]
      Start the background emulator daemon. Default bootrom is rp2350-a2.
      --foreground keeps it in the foreground (default: detach).

  stop
      Stop the running daemon (sends SIGTERM).

  status
      Print daemon + emulator status. Exits 0 if running, 1 if not.

  restart [--... same flags as start]
      Equivalent to stop + start.

Tool subcommands (each mirrors an MCP tool 1:1 — see rp2_emu <tool> --help):

${Object.entries(TOOL_SUBCOMMANDS)
  .map(([name, def]) => `  ${name.padEnd(20)} ${def.help}`)
  .join('\n')}

Common flags:
  --no-autostart   Fail with a clear hint instead of starting a daemon.
  -h, --help       Show this help (or subcommand-specific help if given first).

Integer/flag conventions:
  All integer-valued flags accept decimal ("305419896") or "0x"-prefixed hex
  ("0x12345678"). Boolean flags accept "true"/"false" or act as switches.

Socket path:
  ${socketPath()}  (override with $XDG_RUNTIME_DIR)
`;

function subcommandHelp(name: string, def: ToolDef): string {
  const argList = def.args
    ? Object.entries(def.args).map(([f, a]) => `  --${f.padEnd(18)} → args.${a}`)
    : [];
  const required = def.required ?? [];
  // Long description from the shared single source of truth; falls back to
  // the short help string if absent.
  const longDesc = TOOL_DESCRIPTIONS[def.tool] ?? def.help;
  const lines = [
    `rp2_emu ${name} — ${def.help}`,
    '',
    longDesc,
    '',
    `Usage: rp2_emu ${name}${
      def.args
        ? ' ' +
          Object.keys(def.args)
            .map((a) => `[--${a}]`)
            .join(' ')
        : ''
    }`,
    '',
    'Maps to tool: ' + def.tool,
  ];
  if (argList.length > 0) {
    lines.push('', 'Flags:');
    lines.push(...argList);
  }
  if (required.length > 0) {
    lines.push('', 'Required: ' + required.map((r) => '--' + r).join(', '));
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Daemon control
// ---------------------------------------------------------------------------

/** Resolve the path to this script — used for the auto-start detached spawn. */
function selfBinaryPath(): string {
  // When run via `npm run bin`, process.argv[1] is the .js path. When run
  // directly as `node dist/cjs/rp2-emu-cli/rp2-emu.js`, same. Use it verbatim.
  return process.argv[1];
}

/** Start a daemon. Honours --foreground (in-process) vs detached (spawn). */
async function cmdStart(parsed: ParsedArgs): Promise<number> {
  const state = readState();
  if (state && pidAlive(state.pid)) {
    process.stderr.write(`rp2_emu: daemon already running (pid ${state.pid})\n`);
    return 0;
  }
  // Stale state file — clean it up so the new daemon can write fresh.
  if (state) {
    try {
      fs.unlinkSync(stateFilePath());
    } catch {
      /* ignore */
    }
  }

  const bootrom = (parsed.flags.bootrom as string) ?? 'rp2350-a2';
  const firmware = parsed.flags.firmware as string | undefined;
  const firmwareArch = parsed.flags['firmware-arch'] as 'riscv' | 'arm' | undefined;
  const foreground = parsed.flags.foreground === true;

  const opts = { bootrom, firmware, firmwareArch, foreground };

  if (foreground) {
    // Run in-process; blocks forever (until SIGINT/SIGTERM).
    await startDaemon(opts);
    // Park forever — the daemon's signal handlers do the cleanup.
    await new Promise<void>(() => {
      /* until killed */
    });
    return 0;
  }

  // Detached spawn: re-exec ourselves with `start --foreground` and stdio
  // redirected to /dev/null (or log file later). Parent exits immediately.
  const child = spawn(
    process.execPath,
    [selfBinaryPath(), 'start', '--foreground', ...startFlagArgs(opts)],
    {
      detached: true,
      stdio: 'ignore',
    }
  );
  child.unref();

  // Wait briefly for the socket to come up so callers see "started" only once
  // it's actually reachable.
  const ok = await waitForSocket(5000);
  if (!ok) {
    process.stderr.write('rp2_emu: daemon failed to come up within 5s\n');
    return 1;
  }
  const newState = readState();
  process.stdout.write(
    JSON.stringify(
      { ok: true, pid: newState?.pid ?? child.pid, socketPath: socketPath() },
      null,
      2
    ) + '\n'
  );
  return 0;
}

/** Convert parsed start options back into `--flag value` argv for the spawn. */
function startFlagArgs(opts: {
  bootrom: string;
  firmware?: string;
  firmwareArch?: 'riscv' | 'arm';
}): string[] {
  const out: string[] = [];
  out.push('--bootrom', opts.bootrom);
  if (opts.firmware) out.push('--firmware', opts.firmware);
  if (opts.firmwareArch) out.push('--firmware-arch', opts.firmwareArch);
  return out;
}

/** Stop the running daemon. */
async function cmdStop(): Promise<number> {
  const state = readState();
  if (!state || !pidAlive(state.pid)) {
    process.stderr.write('rp2_emu: no running daemon\n');
    // Clean up stale state file if present.
    if (state) {
      try {
        fs.unlinkSync(stateFilePath());
      } catch {
        /* ignore */
      }
    }
    return 1;
  }
  process.kill(state.pid, 'SIGTERM');
  // Wait for the state file to disappear (daemon unlinks it on exit).
  const cleaned = await waitFor(() => !fs.existsSync(stateFilePath()), 5000);
  process.stdout.write(
    JSON.stringify({ ok: true, stopped_pid: state.pid, cleaned_up: cleaned }, null, 2) + '\n'
  );
  return 0;
}

/** Print daemon + emulator status. */
async function cmdStatus(): Promise<number> {
  const state = readState();
  if (!state || !pidAlive(state.pid)) {
    process.stdout.write(JSON.stringify({ running: false }, null, 2) + '\n');
    return 1;
  }
  // Ask the daemon for emulator-side status via the __status pseudo-tool.
  const resp = await sendRequest('__status', {});
  if (resp === null) {
    process.stdout.write(JSON.stringify({ running: false, state }, null, 2) + '\n');
    return 1;
  }
  if (!resp.ok) {
    process.stderr.write(`rp2_emu: status query failed: ${resp.error}\n`);
    return 1;
  }
  const text = resp.content[0]?.text ?? '{}';
  const emulator = JSON.parse(text);
  process.stdout.write(
    JSON.stringify(
      {
        running: true,
        pid: state.pid,
        socketPath: state.socketPath,
        startedAt: new Date(state.startedAt).toISOString(),
        bootrom: state.bootrom,
        firmware: state.fwPath,
        arch: state.fwArch,
        emulator,
      },
      null,
      2
    ) + '\n'
  );
  return 0;
}

/** Stop then start. */
async function cmdRestart(parsed: ParsedArgs): Promise<number> {
  await cmdStop().catch(() => undefined);
  return cmdStart(parsed);
}

// ---------------------------------------------------------------------------
// IPC — send one request, get one response over a short-lived socket conn
// ---------------------------------------------------------------------------

let nextRequestId = 1;

/** Connect to the daemon socket and probe whether it answers. */
function probeSocket(timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection(socketPath());
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, timeoutMs);
    sock.on('connect', () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/** Wait for the socket to answer; polls every 50ms. */
async function waitForSocket(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeSocket(200)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** Generic predicate waiter. */
async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

/** Open a connection, send one request line, read one response line, return. */
function sendRequest(tool: string, args: Record<string, unknown>): Promise<RpcResponse | null> {
  return new Promise((resolve) => {
    const sock = net.createConnection(socketPath());
    let buffer = '';
    const cleanup = () => {
      sock.removeAllListeners();
      sock.destroy();
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, 10000);
    sock.on('connect', () => {
      sock.write(encodeLine({ id: nextRequestId++, tool, args }));
    });
    sock.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      const line = buffer.slice(0, nl);
      cleanup();
      clearTimeout(timer);
      try {
        resolve(JSON.parse(line) as RpcResponse);
      } catch (e) {
        resolve({ id: -1, ok: false, error: `cli: bad response JSON (${(e as Error).message})` });
      }
    });
    sock.on('error', () => {
      clearTimeout(timer);
      cleanup();
      resolve(null);
    });
  });
}

// ---------------------------------------------------------------------------
// Tool subcommand dispatch
// ---------------------------------------------------------------------------

/** Convert a ParsedArgs's flags into the tool-args object per the ToolDef. */
export function flagsToToolArgs(parsed: ParsedArgs, def: ToolDef): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!def.args) return out;
  for (const [flagName, argName] of Object.entries(def.args)) {
    if (flagName in parsed.flags) {
      const v = parsed.flags[flagName];
      // Boolean flags: convert "true"/"false" strings to actual booleans
      // (so "--use_sram true" works the same as "--use_sram").
      if (v === true) out[argName] = true;
      else if (v === 'true') out[argName] = true;
      else if (v === 'false') out[argName] = false;
      else out[argName] = v;
    }
  }
  // Validate required flags.
  for (const req of def.required ?? []) {
    if (!(req in parsed.flags)) {
      throw new Error(`missing required flag --${req} (see: rp2_emu ${parsed.command} --help)`);
    }
  }
  return out;
}

/** Ensure the daemon is running (auto-start unless --no-autostart). */
async function ensureDaemon(noAutostart: boolean): Promise<boolean> {
  if (await probeSocket()) return true;
  if (noAutostart) {
    process.stderr.write(
      `rp2_emu: daemon not reachable at ${socketPath()}. Run "rp2_emu start" first.\n`
    );
    return false;
  }
  // Auto-start: spawn detached.
  process.stderr.write('rp2_emu: daemon not running — auto-starting...\n');
  const child = spawn(process.execPath, [selfBinaryPath(), 'start', '--foreground'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return waitForSocket(5000);
}

/** Dispatch a tool subcommand: ensure daemon → send → print → exit code. */
async function runToolSubcommand(parsed: ParsedArgs, def: ToolDef): Promise<number> {
  if (parsed.help) {
    process.stdout.write(subcommandHelp(parsed.command, def));
    return 0;
  }
  if (!(await ensureDaemon(parsed.noAutostart))) return 1;

  let args: Record<string, unknown>;
  try {
    args = flagsToToolArgs(parsed, def);
  } catch (e) {
    process.stderr.write(`rp2_emu: ${(e as Error).message}\n`);
    return 2;
  }

  const resp = await sendRequest(def.tool, args);
  if (resp === null) {
    process.stderr.write(`rp2_emu: no response from daemon at ${socketPath()}\n`);
    return 1;
  }
  if (!resp.ok) {
    process.stderr.write(`rp2_emu: ${resp.error}\n`);
    return 1;
  }
  // Print the first text content block. Most tools return exactly one.
  for (const c of resp.content) {
    if (c.type === 'text') process.stdout.write(c.text + '\n');
  }
  return resp.isError ? 1 : 0;
}

// ---------------------------------------------------------------------------
// main()
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.help && parsed.command === '') {
    process.stdout.write(USAGE);
    return 0;
  }

  const cmd = parsed.command;
  if (cmd === '') {
    process.stderr.write(USAGE);
    return 2;
  }

  // Daemon control commands.
  if (cmd === 'start') return cmdStart(parsed);
  if (cmd === 'stop') return cmdStop();
  if (cmd === 'status') return cmdStatus();
  if (cmd === 'restart') return cmdRestart(parsed);

  // Tool subcommand.
  if (cmd in TOOL_SUBCOMMANDS) {
    return runToolSubcommand(parsed, TOOL_SUBCOMMANDS[cmd]);
  }

  process.stderr.write(`rp2_emu: unknown command "${cmd}"\n\n${USAGE}`);
  return 2;
}

// Only auto-run main() when invoked directly as the entry script (not when
// imported by tests). CJS emits this as `require.main === module`; under
// ts-node/ts-node-dev the same idiom works via the wrapper.
const isMainModule = (() => {
  try {
    return typeof require !== 'undefined' && require.main === module;
  } catch {
    // ESM: fall back to comparing argv[1] to this file's URL.
    return false;
  }
})();

if (isMainModule) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`rp2_emu: ${(e as Error).stack ?? (e as Error).message}\n`);
      process.exit(1);
    });
}

// Exported for the test harness (so it can drive startDaemon directly without
// going through the auto-start spawn dance).
export { startDaemon, RunningDaemon };
