/**
 * Profiler trace-magic tests for the Cortex-M33 core.
 *
 * The firmware emits a trace event by placing a 0xabcd/0xffff marker
 * immediately after an unconditional B (T2) instruction, followed by a
 * NUL-terminated tag string. The core detects the marker at decode time and
 * fires chip.onTrace(coreNumber, pc, tag). Mirrors the RISC-V trace tests and
 * the original Cortex-M0+ implementation.
 */

import { describe, expect, test, vi } from 'vitest';
import { RP2350 } from '../rp2350';

const SRAM = 0x20000000;

/**
 * Write the marker + tag at `addr`. Layout (immediately after the 2-byte B):
 *   addr+0: 0xabcd  (uint16 LE)
 *   addr+2: 0xffff  (uint16 LE)
 *   addr+4: tag bytes, NUL-terminated
 */
function writeMagicTag(chip: RP2350, addr: number, tag: string) {
  chip.writeUint16(addr, 0xabcd);
  chip.writeUint16(addr + 2, 0xffff);
  for (let i = 0; i < tag.length; i++) {
    chip.writeUint8(addr + 4 + i, tag.charCodeAt(i));
  }
  chip.writeUint8(addr + 4 + tag.length, 0);
}

describe('Cortex-M33 profiler trace magic', () => {
  test('B (unconditional T2) fires onTrace with the tag and the B address', () => {
    const chip = new RP2350(false, undefined, { coreArch: 'arm' });
    const core = chip.armCore0;

    // b +10  ->  0xe003  (imm11 field = 3, byte offset = 6, target = pc+10)
    // The magic lands at the byte right after the 2-byte B instruction.
    chip.writeUint16(SRAM, 0xe003);
    writeMagicTag(chip, SRAM + 2, 'hello');

    const onTrace = vi.fn();
    chip.onTrace = onTrace;

    core.PC = SRAM;
    core.executeInstruction();

    expect(onTrace).toHaveBeenCalledOnce();
    expect(onTrace).toHaveBeenCalledWith(0, SRAM, 'hello');
    // B must still jump to pc + offset regardless of the magic.
    expect(core.PC).toBe(SRAM + 10);
  });

  test('B without the marker does not fire onTrace', () => {
    const chip = new RP2350(false, undefined, { coreArch: 'arm' });
    const core = chip.armCore0;

    // b +10 with zeros (not 0xabcd/0xffff) after it.
    chip.writeUint16(SRAM, 0xe003);
    chip.writeUint16(SRAM + 2, 0);
    chip.writeUint16(SRAM + 4, 0);

    const onTrace = vi.fn();
    chip.onTrace = onTrace;

    core.PC = SRAM;
    core.executeInstruction();

    expect(onTrace).not.toHaveBeenCalled();
    expect(core.PC).toBe(SRAM + 10);
  });
});
