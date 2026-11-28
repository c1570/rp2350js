import { describe, expect, it } from 'vitest';
import { RP2350 } from '../../rp2350';

const NOP = 0x00000013; // addi x0, x0, 0
const SCRATCH = 0x20000000;

// MCOUNTINHIBIT (0x320) bits
const CY = 1 << 0; // inhibit mcycle/mcycleh
const IR = 1 << 2; // inhibit minstret/minstreth

function setup() {
  const chip = new RP2350();
  const cpu = chip.core0;
  // A sled of NOPs: tests execute several instructions in sequence from SCRATCH.
  for (let i = 0; i < 16; i++) {
    chip.writeUint32(SCRATCH + i * 4, NOP);
  }
  cpu.pc = SCRATCH;
  cpu.next_pc = 0;
  return { chip, cpu };
}

describe('MCOUNTINHIBIT (0x320)', () => {
  it('resets to 0x5: both counters inhibited by default to save power', () => {
    const { cpu } = setup();
    expect(cpu.getCSR(0x320, 0) >>> 0).toBe(CY | IR);
  });

  it('keeps only CY and IR on write; the reserved bits read as zero', () => {
    const { cpu } = setup();
    cpu.setCSR(0x320, 0xffffffff, 0xffffffff);
    expect(cpu.getCSR(0x320, 0) >>> 0).toBe(CY | IR);
    cpu.setCSR(0x320, 0, 0);
    expect(cpu.getCSR(0x320, 0) >>> 0).toBe(0);
  });
});

describe('mcycle/mcycleh (0xb00/0xb80)', () => {
  it('does not count while CY is set, then counts retired cycles once cleared', () => {
    const { cpu } = setup();
    cpu.executeInstruction();
    expect(cpu.getCSR(0xb00, 0) >>> 0).toBe(0); // CY set by default

    cpu.setCSR(0x320, 0, 0); // clear CY and IR
    cpu.executeInstruction();
    cpu.executeInstruction();
    expect(cpu.getCSR(0xb00, 0) >>> 0).toBe(2);
  });

  it('stops counting again when CY is re-set, while minstret keeps its own gate', () => {
    const { cpu } = setup();
    cpu.setCSR(0x320, 0, 0);
    cpu.executeInstruction();
    cpu.executeInstruction();
    cpu.setCSR(0x320, CY, CY); // inhibit mcycle only
    const before = cpu.getCSR(0xb00, 0) >>> 0;
    cpu.executeInstruction();
    cpu.executeInstruction();
    expect(cpu.getCSR(0xb00, 0) >>> 0).toBe(before);
    expect(cpu.getCSR(0xb02, 0) >>> 0).toBe(4); // IR clear: minstret counts all four
  });

  it('counts cycles spent in WFI, but those retire no instructions', () => {
    const { cpu } = setup();
    cpu.setCSR(0x320, IR, IR); // mcycle runs, minstret inhibited
    cpu.waiting = true;
    cpu.executeInstructionsUpTo(cpu.getCycles() + 10);
    expect(cpu.getCSR(0xb00, 0) >>> 0).toBe(10);
    expect(cpu.getCSR(0xb02, 0) >>> 0).toBe(0);
  });

  it('is a 64-bit counter: mcycle writes the low word, mcycleh the high word', () => {
    const { cpu } = setup();
    cpu.setCSR(0x320, 0, 0);
    cpu.setCSR(0xb00, 0xfffffffe, 0xfffffffe);
    cpu.setCSR(0xb80, 1, 1);
    expect(cpu.getCSR(0xb00, 0) >>> 0).toBe(0xfffffffe);
    expect(cpu.getCSR(0xb80, 0) >>> 0).toBe(1);

    cpu.executeInstruction(); // wraps the low word, carries into mcycleh
    expect(cpu.getCSR(0xb00, 0) >>> 0).toBe(0xffffffff);
    cpu.executeInstruction();
    expect(cpu.getCSR(0xb00, 0) >>> 0).toBe(0);
    expect(cpu.getCSR(0xb80, 0) >>> 0).toBe(2);
  });
});

describe('minstret/minstreth (0xb02/0xb82)', () => {
  it('counts retired instructions once IR is clear, and only then', () => {
    const { cpu } = setup();
    cpu.setCSR(0x320, CY, CY); // clear IR, keep mcycle inhibited
    cpu.executeInstruction();
    cpu.executeInstruction();
    expect(cpu.getCSR(0xb02, 0) >>> 0).toBe(2);
    expect(cpu.getCSR(0xb00, 0) >>> 0).toBe(0);

    cpu.setCSR(0x320, CY | IR, CY | IR);
    const before = (cpu.getCSR(0xb02, 0) | (cpu.getCSR(0xb82, 0) === 0 ? 0 : 0)) >>> 0;
    cpu.executeInstruction();
    expect(cpu.getCSR(0xb02, 0) >>> 0).toBe(before);
  });

  it('splits across minstreth like a 64-bit counter', () => {
    const { cpu } = setup();
    cpu.setCSR(0xb02, 0xfffffffe, 0xfffffffe);
    cpu.setCSR(0xb82, 7, 7);
    cpu.setCSR(0x320, CY, CY);
    cpu.executeInstruction();
    expect(cpu.getCSR(0xb02, 0) >>> 0).toBe(0xffffffff);
    expect(cpu.getCSR(0xb82, 0) >>> 0).toBe(7);
    cpu.executeInstruction();
    expect(cpu.getCSR(0xb02, 0) >>> 0).toBe(0);
    expect(cpu.getCSR(0xb82, 0) >>> 0).toBe(8);
  });
});
