/**
 * Thumb-32 instruction tests.
 */

import { describe, expect, it } from 'vitest';
import { RP2350 } from '../rp2350';
import { CortexM33Core } from './core';

const SRAM = 0x20000000;

function setup(pc: number = SRAM): { chip: RP2350; core: CortexM33Core } {
  const chip = new RP2350(false, undefined, { coreArch: 'arm' });
  const core = chip.armCore0;
  core.stopped = false;
  core.PC = pc;
  return { chip, core };
}

function putInsn32(chip: RP2350, addr: number, hw0: number, hw1: number) {
  chip.writeUint16(addr, hw0 & 0xffff);
  chip.writeUint16(addr + 2, hw1 & 0xffff);
}

function step32(
  hw0: number,
  hw1: number,
  opts?: { r0?: number; r1?: number; r2?: number; r3?: number; r4?: number }
) {
  const { chip, core } = setup();
  if (opts?.r0 !== undefined) core.regs.r[0] = opts.r0 >>> 0;
  if (opts?.r1 !== undefined) core.regs.r[1] = opts.r1 >>> 0;
  if (opts?.r2 !== undefined) core.regs.r[2] = opts.r2 >>> 0;
  if (opts?.r3 !== undefined) core.regs.r[3] = opts.r3 >>> 0;
  if (opts?.r4 !== undefined) core.regs.r[4] = opts.r4 >>> 0;
  putInsn32(chip, SRAM, hw0, hw1);
  // Pad with NOPs.
  chip.writeUint16(SRAM + 4, 0xbf00);
  chip.writeUint16(SRAM + 6, 0xbf00);
  core.executeInstruction();
  return {
    r0: core.regs.r[0],
    r1: core.regs.r[1],
    r2: core.regs.r[2],
    r3: core.regs.r[3],
    r4: core.regs.r[4],
    lr: core.regs.lr,
    pc: core.regs.pc,
    N: core.regs.N,
    Z: core.regs.Z,
  };
}

describe('Cortex-M33 Thumb-32 instructions', () => {
  describe('Plain immediate data processing', () => {
    it('MOVW r0, #0x1234', () => {
      // MOVW T3 encoding: 11110 i 10 0100 imm4 | 0 imm3 Rd imm8
      // For value 0x1234: imm16=0x1234, i=0 (high bit), imm4=0x1, imm3=0x2, Rd=0, imm8=0x34.
      // hw0 = 0xf240 | (i<<10) | imm4 = 0xf240 | 0x1 = 0xf241.
      // hw1 = (imm3 << 12) | (Rd << 8) | imm8 = (2 << 12) | 0 | 0x34 = 0x2034.
      const r = step32(0xf241, 0x2034);
      expect(r.r0).toBe(0x1234);
    });
    it('MOVT r0, #0x5678 (after MOVW)', () => {
      const { chip, core } = setup();
      core.regs.r[0] = 0x9abc;
      // MOVT r0, #0x5678 → f2c5 6078 per assembler.
      putInsn32(chip, SRAM, 0xf2c5, 0x6078);
      chip.writeUint16(SRAM + 4, 0xbf00);
      core.executeInstruction();
      expect(core.regs.r[0]).toBe(((0x5678 << 16) | 0x9abc) >>> 0);
    });
    it('ADDW r0, r1, #0x123', () => {
      // ADD.W Rd, Rn, #imm12 (T4): hw0 = 0xf200 | rn, hw1 = (imm3<<12) |
      // (Rd<<8) | imm8, imm12 = imm3:imm8. For #0x123: imm3=0x1, imm8=0x23.
      // hw0 = 0xf201 (rn=r1). hw1 = 0x1023 (Rd=0, imm3=1, imm8=0x23).
      const r = step32(0xf201, 0x1023, { r1: 0x100 });
      expect(r.r0).toBe(0x223);
    });
    it('SUBW r0, r1, #0x10', () => {
      // SUB.W T4: hw0 = 0xf2a0 | rn, hw1 = (imm3<<12) | (Rd<<8) | imm8.
      // imm = 0x10 = imm3=0, imm8=0x10.
      const r = step32(0xf2a1, 0x0010, { r1: 0x100 });
      expect(r.r0).toBe(0xf0);
    });
  });

  describe('Modified immediate DP', () => {
    it('MOV.W r0, #0x42 (modified imm)', () => {
      // MOV (immediate) T2: 11110 op S 00010 1111 | 0 imm3 Rd imm8.
      // For S=0, value 0x42: hw0 = 0xf04f (S=0, op=0), hw1 = 0x0042 (Rd=0, imm8=0x42).
      const r = step32(0xf04f, 0x0042);
      expect(r.r0).toBe(0x42);
    });
    it('ADD.W r0, r1, #0xff (modified imm with ThumbExpandImm)', () => {
      // ADD (immediate) T3: 11110 0 S 0101 0 Rn | 0 imm3 Rd imm8.
      // For Rn=r1, Rd=r0, imm=0xff (encodes as 0x4ff per ThumbExpandImm):
      // Actually 0xff is just imm8=0xff with imm3=0.
      // hw0 = 0xf101 (S=0, op2=0b0101, rn=1). hw1 = 0x00ff (Rd=0, imm8=0xff).
      const r = step32(0xf101, 0x00ff, { r1: 1 });
      expect(r.r0).toBe(0x100);
    });

    it('ADD.W r0, r1, #8 (S=0) does not clobber flags set by a preceding CMP', () => {
      // addSubFlags (used for ADD/ADC/SBC/SUB/RSB in the modified-immediate
      // DP dispatcher) must respect the instruction's own S bit rather than
      // writing NZCV unconditionally — an S=0 ADD.W must not disturb flags a
      // preceding CMP set for a later conditional branch to test.
      // hw0=0xf101 (S=0, op=ADD, rn=1), hw1=0x0008 (Rd=0, imm8=8).
      const { chip, core } = setup();
      core.regs.r[1] = 4;
      core.regs.Z = true;
      core.regs.N = false;
      core.regs.C = true;
      core.regs.V = false;
      putInsn32(chip, SRAM, 0xf101, 0x0008);
      core.executeInstruction();
      expect(core.regs.r[0]).toBe(12);
      expect(core.regs.Z).toBe(true);
      expect(core.regs.N).toBe(false);
      expect(core.regs.C).toBe(true);
      expect(core.regs.V).toBe(false);
    });
  });

  describe('Multiply / divide', () => {
    it('MUL.W r0, r1, r2', () => {
      // MUL T2: 11111 01 0000 Rn | 1111 0000 Rd Rm.
      // hw0 = 0xfb00 | rn=1 → 0xfb01. hw1 = (0xf << 12) | (rd << 8) | rm=2 → 0xf002.
      const r = step32(0xfb01, 0xf002, { r1: 6, r2: 7 });
      expect(r.r0).toBe(42);
    });
    it('MLA r0, r1, r2, r3', () => {
      // MLA: 11111 01 0000 Rn | Ra Rd Rm.
      // hw0 = 0xfb00 | rn=1 → 0xfb01. hw1 = (ra=3 << 12) | (rd=0 << 8) | rm=2 → 0x3002.
      const r = step32(0xfb01, 0x3002, { r1: 6, r2: 7, r3: 100 });
      expect(r.r0).toBe(142);
    });
    it('MLS r0, r1, r2, r3 = Ra - Rn*Rm', () => {
      // MLS: 11111 01 0000 Rn | Ra Rd 0001 Rm (op2[1:0]=01 discriminates MLS).
      // hw0 = 0xfb01. hw1 = (ra=3 << 12) | (rd=0 << 8) | (0001 << 4) | rm=2 = 0x3012.
      const r = step32(0xfb01, 0x3012, { r1: 6, r2: 7, r3: 100 });
      expect(r.r0).toBe(58); // 100 - 42
    });
    it('UDIV r0, r1, r2', () => {
      // Per assembler: fbb1 f0f2.
      const r = step32(0xfbb1, 0xf0f2, { r1: 20, r2: 4 });
      expect(r.r0).toBe(5);
    });
    it('UDIV by zero returns 0 (ARMv8-M, no DIV_0_TRP)', () => {
      const r = step32(0xfbb1, 0xf0f2, { r1: 20, r2: 0 });
      expect(r.r0).toBe(0);
    });
    it('SDIV r0, r1, r2', () => {
      // SDIV: 11111 01 1001 Rn | 1111 Rd Rm → fb91 f002.
      const r = step32(0xfb91, 0xf002, { r1: -20 >>> 0, r2: 4 });
      expect(r.r0).toBe(-5 >>> 0);
    });
    it('SDIV by zero returns 0', () => {
      const r = step32(0xfb91, 0xf002, { r1: -20 >>> 0, r2: 0 });
      expect(r.r0).toBe(0);
    });
    it('SMULL r0, r1, r2, r3', () => {
      // SMULL: 11111 01 1000 Rn | RdLo RdHi 0000 Rm.
      // hw0 = 0xfb82, hw1 = (0<<12)|(1<<8)|3 = 0x0103. r2*r3 → r1:r0.
      const r = step32(0xfb82, 0x0103, { r2: 0x10000, r3: 0x10000 });
      expect(r.r0).toBe(0); // lo32 of 0x1_0000_0000
      expect(r.r1).toBe(1); // hi32
    });
    it('SMULL with negative operands is sign-correct', () => {
      const r = step32(0xfb82, 0x0103, { r2: 2, r3: -3 >>> 0 });
      // product = -6 = 0xFFFF_FFFF_FFFF_FFFA
      expect(r.r0).toBe(0xfffffffa >>> 0);
      expect(r.r1).toBe(0xffffffff >>> 0);
    });
    it('UMULL r0, r1, r2, r3', () => {
      // UMULL: 11111 01 1010 Rn | RdLo RdHi 0000 Rm. hw0 = 0xfba2.
      const r = step32(0xfba2, 0x0103, { r2: 0x10000, r3: 0x10000 });
      expect(r.r0).toBe(0);
      expect(r.r1).toBe(1);
    });
    it('SMLAL r0, r1, r2, r3 accumulates', () => {
      // SMLAL: 11111 01 1100 Rn | RdLo RdHi 0000 Rm. hw0 = 0xfbc2.
      const r = step32(0xfbc2, 0x0103, { r0: 10, r1: 0, r2: 3, r3: 4 });
      expect(r.r0).toBe(22); // 10 + 12
      expect(r.r1).toBe(0);
    });
    it('UMLAL r0, r1, r2, r3 accumulates', () => {
      // UMLAL: 11111 01 1110 Rn | RdLo RdHi 0000 Rm. hw0 = 0xfbe2.
      const r = step32(0xfbe2, 0x0103, { r0: 5, r1: 0, r2: 2, r3: 3 });
      expect(r.r0).toBe(11); // 5 + 6
      expect(r.r1).toBe(0);
    });
  });

  describe('SMULxy/SMLAxy (DSP extension, halfword signed multiply)', () => {
    // All encodings verified against `arm-none-eabi-as -march=armv8-m.main+dsp`.
    it('SMULBB r0, r1, r2 multiplies the bottom halfwords', () => {
      // smulbb r0, r1, r2 = 0xfb11 0xf002.
      const r = step32(0xfb11, 0xf002, { r1: 0x00050002, r2: 0x00030004 });
      expect(r.r0).toBe(2 * 4);
    });

    it('SMULBT r0, r1, r2 multiplies Rn bottom by Rm top', () => {
      // smulbt r0, r1, r2 = 0xfb11 0xf012.
      const r = step32(0xfb11, 0xf012, { r1: 0x00050002, r2: 0x00030004 });
      expect(r.r0).toBe(2 * 3);
    });

    it('SMULTB r0, r1, r2 multiplies Rn top by Rm bottom', () => {
      // smultb r0, r1, r2 = 0xfb11 0xf022.
      const r = step32(0xfb11, 0xf022, { r1: 0x00050002, r2: 0x00030004 });
      expect(r.r0).toBe(5 * 4);
    });

    it('SMULTT r0, r1, r2 multiplies the top halfwords', () => {
      // smultt r0, r1, r2 = 0xfb11 0xf032.
      const r = step32(0xfb11, 0xf032, { r1: 0x00050002, r2: 0x00030004 });
      expect(r.r0).toBe(5 * 3);
    });

    it('SMULTB treats the selected halfword as signed', () => {
      // Rn top halfword = 0xffff (-1 signed), Rm bottom halfword = 3.
      const r = step32(0xfb11, 0xf022, { r1: 0xffff0002, r2: 0x00000003 });
      expect(r.r0).toBe(-3 >>> 0);
    });

    it('SMLABB r0, r1, r2, r3 accumulates into Ra', () => {
      // smlabb r0, r1, r2, r3 = 0xfb11 0x3002.
      const r = step32(0xfb11, 0x3002, { r1: 2, r2: 4, r3: 100 });
      expect(r.r0).toBe(100 + 2 * 4);
    });

    it('SMLABB sets Q (sticky overflow) on signed 32-bit overflow, SMULBB does not', () => {
      const { chip, core } = setup();
      core.regs.r[1] = 1;
      core.regs.r[2] = 1;
      core.regs.r[3] = 0x7fffffff;
      putInsn32(chip, SRAM, 0xfb11, 0x3002); // smlabb r0, r1, r2, r3
      core.executeInstruction();
      expect(core.regs.r[0]).toBe(0x80000000 >>> 0);
      expect(core.regs.Q).toBe(true);
    });

    it('SMULBB sl, sl, fp (real register numbers, as seen in MicroPython)', () => {
      // smulbb sl, sl, fp = 0xfb1a 0xfa0b — the exact instruction previously
      // reported as "Unimplemented Thumb-32 instruction" while parsing a
      // float literal at the real MicroPython REPL.
      const { chip, core } = setup();
      core.regs.r[10] = 6; // sl
      core.regs.r[11] = 7; // fp
      putInsn32(chip, SRAM, 0xfb1a, 0xfa0b);
      core.executeInstruction();
      expect(core.regs.r[10]).toBe(42);
    });
  });

  describe('Wide load/store', () => {
    it('LDR.W r0, [r1, #0x4]', () => {
      const { chip, core } = setup();
      chip.writeUint32(SRAM + 0x100, 0xdeadbeef);
      core.regs.r[1] = SRAM + 0x100 - 4;
      // LDR.W: hw0 = 0xf8d0 | rn=1 → 0xf8d1. hw1 = (rt=0 << 12) | imm12=4 → 0x0004.
      putInsn32(chip, SRAM, 0xf8d1, 0x0004);
      core.executeInstruction();
      expect(core.regs.r[0]).toBe(0xdeadbeef >>> 0);
    });
    it('STR.W r0, [r1, #0x4] round-trips', () => {
      const { chip, core } = setup();
      core.regs.r[0] = 0x12345678;
      core.regs.r[1] = SRAM + 0x100;
      putInsn32(chip, SRAM, 0xf8c1, 0x0004); // STR.W r0, [r1, #4]
      core.executeInstruction();
      expect(chip.readUint32(SRAM + 0x104)).toBe(0x12345678);
    });
    it('LDRD r0, r1, [r2, #0]', () => {
      // Per assembler: e9d2 0100 (LDRD Rt, Rt2, [Rn]).
      const { chip, core } = setup();
      chip.writeUint32(SRAM + 0x100, 0xaaaaaaaa);
      chip.writeUint32(SRAM + 0x104, 0xbbbbbbbb);
      core.regs.r[2] = SRAM + 0x100;
      putInsn32(chip, SRAM, 0xe9d2, 0x0100);
      core.executeInstruction();
      expect(core.regs.r[0]).toBe(0xaaaaaaaa);
      expect(core.regs.r[1]).toBe(0xbbbbbbbb >>> 0);
    });
    it('LDRD r0, r1, [r2, #8] scales offset by 4 (imm8<<2)', () => {
      // LDRD with imm8=2 must access base+8, not base+2.
      // hw0=0xe9d2 (P=1,U=1,W=0,L=1,rn=2), hw1=(0<<12)|(1<<8)|imm8=2 = 0x0102.
      const { chip, core } = setup();
      chip.writeUint32(SRAM + 0x108, 0x11112222);
      chip.writeUint32(SRAM + 0x10c, 0x33334444);
      core.regs.r[2] = SRAM + 0x100;
      putInsn32(chip, SRAM, 0xe9d2, 0x0102);
      core.executeInstruction();
      expect(core.regs.r[0]).toBe(0x11112222);
      expect(core.regs.r[1]).toBe(0x33334444 >>> 0);
      // No writeback (W=0): r2 unchanged.
      expect(core.regs.r[2]).toBe((SRAM + 0x100) >>> 0);
    });
    it('LDRD throws on an unaligned base address (real hardware faults)', () => {
      // LDRD/STRD only support word-aligned accesses and fault otherwise
      // (RP2350 datasheet / ARMv8-M ARM §B8.3) — unlike LDR/STR singles.
      const { chip, core } = setup();
      core.regs.r[2] = SRAM + 0x101; // not 4-byte aligned
      putInsn32(chip, SRAM, 0xe9d2, 0x0100); // LDRD r0, r1, [r2, #0]
      expect(() => core.executeInstruction()).toThrow(/not.*32 bit aligned|unaligned/i);
    });
    it('STRD r0, r1, [r2, #-8] uses the U bit for subtract', () => {
      // STRD with U=0 (negative offset). hw0 with bit7 cleared: 0xe9d2 → U=0 is
      // 0xe952? No: bit7 of 0xe9d2 is 1; clearing it and setting L=0 (store):
      // bits7:4 = 0100 → hw0 = 0xe942 (P=1,U=0,W=0,L=0,rn=2).
      const { chip, core } = setup();
      core.regs.r[0] = 0xdeadbeef;
      core.regs.r[1] = 0xcafebabe;
      core.regs.r[2] = SRAM + 0x108; // base; offset -8 → SRAM+0x100
      putInsn32(chip, SRAM, 0xe942, 0x0102); // imm8=2 → offset = 8, U=0 → subtract
      core.executeInstruction();
      expect(chip.readUint32(SRAM + 0x100)).toBe(0xdeadbeef >>> 0);
      expect(chip.readUint32(SRAM + 0x104)).toBe(0xcafebabe >>> 0);
    });

    it('LDR.W r0, [r1], #+4 (T4 post-indexed writeback)', () => {
      const { chip, core } = setup();
      chip.writeUint32(SRAM + 0x100, 0xcafef00d);
      core.regs.r[1] = SRAM + 0x100;
      // LDR.W T4: hw0 = 0xf850 | r1 = 0xf851. Post-indexed: P=0, U=1, W=1.
      // hw1 bit layout: [15:12]=Rt, [11]=1(fixed, selects imm PUW form),
      // [10]=P, [9]=U, [8]=W, [7:0]=imm8 (post-indexed always has W=1).
      // hw1 = (0<<12) | (1<<11) | (0<<10) | (1<<9) | (1<<8) | 4 = 0x0b04.
      putInsn32(chip, SRAM, 0xf851, 0x0b04);
      core.executeInstruction();
      expect(core.regs.r[0]).toBe(0xcafef00d >>> 0);
      expect(core.regs.r[1]).toBe((SRAM + 0x104) >>> 0); // writeback
    });

    it('LDR.W r0, [r1, #-4] (T4 pre-indexed, negative)', () => {
      const { chip, core } = setup();
      chip.writeUint32(SRAM + 0x100, 0x11223344);
      core.regs.r[1] = SRAM + 0x104;
      // T4: P=1, U=0, W=0, imm8=4 → offset -4, no writeback.
      // hw1 = (0<<12) | (1<<11) | (1<<10) | (0<<9) | (0<<8) | 4 = 0x0c04.
      putInsn32(chip, SRAM, 0xf851, 0x0c04);
      core.executeInstruction();
      expect(core.regs.r[0]).toBe(0x11223344 >>> 0);
      expect(core.regs.r[1]).toBe((SRAM + 0x104) >>> 0); // no writeback
    });

    it('LDR.W r0, [r1, r2] (register offset)', () => {
      const { chip, core } = setup();
      chip.writeUint32(SRAM + 0x108, 0x55667788);
      core.regs.r[1] = SRAM + 0x100;
      core.regs.r[2] = 8;
      // Register offset (T2): hw1 = (rt<<12) | 000000 | imm2<<4 | rm (bit 11
      // clear selects this form; it's a fixed 1 for the immediate PUW form).
      // hw1 = (0<<12) | 0 | 0 | 2 = 0x0002.
      putInsn32(chip, SRAM, 0xf851, 0x0002);
      core.executeInstruction();
      expect(core.regs.r[0]).toBe(0x55667788 >>> 0);
    });

    it('LDR.W r0, [pc, #-4] (literal, negative offset)', () => {
      // Regression test: Rn=PC with the "T4" (non-imm12) hw0 shape isn't a
      // register-offset/PUW-immediate load at all — it's still LDR (literal),
      // just with U=0 (subtract). hw0=0xf85f (bit 7 clear, Rn=1111), hw1 =
      // (rt=0<<12)|imm12=4 = 0x0004. Verified against `arm-none-eabi-as`.
      const { chip, core } = setup();
      // base = opcodePC + 4 = SRAM+0x204; addr = base - imm12(8) = SRAM+0x1fc
      // (kept clear of the 4-byte instruction word itself at SRAM+0x200).
      chip.writeUint32(SRAM + 0x1fc, 0x11223344);
      putInsn32(chip, SRAM + 0x200, 0xf85f, 0x0008);
      core.PC = SRAM + 0x200;
      core.executeInstruction();
      expect(core.regs.r[0]).toBe(0x11223344 >>> 0);
    });

    it('LDR.W r0, [pc, #0] (literal, zero offset — jump-table stub shape)', () => {
      // Same hw0 shape (0xf85f) as MicroPython's linker-generated veneers
      // (`ldr.w pc,[pc]`), with Rt=r0 instead of pc to isolate the
      // addressing mode from PC-write semantics: Rn=PC here must select
      // LDR-literal, not a register-offset load (which would misread Rm
      // from the imm12 bits).
      const { chip, core } = setup();
      chip.writeUint32(SRAM + 0x104, 0xcafef00d);
      putInsn32(chip, SRAM + 0x100, 0xf85f, 0x0000);
      core.PC = SRAM + 0x100;
      core.executeInstruction();
      expect(core.regs.r[0]).toBe(0xcafef00d >>> 0);
    });

    it('LDR.W r0, [pc, #imm] aligns PC down to a word boundary (T3/positive form)', () => {
      // The base for LDR (literal) is Align(PC,4), not the raw instruction
      // address — the instruction only needs 2-byte alignment (it can follow
      // another 32-bit Thumb instruction with no 16-bit filler). Placing
      // this LDR.W at a 2-mod-4 address (SRAM+0x102) exercises
      // Align(opcodePC+4,4) = SRAM+0x104, distinct from the unaligned
      // opcodePC+4 = SRAM+0x106.
      const { chip, core } = setup();
      chip.writeUint32(SRAM + 0x204, 0x12345678); // correct literal-pool word
      chip.writeUint32(SRAM + 0x208, 0x9abcdef0); // adjacent word (decoy)
      putInsn32(chip, SRAM + 0x102, 0xf8df, 0x0100); // LDR.W r0, [pc, #0x100]
      core.PC = SRAM + 0x102;
      core.executeInstruction();
      expect(core.regs.r[0]).toBe(0x12345678 >>> 0);
    });

    it('LDR.W r0, [pc, #-imm] aligns PC down to a word boundary (negative form)', () => {
      const { chip, core } = setup();
      chip.writeUint32(SRAM + 0x204, 0x11223344); // correct literal-pool word
      putInsn32(chip, SRAM + 0x302, 0xf85f, 0x0100); // LDR.W r0, [pc, #-0x100]
      core.PC = SRAM + 0x302;
      core.executeInstruction();
      expect(core.regs.r[0]).toBe(0x11223344 >>> 0);
    });

    it('LDRH.W r0, [r1, #0x4] (halfword imm12)', () => {
      const { chip, core } = setup();
      chip.writeUint16(SRAM + 0x104, 0xbabe);
      core.regs.r[1] = SRAM + 0x100;
      // LDRH.W T3: hw0 = 0xf8b0 | r1 = 0xf8b1. hw1 = (r0<<12) | 4 = 0x0004.
      putInsn32(chip, SRAM, 0xf8b1, 0x0004);
      core.executeInstruction();
      expect(core.regs.r[0]).toBe(0xbabe);
    });

    it('STRH.W r0, [r1, #0x4] (halfword store imm12)', () => {
      const { chip, core } = setup();
      core.regs.r[0] = 0xface;
      core.regs.r[1] = SRAM + 0x100;
      // STRH.W T3: hw0 = 0xf8a0 | r1 = 0xf8a1. hw1 = (r0<<12) | 4 = 0x0004.
      putInsn32(chip, SRAM, 0xf8a1, 0x0004);
      core.executeInstruction();
      expect(chip.readUint16(SRAM + 0x104)).toBe(0xface);
    });

    it('LDR.W r0, [r1] supports an unaligned (non-word-aligned) address', () => {
      // The M33 permits LDR (single) to access unaligned addresses in Normal
      // memory (ARMv8-M ARM B8.3 / RP2350 datasheet) — unlike LDM/LDRD, which
      // require alignment and fault otherwise. Bytes are written individually
      // (rather than via writeUint32) so the unaligned base is exercised.
      const { chip, core } = setup();
      const base = SRAM + 0x101; // not 4-byte aligned
      chip.writeUint8(base, 0x78);
      chip.writeUint8(base + 1, 0x56);
      chip.writeUint8(base + 2, 0x34);
      chip.writeUint8(base + 3, 0x12);
      core.regs.r[1] = base;
      putInsn32(chip, SRAM, 0xf8d1, 0x0000); // LDR.W r0, [r1, #0]
      core.executeInstruction();
      expect(core.regs.r[0]).toBe(0x12345678);
    });

    it('STR.W r0, [r1] supports an unaligned (non-word-aligned) address', () => {
      const { chip, core } = setup();
      const base = SRAM + 0x201; // not 4-byte aligned
      core.regs.r[0] = 0xcafebabe;
      core.regs.r[1] = base;
      putInsn32(chip, SRAM, 0xf8c1, 0x0000); // STR.W r0, [r1, #0]
      core.executeInstruction();
      expect(chip.readUint8(base)).toBe(0xbe);
      expect(chip.readUint8(base + 1)).toBe(0xba);
      expect(chip.readUint8(base + 2)).toBe(0xfe);
      expect(chip.readUint8(base + 3)).toBe(0xca);
    });

    it('LDRH.W r0, [r1] supports an unaligned (odd) address', () => {
      const { chip, core } = setup();
      const base = SRAM + 0x101; // odd address
      chip.writeUint8(base, 0xbe);
      chip.writeUint8(base + 1, 0xba);
      core.regs.r[1] = base;
      putInsn32(chip, SRAM, 0xf8b1, 0x0000); // LDRH.W r0, [r1, #0]
      core.executeInstruction();
      expect(core.regs.r[0]).toBe(0xbabe);
    });

    it('STRH.W r0, [r1] supports an unaligned (odd) address', () => {
      const { chip, core } = setup();
      const base = SRAM + 0x201; // odd address
      core.regs.r[0] = 0xface;
      core.regs.r[1] = base;
      putInsn32(chip, SRAM, 0xf8a1, 0x0000); // STRH.W r0, [r1, #0]
      core.executeInstruction();
      expect(chip.readUint8(base)).toBe(0xce);
      expect(chip.readUint8(base + 1)).toBe(0xfa);
    });

    it('LDRH.W r0, [r1], #+4 (halfword post-indexed)', () => {
      const { chip, core } = setup();
      chip.writeUint16(SRAM + 0x100, 0x1234);
      core.regs.r[1] = SRAM + 0x100;
      // LDRH T4 post-indexed: P=0,U=1,W=1, imm8=4.
      // hw0 = 0xf830 | r1 = 0xf831. hw1 = 0x0b04 (same P/U/W layout as word).
      putInsn32(chip, SRAM, 0xf831, 0x0b04);
      core.executeInstruction();
      expect(core.regs.r[0]).toBe(0x1234);
      expect(core.regs.r[1]).toBe((SRAM + 0x104) >>> 0);
    });

    it('LDRB.W r0, [r1, #0x4] (byte imm12)', () => {
      const { chip, core } = setup();
      chip.writeUint8(SRAM + 0x104, 0xab);
      core.regs.r[1] = SRAM + 0x100;
      // LDRB.W T3: hw0 = 0xf890 | r1 = 0xf891. hw1 = (r0<<12) | 4 = 0x0004.
      putInsn32(chip, SRAM, 0xf891, 0x0004);
      core.executeInstruction();
      expect(core.regs.r[0]).toBe(0xab);
    });

    it('LDRSB.W r0, [r1, #0x0] sign-extends', () => {
      const { chip, core } = setup();
      chip.writeUint8(SRAM + 0x100, 0xff); // -1 as signed byte
      core.regs.r[1] = SRAM + 0x100;
      // LDRSB.W T3: S=1 → hw0 = 0xf990 | r1 = 0xf991. hw1 = (r0<<12) | 0 = 0x0000.
      putInsn32(chip, SRAM, 0xf991, 0x0000);
      core.executeInstruction();
      expect(core.regs.r[0]).toBe(0xffffffff >>> 0);
    });
  });

  describe('BL (long branch with link)', () => {
    it('BL sets LR and jumps', () => {
      const { chip, core } = setup();
      // Per `arm-none-eabi-as`: bl .+8 → f000 f802.
      putInsn32(chip, SRAM, 0xf000, 0xf802);
      // Pad with NOPs.
      chip.writeUint16(SRAM + 4, 0xbf00);
      chip.writeUint16(SRAM + 6, 0xbf00);
      core.executeInstruction();
      // LR = return address (opcodePC + 4) | 1.
      expect(core.regs.lr).toBe((SRAM + 4) | 1);
      // PC = opcodePC + 4 + offset(4) = SRAM + 8.
      expect(core.regs.pc).toBe(SRAM + 8);
    });
  });

  describe('MRS / MSR special registers', () => {
    it('MRS r0, MSP reads MSP', () => {
      const { chip, core } = setup();
      core.regs.msp = 0x20001000;
      // MRS: 1111 0011 1110 1111 | 1000 Rd 0000 0000.
      // For MSP (SYSm=8): hw0 = 0xf3ef. hw1 = 0x8000 | (rd << 8) | 8 → 0x8008.
      putInsn32(chip, SRAM, 0xf3ef, 0x8008);
      core.executeInstruction();
      expect(core.regs.r[0]).toBe(0x20001000);
    });
    it('MSR MSP, r0 writes MSP', () => {
      const { chip, core } = setup();
      core.regs.r[0] = 0x20002000;
      // MSR: 1111 0011 1000 Rn | 1000 1000 SYSm.
      // For MSP (SYSm=8): hw0 = 0xf380 | 0 = 0xf380. hw1 = 0x8808.
      putInsn32(chip, SRAM, 0xf380, 0x8808);
      core.executeInstruction();
      expect(core.regs.msp).toBe(0x20002000 & ~3);
    });
    // Regression: `regs.sp` (r[13]) is a plain register alias, not a live
    // view of msp/psp (see registers.ts `syncSpFromBanked`/`syncSpToBanked`).
    // `MSR MSP, Rn` was only updating the banked `regs.msp` copy, leaving the
    // *active* SP (r[13]) stale whenever MSP is the currently-active stack
    // pointer (Handler mode, or Thread mode with CONTROL.SPSEL=0 — the
    // common case, including this test's default core state). Real bootrom
    // code relies on this to hand off to a freshly-launched image's own
    // stack; without the sync, the image silently kept running on the
    // bootrom's old stack pointer.
    it('MSR MSP, r0 also updates the active SP (r13), not just banked msp', () => {
      const { chip, core } = setup();
      core.regs.sp = 0x400e0060; // simulate a stale/unrelated old SP
      core.regs.r[0] = 0x20082000;
      putInsn32(chip, SRAM, 0xf380, 0x8808); // MSR MSP, r0
      core.executeInstruction();
      expect(core.regs.msp).toBe(0x20082000);
      expect(core.regs.sp).toBe(0x20082000);
    });

    it('MRS r0, BASEPRI reads BASEPRI', () => {
      const { chip, core } = setup();
      core.regs.basepri = 0x10;
      putInsn32(chip, SRAM, 0xf3ef, 0x8011); // SYSm=17=0x11
      core.executeInstruction();
      expect(core.regs.r[0]).toBe(0x10);
    });
    it('MRS r0, MSPLIM reads MSPLIM (SYSm=0x0A)', () => {
      const { chip, core } = setup();
      core.regs.msplim = 0x20008000;
      // SYSm=0x0A: hw1 = (0 << 8) | 0x0a = 0x000a.
      putInsn32(chip, SRAM, 0xf3ef, 0x000a);
      core.executeInstruction();
      expect(core.regs.r[0]).toBe(0x20008000);
    });
    it('MRS r0, PSPLIM reads PSPLIM (SYSm=0x0B)', () => {
      const { chip, core } = setup();
      core.regs.psplim = 0x20009000;
      putInsn32(chip, SRAM, 0xf3ef, 0x000b);
      core.executeInstruction();
      expect(core.regs.r[0]).toBe(0x20009000);
    });
    it('MSR MSPLIM, r0 writes MSPLIM (SYSm=0x0A, 8-byte aligned)', () => {
      const { chip, core } = setup();
      core.regs.r[0] = 0x20008888;
      // MSR ... SYSm=0x0A: hw0 = 0xf380, hw1 = 0x8800 | 0x0a = 0x880a.
      putInsn32(chip, SRAM, 0xf380, 0x880a);
      core.executeInstruction();
      expect(core.regs.msplim).toBe(0x20008888 & ~0x7);
    });
    it('MRS r0, CONTROL_NS reads CONTROL_NS (SYSm=0x94)', () => {
      const { chip, core } = setup();
      core.regs.control_ns = 0x7;
      putInsn32(chip, SRAM, 0xf3ef, 0x0094);
      core.executeInstruction();
      expect(core.regs.r[0]).toBe(0x7);
    });
    it('MSR CONTROL preserves FPCA bit 2', () => {
      const { chip, core } = setup();
      core.regs.control = 0x4; // FPCA set, nPRIV/SPSEL clear
      core.regs.r[0] = 0x1; // attempt to write nPRIV=1
      // MSR CONTROL, r0: SYSm=20=0x14. hw0=0xf380, hw1=0x8800|0x14=0x8814.
      putInsn32(chip, SRAM, 0xf380, 0x8814);
      core.executeInstruction();
      // FPCA (0x4) must be preserved; only nPRIV/SPSEL (bits 1:0) come from r0.
      expect(core.regs.control).toBe(0x5); // 0x1 | 0x4
    });

    it('MSR CONTROL (SPSEL=1) switches the active SP from MSP to PSP', () => {
      const { chip, core } = setup();
      core.regs.msp = 0x20001000;
      core.regs.psp = 0x20002000;
      core.regs.sp = core.regs.msp; // MSP active initially (SPSEL=0)
      core.regs.r[0] = 0x2; // SPSEL=1, nPRIV=0
      putInsn32(chip, SRAM, 0xf380, 0x8814); // MSR CONTROL, r0
      core.executeInstruction();
      expect(core.regs.control & 0x2).toBe(0x2);
      expect(core.regs.sp).toBe(0x20002000); // now reflects PSP
      expect(core.regs.msp).toBe(0x20001000); // old active SP saved back to MSP
    });
  });

  describe('Wide register DP', () => {
    it('LSL.W r0, r1, #4', () => {
      // Per `arm-none-eabi-as`: lsl.w r0, r1, #4 → ea4f 1001 (encoded as
      // MOV.W with shift).
      const r = step32(0xea4f, 0x1001, { r1: 0x3 });
      expect(r.r0).toBe(0x30);
    });
    it('ADD.W r0, r1, r2 (register)', () => {
      // Per `arm-none-eabi-as`: add.w r0, r1, r2 → eb01 0002.
      const r = step32(0xeb01, 0x0002, { r1: 5, r2: 7 });
      expect(r.r0).toBe(12);
    });

    it('ADD.W r0, r1, r2 (register, S=0) does not clobber flags set by a preceding CMP', () => {
      // Same regression as the modified-immediate case above, for the
      // shifted-register DP dispatcher's addSubFlags call sites.
      const { chip, core } = setup();
      core.regs.r[1] = 5;
      core.regs.r[2] = 7;
      core.regs.Z = true;
      core.regs.N = false;
      core.regs.C = true;
      core.regs.V = false;
      putInsn32(chip, SRAM, 0xeb01, 0x0002);
      core.executeInstruction();
      expect(core.regs.r[0]).toBe(12);
      expect(core.regs.Z).toBe(true);
      expect(core.regs.N).toBe(false);
      expect(core.regs.C).toBe(true);
      expect(core.regs.V).toBe(false);
    });
  });

  describe('Barriers and hints', () => {
    it('DSB executes without error', () => {
      // DSB: hw0=0xf3bf, hw1=0x8f4f.
      const r = step32(0xf3bf, 0x8f4f);
      void r;
    });
    it('CLREX executes without error', () => {
      // CLREX: hw0=0xf3bf, hw1=0x8f2f.
      const r = step32(0xf3bf, 0x8f2f);
      void r;
    });
  });

  describe('Load/store multiple (LDM/STM)', () => {
    it('LDMIA.W r0!, {r1, r2} loads (does not store) and writes back', () => {
      const { chip, core } = setup();
      chip.writeUint32(SRAM + 0x200, 0x11111111);
      chip.writeUint32(SRAM + 0x204, 0x22222222);
      core.regs.r[0] = SRAM + 0x200;
      // LDMIA.W r0!, {r1, r2} = 0xE8B0 0x0006
      putInsn32(chip, SRAM, 0xe8b0, 0x0006);
      core.executeInstruction();
      expect(core.regs.r[1]).toBe(0x11111111);
      expect(core.regs.r[2]).toBe(0x22222222);
      expect(core.regs.r[0]).toBe((SRAM + 0x208) >>> 0);
    });

    it('STMDB.W r0!, {r1, r2} decrements before and stores', () => {
      const { chip, core } = setup();
      core.regs.r[0] = SRAM + 0x308;
      core.regs.r[1] = 0xaaaaaaaa;
      core.regs.r[2] = 0xbbbbbbbb;
      // STMDB.W r0!, {r1, r2} = 0xE920 0x0006
      putInsn32(chip, SRAM, 0xe920, 0x0006);
      core.executeInstruction();
      expect(chip.readUint32(SRAM + 0x300)).toBe(0xaaaaaaaa >>> 0);
      expect(chip.readUint32(SRAM + 0x304)).toBe(0xbbbbbbbb >>> 0);
      expect(core.regs.r[0]).toBe((SRAM + 0x300) >>> 0);
    });

    it('STMIA.W r0, {r1} (no writeback) leaves Rn unchanged', () => {
      const { chip, core } = setup();
      core.regs.r[0] = SRAM + 0x400;
      core.regs.r[1] = 0x5;
      // STMIA.W r0, {r1} (W=0) = 0xE880 0x0002
      putInsn32(chip, SRAM, 0xe880, 0x0002);
      core.executeInstruction();
      expect(chip.readUint32(SRAM + 0x400)).toBe(0x5);
      expect(core.regs.r[0]).toBe((SRAM + 0x400) >>> 0);
    });

    it('LDMIA.W throws on an unaligned base address (real hardware faults)', () => {
      // Unlike LDR/STR singles, LDM/STM require word alignment and generate
      // a fault if this is attempted (RP2350 datasheet / ARMv8-M ARM §B8.3).
      const { chip, core } = setup();
      core.regs.r[0] = SRAM + 0x201; // not 4-byte aligned
      putInsn32(chip, SRAM, 0xe8b0, 0x0006); // LDMIA.W r0!, {r1, r2}
      expect(() => core.executeInstruction()).toThrow(
        /unaligned word read.*PC=[0-9a-f]+ \(core0\)/i
      );
    });

    it('STMIA.W throws on an unaligned base address (real hardware faults)', () => {
      const { chip, core } = setup();
      core.regs.r[0] = SRAM + 0x401; // not 4-byte aligned
      core.regs.r[1] = 0x5;
      putInsn32(chip, SRAM, 0xe880, 0x0002); // STMIA.W r0, {r1}
      expect(() => core.executeInstruction()).toThrow(/not.*32 bit aligned|unaligned/i);
    });
  });

  describe('Load/store exclusive, load-acquire/store-release, table branch', () => {
    // All encodings verified against `arm-none-eabi-as -march=armv8-m.main`.
    // We don't model the exclusive-access monitor (single-threaded, no real
    // inter-core contention within one core-step), so STREX*/STLEX* always
    // succeed (status 0).
    it('LDREX r0, [r1]', () => {
      // ldrex r0, [r1] = 0xe851 0x0f00
      const { chip, core } = setup();
      chip.writeUint32(SRAM + 0x300, 0xdeadbeef);
      core.regs.r[1] = SRAM + 0x300;
      putInsn32(chip, SRAM, 0xe851, 0x0f00);
      core.executeInstruction();
      expect(core.regs.r[0]).toBe(0xdeadbeef >>> 0);
    });

    it('STREX r0, r2, [r1] stores and reports success (r0=0)', () => {
      // strex r0, r2, [r1] = 0xe841 0x2000
      const { chip, core } = setup();
      core.regs.r[1] = SRAM + 0x300;
      core.regs.r[2] = 0x12345678;
      putInsn32(chip, SRAM, 0xe841, 0x2000);
      core.executeInstruction();
      expect(chip.readUint32(SRAM + 0x300)).toBe(0x12345678);
      expect(core.regs.r[0]).toBe(0);
    });

    it('LDAEXB r1, [r3] (the spinlock-acquire pattern MicroPython uses)', () => {
      // ldaexb r1, [r3] = 0xe8d3 0x1fcf
      const { chip, core } = setup();
      chip.writeUint8(SRAM + 0x300, 0);
      core.regs.r[3] = SRAM + 0x300;
      putInsn32(chip, SRAM, 0xe8d3, 0x1fcf);
      core.executeInstruction();
      expect(core.regs.r[1]).toBe(0);
    });

    it('STLEXB r0, r2, [r1] stores a byte and reports success (r0=0)', () => {
      // stlexb r0, r2, [r1] = 0xe8c1 0x2fc0 (verified against `arm-none-eabi-as`)
      const { chip, core } = setup();
      core.regs.r[1] = SRAM + 0x300;
      core.regs.r[2] = 0xab;
      putInsn32(chip, SRAM, 0xe8c1, 0x2fc0);
      core.executeInstruction();
      expect(chip.readUint8(SRAM + 0x300)).toBe(0xab);
      expect(core.regs.r[0]).toBe(0);
    });

    it('LDA r0, [r1] (plain load-acquire, non-exclusive)', () => {
      // lda r0, [r1] = 0xe8d1 0x0faf
      const { chip, core } = setup();
      chip.writeUint32(SRAM + 0x300, 0xcafef00d);
      core.regs.r[1] = SRAM + 0x300;
      putInsn32(chip, SRAM, 0xe8d1, 0x0faf);
      core.executeInstruction();
      expect(core.regs.r[0]).toBe(0xcafef00d >>> 0);
    });

    it('STL r0, [r1] (plain store-release, non-exclusive)', () => {
      // stl r0, [r1] = 0xe8c1 0x0faf
      const { chip, core } = setup();
      core.regs.r[0] = 0x11223344;
      core.regs.r[1] = SRAM + 0x300;
      putInsn32(chip, SRAM, 0xe8c1, 0x0faf);
      core.executeInstruction();
      expect(chip.readUint32(SRAM + 0x300)).toBe(0x11223344);
    });

    it('TBB [r0, r1] jumps via a byte-indexed table', () => {
      // tbb [r0, r1] = 0xe8d0 0xf001
      const { chip, core } = setup();
      core.regs.r[0] = SRAM + 0x300;
      core.regs.r[1] = 2; // index 2
      chip.writeUint8(SRAM + 0x300 + 2, 5); // table[2] = 5 halfwords
      putInsn32(chip, SRAM, 0xe8d0, 0xf001);
      core.executeInstruction();
      // target = (opcodePC + 4) + table[2]*2 = SRAM+4 + 10
      expect(core.regs.pc >>> 0).toBe((SRAM + 4 + 10) >>> 0);
    });

    it('TBH [r0, r1, lsl #1] jumps via a halfword-indexed table', () => {
      // tbh [r0, r1, lsl #1] = 0xe8d0 0xf011
      const { chip, core } = setup();
      core.regs.r[0] = SRAM + 0x300;
      core.regs.r[1] = 2; // index 2
      chip.writeUint16(SRAM + 0x300 + 4, 7); // table[2] = 7 halfwords
      putInsn32(chip, SRAM, 0xe8d0, 0xf011);
      core.executeInstruction();
      expect(core.regs.pc >>> 0).toBe((SRAM + 4 + 14) >>> 0);
    });
  });

  describe('ThumbExpandImm (i bit)', () => {
    it('MOV.W r0, #0x00810000 (rotation 16 requires the i bit)', () => {
      // imm12 = i:imm3:imm8 = 1:000:0x01 → ROR(0x81, 16) = 0x00810000.
      // MOV.W r0, #imm: hw0 = 0xf04f | (i<<10) = 0xf44f, hw1 = imm8 = 0x0001.
      const r = step32(0xf44f, 0x0001);
      expect(r.r0).toBe(0x00810000);
    });

    it('ADDW r0, r1, #0x801 (i bit set) adds the full 12-bit immediate', () => {
      // ADDW: hw0 = 0xf200 | (i<<10) | rn = 0xf600 | 1 = 0xf601.
      // imm12 = 0x801 → i=1, imm3=0, imm8=0x01. hw1 = (imm3<<12)|(rd<<8)|imm8.
      const r = step32(0xf601, 0x0001, { r1: 0x1000 });
      expect(r.r0).toBe((0x1000 + 0x801) >>> 0);
    });

    it('ANDS.W r0, r1, #rotated sets carry from the ThumbExpandImm carry-out', () => {
      const { chip, core } = setup();
      core.regs.r[1] = 0xffffffff;
      core.regs.C = false;
      // ANDS.W r0, r1, #0x00810000 (rotated → carry-out = bit31 of imm = 0).
      // AND op=0000, S=1: hw0 = 0xf000 | (i<<10) | 0x10 | rn = 0xf410 | 1 = 0xf411.
      putInsn32(chip, SRAM, 0xf411, 0x0001);
      core.executeInstruction();
      expect(core.regs.r[0]).toBe(0x00810000);
      expect(core.regs.C).toBe(false); // imm bit31 = 0 → carry cleared
    });
  });

  describe('UBFX/SBFX/BFI/BFC (data-processing, plain immediate)', () => {
    // All encodings verified against `arm-none-eabi-as -march=armv8-m.main`.
    // Regression coverage for a bug where UBFX (opField=28=0b11100) and SBFX
    // (opField=20=0b10100) were misdecoded as MOVT (opField=12=0b01100)
    // because the dispatcher only checked the low 3 bits of the 5-bit
    // opField (0b100) instead of requiring an exact match — silently
    // corrupting Rd's upper 16 bits instead of computing a bitfield extract.
    it('UBFX r0, r5, #2, #7 extracts an unsigned bitfield', () => {
      // ubfx r0, r5, #2, #7 = 0xf3c5 0x0086
      const { chip, core } = setup();
      core.regs.r[5] = 0b1111_1100; // bits[8:2] = 0x3f
      putInsn32(chip, SRAM, 0xf3c5, 0x0086);
      core.executeInstruction();
      expect(core.regs.r[0]).toBe(0x3f);
    });

    it('SBFX r0, r5, #2, #7 sign-extends the extracted bitfield', () => {
      // sbfx r0, r5, #2, #7 = 0xf345 0x0086
      const { chip, core } = setup();
      core.regs.r[5] = 0b1_0000_0000; // bits[8:2] = 0x40 (sign bit of 7-bit field set)
      putInsn32(chip, SRAM, 0xf345, 0x0086);
      core.executeInstruction();
      expect(core.regs.r[0]).toBe(0xffffffc0 >>> 0);
    });

    it('BFI r0, r1, #4, #8 inserts bits without disturbing the rest of Rd', () => {
      // bfi r0, r1, #4, #8 = 0xf361 0x100b
      const { chip, core } = setup();
      core.regs.r[0] = 0xf000000f;
      core.regs.r[1] = 0xff;
      putInsn32(chip, SRAM, 0xf361, 0x100b);
      core.executeInstruction();
      expect(core.regs.r[0]).toBe(0xf0000fff >>> 0);
    });

    it('BFC r0, #4, #8 clears bits without disturbing the rest of Rd', () => {
      // bfc r0, #4, #8 = 0xf36f 0x100b
      const { chip, core } = setup();
      core.regs.r[0] = 0xffffffff;
      putInsn32(chip, SRAM, 0xf36f, 0x100b);
      core.executeInstruction();
      expect(core.regs.r[0]).toBe(0xfffff00f >>> 0);
    });
  });

  describe('B.W conditional (T3) / unconditional (T4)', () => {
    it('BEQ.W is NOT taken when Z=0 (conditional, not unconditional)', () => {
      const { chip, core } = setup();
      core.regs.Z = false;
      // BEQ.W .+0x24: hw0=0xf000 (cond=EQ in hw0[9:6]=0), hw1=0x8010 (T3).
      putInsn32(chip, SRAM, 0xf000, 0x8010);
      chip.writeUint16(SRAM + 4, 0xbf00);
      core.executeInstruction();
      expect(core.regs.pc).toBe((SRAM + 4) >>> 0); // fell through
    });

    it('BEQ.W IS taken when Z=1', () => {
      const { chip, core } = setup();
      core.regs.Z = true;
      putInsn32(chip, SRAM, 0xf000, 0x8010);
      core.executeInstruction();
      // target = (opcodePC + 4) + 0x20 = SRAM + 0x24
      expect(core.regs.pc).toBe((SRAM + 0x24) >>> 0);
    });

    it('B.W (unconditional, T4) always branches regardless of flags', () => {
      const { chip, core } = setup();
      core.regs.Z = false;
      // B.W .+0x24: hw0=0xf000, hw1=0xb810 (T4, i1=i2=0).
      putInsn32(chip, SRAM, 0xf000, 0xb810);
      core.executeInstruction();
      expect(core.regs.pc).toBe((SRAM + 0x24) >>> 0);
    });
  });

  describe('TST / CMP (flags only, no PC write)', () => {
    it('TST.W r0, #0xff sets flags and does not corrupt PC', () => {
      const { chip, core } = setup();
      core.regs.r[0] = 0x100;
      // TST.W r0, #0xff: AND op=0000, S=1, Rd=1111. hw0=0xf010, hw1=0x0fff.
      putInsn32(chip, SRAM, 0xf010, 0x0fff);
      core.executeInstruction();
      expect(core.regs.pc).toBe((SRAM + 4) >>> 0);
      expect(core.regs.Z).toBe(true); // 0x100 & 0xff == 0
      expect(core.regs.r[0]).toBe(0x100); // unchanged
    });

    it('CMP.W r0, #5 sets Z/C and does not corrupt PC', () => {
      const { chip, core } = setup();
      core.regs.r[0] = 5;
      // CMP.W r0, #5: SUB op=1101, S=1, Rd=1111. hw0=0xf1b0, hw1=0x0f05.
      putInsn32(chip, SRAM, 0xf1b0, 0x0f05);
      core.executeInstruction();
      expect(core.regs.pc).toBe((SRAM + 4) >>> 0);
      expect(core.regs.Z).toBe(true);
      expect(core.regs.C).toBe(true); // 5 >= 5, no borrow
    });
  });

  describe('Register-controlled shift (shift amount from Rm)', () => {
    it('LSL.W r0, r1, r2 shifts by r2 (not by immediate bits)', () => {
      // LSL.W r0, r1, r2 = 0xFA01 0xF002
      const r = step32(0xfa01, 0xf002, { r1: 1, r2: 4 });
      expect(r.r0).toBe(0x10); // 1 << 4
    });

    it('LSLS.W r0, r1, r2 updates the carry from the shifted-out bit', () => {
      const { chip, core } = setup();
      core.regs.r[1] = 0x80000000;
      core.regs.r[2] = 1;
      core.regs.C = false;
      // LSLS.W r0, r1, r2 (S=1) = 0xFA11 0xF002
      putInsn32(chip, SRAM, 0xfa11, 0xf002);
      core.executeInstruction();
      expect(core.regs.r[0]).toBe(0);
      expect(core.regs.Z).toBe(true);
      expect(core.regs.C).toBe(true); // bit 31 shifted out
    });

    it('LSR.W r0, r1, r2 with r2=0 leaves the value unchanged', () => {
      // LSR.W r0, r1, r2 = 0xFA21 0xF002
      const r = step32(0xfa21, 0xf002, { r1: 0xdeadbeef, r2: 0 });
      expect(r.r0).toBe(0xdeadbeef >>> 0);
    });
  });

  describe('Data-processing (register): REV/REV16/RBIT/REVSH/CLZ', () => {
    // All encodings verified against `arm-none-eabi-as -march=armv8-m.main`.
    it('CLZ r0, r1', () => {
      // clz r0, r1 = 0xfab1 0xf081
      const r = step32(0xfab1, 0xf081, { r1: 0x0000f000 });
      expect(r.r0).toBe(16);
    });

    it('CLZ r0, r1 with r1=0 returns 32', () => {
      const r = step32(0xfab1, 0xf081, { r1: 0 });
      expect(r.r0).toBe(32);
    });

    it('REV.W r0, r1', () => {
      // rev.w r0, r1 = 0xfa91 0xf081
      const r = step32(0xfa91, 0xf081, { r1: 0x11223344 });
      expect(r.r0).toBe(0x44332211);
    });

    it('REV16.W r0, r1', () => {
      // rev16.w r0, r1 = 0xfa91 0xf091
      const r = step32(0xfa91, 0xf091, { r1: 0x11223344 });
      expect(r.r0).toBe(0x22114433);
    });

    it('RBIT r0, r1', () => {
      // rbit r0, r1 = 0xfa91 0xf0a1
      const r = step32(0xfa91, 0xf0a1, { r1: 0x80000001 });
      expect(r.r0).toBe(0x80000001 >>> 0); // palindromic bit pattern
    });

    it('RBIT r0, r1 reverses a non-palindromic pattern', () => {
      const r = step32(0xfa91, 0xf0a1, { r1: 0x00000001 });
      expect(r.r0).toBe(0x80000000 >>> 0);
    });

    it('REVSH.W r0, r1', () => {
      // revsh.w r0, r1 = 0xfa91 0xf0b1
      const r = step32(0xfa91, 0xf0b1, { r1: 0x000080ff });
      expect(r.r0).toBe(0xffffff80 >>> 0); // bytes 0xff,0x80 swapped -> 0x80ff, sign-extended
    });
  });

  describe('SXTH.W/UXTH.W/SXTB.W/UXTB.W', () => {
    // All encodings verified against `arm-none-eabi-as -march=armv8-m.main`.
    it('SXTH.W r0, r1 sign-extends a 16-bit halfword', () => {
      // sxth.w r0, r1 = 0xfa0f 0xf081
      const r = step32(0xfa0f, 0xf081, { r1: 0x0000f000 });
      expect(r.r0).toBe(0xfffff000 >>> 0);
    });

    it('UXTH.W r0, r1 zero-extends a 16-bit halfword', () => {
      // uxth.w r0, r1 = 0xfa1f 0xf081
      const r = step32(0xfa1f, 0xf081, { r1: 0xdeadf000 });
      expect(r.r0).toBe(0x0000f000);
    });

    it('SXTB.W r0, r1 sign-extends an 8-bit byte', () => {
      // sxtb.w r0, r1 = 0xfa4f 0xf081
      const r = step32(0xfa4f, 0xf081, { r1: 0x000000f0 });
      expect(r.r0).toBe(0xfffffff0 >>> 0);
    });

    it('UXTB.W r0, r1 zero-extends an 8-bit byte', () => {
      // uxtb.w r0, r1 = 0xfa5f 0xf081
      const r = step32(0xfa5f, 0xf081, { r1: 0xdeadbef0 });
      expect(r.r0).toBe(0x000000f0);
    });

    it('UXTH.W r0, r1, ror #16 rotates before extending', () => {
      // uxth.w r0, r1, ror #16 = 0xfa1f 0xf0a1
      const r = step32(0xfa1f, 0xf0a1, { r1: 0x1234abcd });
      expect(r.r0).toBe(0x1234);
    });
  });

  describe('SXTAB/SXTAH/UXTAB/UXTAH (DSP-extension accumulating extend)', () => {
    // Same encoding family as SXTH.W/UXTH.W/SXTB.W/UXTB.W above, but Rn is a
    // real register (added to the extended result) instead of the fixed
    // 0xf that selects the plain form. All encodings verified against
    // `arm-none-eabi-as -march=armv8-m.main+dsp` (RP2350's M33 includes the
    // DSP extension).
    it('SXTAB.W r0, r1, r2 sign-extends r2 as a byte and adds r1', () => {
      // sxtab r0, r1, r2 = 0xfa41 0xf082
      const r = step32(0xfa41, 0xf082, { r1: 0x100, r2: 0xf0 });
      expect(r.r0).toBe((0x100 + ((0xf0 << 24) >> 24)) >>> 0);
    });

    it('SXTAH.W r0, r1, r2 sign-extends r2 as a halfword and adds r1', () => {
      // sxtah r0, r1, r2 = 0xfa01 0xf082
      const r = step32(0xfa01, 0xf082, { r1: 0x2000, r2: 0x8000 });
      expect(r.r0).toBe((0x2000 + ((0x8000 << 16) >> 16)) >>> 0);
    });

    it('UXTAB.W r0, r1, r2 zero-extends r2 as a byte and adds r1', () => {
      // uxtab r0, r1, r2 = 0xfa51 0xf082
      const r = step32(0xfa51, 0xf082, { r1: 0x1000, r2: 0xdeadbeef });
      expect(r.r0).toBe(0x1000 + 0xef);
    });

    it('UXTAH.W r0, r1, r2 zero-extends r2 as a halfword and adds r1', () => {
      // uxtah r0, r1, r2 = 0xfa11 0xf082
      const r = step32(0xfa11, 0xf082, { r1: 0x30000, r2: 0xdead1234 });
      expect(r.r0).toBe(0x30000 + 0x1234);
    });

    it('SXTAB.W r0, r1, r2, ror #8 rotates r2 before extending', () => {
      // sxtab r0, r1, r2, ror #8 = 0xfa41 0xf092
      const r = step32(0xfa41, 0xf092, { r1: 0, r2: 0x0000abf0 });
      // ror #8 on 0x0000abf0 -> 0xf00000ab; extend low byte 0xab as signed.
      expect(r.r0).toBe(((0xab << 24) >> 24) >>> 0);
    });

    it('UXTAH.W r5, r7, r5 (real register numbers, as seen in MicroPython)', () => {
      // uxtah r5, r7, r5 = 0xfa17 0xf585 — the exact instruction that
      // previously crashed with "Unimplemented Thumb-32 instruction" while
      // booting the real MicroPython UF2 through the bootrom.
      const { chip, core } = setup();
      core.regs.r[7] = 0x2000;
      core.regs.r[5] = 0xdead1234;
      putInsn32(chip, SRAM, 0xfa17, 0xf585);
      core.executeInstruction();
      expect(core.regs.r[5]).toBe(0x2000 + 0x1234);
    });
  });

  describe('PC-write masking / self-healing (regression: MicroPython "2+2" computed as "-")', () => {
    // PC must be masked (bit0 cleared) on every write, and every read-as-value
    // (TBB/TBH base, ADR, `ADD Rd,PC,Rm`, etc.) must see the masked value —
    // ordinary fetch only re-masks PC for *decoding*, not for operand reads,
    // so a stray odd PC would otherwise silently propagate into every
    // subsequent PC-relative address computation until the next branch.
    it('a data-processing instruction with Rd=15 masks bit0 instead of writing PC raw', () => {
      // orr.w pc, r1, r2 (Rd hand-patched to 15; real assemblers reject Rd=PC
      // here as UNPREDICTABLE, but our emulator must still defensively mask
      // bit0 rather than let a stray odd result corrupt PC permanently).
      // Base encoding via `arm-none-eabi-as`: orr.w r0,r1,r2 = 0xea41 0x0002;
      // patched hw1 Rd field (bits[11:8]) from 0 to 0xf.
      const { chip, core } = setup();
      core.regs.r[1] = 0x1000;
      core.regs.r[2] = 0x1041; // r1|r2 = 0x1041 (odd — bit0 set)
      putInsn32(chip, SRAM, 0xea41, 0x0f02);
      core.executeInstruction();
      expect(core.regs.pc >>> 0).toBe(0x1040); // bit0 masked off, not left set
    });

    it('PC self-heals: instruction fetch/advance never compounds a stray bit0 left in PC', () => {
      // Forces a stray bit0 into PC directly and confirms core.ts's
      // fetch/advance cycle re-bases the next PC from the *masked* fetch
      // address rather than the raw (possibly-odd) live register, so the
      // corruption doesn't propagate to every subsequent instruction.
      const { chip, core } = setup();
      chip.writeUint16(SRAM, 0xbf00); // NOP
      core.regs.pc = (SRAM + 1) >>> 0; // simulate a stray odd bit in PC
      core.executeInstruction();
      expect(core.regs.pc >>> 0).toBe((SRAM + 2) >>> 0); // not SRAM+3
    });
  });
});
