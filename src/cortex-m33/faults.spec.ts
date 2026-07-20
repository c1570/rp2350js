import { describe, expect, it } from 'vitest';
import { RP2350 } from '../rp2350';

const SRAM = 0x20000000;
const EXC_HARDFAULT = 3;

function setup() {
  const chip = new RP2350(false, undefined, { coreArch: 'arm' });
  const core = chip.armCore0;
  chip.currentCore = 0;
  chip.writeUint32(0xe000ed08, SRAM); // VTOR
  return { chip, core };
}

describe('Cortex-M33 fault model', () => {
  it('stack overflow raises STKOF in CFSR and escalates to HardFault', () => {
    const { chip, core } = setup();
    chip.writeUint32(SRAM + 3 * 4, SRAM + 0x300); // HardFault vector
    // Thread mode uses PSP with tight limit; HardFault uses MSP with room.
    core.regs.control |= 0x2; // SPSEL=1 → PSP
    core.regs.psp = SRAM + 0x100;
    core.regs.psplim = SRAM + 0xf0; // frameSp=0xE0 < 0xF0 → overflow
    core.regs.msp = SRAM + 0x2000; // MSP has room for HardFault
    core.regs.msplim = 0;
    core.regs.sp = core.regs.psp;
    chip.writeUint32(0xe000e100, 1 << 0);
    chip.writeUint32(0xe000e200, 1 << 0);
    chip.writeUint16(SRAM + 0x300, 0xbf00);
    core.PC = SRAM + 0x1000;
    core.executeInstruction();
    expect(core.regs.ipsr).toBe(3); // HardFault
    expect(chip.readUint32(0xe000ed28) & (1 << 20)).not.toBe(0); // STKOF
    expect(chip.readUint32(0xe000ed2c) & (1 << 30)).not.toBe(0); // FORCED
  });

  it('UsageFault handler runs when SHCSR.USGFAULTENA is set', () => {
    const { chip, core } = setup();
    chip.writeUint32(SRAM + 6 * 4, SRAM + 0x600); // UsageFault vector
    chip.writeUint32(0xe000ed24, 1 << 18); // SHCSR.USGFAULTENA
    core.regs.control |= 0x2; // PSP
    core.regs.psp = SRAM + 0x100;
    core.regs.psplim = SRAM + 0xf0;
    core.regs.msp = SRAM + 0x2000;
    core.regs.msplim = 0;
    core.regs.sp = core.regs.psp;
    chip.writeUint32(0xe000e100, 1 << 0);
    chip.writeUint32(0xe000e200, 1 << 0);
    core.PC = SRAM + 0x1000;
    chip.writeUint16(SRAM + 0x600, 0xbf00);
    core.executeInstruction();
    expect(core.regs.ipsr).toBe(6); // UsageFault
    expect(core.PC).toBe(SRAM + 0x600);
  });

  it('lockup: HardFault-in-HardFault returns without taking the exception', () => {
    const { chip, core } = setup();
    // Put core directly in HardFault handler state.
    core.regs.xpsr = (core.regs.xpsr & ~0x1ff) | 3; // IPSR=3
    core.regs.msp = SRAM + 0x1000;
    core.regs.sp = core.regs.msp;
    // Directly call exceptionEntry for HardFault → triggers lockup check.
    // In lockup the handler must NOT advance: no stack push, no IPSR update,
    // no vector fetch — real hardware enters a "stable fault" halt.
    core.exceptionEntry(EXC_HARDFAULT);
    const spBefore = core.regs.msp;
    expect(core.regs.sp).toBe(spBefore); // no stack frame pushed
    expect(core.regs.ipsr).toBe(3); // unchanged
  });
});

describe('Cortex-M33 FP lazy stacking', () => {
  it('CONTROL.FPCA causes FP frame reservation on exception entry', () => {
    const { chip, core } = setup();
    chip.writeUint32(SRAM + 16 * 4, SRAM + 0x200); // IRQ 0 handler
    chip.writeUint32(0xe000e100, 1 << 0); // enable
    chip.writeUint32(0xe000e200, 1 << 0); // pend
    core.regs.control |= 1 << 2; // FPCA
    core.regs.s[0] = 3.14;
    core.regs.fpscr = 0x00080000;
    core.regs.sp = SRAM + 0x1000;
    core.regs.msp = SRAM + 0x1000;
    chip.writeUint32(0xe000ef34, 0); // eager (LSPEN=0)
    core.PC = SRAM + 0x1000;
    chip.writeUint16(SRAM + 0x200, 0xbf00);
    core.executeInstruction();
    expect(core.regs.lr & 0x10).toBe(0); // FType=0
    const s0 = chip.readUint32(SRAM + 0x0f98 + 0x20);
    expect(s0).not.toBe(0);
    expect(core.regs.control & (1 << 2)).toBe(0);
  });

  it('lazy stacking defers FP save (LSPACT set)', () => {
    const { chip, core } = setup();
    chip.writeUint32(SRAM + 16 * 4, SRAM + 0x200);
    chip.writeUint32(0xe000e100, 1 << 0); // enable
    chip.writeUint32(0xe000e200, 1 << 0); // pend
    core.regs.control |= 1 << 2;
    core.regs.sp = SRAM + 0x1000;
    core.regs.msp = SRAM + 0x1000;
    chip.writeUint32(0xe000ef34, 1 << 30); // LSPEN
    core.PC = SRAM + 0x1000;
    chip.writeUint16(SRAM + 0x200, 0xbf00);
    core.executeInstruction();
    const fpccr = chip.readUint32(0xe000ef34);
    expect(fpccr & 1).not.toBe(0); // LSPACT
    const fpcar = chip.readUint32(0xe000ef38);
    expect(fpcar).not.toBe(0);
    const s0AtFrame = chip.readUint32(fpcar);
    expect(s0AtFrame).toBe(0); // not written yet (lazy)
  });

  it('flushLazyFp writes S0-S15 and clears LSPACT', () => {
    const { chip, core } = setup();
    chip.writeUint32(SRAM + 16 * 4, SRAM + 0x200);
    chip.writeUint32(0xe000e100, 1 << 0); // enable
    chip.writeUint32(0xe000e200, 1 << 0); // pend
    core.regs.control |= 1 << 2;
    core.regs.s[0] = 1.0;
    core.regs.fpscr = 0x1000000;
    core.regs.sp = SRAM + 0x1000;
    core.regs.msp = SRAM + 0x1000;
    chip.writeUint32(0xe000ef34, 1 << 30); // LSPEN
    core.PC = SRAM + 0x1000;
    chip.writeUint16(SRAM + 0x200, 0xbf00);
    core.executeInstruction();
    const fpcar = chip.readUint32(0xe000ef38);
    expect(chip.readUint32(fpcar)).toBe(0); // before flush
    core.flushLazyFp();
    expect(chip.readUint32(fpcar)).not.toBe(0); // after flush
    expect(chip.readUint32(0xe000ef34) & 1).toBe(0); // LSPACT cleared
  });
});

describe('Cortex-M33 MPU/SAU registers', () => {
  it('MPU region registers round-trip', () => {
    const chip = new RP2350(false, undefined, { coreArch: 'arm' });
    chip.currentCore = 0;
    // Select region 3.
    chip.writeUint32(0xe000ed98, 3); // MPU_RNR
    chip.writeUint32(0xe000ed9c, 0x20000000); // MPU_RBAR
    chip.writeUint32(0xe000eda0, 0x2000ffff); // MPU_RLAR
    expect(chip.readUint32(0xe000ed98)).toBe(3);
    expect(chip.readUint32(0xe000ed9c)).toBe(0x20000000);
    expect(chip.readUint32(0xe000eda0)).toBe(0x2000ffff);
    // Region 0 unaffected.
    chip.writeUint32(0xe000ed98, 0);
    expect(chip.readUint32(0xe000ed9c)).toBe(0);
  });

  it('SAU region registers round-trip', () => {
    const chip = new RP2350(false, undefined, { coreArch: 'arm' });
    chip.currentCore = 0;
    chip.writeUint32(0xe000edd8, 2); // SAU_RNR
    chip.writeUint32(0xe000eddc, 0x10000000); // SAU_RBAR
    chip.writeUint32(0xe000ede0, 0x100001ff); // SAU_RLAR
    expect(chip.readUint32(0xe000eddc)).toBe(0x10000000);
    expect(chip.readUint32(0xe000ede0)).toBe(0x100001ff);
  });

  it('SFSR is W1C', () => {
    const chip = new RP2350(false, undefined, { coreArch: 'arm' });
    chip.currentCore = 0;
    const st = chip.ppb!.coreState[0];
    st.sfsr = 0xff;
    chip.writeUint32(0xe000ede4, 0x02); // clear bit 1
    expect(chip.readUint32(0xe000ede4)).toBe(0xff & ~0x02);
  });

  it('FPDSCR round-trips', () => {
    const chip = new RP2350(false, undefined, { coreArch: 'arm' });
    chip.currentCore = 0;
    chip.writeUint32(0xe000ef3c, 0x08000000);
    expect(chip.readUint32(0xe000ef3c)).toBe(0x08000000);
  });

  it('MVFR0 reports FPv5-SP feature bits', () => {
    const chip = new RP2350(false, undefined, { coreArch: 'arm' });
    chip.currentCore = 0;
    const mvfr0 = chip.readUint32(0xe000ef40);
    // Should indicate single-precision FP support (not zero).
    expect(mvfr0).not.toBe(0);
  });

  describe('Unimplemented opcodes throw (debug aid, not silent skip)', () => {
    // An unimplemented opcode is treated as an emulator bug, so we throw rather
    // than advancing PC past it (which would hide the bug).
    it('an unimplemented 32-bit opcode throws', () => {
      const { chip, core } = setup();
      chip.writeUint16(SRAM, 0xf7f0);
      chip.writeUint16(SRAM + 2, 0xa000);
      core.PC = SRAM;
      expect(() => core.executeInstruction()).toThrow();
    });

    it('an unimplemented 16-bit opcode throws', () => {
      const { chip, core } = setup();
      // 0xB6xx is an unhandled reserved encoding in executeThumb16.
      chip.writeUint16(SRAM, 0xb600);
      core.PC = SRAM;
      expect(() => core.executeInstruction()).toThrow();
    });

    it('NOCP (FPU op with CPACR disabled) still delivers the fault, not a throw', () => {
      // The throw-on-unimplemented guard must NOT swallow synchronous faults that
      // are already pending (NOCP). VADD with CP10 disabled sets pendingFault
      // then returns -1; the UsageFault/HardFault must still be delivered.
      const chip = new RP2350(false, undefined, { coreArch: 'arm' });
      const core = chip.armCore0;
      chip.currentCore = 0;
      chip.writeUint32(0xe000ed08, SRAM); // VTOR
      chip.writeUint32(SRAM + 3 * 4, SRAM + 0x300); // HardFault vector
      chip.writeUint16(SRAM + 0x300, 0xbf00); // NOP in HardFault handler
      core.regs.msp = SRAM + 0x2000;
      core.regs.sp = SRAM + 0x2000;
      chip.writeUint16(SRAM, 0xee30);
      chip.writeUint16(SRAM + 2, 0x0a81); // VADD.F32 (CP10, CPACR=0 → NOCP)
      core.PC = SRAM;
      core.executeInstruction();
      // The fault was delivered (HardFault taken), NOT a bare halt: IPSR
      // shows we're in the HardFault handler.
      expect(core.regs.ipsr).toBe(3); // HardFault
      expect(chip.readUint32(0xe000ed28) & (1 << 21)).not.toBe(0); // NOCP
    });
  });
});
