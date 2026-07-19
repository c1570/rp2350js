/*
 * rp2_emu CLI + daemon tests.
 *
 * Two layers:
 *   1. parseArgs / flagsToToolArgs unit tests (no daemon needed).
 *   2. IPC integration: spin up startDaemon in-process on an ephemeral socket,
 *      drive it with the same line-delimited JSON the CLI sends, and verify
 *      responses match what EmulatorController.handleToolCall returns directly.
 *
 * The integration tests use socket + state file paths inside the test's own
 * tmpdir so they cannot collide with a real daemon a developer may have
 * running.
 */

import { connect } from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, test, beforeAll, afterAll } from 'vitest';
import { startDaemon } from '../daemon';
import { encodeLine, RpcResponse, isToolResponse } from '../protocol';
import { parseArgs, flagsToToolArgs, TOOL_SUBCOMMANDS } from '../rp2-emu';

// ---------------------------------------------------------------------------
// Unit: parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  test('command + simple flag', () => {
    expect(parseArgs(['get_status'])).toEqual({
      command: 'get_status',
      flags: {},
      noAutostart: false,
      help: false,
    });
  });

  test('long flag with value', () => {
    const p = parseArgs(['write_register', '--register', 'ra', '--value', '0x42']);
    expect(p.command).toBe('write_register');
    expect(p.flags.register).toBe('ra');
    expect(p.flags.value).toBe('0x42');
  });

  test('hex value with 0x prefix not eaten as flag', () => {
    const p = parseArgs(['set_breakpoint', '--address', '0x20000100']);
    expect(p.flags.address).toBe('0x20000100');
  });

  test('numeric value not eaten as flag', () => {
    const p = parseArgs(['write_register', '--register', 'ra', '--value', '305419896']);
    expect(p.flags.value).toBe('305419896');
  });

  test('boolean flag (no value)', () => {
    const p = parseArgs(['reset', '--keep_breakpoints']);
    expect(p.flags.keep_breakpoints).toBe(true);
  });

  test('--no-autostart is hoisted', () => {
    const p = parseArgs(['get_status', '--no-autostart']);
    expect(p.noAutostart).toBe(true);
    expect('no-autostart' in p.flags).toBe(false);
  });

  test('-h and --help', () => {
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['get_status', '--help']).help).toBe(true);
  });

  test('first non-flag is command; later non-flags ignored', () => {
    const p = parseArgs(['get_status', 'extra', 'tokens']);
    expect(p.command).toBe('get_status');
  });

  test('flag immediately before another flag is boolean', () => {
    const p = parseArgs(['reset', '--keep_breakpoints', '--verbose']);
    expect(p.flags.keep_breakpoints).toBe(true);
    expect(p.flags.verbose).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unit: flagsToToolArgs
// ---------------------------------------------------------------------------

describe('flagsToToolArgs', () => {
  test('maps flag names to MCP arg names', () => {
    const args = flagsToToolArgs(
      {
        command: 'write_register',
        flags: { register: 'ra', value: '0x42', core: '0x1' },
        noAutostart: false,
        help: false,
      },
      TOOL_SUBCOMMANDS.write_register
    );
    expect(args).toEqual({ register: 'ra', value: '0x42', core: '0x1' });
  });

  test('"true"/"false" strings become booleans', () => {
    const args = flagsToToolArgs(
      {
        command: 'load_firmware',
        flags: { path: '/tmp/x.hex', use_sram: 'true' },
        noAutostart: false,
        help: false,
      },
      TOOL_SUBCOMMANDS.load_firmware
    );
    expect(args.use_sram).toBe(true);
  });

  test('boolean flag (no value) becomes true', () => {
    const args = flagsToToolArgs(
      {
        command: 'reset',
        flags: { keep_breakpoints: true },
        noAutostart: false,
        help: false,
      },
      TOOL_SUBCOMMANDS.reset
    );
    expect(args.keep_breakpoints).toBe(true);
  });

  test('missing required flag throws', () => {
    expect(() =>
      flagsToToolArgs(
        { command: 'set_breakpoint', flags: {}, noAutostart: false, help: false },
        TOOL_SUBCOMMANDS.set_breakpoint
      )
    ).toThrow(/required flag --address/);
  });

  test('omitted optional flags are absent', () => {
    const args = flagsToToolArgs(
      {
        command: 'read_registers',
        flags: {},
        noAutostart: false,
        help: false,
      },
      TOOL_SUBCOMMANDS.read_registers
    );
    expect(args).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Integration: startDaemon + socket IPC
// ---------------------------------------------------------------------------

describe('daemon IPC integration', () => {
  let sockPath: string;
  let statePath: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp2-emu-test-'));
    sockPath = path.join(tmp, 'test.sock');
    statePath = path.join(tmp, 'test.state.json');
    const running = await startDaemon({
      bootrom: 'rp2350-a2',
      foreground: true,
      socketOverride: sockPath,
      stateOverride: statePath,
    });
    cleanup = running.close;
  });

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  /** One-shot RPC helper: open socket, send line, read line, return parsed. */
  function rpc(tool: string, args: Record<string, unknown>): Promise<RpcResponse> {
    return new Promise((resolve, reject) => {
      const sock = connect(sockPath, () => {
        sock.write(encodeLine({ id: 1, tool, args }));
      });
      let buf = '';
      sock.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf-8');
        const nl = buf.indexOf('\n');
        if (nl !== -1) {
          const line = buf.slice(0, nl);
          sock.destroy();
          try {
            resolve(JSON.parse(line) as RpcResponse);
          } catch (e) {
            reject(e);
          }
        }
      });
      sock.on('error', reject);
      setTimeout(() => {
        sock.destroy();
        reject(new Error('timeout'));
      }, 5000);
    });
  }

  /** Same as rpc() but asserts ok:true and narrows to the tool-response shape. */
  async function rpcOk(tool: string, args: Record<string, unknown>) {
    const resp = await rpc(tool, args);
    if (!isToolResponse(resp)) {
      throw new Error(`expected ok response, got: ${resp.error}`);
    }
    return resp;
  }

  /** Extract content[0].text parsed as JSON (or raw string for non-JSON tools). */
  async function rpcJson<T = unknown>(tool: string, args: Record<string, unknown>): Promise<T> {
    const resp = await rpcOk(tool, args);
    return JSON.parse(resp.content[0].text) as T;
  }

  test('state file was written with correct socket path', () => {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(state.socketPath).toBe(sockPath);
    expect(state.pid).toBe(process.pid);
    expect(state.bootrom).toBe('rp2350-a2');
  });

  test('get_status returns running state', async () => {
    const data = await rpcJson<{ emulation_running: boolean; arch: string }>('get_status', {});
    expect(data.emulation_running).toBe(false);
    expect(data.arch).toBe('riscv');
  });

  test('write_register then read_registers round-trips', async () => {
    const write = await rpcOk('write_register', { core: 0, register: 'ra', value: '0xdeadbeef' });
    expect(write.isError).toBe(false);

    const data = await rpcJson<{ ra: string }>('read_registers', { core: 0 });
    expect(data.ra).toBe('0xdeadbeef');
  });

  test('read_memory returns hex dump text', async () => {
    await rpcOk('write_memory', { address: '0x20000000', hex: 'efbeadde' });
    const resp = await rpcOk('read_memory', { address: '0x20000000', length: 4 });
    expect(resp.isError).toBe(false);
    expect(resp.content[0].text).toMatch(/ef be ad de/);
  });

  test('unknown register returns tool-level error (ok:true, isError:true)', async () => {
    const resp = await rpcOk('write_register', { register: 'no_such_reg', value: 0 });
    expect(resp.isError).toBe(true);
    expect(resp.content[0].text).toMatch(/Unknown register/);
  });

  test('unknown tool returns tool-level error', async () => {
    const resp = await rpcOk('not_a_tool', {});
    expect(resp.isError).toBe(true);
    expect(resp.content[0].text).toMatch(/Unknown tool/);
  });

  test('breakpoint set/list/clear', async () => {
    await rpcOk('set_breakpoint', { address: '0x20000200' });
    await rpcOk('set_breakpoint', { address: '0x20000300' });
    const data = await rpcJson<{ addresses: string[] }>('list_breakpoints', {});
    expect(data.addresses).toContain('0x20000200');
    expect(data.addresses).toContain('0x20000300');
    await rpcOk('clear_breakpoint', { address: '0x20000200' });
    const afterData = await rpcJson<{ addresses: string[] }>('list_breakpoints', {});
    expect(afterData.addresses).not.toContain('0x20000200');
    expect(afterData.addresses).toContain('0x20000300');
  });

  test('single_step executes a nop and advances pc', async () => {
    await rpcOk('write_memory', { address: '0x20001000', hex: '13000000' }); // little-endian nop
    await rpcOk('write_register', { register: 'pc', value: '0x20001000' });
    const data = await rpcJson<{ pc: string }>('single_step', { core: 0 });
    expect(data.pc).toBe('0x20001004');
  });

  test('__status pseudo-tool returns running state', async () => {
    const data = await rpcJson<{ running: boolean; pid: number }>('__status', {});
    expect(data.running).toBe(true);
    expect(data.pid).toBe(process.pid);
  });

  test('convert_number dec/hex parity with MCP tool', async () => {
    const data = await rpcJson<{ decimal: number; hex: string }>('convert_number', {
      value: '0x12345678',
    });
    expect(data.decimal).toBe(0x12345678);
    expect(data.hex).toBe('0x12345678');
  });

  test('dump_memory writes a file with correct region address', async () => {
    // write_memory writes raw bytes in the order given (not as a little-endian word)
    await rpcOk('write_memory', { address: '0x20000000', hex: 'cafebabe' });
    const data = await rpcJson<{ ok: boolean; address: string; path: string }>('dump_memory', {
      region: 'sram',
      address: 0,
      length: 4,
    });
    expect(data.ok).toBe(true);
    expect(data.address).toBe('0x20000000');
    const fileContent = fs.readFileSync(data.path, 'utf-8');
    // Intel HEX data record preserves byte order: ca fe ba be
    expect(fileContent).toContain('CAFEBABE');
    fs.unlinkSync(data.path);
  });
});
