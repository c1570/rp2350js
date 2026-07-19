import { describe, expect, it } from 'vitest';
import { RP2350 } from '../rp2350';

const SRAM = 0x20000000;

function setup() {
  const chip = new RP2350(false, undefined, { coreArch: 'arm' });
  const core = chip.armCore0;
  core.stopped = false;
  chip.currentCore = 0;
  chip.writeUint32(0xe000ed08, SRAM);
  chip.writeUint32(0xe000ed88, 0x00ff0000);
  return { chip, core };
}

function put32(chip: RP2350, addr: number, hw0: number, hw1: number) {
  chip.writeUint16(addr, hw0);
  chip.writeUint16(addr + 2, hw1);
}

describe('Cortex-M33 TrustZone stubs', () => {
  it('core resets to Secure state', () => {
    const { core } = setup();
    expect(core.secure).toBe(true);
  });

  it('SG instruction transitions to Secure state', () => {
    const { chip, core } = setup();
    core.secure = false; // start Non-secure
    put32(chip, SRAM, 0xe97f, 0xe97f); // SG
    core.PC = SRAM;
    core.executeInstruction();
    expect(core.secure).toBe(true);
  });

  it('TT sets the S (bit 22) result in Secure state', () => {
    const { chip, core } = setup();
    core.secure = true;
    core.regs.r[1] = SRAM + 0x1000;
    // TT r0, r1: hw0 = 0xe840|Rn=1, hw1 = 1111 Rt(=0) 00 000000.
    // Encoding verified against `arm-none-eabi-as -march=armv8-m.main`.
    put32(chip, SRAM, 0xe841, 0xf000); // TT r0, r1
    core.PC = SRAM;
    core.executeInstruction();
    // Real ARMv8-M TT result bit 22 is "S" (Secure attribute of the tested
    // address) — SDK code such as rom_func_lookup's Secure/Non-secure check
    // tests exactly this bit (shifted into the sign bit) to choose between
    // RT_FLAG_FUNC_ARM_SEC and RT_FLAG_FUNC_ARM_NONSEC.
    expect(core.regs.r[0] & 0x400000).not.toBe(0);
  });

  it('TT clears the S (bit 22) result in Non-secure state', () => {
    const { chip, core } = setup();
    core.secure = false;
    core.regs.r[1] = SRAM + 0x1000;
    put32(chip, SRAM, 0xe841, 0xf000);
    core.PC = SRAM;
    core.executeInstruction();
    expect(core.regs.r[0] & 0x400000).toBe(0);
  });

  it('MRS/MSR NS aliases round-trip MSP_NS', () => {
    const { chip, core } = setup();
    core.regs.msp_ns = 0x20008000;
    // MRS r0, MSP_NS: SYSm=0x88. hw0=0xf3ef, hw1=0x8088.
    put32(chip, SRAM, 0xf3ef, 0x8088);
    core.PC = SRAM;
    core.executeInstruction();
    expect(core.regs.r[0]).toBe(0x20008000);
    // MSR MSP_NS, r0.
    core.regs.r[0] = 0x20009000;
    put32(chip, SRAM + 4, 0xf380, 0x8888);
    core.PC = SRAM + 4;
    core.executeInstruction();
    expect(core.regs.msp_ns).toBe(0x20009000 & ~3);
  });

  it('NS PPB alias can read CPUID', () => {
    const chip = new RP2350(false, undefined, { coreArch: 'arm' });
    chip.currentCore = 0;
    // NS alias: 0xe002ed00 should return same CPUID as 0xe000ed00.
    expect(chip.readUint32(0xe002ed00)).toBe(0x410fd213);
  });

  it('NS PPB alias can write/read VTOR', () => {
    const chip = new RP2350(false, undefined, { coreArch: 'arm' });
    chip.currentCore = 0;
    chip.writeUint32(0xe002ed08, 0x20001000);
    expect(chip.readUint32(0xe000ed08)).toBe(0x20001000);
  });
});
