/*
 * RP2350 MCP server unit tests.
 *
 * Tests call handleToolCall() directly (no MCP transport needed), then
 * assert on the returned content.
 */

import { describe, expect, test, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RP2350 } from '../../rp2350';
import { RP2350McpServer } from '../rp2350-mcp-server';

const SCRATCH = 0x20000000;

describe('RP2350 MCP Server', () => {
  let chip: RP2350;
  let server: RP2350McpServer;

  beforeEach(() => {
    server = new RP2350McpServer();
    chip = server.chip;
    chip.core1.waiting = true;
  });

  function text(result: { content: { text: string }[] }): string {
    return result.content[0].text;
  }

  function json(result: { content: { text: string }[]; isError?: boolean }): any {
    return JSON.parse(result.content[0].text);
  }

  // =====================================================================
  // get_status
  // =====================================================================

  describe('get_status', () => {
    test('returns core PCs, emulation_running=false, and empty breakpoints', () => {
      const data = json(server.handleToolCall('get_status', {}));
      expect(data.emulation_running).toBe(false);
      expect(data.core0.pc).toBe(chip.core0.pc);
      expect(data.core0.wfi).toBeDefined();
      expect(data.core1.pc).toBe(chip.core1.pc);
      expect(data.core1.wfi).toBeDefined();
      expect(data.breakpoints).toEqual([]);
    });

    test('includes breakpoints after setting them', () => {
      server.handleToolCall('set_breakpoint', { address: 0x20000100 });
      server.handleToolCall('set_breakpoint', { address: 0x20000200 });
      const data = json(server.handleToolCall('get_status', {}));
      expect(data.breakpoints).toContain(0x20000100);
      expect(data.breakpoints).toContain(0x20000200);
    });
  });

  // =====================================================================
  // read_registers / write_register
  // =====================================================================

  describe('registers', () => {
    test('read all registers', () => {
      chip.core0.registerSet.setRegisterU(1, 0xdeadbeef);
      chip.core0.pc = 0x20000100;
      const data = json(server.handleToolCall('read_registers', { core: 0 }));
      expect(data.ra).toBe(0xdeadbeef);
      expect(data.pc).toBe(0x20000100);
      expect(data.zero).toBe(0);
      expect(data.mstatus).toBeDefined();
      expect(data.mhartid).toBeDefined();
    });

    test('read registers for core 1', () => {
      chip.core1.registerSet.setRegisterU(5, 0x42);
      const data = json(server.handleToolCall('read_registers', { core: 1 }));
      expect(data.t0).toBe(0x42);
    });

    test('write register by ABI name', () => {
      server.handleToolCall('write_register', { core: 0, register: 'ra', value: 0x12345678 });
      expect(chip.core0.registerSet.getRegisterU(1)).toBe(0x12345678);
    });

    test('write register by numeric name', () => {
      server.handleToolCall('write_register', { core: 0, register: 'x5', value: 0xabc });
      expect(chip.core0.registerSet.getRegisterU(5)).toBe(0xabc);
    });

    test('write pc', () => {
      server.handleToolCall('write_register', { core: 0, register: 'pc', value: 0x20000100 });
      expect(chip.core0.pc).toBe(0x20000100);
    });

    test('write CSR (mepc)', () => {
      server.handleToolCall('write_register', { core: 0, register: 'mepc', value: 0x20004000 });
      expect(chip.core0.csrs[0x341]).toBe(0x20004000);
    });

    test('write to core 1', () => {
      server.handleToolCall('write_register', { core: 1, register: 'sp', value: 0x20010000 });
      expect(chip.core1.registerSet.getRegisterU(2)).toBe(0x20010000);
      expect(chip.core0.registerSet.getRegisterU(2)).toBe(0);
    });

    test('unknown register returns error', () => {
      const result = server.handleToolCall('write_register', { register: 'foo', value: 0 }) as any;
      expect(result.isError).toBe(true);
    });
  });

  // =====================================================================
  // read_memory / write_memory
  // =====================================================================

  describe('memory', () => {
    test('read memory returns hex dump', () => {
      chip.writeUint32(SCRATCH, 0xdeadbeef);
      const dump = text(server.handleToolCall('read_memory', { address: SCRATCH, length: 4 }));
      expect(dump).toContain('ef be ad de');
      expect(dump).toContain('0x20000000');
    });

    test('read memory shows ASCII representation', () => {
      chip.writeUint8(SCRATCH, 0x48); // 'H'
      chip.writeUint8(SCRATCH + 1, 0x49); // 'I'
      const dump = text(server.handleToolCall('read_memory', { address: SCRATCH, length: 2 }));
      expect(dump).toContain('HI');
    });

    test('write memory', () => {
      server.handleToolCall('write_memory', { address: SCRATCH, hex: 'efbeadde' });
      expect(chip.readUint32(SCRATCH)).toBe(0xdeadbeef);
    });

    test('read memory handles invalid addresses', () => {
      const dump = text(server.handleToolCall('read_memory', { address: 0xffff0000, length: 4 }));
      expect(dump).toContain('ff');
    });
  });

  // =====================================================================
  // single_step
  // =====================================================================

  describe('single_step', () => {
    test('steps core 0 by one instruction', () => {
      chip.writeUint32(SCRATCH, 0x00000013); // nop
      chip.core0.pc = SCRATCH;
      const data = json(server.handleToolCall('single_step', { core: 0 }));
      expect(data.core).toBe(0);
      expect(data.pc).toBe(SCRATCH + 4);
      expect(data.traces).toEqual([]);
    });

    test('single_step returns trace hits', () => {
      chip.writeUint32(SCRATCH, 0x00c0006f); // j +12
      chip.writeUint16(SCRATCH + 4, 0xabcd);
      chip.writeUint16(SCRATCH + 6, 0xffff);
      chip.writeUint8(SCRATCH + 8, 0x68); // 'h'
      chip.writeUint8(SCRATCH + 9, 0x69); // 'i'
      chip.writeUint8(SCRATCH + 10, 0x00);
      chip.core0.pc = SCRATCH;
      const data = json(server.handleToolCall('single_step', { core: 0 }));
      expect(data.traces.length).toBe(1);
      expect(data.traces[0].tag).toBe('hi');
    });

    test('steps core 1 independently', () => {
      chip.writeUint32(SCRATCH, 0x00000013); // nop
      chip.core1.waiting = false;
      chip.core1.pc = SCRATCH;
      const core0Pc = chip.core0.pc;
      const data = json(server.handleToolCall('single_step', { core: 1 }));
      expect(data.core).toBe(1);
      expect(chip.core1.pc).toBe(SCRATCH + 4);
      expect(chip.core0.pc).toBe(core0Pc);
    });
  });

  // =====================================================================
  // run
  // =====================================================================

  describe('run', () => {
    test('halts at breakpoint', () => {
      chip.writeUint32(SCRATCH, 0x00000013); // nop
      chip.writeUint32(SCRATCH + 4, 0x00000013); // nop
      chip.writeUint32(SCRATCH + 8, 0xffdff06f); // j -4
      chip.core0.pc = SCRATCH;

      server.handleToolCall('set_breakpoint', { address: SCRATCH + 4 });
      const data = json(server.handleToolCall('run', { max_instructions: 1000 }));

      expect(data.halted).toBe(true);
      expect(data.reason).toBe('breakpoint');
      expect(data.core0_pc).toBe(SCRATCH + 4);
    });

    test('stops at max_instructions', () => {
      chip.writeUint32(SCRATCH, 0x00000013); // nop
      chip.writeUint32(SCRATCH + 4, 0xffdff06f); // j -4
      chip.core0.pc = SCRATCH;

      const data = json(server.handleToolCall('run', { max_instructions: 10 }));
      expect(data.halted).toBe(false);
      expect(data.reason).toBe('max_reached');
      expect(data.instructions_executed).toBe(10);
    });
  });

  // =====================================================================
  // breakpoints
  // =====================================================================

  describe('breakpoints', () => {
    test('set and list', () => {
      server.handleToolCall('set_breakpoint', { address: 0x100 });
      server.handleToolCall('set_breakpoint', { address: 0x200 });
      const data = json(server.handleToolCall('list_breakpoints', {}));
      expect(data.addresses).toContain(0x100);
      expect(data.addresses).toContain(0x200);
    });

    test('clear', () => {
      server.handleToolCall('set_breakpoint', { address: 0x100 });
      server.handleToolCall('clear_breakpoint', { address: 0x100 });
      const data = json(server.handleToolCall('list_breakpoints', {}));
      expect(data.addresses).not.toContain(0x100);
    });
  });

  // =====================================================================
  // tracepoints
  // =====================================================================

  describe('tracepoints', () => {
    test('set and list', () => {
      server.handleToolCall('set_tracepoint', { label: 'entry', address: 0x20000100 });
      server.handleToolCall('set_tracepoint', { label: 'loop', address: 0x20000200 });
      const data = json(server.handleToolCall('list_tracepoints', {}));
      expect(data.tracepoints).toContainEqual({ label: 'entry', address: 0x20000100 });
      expect(data.tracepoints).toContainEqual({ label: 'loop', address: 0x20000200 });
    });

    test('clear by label', () => {
      server.handleToolCall('set_tracepoint', { label: 'foo', address: 0x100 });
      server.handleToolCall('clear_tracepoint', { label: 'foo' });
      const data = json(server.handleToolCall('list_tracepoints', {}));
      expect(data.tracepoints).toEqual([]);
    });

    test('get_status includes tracepoint info', () => {
      server.handleToolCall('set_tracepoint', { label: 'x', address: 0x100 });
      const data = json(server.handleToolCall('get_status', {}));
      expect(data.tracepoints).toContainEqual({ label: 'x', address: 0x100 });
    });

    test('run reports traces from hardwired trace markers', () => {
      // Layout: j skips over the marker data to the code after it.
      //   SCRATCH+0:  j SCRATCH+12   (jal x0, +12 → 0x00C0006F)
      //   SCRATCH+4:  .half 0xABCD   (marker)
      //   SCRATCH+6:  .half 0xFFFF   (marker)
      //   SCRATCH+8:  "hi\0"         (tag string)
      //   SCRATCH+12: nop            (code resumes here)
      //   SCRATCH+16: j -4           (loop back to SCRATCH+12)
      chip.writeUint32(SCRATCH, 0x00c0006f); // j +12
      chip.writeUint16(SCRATCH + 4, 0xabcd);
      chip.writeUint16(SCRATCH + 6, 0xffff);
      chip.writeUint8(SCRATCH + 8, 0x68); // 'h'
      chip.writeUint8(SCRATCH + 9, 0x69); // 'i'
      chip.writeUint8(SCRATCH + 10, 0x00); // NUL
      chip.writeUint32(SCRATCH + 12, 0x00000013); // nop
      chip.writeUint32(SCRATCH + 16, 0xffdff06f); // j -4
      chip.core0.pc = SCRATCH;

      const data = json(server.handleToolCall('run', { max_instructions: 20 }));
      expect(data.traces.length).toBeGreaterThanOrEqual(1);
      expect(data.traces[0].tag).toBe('hi');
      expect(data.traces[0].pc).toBe(SCRATCH >>> 0);
    });

    test('run does NOT halt on tracepoints', () => {
      chip.writeUint32(SCRATCH, 0x00c0006f); // j +12
      chip.writeUint16(SCRATCH + 4, 0xabcd);
      chip.writeUint16(SCRATCH + 6, 0xffff);
      chip.writeUint8(SCRATCH + 8, 0x68); // 'h'
      chip.writeUint8(SCRATCH + 9, 0x00);
      chip.writeUint8(SCRATCH + 10, 0x00);
      chip.writeUint32(SCRATCH + 12, 0x00000013); // nop
      chip.writeUint32(SCRATCH + 16, 0xffdff06f); // j -4
      chip.core0.pc = SCRATCH;

      const data = json(server.handleToolCall('run', { max_instructions: 10 }));
      expect(data.halted).toBe(false);
      expect(data.reason).toBe('max_reached');
    });

    test('list_tracepoints shows only definitions, not traces', () => {
      server.handleToolCall('set_tracepoint', { label: 'foo', address: 0x200 });
      const data = json(server.handleToolCall('list_tracepoints', {}));
      expect(data.tracepoints).toContainEqual({ label: 'foo', address: 0x200 });
      expect(data.traces).toBeUndefined();
    });
  });

  // =====================================================================
  // dump_pio
  // =====================================================================

  describe('dump_pio', () => {
    test('dumps all PIO instances', () => {
      const dump = text(server.handleToolCall('dump_pio', {}));
      expect(dump).toContain('PIO0');
      expect(dump).toContain('PIO1');
      expect(dump).toContain('PIO2');
      expect(dump).toContain('SM0');
    });

    test('dumps single instance', () => {
      const dump = text(server.handleToolCall('dump_pio', { instance: 1 }));
      expect(dump).toContain('PIO1');
      expect(dump).not.toContain('=== PIO0');
    });

    test('shows ISR/OSR state', () => {
      chip.pio[0].machines[0].inputShiftReg = 0xdeadbeef;
      chip.pio[0].machines[0].inputShiftCount = 16;
      const dump = text(server.handleToolCall('dump_pio', { instance: 0 }));
      expect(dump).toContain('ISR=0xdeadbeef');
      expect(dump).toContain('16/');
    });
  });

  // =====================================================================
  // dump_gpio
  // =====================================================================

  describe('dump_gpio', () => {
    test('dumps all 48 pins', () => {
      const dump = text(server.handleToolCall('dump_gpio', {}));
      expect(dump).toContain('48 pins');
      expect(dump).toContain('GP 0');
      expect(dump).toContain('GP47');
      expect(dump).toContain('inputs:');
      expect(dump).toContain('outputs:');
    });

    test('shows pin function', () => {
      chip.gpio[0].ctrl = 5; // SIO
      const dump = text(server.handleToolCall('dump_gpio', {}));
      expect(dump).toMatch(/GP 0 SIO/);
    });
  });

  // =====================================================================
  // load_firmware / reset
  // =====================================================================

  describe('load_firmware and reset', () => {
    function writeTempHex(baseAddr: number, data: number[]): string {
      // Write a minimal Intel HEX file: extended address record + data record
      const hi = (baseAddr >> 16) & 0xffff;
      const lo = baseAddr & 0xffff;
      const lines: string[] = [];
      // Extended linear address record
      const hiChecksum = (0x02 + 0x00 + 0x00 + 0x04 + (hi >> 8) + (hi & 0xff)) & 0xff;
      lines.push(
        `:02000004${hi.toString(16).padStart(4, '0')}${hiChecksum
          .toString(16)
          .padStart(2, '0')
          .toUpperCase()}`
      );
      // Data record
      const byteCount = data.length;
      let sum = byteCount + (lo >> 8) + (lo & 0xff) + 0x00;
      let hexData = '';
      for (const b of data) {
        sum += b;
        hexData += b.toString(16).padStart(2, '0').toUpperCase();
      }
      const checksum = ((~sum + 1) & 0xff).toString(16).padStart(2, '0').toUpperCase();
      lines.push(
        `:${byteCount.toString(16).padStart(2, '0').toUpperCase()}${lo
          .toString(16)
          .padStart(4, '0')
          .toUpperCase()}00${hexData}${checksum}`
      );
      // EOF record
      lines.push(':00000001FF');
      const tmp = path.join(os.tmpdir(), `mcp-test-${Date.now()}.hex`);
      fs.writeFileSync(tmp, lines.join('\n') + '\n');
      return tmp;
    }

    test('load_firmware loads SRAM hex and sets PC', () => {
      const hexPath = writeTempHex(0x20000000, [0x13, 0x00, 0x00, 0x00]); // nop at 0x20000000
      const data = json(server.handleToolCall('load_firmware', { path: hexPath }));
      expect(data.ok).toBe(true);
      expect(data.use_sram).toBe(true);
      expect(data.entry_pc).toBe(0x20000220);
      fs.unlinkSync(hexPath);
    });

    test('load_firmware loads flash hex', () => {
      const hexPath = writeTempHex(0x10000000, [0x6f, 0x00, 0x00, 0x00]); // j at 0x10000000
      const data = json(server.handleToolCall('load_firmware', { path: hexPath }));
      expect(data.ok).toBe(true);
      expect(data.use_sram).toBe(false);
      expect(data.entry_pc).toBe(0x10000036);
      fs.unlinkSync(hexPath);
    });

    test('load_firmware clears breakpoints', () => {
      server.handleToolCall('set_breakpoint', { address: 0x100 });
      server.handleToolCall('set_breakpoint', { address: 0x200 });
      const hexPath = writeTempHex(0x20000000, [0x13, 0x00, 0x00, 0x00]);
      server.handleToolCall('load_firmware', { path: hexPath });
      const data = json(server.handleToolCall('list_breakpoints', {}));
      expect(data.addresses).toEqual([]);
      fs.unlinkSync(hexPath);
    });

    test('reset reloads last firmware', () => {
      const hexPath = writeTempHex(0x20000000, [0x13, 0x00, 0x00, 0x00]);
      server.handleToolCall('load_firmware', { path: hexPath, entry_pc: 0x20000000 });
      // Step one instruction to dirty the state
      server.handleToolCall('single_step', {});
      server.handleToolCall('set_breakpoint', { address: 0x500 });
      // Reset
      const data = json(server.handleToolCall('reset', {}));
      expect(data.ok).toBe(true);
      expect(data.firmware_loaded).toBe(true);
      // PC should be back at entry
      const status = json(server.handleToolCall('get_status', {}));
      expect(status.core0.pc).toBe(0x20000000);
      // Breakpoints cleared
      const bps = json(server.handleToolCall('list_breakpoints', {}));
      expect(bps.addresses).toEqual([]);
      fs.unlinkSync(hexPath);
    });

    test('load_firmware loads UF2 binary', () => {
      const data = json(
        server.handleToolCall('load_firmware', { path: 'demo/riscv_blink/blink_simple.uf2' })
      );
      expect(data.ok).toBe(true);
      expect(data.format).toBe('uf2');
      // This UF2 targets SRAM (0x20000000)
      expect(data.use_sram).toBe(true);
      expect(data.entry_pc).toBe(0x20000220);
    });

    test('reset without firmware clears state', () => {
      // Don't load firmware, just set some state
      server.handleToolCall('set_breakpoint', { address: 0x100 });
      server.handleToolCall('set_tracepoint', { label: 'x', address: 0x200 });
      const data = json(server.handleToolCall('reset', {}));
      expect(data.ok).toBe(true);
      expect(data.firmware_loaded).toBe(false);
      const bps = json(server.handleToolCall('list_breakpoints', {}));
      expect(bps.addresses).toEqual([]);
      const tps = json(server.handleToolCall('list_tracepoints', {}));
      expect(tps.tracepoints).toEqual([]);
    });

    test('load_firmware auto-detects .dis file', () => {
      const data = json(
        server.handleToolCall('load_firmware', {
          path: 'demo/riscv_blink/blink_simple.hex',
        })
      );
      expect(data.ok).toBe(true);
      expect(data.disassembly_loaded).toBe(true);
    });

    test('single_step includes disassembly context', () => {
      server.handleToolCall('load_firmware', {
        path: 'demo/riscv_blink/blink_simple.hex',
      });
      // Step past the entry point; the result should include disassembly
      const data = json(server.handleToolCall('single_step', { core: 0 }));
      expect(data.disassembly).toBeDefined();
      expect(typeof data.disassembly).toBe('string');
      // Should contain instruction lines (hex address + tab)
      expect(data.disassembly).toMatch(/20000[0-9a-f]+:/);
    });

    test('run includes disassembly context on breakpoint', () => {
      server.handleToolCall('load_firmware', {
        path: 'demo/riscv_blink/blink_simple.hex',
      });
      // Set a breakpoint early in the boot sequence
      server.handleToolCall('set_breakpoint', { address: 0x2000025c }); // platform_entry
      const data = json(server.handleToolCall('run', { max_instructions: 50000 }));
      if (data.halted) {
        expect(data.disassembly).toBeDefined();
        expect(data.disassembly).toMatch(/20000[0-9a-f]+:/);
      }
    });

    test('get_status reports disassembly_loaded', () => {
      const before = json(server.handleToolCall('get_status', {}));
      expect(before.disassembly_loaded).toBe(false);

      server.handleToolCall('load_firmware', {
        path: 'demo/riscv_blink/blink_simple.hex',
      });
      const after = json(server.handleToolCall('get_status', {}));
      expect(after.disassembly_loaded).toBe(true);
      expect(after.disassembly_path).toContain('blink_simple.dis');
    });
  });
});
