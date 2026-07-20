import { describe, expect, it } from 'vitest';
import { RP2350 } from '../rp2350';
import { CortexM33Core } from './core';
import { M33Registers, XPSR_T } from './registers';

describe('RP2350 ARM (Cortex-M33) scaffolding', () => {
  it('defaults to RISC-V cores when no options are passed (backward compat)', () => {
    const chip = new RP2350();
    expect(chip.coreArch).toBe('riscv');
    expect(chip.ppb).toBeUndefined();
    // Back-compat accessors must work — these are the ones existing code uses.
    expect(chip.core0).toBe(chip.core[0]);
    expect(chip.core1).toBe(chip.core[1]);
  });

  it('constructs ARM cores when coreArch: arm is requested', () => {
    const chip = new RP2350(false, undefined, { coreArch: 'arm' });
    expect(chip.coreArch).toBe('arm');
    expect(chip.ppb).toBeDefined();
    expect(chip.armCore0).toBeInstanceOf(CortexM33Core);
    expect(chip.armCore1).toBeInstanceOf(CortexM33Core);
    expect(chip.armCore0.coreIndex).toBe(0);
    expect(chip.armCore1.coreIndex).toBe(1);
    // Sibling wiring (for SEV).
    expect(chip.armCore0.otherCore).toBe(chip.armCore1);
    expect(chip.armCore1.otherCore).toBe(chip.armCore0);
  });

  it('M33 registers reset to a Thumb-mode post-power-on state', () => {
    const regs = new M33Registers();
    regs.reset();
    expect(regs.xpsr).toBe(XPSR_T);
    expect(regs.primask).toBe(0);
    expect(regs.basepri).toBe(0);
    expect(regs.faultmask).toBe(0);
    expect(regs.control).toBe(0);
    expect(regs.N).toBe(false);
    expect(regs.Z).toBe(false);
    expect(regs.itState).toBe(0);
    expect(regs.ipsr).toBe(0);
    expect(regs.inHandlerMode()).toBe(false);
  });

  it('M33 APSR flag setters update xPSR bits', () => {
    const regs = new M33Registers();
    regs.reset();
    regs.setNZCV(true, false, true, false);
    expect(regs.N).toBe(true);
    expect(regs.Z).toBe(false);
    expect(regs.C).toBe(true);
    expect(regs.V).toBe(false);
    regs.setQ();
    expect(regs.Q).toBe(true);
    // Q is sticky.
    regs.N = false;
    expect(regs.Q).toBe(true);
    regs.clearQ();
    expect(regs.Q).toBe(false);
  });

  it('M33 GE flags live in xPSR[19:16]', () => {
    const regs = new M33Registers();
    regs.reset();
    regs.GE = 0xa;
    expect(regs.GE).toBe(0xa);
    // GE bits land in [19:16], not collide with other fields.
    expect((regs.xpsr >>> 16) & 0xf).toBe(0xa);
  });

  it('M33 IT state round-trips through xPSR', () => {
    const regs = new M33Registers();
    regs.reset();
    // IT instruction encodes cond in [7:4], mask in [3:0].
    // Example: cond=0b1010 (GE), mask=0b1000 (1 instruction) → byte 0xa8.
    regs.itState = 0xa8;
    expect(regs.itState).toBe(0xa8);
    // xPSR[26:25] gets cond[3:2] (top 2 bits of cond); xPSR[15:10] gets
    // cond[1:0]:mask[3:0] (bottom 6 bits of the IT byte).
    expect((regs.xpsr >>> 25) & 0x3).toBe(0b10); // top 2 bits of cond=0b1010
    expect((regs.xpsr >>> 10) & 0x3f).toBe(0x28); // 0xa8 & 0x3f
  });

  it('M33 SP banking: R13 follows CONTROL.SPSEL only in Thread mode', () => {
    const regs = new M33Registers();
    regs.reset();
    regs.msp = 0x1000;
    regs.psp = 0x2000;
    // Thread mode + SPSEL=0 → R13 mirrors MSP.
    regs.syncSpFromBanked();
    expect(regs.sp).toBe(0x1000);
    // Switch to PSP.
    regs.control = 0x2; // SPSEL=1
    regs.syncSpFromBanked();
    expect(regs.sp).toBe(0x2000);
    // In Handler mode (IPSR != 0), MSP is always used regardless of SPSEL.
    regs.xpsr = (regs.xpsr & ~0x1ff) | 3; // HardFault IPSR=3
    regs.syncSpFromBanked();
    expect(regs.sp).toBe(0x1000);
  });

  it('PPB CPUID reads as the documented M33 r0p1 value', () => {
    const chip = new RP2350(false, undefined, { coreArch: 'arm' });
    const cpuid = chip.readUint32(0xe000ed00);
    expect(cpuid >>> 0).toBe(0x410fd213);
  });

  it('PPB VTOR is writable per core and reads back', () => {
    const chip = new RP2350(false, undefined, { coreArch: 'arm' });
    chip.currentCore = 0;
    chip.writeUint32(0xe000ed08, 0x20001000);
    expect(chip.readUint32(0xe000ed08)).toBe(0x20001000);
    // Core 1's VTOR is independent.
    chip.currentCore = 1;
    expect(chip.readUint32(0xe000ed08)).toBe(0);
    chip.writeUint32(0xe000ed08, 0x20002000);
    expect(chip.readUint32(0xe000ed08)).toBe(0x20002000);
    chip.currentCore = 0;
    expect(chip.readUint32(0xe000ed08)).toBe(0x20001000);
  });

  it('NVIC pending/enabled bitmasks are per-core and writable', () => {
    const chip = new RP2350(false, undefined, { coreArch: 'arm' });
    chip.currentCore = 0;
    // NVIC_ISPR0 = 0xe000e200, NVIC_ISER0 = 0xe000e100.
    chip.writeUint32(0xe000e100, 1 << 5); // enable IRQ 5
    chip.writeUint32(0xe000e200, 1 << 5); // pend IRQ 5
    expect(chip.readUint32(0xe000e100)).toBe(1 << 5); // enabled
    expect(chip.readUint32(0xe000e200)).toBe(1 << 5); // pending
    // Clear pending.
    chip.writeUint32(0xe000e280, 1 << 5); // ICPR0
    expect(chip.readUint32(0xe000e200)).toBe(0);
    // Core 1 is independent.
    chip.currentCore = 1;
    expect(chip.readUint32(0xe000e100)).toBe(0);
    expect(chip.readUint32(0xe000e200)).toBe(0);
  });

  it('ARM core executeInstruction returns without crashing', () => {
    const chip = new RP2350(false, undefined, { coreArch: 'arm' });
    const cycles = chip.armCore0.executeInstruction();
    expect(cycles).toBeGreaterThan(0);
    expect(chip.armCore0.cycles).toBeGreaterThan(0);
  });

  it('ICpuCore.setInterrupt is implemented on both architectures', () => {
    const riscvChip = new RP2350();
    expect(() => riscvChip.core0.setInterrupt(0, true)).not.toThrow();
    const armChip = new RP2350(false, undefined, { coreArch: 'arm' });
    expect(() => armChip.armCore0.setInterrupt(0, true)).not.toThrow();
  });
});
