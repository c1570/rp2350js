import { describe, expect, it } from 'vitest';
import { RP2350 } from '../rp2350';

const SRAM = 0x20000000;

function setup() {
  const chip = new RP2350({ coreArch: 'arm' });
  const core = chip.armCore0;
  chip.currentCore = 0;
  chip.writeUint32(0xe000ed08, SRAM); // VTOR
  chip.writeUint32(0xe000ed88, 0x00f00000); // CPACR: enable CP10/CP11
  return { chip, core };
}

function put32(chip: RP2350, addr: number, hw0: number, hw1: number) {
  chip.writeUint16(addr, hw0);
  chip.writeUint16(addr + 2, hw1);
}

function f32ToU32(f: number): number {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, f, true);
  return new DataView(buf).getUint32(0, true);
}

function u32ToF32(u: number): number {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setUint32(0, u >>> 0, true);
  return new DataView(buf).getFloat32(0, true);
}

describe('Cortex-M33 FPU (VFPv5-SP)', () => {
  it('VADD.F32 s0 = s1 + s2', () => {
    const { chip, core } = setup();
    core.regs.s[1] = 1.5;
    core.regs.s[2] = 2.5;
    put32(chip, SRAM, 0xee30, 0x0a81); // vadd.f32 s0, s1, s2
    core.PC = SRAM;
    core.executeInstruction();
    expect(core.regs.s[0]).toBeCloseTo(4.0, 6);
  });

  it('VSUB.F32 s0 = s1 - s2', () => {
    const { chip, core } = setup();
    core.regs.s[1] = 5.5;
    core.regs.s[2] = 2.0;
    put32(chip, SRAM, 0xee30, 0x0ac1); // vsub.f32 s0, s1, s2
    core.PC = SRAM;
    core.executeInstruction();
    expect(core.regs.s[0]).toBeCloseTo(3.5, 6);
  });

  it('VMUL.F32 s0 = s1 * s2', () => {
    const { chip, core } = setup();
    core.regs.s[1] = 3.0;
    core.regs.s[2] = 4.0;
    put32(chip, SRAM, 0xee20, 0x0a81); // vmul.f32 s0, s1, s2
    core.PC = SRAM;
    core.executeInstruction();
    expect(core.regs.s[0]).toBeCloseTo(12.0, 6);
  });

  it('VDIV.F32 s0 = s1 / s2', () => {
    const { chip, core } = setup();
    core.regs.s[1] = 10.0;
    core.regs.s[2] = 4.0;
    put32(chip, SRAM, 0xee80, 0x0a81); // vdiv.f32 s0, s1, s2
    core.PC = SRAM;
    core.executeInstruction();
    expect(core.regs.s[0]).toBeCloseTo(2.5, 6);
  });

  it('VSQRT.F32 s0 = sqrt(s1)', () => {
    const { chip, core } = setup();
    core.regs.s[1] = 16.0;
    put32(chip, SRAM, 0xeeb1, 0x0ae0); // vsqrt.f32 s0, s1
    core.PC = SRAM;
    core.executeInstruction();
    expect(core.regs.s[0]).toBeCloseTo(4.0, 6);
  });

  it('VABS.F32 s0 = abs(s1)', () => {
    const { chip, core } = setup();
    core.regs.s[1] = -3.5;
    put32(chip, SRAM, 0xeeb0, 0x0ae0); // vabs.f32 s0, s1
    core.PC = SRAM;
    core.executeInstruction();
    expect(core.regs.s[0]).toBeCloseTo(3.5, 6);
  });

  it('VNEG.F32 s0 = -s1', () => {
    const { chip, core } = setup();
    core.regs.s[1] = 2.25;
    put32(chip, SRAM, 0xeeb1, 0x0a60); // vneg.f32 s0, s1
    core.PC = SRAM;
    core.executeInstruction();
    expect(core.regs.s[0]).toBeCloseTo(-2.25, 6);
  });

  it('VCMP.F32 sets FPSCR NZCV', () => {
    const { chip, core } = setup();
    core.regs.s[0] = 5.0;
    core.regs.s[1] = 3.0;
    put32(chip, SRAM, 0xeeb4, 0x0a60); // vcmp.f32 s0, s1
    core.PC = SRAM;
    core.executeInstruction();
    // 5.0 > 3.0 → N=0 Z=0 C=1 V=0
    expect(core.regs.fpscr & 0x20000000).not.toBe(0); // C=1
    expect(core.regs.fpscr & 0x40000000).toBe(0); // Z=0
  });

  it('VLDR s0, [r1] loads from memory', () => {
    const { chip, core } = setup();
    chip.writeUint32(SRAM + 0x100, f32ToU32(3.14));
    core.regs.r[1] = SRAM + 0x100;
    put32(chip, SRAM, 0xed91, 0x0a00); // vldr s0, [r1]
    core.PC = SRAM;
    core.executeInstruction();
    expect(core.regs.s[0]).toBeCloseTo(3.14, 5);
  });

  it('VSTR s0, [r1] stores to memory', () => {
    const { chip, core } = setup();
    core.regs.s[0] = 2.718;
    core.regs.r[1] = SRAM + 0x100;
    put32(chip, SRAM, 0xed81, 0x0a00); // vstr s0, [r1]
    core.PC = SRAM;
    core.executeInstruction();
    expect(u32ToF32(chip.readUint32(SRAM + 0x100))).toBeCloseTo(2.718, 5);
  });

  it('VMOV s0, r1 transfers ARM to FPU', () => {
    const { chip, core } = setup();
    core.regs.r[1] = f32ToU32(42.5);
    put32(chip, SRAM, 0xee00, 0x1a10); // vmov s0, r1
    core.PC = SRAM;
    core.executeInstruction();
    expect(core.regs.s[0]).toBeCloseTo(42.5, 5);
  });

  it('VMOV r0, s1 transfers FPU to ARM', () => {
    const { chip, core } = setup();
    core.regs.s[1] = 99.0;
    put32(chip, SRAM, 0xee10, 0x0a90); // vmov r0, s1
    core.PC = SRAM;
    core.executeInstruction();
    expect(core.regs.r[0]).toBe(f32ToU32(99.0));
  });

  it('VMRS r0, FPSCR reads FPSCR', () => {
    const { chip, core } = setup();
    core.regs.fpscr = 0x12345678;
    put32(chip, SRAM, 0xeef1, 0x0a10); // vmrs r0, fpscr
    core.PC = SRAM;
    core.executeInstruction();
    expect(core.regs.r[0]).toBe(0x12345678);
  });

  it('VMSR FPSCR, r0 writes FPSCR', () => {
    const { chip, core } = setup();
    core.regs.r[0] = 0xdeadbeef;
    put32(chip, SRAM, 0xeee1, 0x0a10); // vmsr fpscr, r0
    core.PC = SRAM;
    core.executeInstruction();
    expect(core.regs.fpscr).toBe(0xdeadbeef);
  });

  it('VMOV.F32 s0, #1.0 loads immediate', () => {
    const { chip, core } = setup();
    put32(chip, SRAM, 0xeeb7, 0x0a00); // vmov.f32 s0, #1.0
    core.PC = SRAM;
    core.executeInstruction();
    expect(core.regs.s[0]).toBeCloseTo(1.0, 6);
  });

  it('VPUSH {s0} / VPOP {s0} round-trip', () => {
    const { chip, core } = setup();
    core.regs.s[0] = 3.14159;
    core.regs.sp = SRAM + 0x1000;
    core.regs.msp = SRAM + 0x1000;
    put32(chip, SRAM, 0xed2d, 0x0a01); // vpush {s0}
    put32(chip, SRAM + 4, 0xecbd, 0x0a01); // vpop {s0}
    core.PC = SRAM;
    core.executeInstruction(); // vpush
    core.PC = SRAM + 4;
    core.regs.s[0] = 0; // clear before pop
    core.executeInstruction(); // vpop
    expect(core.regs.s[0]).toBeCloseTo(3.14159, 5);
  });

  it('VMOV s0, s1, r3, r0 (MCRR, two ARM → two FP)', () => {
    // vmov s0, s1, r3, r0: hw0=0xec40, hw1=0x3a10
    const { chip, core } = setup();
    core.regs.r[3] = f32ToU32(1.5);
    core.regs.r[0] = f32ToU32(-2.25);
    put32(chip, SRAM, 0xec40, 0x3a10);
    core.PC = SRAM;
    core.executeInstruction();
    expect(core.regs.s[0]).toBeCloseTo(1.5, 6);
    expect(core.regs.s[1]).toBeCloseTo(-2.25, 6);
  });

  it('VMOV r3, r0, s0, s1 (MRRC, two FP → two ARM)', () => {
    // vmov r3, r0, s0, s1: hw0=0xec50, hw1=0x3a10
    const { chip, core } = setup();
    core.regs.s[0] = 3.5;
    core.regs.s[1] = -7.0;
    put32(chip, SRAM, 0xec50, 0x3a10);
    core.PC = SRAM;
    core.executeInstruction();
    expect(u32ToF32(core.regs.r[3])).toBeCloseTo(3.5, 6);
    expect(u32ToF32(core.regs.r[0])).toBeCloseTo(-7.0, 6);
  });

  it('VLDM r3!, {s8, s9, s10} loads 3 S regs from arbitrary base', () => {
    // vldmia r3, {s8, s9, s10}: hw0=0xec93, hw1=0x4a03
    const { chip, core } = setup();
    const base = SRAM + 0x100;
    core.regs.r[3] = base;
    chip.writeUint32(base, f32ToU32(1.0));
    chip.writeUint32(base + 4, f32ToU32(2.0));
    chip.writeUint32(base + 8, f32ToU32(3.0));
    put32(chip, SRAM, 0xec93, 0x4a03);
    core.PC = SRAM;
    core.executeInstruction();
    expect(core.regs.s[8]).toBeCloseTo(1.0, 6);
    expect(core.regs.s[9]).toBeCloseTo(2.0, 6);
    expect(core.regs.s[10]).toBeCloseTo(3.0, 6);
  });

  it('VSTM r3!, {s0, s1} stores 2 S regs to arbitrary base', () => {
    // vstmia r3, {s0, s1}: hw0=0xec80, hw1=0x0a02 (L=0, D=0, Vd=0, imm8=2)
    const { chip, core } = setup();
    const base = SRAM + 0x200;
    core.regs.r[3] = base;
    core.regs.s[0] = 10.5;
    core.regs.s[1] = -20.25;
    put32(chip, SRAM, 0xec83, 0x0a02);
    core.PC = SRAM;
    core.executeInstruction();
    expect(u32ToF32(chip.readUint32(base))).toBeCloseTo(10.5, 6);
    expect(u32ToF32(chip.readUint32(base + 4))).toBeCloseTo(-20.25, 6);
  });

  it('FPU op without CPACR enable triggers NOCP fault', () => {
    const chip = new RP2350({ coreArch: 'arm' });
    const core = chip.armCore0;
    chip.currentCore = 0;
    chip.writeUint32(0xe000ed08, SRAM); // VTOR
    // Set up SP + HardFault vector.
    chip.writeUint32(SRAM + 3 * 4, SRAM + 0x300);
    core.regs.msp = SRAM + 0x2000;
    core.regs.sp = SRAM + 0x2000;
    // CPACR not set — CP10/CP11 disabled.
    core.regs.s[1] = 1.5;
    core.regs.s[2] = 2.5;
    put32(chip, SRAM, 0xee30, 0x0a81); // vadd.f32 s0, s1, s2
    chip.writeUint16(SRAM + 0x300, 0xbf00); // NOP in HardFault handler
    core.PC = SRAM;
    core.executeInstruction();
    expect(chip.readUint32(0xe000ed28) & (1 << 21)).not.toBe(0); // NOCP
  });

  // ---- FPU decode / flag edge cases ----
  describe('FPU decode / flag edge cases', () => {
    it('VMRS APSR_nzcv, FPSCR (Rt=15) copies FPSCR NZCV to APSR', () => {
      const { chip, core } = setup();
      core.regs.fpscr = 0xa0000000; // N=1, Z=0, C=1, V=0
      // VMRS APSR_nzcv, FPSCR: hw0=0xeef1, hw1=(15<<12)|0x0a10 = 0xfa10.
      put32(chip, SRAM, 0xeef1, 0xfa10);
      core.PC = SRAM;
      core.executeInstruction();
      expect(core.regs.xpsr & 0x80000000).not.toBe(0); // N set
      expect(core.regs.xpsr & 0x20000000).not.toBe(0); // C set
      expect(core.regs.xpsr & 0x40000000).toBe(0); // Z clear
    });
    it('VMSR FPSCR, R1 (Rt=1, non-zero) writes FPSCR', () => {
      const { chip, core } = setup();
      core.regs.r[1] = 0xdeadbeef;
      // VMSR FPSCR, R1: hw0=0xeee1, hw1=(1<<12)|0x0a10 = 0x1a10.
      put32(chip, SRAM, 0xeee1, 0x1a10);
      core.PC = SRAM;
      core.executeInstruction();
      expect(core.regs.fpscr).toBe(0xdeadbeef);
    });

    it('VSTR S0, [R9, #4] uses the U bit, not Rn bit3', () => {
      // Rn=9 (bit3=1) + U=1 + imm8=4 → offset +16.
      const { chip, core } = setup();
      core.regs.s[0] = 2.718;
      core.regs.r[9] = SRAM + 0x100;
      // VSTR S0,[R9,#4]: P=1,U=1,W=0,L=0,D=0,Rn=9 → hw0=0xed89, hw1=0x0a04.
      put32(chip, SRAM, 0xed89, 0x0a04);
      core.PC = SRAM;
      core.executeInstruction();
      expect(u32ToF32(chip.readUint32(SRAM + 0x110))).toBeCloseTo(2.718, 5);
      // Ensure the subtract target (R9-16) was NOT written.
      expect(u32ToF32(chip.readUint32(SRAM + 0x100 - 16))).not.toBeCloseTo(2.718, 5);
    });
    it('VSTR S0, [R1, #-8] decodes the U=0 (subtract) form', () => {
      const { chip, core } = setup();
      core.regs.s[0] = 1.5;
      core.regs.r[1] = SRAM + 0x100;
      // VSTR S0,[R1,#-8]: P=1,U=0,W=0,L=0 → hw0=0xed01, hw1=0x0a02 (imm8=2→off 8).
      put32(chip, SRAM, 0xed01, 0x0a02);
      core.PC = SRAM;
      core.executeInstruction();
      expect(u32ToF32(chip.readUint32(SRAM + 0x100 - 8))).toBeCloseTo(1.5, 5);
    });
    it('VLDR S1, [R1] decodes an odd-numbered Sd (D=1)', () => {
      const { chip, core } = setup();
      chip.writeUint32(SRAM + 0x100, f32ToU32(3.14));
      core.regs.r[1] = SRAM + 0x100;
      // VLDR S1,[R1]: D=1 → hw0=0xed91|0x40=0xedd1, hw1=0x0a00.
      put32(chip, SRAM, 0xedd1, 0x0a00);
      core.PC = SRAM;
      core.executeInstruction();
      expect(core.regs.s[1]).toBeCloseTo(3.14, 5);
    });

    it('VMOV S2, R0 (Vn=1, non-zero) writes S2', () => {
      const { chip, core } = setup();
      core.regs.r[0] = f32ToU32(42.5);
      // VMOV S2, R0: Vn=1 (S2=(1<<1)|0), L=0 → hw0=0xee01, hw1=0x0a10.
      put32(chip, SRAM, 0xee01, 0x0a10);
      core.PC = SRAM;
      core.executeInstruction();
      expect(core.regs.s[2]).toBeCloseTo(42.5, 5);
    });
    it('VMOV R0, S3 (Vn=1,N=1) reads S3', () => {
      const { chip, core } = setup();
      core.regs.s[3] = 7.25;
      // VMOV R0, S3: Vn=1, N=1, L=1 → hw0=0xee11, hw1=0x0a90.
      put32(chip, SRAM, 0xee11, 0x0a90);
      core.PC = SRAM;
      core.executeInstruction();
      expect(core.regs.r[0]).toBe(f32ToU32(7.25));
    });

    it('VNMUL.F32 s0 = -(s1 * s2) negates the product', () => {
      const { chip, core } = setup();
      core.regs.s[1] = 2.0;
      core.regs.s[2] = 3.0;
      // VNMUL: opc1=2, hw1[6]=1 → hw0=0xee20, hw1=0x0a81|0x40=0x0ac1.
      put32(chip, SRAM, 0xee20, 0x0ac1);
      core.PC = SRAM;
      core.executeInstruction();
      expect(core.regs.s[0]).toBeCloseTo(-6.0, 6);
    });

    it('VCMP with NaN sets C=1 (unordered)', () => {
      const { chip, core } = setup();
      core.regs.s[0] = 5.0;
      core.regs.s[1] = NaN;
      // vcmp.f32 s0, s1: hw0=0xeeb4, hw1=0x0a60.
      put32(chip, SRAM, 0xeeb4, 0x0a60);
      core.PC = SRAM;
      core.executeInstruction();
      // Unordered: N=0 Z=0 C=1 V=1.
      expect(core.regs.fpscr & 0x20000000).not.toBe(0); // C=1
      expect(core.regs.fpscr & 0x10000000).not.toBe(0); // V=1
      expect(core.regs.fpscr & 0x40000000).toBe(0); // Z=0
    });

    it('VDIV -1.0/0.0 = -Infinity (div-by-zero sign)', () => {
      const { chip, core } = setup();
      core.regs.s[1] = -1.0;
      core.regs.s[2] = 0.0;
      // vdiv.f32 s0, s1, s2: hw0=0xee80, hw1=0x0a81.
      put32(chip, SRAM, 0xee80, 0x0a81);
      core.PC = SRAM;
      core.executeInstruction();
      expect(core.regs.s[0]).toBe(-Infinity);
    });

    it('VDIV 1.0/-0.0 = -Infinity', () => {
      const { chip, core } = setup();
      core.regs.s[1] = 1.0;
      core.regs.s[2] = -0.0;
      put32(chip, SRAM, 0xee80, 0x0a81);
      core.PC = SRAM;
      core.executeInstruction();
      expect(Object.is(core.regs.s[0], -Infinity)).toBe(true);
    });

    it('FZ=1 flushes positive denormal input to +0 and sets IDC', () => {
      const { chip, core } = setup();
      // Enable FZ (bit 8 of FPSCR).
      core.regs.fpscr = 0x100;
      // Load a positive denormal into s1; VADD s0,s1,s2 (s2=0) will trigger
      // checkInput on s1. Denormal: exp=0, frac=1 → 2^-149 ≈ 1.4e-45.
      const dnBuf = new ArrayBuffer(4);
      new DataView(dnBuf).setUint32(0, 0x00000001, true);
      core.regs.s[1] = new DataView(dnBuf).getFloat32(0, true);
      core.regs.s[2] = 0.0;
      put32(chip, SRAM, 0xee30, 0x0a81); // vadd.f32 s0, s1, s2
      core.PC = SRAM;
      core.executeInstruction();
      expect(core.regs.s[0]).toBe(0); // flushed to +0, not left denormal
      expect(core.regs.fpscr & 0x80).not.toBe(0); // IDC set
    });

    it('FZ=1 flushes negative denormal to -0 preserving sign', () => {
      const { chip, core } = setup();
      core.regs.fpscr = 0x100;
      const dnBuf = new ArrayBuffer(4);
      new DataView(dnBuf).setUint32(0, 0x80000001, true); // negative denormal
      core.regs.s[1] = new DataView(dnBuf).getFloat32(0, true);
      core.regs.s[2] = 1.0;
      // VMUL s0,s1,s2: -0 * 1.0 = -0 (distinguishes -0 from +0).
      put32(chip, SRAM, 0xee20, 0x0a81); // vmul.f32 s0, s1, s2
      core.PC = SRAM;
      core.executeInstruction();
      // Must be -0 (sign preserved), not +0.
      expect(Object.is(core.regs.s[0], -0)).toBe(true);
    });

    it('IDC set on denormal input even when FZ=0', () => {
      const { chip, core } = setup();
      core.regs.fpscr = 0; // FZ=0
      const dnBuf = new ArrayBuffer(4);
      new DataView(dnBuf).setUint32(0, 0x00000001, true);
      core.regs.s[1] = new DataView(dnBuf).getFloat32(0, true);
      core.regs.s[2] = 0.0;
      put32(chip, SRAM, 0xee30, 0x0a81); // vadd.f32 s0, s1, s2
      core.PC = SRAM;
      core.executeInstruction();
      expect(core.regs.fpscr & 0x80).not.toBe(0); // IDC set even without FZ
    });
  });

  describe('VCVT (int <-> float) and the D-bit group-detection regression', () => {
    // Covers the unary/misc FP group (VABS/VNEG/VSQRT/VMOV/VCMP/VCVT) D-bit
    // masking: dispatch must mask out hw0 bit6 (the D bit, part of Sd's
    // encoding) rather than compare the raw `((hw0>>>4)&0xf)===0xb` nibble,
    // which only matches when Sd is even (D=0) and misses every odd-Sd
    // destination (s1, s3, ..., s15). Encodings verified against
    // `arm-none-eabi-as -march=armv8-m.main+fp`.

    it('VCVT.F32.U32 s0, s0 converts an unsigned int bit pattern to float', () => {
      const { chip, core } = setup();
      core.regs.s[0] = u32ToF32(7); // Sm holds int 7, bit-reinterpreted
      put32(chip, SRAM, 0xeeb8, 0x0a40); // vcvt.f32.u32 s0, s0
      core.PC = SRAM;
      core.executeInstruction();
      expect(core.regs.s[0]).toBeCloseTo(7.0, 6);
    });

    it('VCVT.F32.S32 s0, s0 converts a signed int bit pattern to float', () => {
      const { chip, core } = setup();
      core.regs.s[0] = u32ToF32(-3 >>> 0); // Sm holds int -3, bit-reinterpreted
      put32(chip, SRAM, 0xeeb8, 0x0ac0); // vcvt.f32.s32 s0, s0
      core.PC = SRAM;
      core.executeInstruction();
      expect(core.regs.s[0]).toBeCloseTo(-3.0, 6);
    });

    it('VCVT.U32.F32 s0, s0 converts a float to an unsigned int bit pattern', () => {
      const { chip, core } = setup();
      core.regs.s[0] = 7.0;
      put32(chip, SRAM, 0xeebc, 0x0ac0); // vcvt.u32.f32 s0, s0
      core.PC = SRAM;
      core.executeInstruction();
      expect(f32ToU32(core.regs.s[0])).toBe(7);
    });

    it('VCVT.S32.F32 s0, s0 converts a float to a signed int bit pattern, truncating toward zero', () => {
      const { chip, core } = setup();
      core.regs.s[0] = -3.7;
      put32(chip, SRAM, 0xeebd, 0x0ac0); // vcvt.s32.f32 s0, s0
      core.PC = SRAM;
      core.executeInstruction();
      expect(f32ToU32(core.regs.s[0]) | 0).toBe(-3);
    });

    it('VCVT.S32.F32 saturates and sets IOC on overflow instead of wrapping', () => {
      const { chip, core } = setup();
      core.regs.s[0] = 1e20; // way out of int32 range
      put32(chip, SRAM, 0xeebd, 0x0ac0); // vcvt.s32.f32 s0, s0
      core.PC = SRAM;
      core.executeInstruction();
      expect(f32ToU32(core.regs.s[0]) | 0).toBe(0x7fffffff);
      expect(core.regs.fpscr & 0x1).not.toBe(0); // IOC set
    });

    it('VCVT.U32.F32 s15, s15 (odd Sd/Sm — the exact instruction MicroPython executes for float literals)', () => {
      // vcvt.u32.f32 s15, s15 = 0xeefc 0x7ae7 — exercises the D-bit masking
      // above with an odd Sd/Sm (s15).
      const { chip, core } = setup();
      core.regs.s[15] = 10.0;
      put32(chip, SRAM, 0xeefc, 0x7ae7);
      core.PC = SRAM;
      core.executeInstruction();
      expect(f32ToU32(core.regs.s[15])).toBe(10);
    });

    it('VABS.F32 s15, s15 (odd Sd — same D-bit group-detection bug, non-VCVT op)', () => {
      // vabs.f32 s15, s15 = 0xeef0 0x7ae7 (verified against `arm-none-eabi-as`).
      const { chip, core } = setup();
      core.regs.s[15] = -4.5;
      put32(chip, SRAM, 0xeef0, 0x7ae7);
      core.PC = SRAM;
      core.executeInstruction();
      expect(core.regs.s[15]).toBeCloseTo(4.5, 6);
    });

    it('VCMP.F32 Sd, #0.0 compares against an immediate zero (opc3=5, not the register form)', () => {
      // vcmp.f32 s15, #0.0 = 0xeef5 0x7a40 — the immediate-zero form
      // (opc3=5), distinct from the register-register VCMP form (opc3=4).
      const { chip, core } = setup();
      core.regs.s[15] = -2.5;
      put32(chip, SRAM, 0xeef5, 0x7a40);
      core.PC = SRAM;
      core.executeInstruction();
      // -2.5 < 0.0 → N=1 Z=0 C=0 V=0
      expect(core.regs.fpscr & 0x80000000).not.toBe(0); // N=1
      expect(core.regs.fpscr & 0x40000000).toBe(0); // Z=0
    });

    it('VCMP.F32 Sd, #0.0 with Sd=0.0 sets Z=1', () => {
      const { chip, core } = setup();
      core.regs.s[0] = 0.0;
      put32(chip, SRAM, 0xeeb5, 0x0a40); // vcmp.f32 s0, #0.0
      core.PC = SRAM;
      core.executeInstruction();
      expect(core.regs.fpscr & 0x40000000).not.toBe(0); // Z=1
    });

    it('VDIV.F32 s15, s16, s14 (odd Sd — same D-bit leak, this time in the 3-register dispatch)', () => {
      // vdiv.f32 s15, s16, s14 = 0xeec8 0x7a07 — with Sd odd (D=1), the naive
      // `(hw0>>>4)&0xf` extraction folds the D bit into opc1 (0b1000 VDIV ->
      // 0b1100), missing the whole three-register arithmetic dispatch
      // (VADD/VSUB/VMUL/VDIV) for any odd destination register.
      const { chip, core } = setup();
      core.regs.s[16] = 10.0;
      core.regs.s[14] = 4.0;
      put32(chip, SRAM, 0xeec8, 0x7a07);
      core.PC = SRAM;
      core.executeInstruction();
      expect(core.regs.s[15]).toBeCloseTo(2.5, 6);
    });
  });

  describe('VFMA/VFMS/VFNMA/VFNMS (fused multiply-add family)', () => {
    // All encodings verified against `arm-none-eabi-as -march=armv8-m.main+fp`.
    it('VFMA.F32 s0, s1, s2: Sd = Sd + Sn*Sm', () => {
      const { chip, core } = setup();
      core.regs.s[0] = 1.0;
      core.regs.s[1] = 3.0;
      core.regs.s[2] = 4.0;
      put32(chip, SRAM, 0xeea0, 0x0a81); // vfma.f32 s0, s1, s2
      core.PC = SRAM;
      core.executeInstruction();
      expect(core.regs.s[0]).toBeCloseTo(1.0 + 3.0 * 4.0, 6);
    });

    it('VFMS.F32 s0, s1, s2: Sd = Sd - Sn*Sm', () => {
      const { chip, core } = setup();
      core.regs.s[0] = 20.0;
      core.regs.s[1] = 3.0;
      core.regs.s[2] = 4.0;
      put32(chip, SRAM, 0xeea0, 0x0ac1); // vfms.f32 s0, s1, s2
      core.PC = SRAM;
      core.executeInstruction();
      expect(core.regs.s[0]).toBeCloseTo(20.0 - 3.0 * 4.0, 6);
    });

    it('VFNMA.F32 s0, s1, s2: Sd = -Sd - Sn*Sm', () => {
      const { chip, core } = setup();
      core.regs.s[0] = 1.0;
      core.regs.s[1] = 3.0;
      core.regs.s[2] = 4.0;
      put32(chip, SRAM, 0xee90, 0x0ac1); // vfnma.f32 s0, s1, s2
      core.PC = SRAM;
      core.executeInstruction();
      expect(core.regs.s[0]).toBeCloseTo(-1.0 - 3.0 * 4.0, 6);
    });

    it('VFNMS.F32 s0, s1, s2: Sd = -Sd + Sn*Sm', () => {
      const { chip, core } = setup();
      core.regs.s[0] = 1.0;
      core.regs.s[1] = 3.0;
      core.regs.s[2] = 4.0;
      put32(chip, SRAM, 0xee90, 0x0a81); // vfnms.f32 s0, s1, s2
      core.PC = SRAM;
      core.executeInstruction();
      expect(core.regs.s[0]).toBeCloseTo(-1.0 + 3.0 * 4.0, 6);
    });

    it('VFMS.F32 s14, s11, s15 (odd Sn/Sm, the exact instruction that crashed parsing a float literal)', () => {
      // vfms.f32 s14, s11, s15 = 0xeea5 0x7ae7 — Sd=s14 is even here, so this
      // exercises the FMA family's own dispatch (VFMA/VFMS/VFNMA/VFNMS)
      // rather than the D-bit masking covered above.
      const { chip, core } = setup();
      core.regs.s[14] = 20.0;
      core.regs.s[11] = 3.0;
      core.regs.s[15] = 4.0;
      put32(chip, SRAM, 0xeea5, 0x7ae7);
      core.PC = SRAM;
      core.executeInstruction();
      expect(core.regs.s[14]).toBeCloseTo(20.0 - 3.0 * 4.0, 6);
    });

    it('VFMA.F32 with an odd Sd also dispatches correctly (D-bit masking applies here too)', () => {
      // vfma.f32 s15, s11, s10 = 0xeee5 0x7a85.
      const { chip, core } = setup();
      core.regs.s[15] = 1.0;
      core.regs.s[11] = 3.0;
      core.regs.s[10] = 4.0;
      put32(chip, SRAM, 0xeee5, 0x7a85);
      core.PC = SRAM;
      core.executeInstruction();
      expect(core.regs.s[15]).toBeCloseTo(1.0 + 3.0 * 4.0, 6);
    });

    it('fused multiply-add avoids intermediate rounding (single rounding step)', () => {
      // Choose a*b whose exact double-precision product is NOT exactly
      // representable in float32, so a naive "round the product, then add"
      // implementation would disagree with the true single-rounded result.
      const { chip, core } = setup();
      const a = Math.fround(16777217 / 3); // an odd float32 mantissa pattern
      const b = Math.fround(3);
      core.regs.s[0] = 0;
      core.regs.s[1] = a;
      core.regs.s[2] = b;
      put32(chip, SRAM, 0xeea0, 0x0a81); // vfma.f32 s0, s1, s2
      core.PC = SRAM;
      core.executeInstruction();
      // The fused result rounds (0 + a*b) once, from the exact double product.
      expect(core.regs.s[0]).toBe(Math.fround(0 + a * b));
    });
  });
});
