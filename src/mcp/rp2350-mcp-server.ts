/**
 * MCP (Model Context Protocol) server for the RP2350 RISC-V emulator.
 *
 * Exposes emulator state and control as MCP tools, so an AI assistant can
 * read/write registers and memory, set breakpoints and tracepoints,
 * single-step, run, load/reset firmware, inspect PIO/GPIO state, dump
 * memory regions to files, and convert between decimal and hex. Mirrors
 * the GDB server's functionality but uses the MCP tool-call interface
 * instead of the GDB Remote Serial Protocol.
 *
 * Value conventions:
 *   - All register values, addresses, and offsets in tool *outputs* are
 *     formatted as zero-padded hex strings (e.g. "0x20000220").
 *   - All integer *inputs* accept a JSON number, a decimal string, or a
 *     "0x"-prefixed hex string (case-insensitive); see parseUint().
 *
 * Usage as a plugin:
 *   const mcp = new RP2350McpServer(); // optional bootrom Uint32Array arg
 *   const transport = new StdioServerTransport();
 *   await mcp.createServer().connect(transport);
 * Firmware is loaded at runtime via the load_firmware tool, or you can
 * pre-seed chip state via the read/write_register and read/write_memory
 * tools before connecting.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RP2350 } from '../rp2350';
import { CPU } from '../riscv/cpu';
import { loadHex } from '../utils/load-hex';
import { loadUF2 } from '../utils/load-uf2';
import { decodeBlock } from 'uf2';

// CSR address map for register read/write by name
const CSR_MAP: Record<string, number> = {
  mstatus: 0x300,
  mie: 0x304,
  mtvec: 0x305,
  mepc: 0x341,
  mcause: 0x342,
  mip: 0x344,
  mhartid: 0xf14,
};

// Format a 32-bit unsigned value as a hex string, e.g. 0x12345678
function hex(n: number): string {
  return '0x' + (n >>> 0).toString(16).padStart(8, '0');
}

// Parse a flexible integer input into an unsigned 32-bit number. Accepts:
//   - JSON numbers (e.g. 305419896)
//   - decimal strings (e.g. "305419896")
//   - hex strings with 0x prefix (e.g. "0x12345678", "0XDEADBEEF")
//   - undefined/null (returns defaultValue)
// Throws on unparseable input so the caller surfaces a clear error.
function parseUint(v: unknown, defaultValue?: number): number {
  if (v === undefined || v === null) {
    if (defaultValue !== undefined) return defaultValue >>> 0;
    throw new Error('Missing required integer argument');
  }
  if (typeof v === 'number') return v >>> 0;
  if (typeof v !== 'string') {
    throw new Error(`Could not parse integer: unexpected type ${typeof v}`);
  }
  const s = v.trim();
  if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16) >>> 0;
  if (/^-?\d+$/.test(s)) return Number(s) >>> 0;
  throw new Error(`Could not parse integer: "${v}" (use decimal or "0x..." hex)`);
}

// Intel HEX checksum: two's complement of the LSB of the byte sum.
function ihexChecksum(byteSum: number): string {
  return ((~byteSum + 1) & 0xff).toString(16).padStart(2, '0').toUpperCase();
}

// Encode bytes as an Intel HEX file starting at the given absolute address.
// Emits an extended linear address record for the upper 16 bits (and again
// whenever the data crosses a 64K boundary), 16-byte data records, and a
// final EOF record.
function toIntelHex(bytes: number[], startAddr: number): string {
  const lines: string[] = [];
  const emitExtendedAddr = (upper: number) => {
    const sum = 0x02 + 0x00 + 0x00 + 0x04 + (upper >> 8) + (upper & 0xff);
    lines.push(`:02000004${upper.toString(16).padStart(4, '0').toUpperCase()}${ihexChecksum(sum)}`);
  };

  let curUpper = -1;
  let offset = 0;
  while (offset < bytes.length) {
    const chunkAddr = (startAddr + offset) >>> 0;
    const upper = (chunkAddr >>> 16) & 0xffff;
    if (upper !== curUpper) {
      emitExtendedAddr(upper);
      curUpper = upper;
    }
    const lower = chunkAddr & 0xffff;
    const chunkSize = Math.min(16, bytes.length - offset);
    let sum = chunkSize + (lower >> 8) + (lower & 0xff) + 0x00; // record type 00 (data)
    let data = '';
    for (let i = 0; i < chunkSize; i++) {
      const b = bytes[offset + i];
      sum += b;
      data += b.toString(16).padStart(2, '0').toUpperCase();
    }
    lines.push(
      `:${chunkSize.toString(16).padStart(2, '0').toUpperCase()}${lower
        .toString(16)
        .padStart(4, '0')
        .toUpperCase()}00${data}${ihexChecksum(sum)}`
    );
    offset += chunkSize;
  }
  lines.push(':00000001FF'); // EOF
  return lines.join('\n') + '\n';
}

const GPR_NAMES = [
  'zero',
  'ra',
  'sp',
  'gp',
  'tp',
  't0',
  't1',
  't2',
  's0',
  's1',
  'a0',
  'a1',
  'a2',
  'a3',
  'a4',
  'a5',
  'a6',
  'a7',
  's2',
  's3',
  's4',
  's5',
  's6',
  's7',
  's8',
  's9',
  's10',
  's11',
  't3',
  't4',
  't5',
  't6',
];

export class RP2350McpServer {
  private breakpoints = new Set<number>();
  private tracepoints = new Map<string, number>(); // label → address
  private traces: { tag: string; core: number; pc: number; cycles: number }[] = [];
  private bootrom: Uint32Array | null = null;
  // Last-loaded firmware info, for reset()
  private fwPath: string | null = null;
  private fwEntryPc: number = 0;
  private fwUseSram: boolean = false;
  private fwIsUf2: boolean = false;
  private fwDisPath: string | null = null;
  // Disassembly: lines array + map from address to line index
  private disLines: string[] = [];
  private disMap: Map<number, number> = new Map(); // address → line index

  chip: RP2350;

  constructor(bootrom?: Uint32Array) {
    if (bootrom) this.bootrom = bootrom;
    this.chip = this.createChip();
  }

  private createChip(): RP2350 {
    const chip = new RP2350();
    if (this.bootrom) chip.loadBootrom(this.bootrom);
    chip.onTrace = (core, pc, tag) => {
      this.traces.push({
        tag,
        core,
        pc: pc >>> 0,
        cycles: core === 0 ? chip.core0.cycles : chip.core1.cycles,
      });
    };
    return chip;
  }

  // Parse a .dis file into a line array and an address→line-index map.
  // Lines matching /^([0-9a-f]+):\t/ are instruction lines.
  private parseDisassembly(content: string) {
    this.disLines = content.split('\n');
    this.disMap.clear();
    for (let i = 0; i < this.disLines.length; i++) {
      const m = this.disLines[i].match(/^([0-9a-f]+):\t/);
      if (m) this.disMap.set(parseInt(m[1], 16), i);
    }
  }

  // Return ±contextLines around the disassembly entry for the given PC.
  private disasmContext(pc: number, contextLines: number = 5): string | undefined {
    const lineIdx = this.disMap.get(pc >>> 0);
    if (lineIdx === undefined) return undefined;
    const start = Math.max(0, lineIdx - contextLines);
    const end = Math.min(this.disLines.length, lineIdx + contextLines + 1);
    return this.disLines.slice(start, end).join('\n');
  }

  createServer(): Server {
    const server = new Server(
      { name: 'rp2350-mcp-server', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'get_status',
          description:
            'Get emulator status. Emulation is always paused (only runs on single_step/run). emulation_running=false. wfi indicates the RISC-V wait-for-interrupt state (different from emulation pause).',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'read_registers',
          description: 'Read all registers (x0-x31, pc, CSRs) for a core',
          inputSchema: {
            type: 'object',
            properties: {
              core: {
                type: ['number', 'string'],
                enum: [0, 1],
                default: 0,
                description: 'Core index (0 or 1; accepts decimal or "0x...")',
              },
            },
          },
        },
        {
          name: 'write_register',
          description: 'Write a single register by name (e.g. "x5", "pc", "mstatus")',
          inputSchema: {
            type: 'object',
            properties: {
              core: {
                type: ['number', 'string'],
                enum: [0, 1],
                default: 0,
                description: 'Core index (0 or 1; accepts decimal or "0x...")',
              },
              register: {
                type: 'string',
                description: 'Register name (x0-x31, ra, sp, pc, mstatus, etc.)',
              },
              value: {
                type: ['number', 'string'],
                description: '32-bit unsigned value (decimal or "0x..." hex)',
              },
            },
            required: ['register', 'value'],
          },
        },
        {
          name: 'read_memory',
          description: 'Read memory as a hex dump',
          inputSchema: {
            type: 'object',
            properties: {
              address: {
                type: ['number', 'string'],
                description: 'Memory address (decimal or "0x..." hex)',
              },
              length: {
                type: ['number', 'string'],
                description: 'Number of bytes to read (decimal or "0x..." hex)',
                default: 32,
              },
            },
            required: ['address'],
          },
        },
        {
          name: 'write_memory',
          description: 'Write raw bytes to memory (hex-encoded)',
          inputSchema: {
            type: 'object',
            properties: {
              address: {
                type: ['number', 'string'],
                description: 'Memory address (decimal or "0x..." hex)',
              },
              hex: { type: 'string', description: 'Hex-encoded bytes, e.g. "efbeadde"' },
            },
            required: ['address', 'hex'],
          },
        },
        {
          name: 'single_step',
          description: 'Execute one instruction on the specified core',
          inputSchema: {
            type: 'object',
            properties: {
              core: {
                type: ['number', 'string'],
                enum: [0, 1],
                default: 0,
                description: 'Core index (0 or 1; accepts decimal or "0x...")',
              },
            },
          },
        },
        {
          name: 'run',
          description:
            'Run up to max_instructions, stopping at breakpoints. Returns halt reason, cycle count, and any trace hits recorded during this run.',
          inputSchema: {
            type: 'object',
            properties: {
              max_instructions: {
                type: ['number', 'string'],
                default: 10000,
                description: 'Instruction budget (decimal or "0x..." hex)',
              },
            },
          },
        },
        {
          name: 'set_breakpoint',
          description: 'Set a software breakpoint at an address',
          inputSchema: {
            type: 'object',
            properties: {
              address: {
                type: ['number', 'string'],
                description: 'Breakpoint address (decimal or "0x..." hex)',
              },
            },
            required: ['address'],
          },
        },
        {
          name: 'clear_breakpoint',
          description: 'Remove a breakpoint',
          inputSchema: {
            type: 'object',
            properties: {
              address: {
                type: ['number', 'string'],
                description: 'Breakpoint address (decimal or "0x..." hex)',
              },
            },
            required: ['address'],
          },
        },
        {
          name: 'list_breakpoints',
          description: 'List all active breakpoints',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'set_tracepoint',
          description:
            'Set a named tracepoint at an address. Firmware can contain hardwired trace markers (0xabcd/0xffff magic bytes followed by a NUL-terminated tag string placed at a jal return address) which fire automatically. Use list_tracepoints to see all traces including hardwired ones.',
          inputSchema: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Unique name for this tracepoint' },
              address: {
                type: ['number', 'string'],
                description: 'Address of the jal instruction (decimal or "0x..." hex)',
              },
            },
            required: ['label', 'address'],
          },
        },
        {
          name: 'clear_tracepoint',
          description: 'Remove a tracepoint by label',
          inputSchema: {
            type: 'object',
            properties: { label: { type: 'string' } },
            required: ['label'],
          },
        },
        {
          name: 'list_tracepoints',
          description: 'List all tracepoints (label → address) and any recorded traces',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'dump_pio',
          description: 'Dump PIO state machine registers (pc, x, y, ISR, OSR, FIFOs)',
          inputSchema: {
            type: 'object',
            properties: {
              instance: {
                type: ['number', 'string'],
                enum: [0, 1, 2],
                description: 'PIO instance index (accepts decimal or "0x...")',
              },
            },
          },
        },
        {
          name: 'dump_gpio',
          description: 'Dump all GPIO pin states (function, in/out values, pullups)',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'load_firmware',
          description:
            'Load an Intel HEX (.hex) or UF2 (.uf2) firmware file. Re-instantiates the chip with bootrom + firmware. HEX files auto-detect SRAM vs flash from the address map; UF2 files auto-detect from the first block address. Optionally attach a .dis disassembly file for source context in run/single_step output.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Path to the .hex or .uf2 file' },
              entry_pc: {
                type: ['number', 'string'],
                description: 'Optional entry PC (decimal or "0x..." hex; auto-detected if omitted)',
              },
              use_sram: {
                type: 'boolean',
                description: 'Force SRAM loading (auto-detected if omitted)',
              },
              disassembly_path: {
                type: 'string',
                description: 'Path to a .dis disassembly file for source context',
              },
            },
            required: ['path'],
          },
        },
        {
          name: 'reset',
          description:
            'Reset the chip: re-instantiate RP2350, reload bootrom + last firmware. By default clears all breakpoints and tracepoints; set keep_breakpoints to true to preserve them.',
          inputSchema: {
            type: 'object',
            properties: {
              keep_breakpoints: {
                type: 'boolean',
                description:
                  'If true, preserve breakpoints and tracepoints across the reset (default: false).',
              },
            },
          },
        },
        {
          name: 'convert_number',
          description:
            'Convert a value between decimal and hex. Direction is auto-detected: input starting with "0x" (case-insensitive) is treated as hex and converted to decimal; otherwise the input is treated as a decimal integer and converted to hex (0x-prefixed). Both signed and unsigned 32-bit inputs are accepted.',
          inputSchema: {
            type: 'object',
            properties: {
              value: {
                type: 'string',
                description:
                  'Value to convert, e.g. "0x12345678" (hex→dec) or "305419896" (dec→hex)',
              },
            },
            required: ['value'],
          },
        },
        {
          name: 'dump_memory',
          description:
            'Dump a contiguous range of flash or SRAM to a temporary file. Output format: "ihex" (Intel HEX, reloadable via load_firmware) or "text" (raw hex string, one line per 16 bytes). Returns the temp file path.',
          inputSchema: {
            type: 'object',
            properties: {
              region: {
                type: 'string',
                enum: ['flash', 'sram'],
                description: 'Which memory region to dump',
              },
              address: {
                type: ['number', 'string'],
                description:
                  'Byte offset within the region (e.g. 0 for start of flash/SRAM; accepts decimal or "0x..." hex)',
              },
              length: {
                type: ['number', 'string'],
                description: 'Number of bytes to dump (decimal or "0x..." hex)',
              },
              format: {
                type: 'string',
                enum: ['ihex', 'text'],
                default: 'ihex',
                description: 'Output file format',
              },
            },
            required: ['region', 'address', 'length'],
          },
        },
      ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      try {
        return this.handleToolCall(name, args || {});
      } catch (e) {
        return {
          content: [{ type: 'text', text: `Error: ${(e as Error).message}` }],
          isError: true,
        };
      }
    });

    return server;
  }

  // Expose handler for testing without MCP transport. Wraps the dispatch in a
  // try/catch so direct callers (and the MCP transport) get a uniform
  // { isError: true, content: [...] } error shape on bad input.
  handleToolCall(name: string, args: Record<string, unknown>) {
    try {
      return this.dispatch(name, args);
    } catch (e) {
      return {
        content: [{ type: 'text', text: `Error: ${(e as Error).message}` }],
        isError: true,
      };
    }
  }

  private dispatch(name: string, args: Record<string, unknown>) {
    switch (name) {
      case 'get_status':
        return this.getStatus();
      case 'read_registers':
        return this.readRegisters(parseUint(args.core, 0));
      case 'write_register':
        return this.writeRegister(
          parseUint(args.core, 0),
          args.register as string,
          parseUint(args.value)
        );
      case 'read_memory':
        return this.readMemory(parseUint(args.address), parseUint(args.length, 32));
      case 'write_memory':
        return this.writeMemory(parseUint(args.address), args.hex as string);
      case 'single_step':
        return this.singleStep(parseUint(args.core, 0));
      case 'run':
        return this.run(parseUint(args.max_instructions, 10000));
      case 'set_breakpoint':
        return this.setBreakpoint(parseUint(args.address));
      case 'clear_breakpoint':
        return this.clearBreakpoint(parseUint(args.address));
      case 'list_breakpoints':
        return this.listBreakpoints();
      case 'set_tracepoint':
        return this.setTracepoint(args.label as string, parseUint(args.address));
      case 'clear_tracepoint':
        return this.clearTracepoint(args.label as string);
      case 'list_tracepoints':
        return this.listTracepoints();
      case 'dump_pio':
        return this.dumpPio(args.instance != null ? parseUint(args.instance) : undefined);
      case 'dump_gpio':
        return this.dumpGpio();
      case 'load_firmware':
        return this.loadFirmware(
          args.path as string,
          args.entry_pc != null ? parseUint(args.entry_pc) : undefined,
          args.use_sram as boolean | undefined,
          args.disassembly_path as string | undefined
        );
      case 'reset':
        return this.reset(args.keep_breakpoints as boolean | undefined);
      case 'convert_number':
        return this.convertNumber(args.value as string | number);
      case 'dump_memory':
        return this.dumpMemory(
          args.region as 'flash' | 'sram',
          parseUint(args.address),
          parseUint(args.length),
          (args.format as 'ihex' | 'text') ?? 'ihex'
        );
      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
  }

  private cpu(core: number): CPU {
    return core === 0 ? this.chip.core0 : this.chip.core1;
  }

  private json(data: unknown) {
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }

  private text(data: string) {
    return { content: [{ type: 'text', text: data }] };
  }

  private getStatus() {
    return this.json({
      emulation_running: false,
      core0: { pc: hex(this.chip.core0.pc), wfi: this.chip.core0.waiting },
      core1: { pc: hex(this.chip.core1.pc), wfi: this.chip.core1.waiting },
      breakpoints: [...this.breakpoints].map((a) => hex(a)),
      tracepoints: [...this.tracepoints.entries()].map(([label, addr]) => ({
        label,
        address: hex(addr),
      })),
      disassembly_loaded: this.disLines.length > 0,
      disassembly_path: this.fwDisPath,
    });
  }

  private readRegisters(core: number) {
    const cpu = this.cpu(core);
    const regs: Record<string, string> = {};
    for (let i = 0; i < 32; i++) {
      regs[GPR_NAMES[i]] = hex(cpu.registerSet.getRegisterU(i));
    }
    regs.pc = hex(cpu.pc);
    for (const [csrName, csrAddr] of Object.entries(CSR_MAP)) {
      regs[csrName] = hex(cpu.getCSR(csrAddr, 0));
    }
    return this.json(regs);
  }

  private writeRegister(core: number, register: string, value: number) {
    const cpu = this.cpu(core);
    const v = value >>> 0;

    if (register === 'pc') {
      cpu.pc = v;
      return this.json({ ok: true });
    }
    const gprIdx = GPR_NAMES.indexOf(register);
    if (gprIdx >= 0 || /^x\d+$/i.test(register)) {
      const idx = gprIdx >= 0 ? gprIdx : parseInt(register.substring(1));
      cpu.registerSet.setRegisterU(idx, v);
      return this.json({ ok: true });
    }
    if (register in CSR_MAP) {
      cpu.setCSR(CSR_MAP[register], v, 0);
      return this.json({ ok: true });
    }
    return { content: [{ type: 'text', text: `Unknown register: ${register}` }], isError: true };
  }

  private readMemory(address: number, length: number) {
    const bytes: number[] = [];
    for (let i = 0; i < length; i++) {
      let b: number;
      try {
        b = this.chip.readUint8(address + i);
      } catch {
        b = 0xff;
      }
      bytes.push(b);
    }
    // Format as a hex dump with address offsets
    let dump = '';
    for (let i = 0; i < length; i += 16) {
      const addr = (address + i) >>> 0;
      const slice = bytes.slice(i, i + 16);
      const hexPart = slice
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ')
        .padEnd(47, ' ');
      const asciiPart = slice
        .map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.'))
        .join('');
      dump += `0x${addr.toString(16).padStart(8, '0')}  ${hexPart}  ${asciiPart}\n`;
    }
    return this.text(dump.trimEnd());
  }

  private writeMemory(address: number, hex: string) {
    const data = Buffer.from(hex, 'hex');
    for (let i = 0; i < data.length; i++) {
      this.chip.writeUint8(address + i, data[i]);
    }
    return this.json({ ok: true, bytes_written: data.length });
  }

  private formatTrace(t: { tag: string; core: number; pc: number; cycles: number }) {
    return { tag: t.tag, core: t.core, pc: hex(t.pc), cycles: t.cycles };
  }

  private singleStep(core: number) {
    const cpu = this.cpu(core);
    this.chip.isCore0Running = core === 0;
    const traceStart = this.traces.length;
    const elapsed = cpu.executeInstruction();
    if (core === 0) this.chip.stepThings(elapsed);
    const pc = cpu.pc >>> 0;
    const result: Record<string, unknown> = {
      core,
      pc: hex(pc),
      traces: this.traces.slice(traceStart).map((t) => this.formatTrace(t)),
    };
    const ctx = this.disasmContext(pc);
    if (ctx) result.disassembly = ctx;
    return this.json(result);
  }

  private run(maxInstructions: number) {
    this.chip.core1.waiting = true; // park core1 by default
    const traceStart = this.traces.length;
    const hitBp = (core: number): boolean => {
      const cpu = core === 0 ? this.chip.core0 : this.chip.core1;
      return !cpu.waiting && this.breakpoints.has(cpu.pc >>> 0);
    };
    let instructions = 0;
    const result = (halted: boolean, reason: string, core?: number) => {
      const r: Record<string, unknown> = {
        halted,
        reason,
        core,
        core0_pc: hex(this.chip.core0.pc),
        core1_pc: hex(this.chip.core1.pc),
        instructions_executed: instructions,
        cycles: this.chip.core0.cycles,
        traces: this.traces.slice(traceStart).map((t) => this.formatTrace(t)),
      };
      // Show disassembly context for the halted core
      const haltPc =
        core === 0 || core === undefined ? this.chip.core0.pc >>> 0 : this.chip.core1.pc >>> 0;
      const ctx = this.disasmContext(haltPc);
      if (ctx) r.disassembly = ctx;
      return this.json(r);
    };

    while (instructions < maxInstructions) {
      // If both cores are parked, nothing will happen — bail out
      if (this.chip.core0.waiting && this.chip.core1.waiting) {
        return result(false, 'idle');
      }

      // Step whichever core has fewer cycles. Only core0 advances wall-clock
      // time for peripherals; core1 is catching up.
      const step0 = this.chip.core0.cycles <= this.chip.core1.cycles;
      const cpu = step0 ? this.chip.core0 : this.chip.core1;
      const wasWaiting = cpu.waiting;
      this.chip.isCore0Running = step0;
      const elapsed = cpu.executeInstruction();
      if (step0) this.chip.stepThings(elapsed);

      // Only count non-WFI instructions toward the limit
      if (!wasWaiting) instructions++;

      // Check breakpoints on the core that just ran
      if (hitBp(step0 ? 0 : 1)) {
        return result(true, 'breakpoint', step0 ? 0 : 1);
      }
    }
    return result(false, 'max_reached');
  }

  private setBreakpoint(address: number) {
    this.breakpoints.add(address >>> 0);
    return this.json({ ok: true, address: hex(address) });
  }

  private clearBreakpoint(address: number) {
    this.breakpoints.delete(address >>> 0);
    return this.json({ ok: true, address: hex(address) });
  }

  private listBreakpoints() {
    return this.json({ addresses: [...this.breakpoints].map((a) => hex(a)) });
  }

  private setTracepoint(label: string, address: number) {
    this.tracepoints.set(label, address >>> 0);
    return this.json({ ok: true, label, address: hex(address) });
  }

  private clearTracepoint(label: string) {
    const existed = this.tracepoints.delete(label);
    return this.json({ ok: true, label, existed });
  }

  private listTracepoints() {
    const tps = [...this.tracepoints.entries()].map(([label, address]) => ({
      label,
      address: hex(address),
    }));
    return this.json({ tracepoints: tps });
  }

  private loadFirmware(
    path: string,
    entryPc?: number,
    useSram?: boolean,
    disassemblyPath?: string
  ) {
    const isUf2 = path.toLowerCase().endsWith('.uf2');

    if (!isUf2) {
      const hex = fs.readFileSync(path, 'utf-8');
      // Auto-detect SRAM vs flash from hex extended address record
      const detectSram = (source: string): boolean => {
        for (const line of source.split('\n')) {
          if (line[0] === ':' && line.substring(7, 9) === '04') {
            return parseInt(line.substring(9, 13), 16) >= 0x2000;
          }
        }
        return false;
      };
      const sram = useSram ?? detectSram(hex);
      const pc = entryPc ?? (sram ? 0x20000220 : 0x10000036);

      this.fwPath = path;
      this.fwEntryPc = pc;
      this.fwUseSram = sram;
      this.fwIsUf2 = false;
      this.reinitChip(hex, sram, pc);
    } else {
      // UF2 files: detect SRAM vs flash from the first block's address
      const uf2Data = fs.readFileSync(path);
      const tmpBuf = new Uint8Array(512);
      tmpBuf.set(uf2Data.subarray(0, 512));
      const firstBlock = decodeBlock(tmpBuf);
      const isSram = firstBlock.flashAddress >= 0x20000000;
      const pc = entryPc ?? (isSram ? 0x20000220 : 0x10000036);

      this.fwPath = path;
      this.fwEntryPc = pc;
      this.fwUseSram = isSram;
      this.fwIsUf2 = true;
      this.reinitChipUf2(path, pc);
    }

    // Load disassembly if provided (or auto-detect .dis alongside .hex/.uf2)
    const disPath = disassemblyPath ?? path.replace(/\.(hex|uf2)$/i, '.dis');
    if (fs.existsSync(disPath)) {
      this.fwDisPath = disPath;
      this.parseDisassembly(fs.readFileSync(disPath, 'utf-8'));
    } else {
      this.fwDisPath = null;
      this.disLines = [];
      this.disMap.clear();
    }

    this.breakpoints.clear();
    this.tracepoints.clear();
    this.traces = [];
    return this.json({
      ok: true,
      path,
      entry_pc: hex(this.fwEntryPc),
      use_sram: this.fwUseSram,
      format: this.fwIsUf2 ? 'uf2' : 'hex',
      disassembly_loaded: this.disLines.length > 0,
    });
  }

  // Dump a range of flash or SRAM to a temp file. Region selects the base
  // address (flash=0x10000000, sram=0x20000000); address is an offset within
  // that region. Output is Intel HEX (default) or plain hex text.
  private dumpMemory(
    region: 'flash' | 'sram',
    address: number,
    length: number,
    format: 'ihex' | 'text'
  ) {
    if (length <= 0) {
      return {
        content: [{ type: 'text', text: `length must be > 0 (got ${length})` }],
        isError: true,
      };
    }
    const baseAddr = region === 'sram' ? 0x20000000 : 0x10000000;
    const absAddr = (baseAddr + address) >>> 0;

    // Read bytes; treat unmapped reads as 0xff (matches readMemory behaviour)
    const bytes: number[] = [];
    for (let i = 0; i < length; i++) {
      let b: number;
      try {
        b = this.chip.readUint8(absAddr + i);
      } catch {
        b = 0xff;
      }
      bytes.push(b);
    }

    let content: string;
    let ext: string;
    if (format === 'ihex') {
      content = toIntelHex(bytes, absAddr);
      ext = '.hex';
    } else {
      // One 16-byte row per line, address-prefixed for readability
      const lines: string[] = [];
      for (let i = 0; i < bytes.length; i += 16) {
        const slice = bytes.slice(i, i + 16);
        const addr = (absAddr + i) >>> 0;
        const hexPart = slice.map((b) => b.toString(16).padStart(2, '0')).join('');
        lines.push(`${hex(addr)} ${hexPart}`);
      }
      content = lines.join('\n') + '\n';
      ext = '.txt';
    }

    const tmpPath = path.join(os.tmpdir(), `rp2350-dump-${Date.now()}${ext}`);
    fs.writeFileSync(tmpPath, content);

    return this.json({
      ok: true,
      path: tmpPath,
      region,
      address: hex(absAddr),
      length,
      format,
      file_size: content.length,
    });
  }

  // Convert a value between decimal and hex. Direction is auto-detected:
  // inputs prefixed with "0x" (case-insensitive) are hex→dec, all others are
  // dec→hex. Accepts the value as either a string or a JSON number.
  private convertNumber(value: string | number) {
    const str = typeof value === 'number' ? String(value) : value.trim();
    const isHex = /^0x[0-9a-f]+$/i.test(str);
    const isDec = /^-?\d+$/.test(str);

    if (isHex) {
      const n = parseInt(str, 16) >>> 0;
      return this.json({ input: str, hex: hex(n), decimal: n });
    }
    if (isDec) {
      // >>> 0 normalizes negative numbers to their unsigned 32-bit representation
      const n = Number(str) >>> 0;
      return this.json({ input: str, hex: hex(n), decimal: n });
    }
    return {
      content: [
        {
          type: 'text',
          text: `Could not parse "${str}". Use "0x..." for hex or a decimal integer.`,
        },
      ],
      isError: true,
    };
  }

  private reset(keepBreakpoints = false) {
    if (this.fwPath) {
      if (this.fwIsUf2) {
        this.reinitChipUf2(this.fwPath, this.fwEntryPc);
      } else {
        const hex = fs.readFileSync(this.fwPath, 'utf-8');
        this.reinitChip(hex, this.fwUseSram, this.fwEntryPc);
      }
      // Reload disassembly if it was previously loaded
      if (this.fwDisPath && fs.existsSync(this.fwDisPath)) {
        this.parseDisassembly(fs.readFileSync(this.fwDisPath, 'utf-8'));
      }
    } else {
      this.chip = this.createChip();
      this.fwDisPath = null;
      this.disLines = [];
      this.disMap.clear();
    }
    if (!keepBreakpoints) {
      this.breakpoints.clear();
      this.tracepoints.clear();
    }
    this.traces = [];
    return this.json({
      ok: true,
      firmware_loaded: this.fwPath !== null,
      disassembly_loaded: this.disLines.length > 0,
      breakpoints_kept: keepBreakpoints,
    });
  }

  private reinitChip(hex: string, useSram: boolean, entryPc: number) {
    this.chip = this.createChip();
    if (useSram) {
      loadHex(hex, this.chip.sram, 0x20000000);
    } else {
      loadHex(hex, this.chip.flash, 0x10000000);
    }
    this.chip.core0.pc = entryPc;
    this.chip.core1.pc = entryPc;
    this.chip.core1.waiting = true;
  }

  private reinitChipUf2(path: string, entryPc: number) {
    this.chip = this.createChip();
    loadUF2(path, this.chip);
    this.chip.core0.pc = entryPc;
    this.chip.core1.pc = entryPc;
    this.chip.core1.waiting = true;
  }

  private dumpPio(instance?: number) {
    const pios = this.chip.pio;
    const lines: string[] = [];
    const indices =
      instance != null && instance >= 0 && instance < pios.length
        ? [instance]
        : pios.map((_, i) => i);

    for (const i of indices) {
      const pio = pios[i];
      lines.push(`=== PIO${i} ===`);
      for (let sm = 0; sm < pio.machines.length; sm++) {
        const m = pio.machines[sm];
        lines.push(
          `  SM${sm}: pc=${m.pc} x=0x${(m.x >>> 0).toString(16)} y=0x${(m.y >>> 0).toString(16)}` +
            ` enabled=${m.enabled ? 1 : 0} waiting=${m.waiting ? 1 : 0}` +
            ` tx=${m.txFIFO.itemCount}/${m.txFIFO.size} rx=${m.rxFIFO.itemCount}/${m.rxFIFO.size}` +
            ` instr=0x${(pio.instructions[m.pc] >>> 0).toString(16).padStart(8, '0')}`
        );
        lines.push(
          `    ISR=0x${(m.inputShiftReg >>> 0).toString(16).padStart(8, '0')} (${(
            m.inputShiftReg >>> 0
          )
            .toString(2)
            .padStart(32, '0')}) ${m.inputShiftCount}/${m.pushThreshold} bits` +
            (m.shiftCtrl & (1 << 16) ? ' autopush' : '') +
            (m.shiftCtrl & (1 << 18) ? ' →' : ' ←')
        );
        lines.push(
          `    OSR=0x${(m.outputShiftReg >>> 0).toString(16).padStart(8, '0')} (${(
            m.outputShiftReg >>> 0
          )
            .toString(2)
            .padStart(32, '0')}) ${m.outputShiftCount}/${m.pullThreshold} bits` +
            (m.shiftCtrl & (1 << 17) ? ' autopull' : '') +
            (m.shiftCtrl & (1 << 19) ? ' →' : ' ←')
        );
      }
    }
    return this.text(lines.join('\n') + '\n');
  }

  private dumpGpio() {
    const pins = this.chip.gpio;
    const n = pins.length;
    const funcNames = [
      'SPI',
      'UART',
      'I2C',
      'XIP',
      'PWM',
      'SIO',
      'PIO0',
      'PIO1',
      'PIO2',
      'CLK',
      'USB',
    ];
    const funcName = (f: number) => funcNames[f] ?? `FUNC${f}`;

    const lines: string[] = [`=== GPIO (${n} pins) ===`];
    for (let i = 0; i < n; i++) {
      const p = pins[i];
      lines.push(
        `  GP${i.toString().padStart(2)} ${funcName(p.functionSelect).padEnd(5)}` +
          ` in=${p.inputValue ? 1 : 0} out=${p.outputValue ? 1 : 0} oe=${p.outputEnable ? 1 : 0}` +
          ` irq=${p.irqValue ? 1 : 0} pu=${p.pullupEnabled ? 1 : 0} pd=${p.pulldownEnabled ? 1 : 0}`
      );
    }
    let inBits = '';
    let outBits = '';
    for (let i = 0; i < n; i++) {
      inBits = (pins[i].inputValue ? '1' : '0') + inBits;
      outBits = (pins[i].outputValue ? '1' : '0') + outBits;
    }
    lines.push(`  inputs:  ${inBits}`);
    lines.push(`  outputs: ${outBits}`);
    return this.text(lines.join('\n') + '\n');
  }
}
