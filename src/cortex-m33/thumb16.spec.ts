/**
 * Instruction tests for the Cortex-M33 core.
 *
 * Hand-assembled Thumb-16 instructions executed in a minimal in-memory
 * harness. Confirms the Thumb-16 port from cortex-m0-core.ts behaves
 * correctly on the M33 register model, plus M33-only additions (CBZ/CBNZ/IT).
 */

import { describe, expect, it } from 'vitest';
import { RP2350 } from '../rp2350';
import { CortexM33Core } from './core';

const SRAM = 0x20000000;

/** Helper: build a chip, set core0 PC, optionally pre-load SRAM. */
function setup(pc: number = SRAM): { chip: RP2350; core: CortexM33Core } {
  const chip = new RP2350(false, undefined, { coreArch: 'arm' });
  const core = chip.armCore0;
  core.stopped = false;
  core.PC = pc;
  return { chip, core };
}

/** Write a 16-bit instruction / data halfword to SRAM. */
function put16(chip: RP2350, addr: number, value: number) {
  chip.writeUint16(addr, value & 0xffff);
}

/** Execute one instruction and read back R0-R3 + flags. */
function step(
  insn: number,
  opts?: { r0?: number; r1?: number; r2?: number; r3?: number; sp?: number; c?: boolean }
) {
  const { chip, core } = setup();
  if (opts?.r0 !== undefined) core.regs.r[0] = opts.r0 >>> 0;
  if (opts?.r1 !== undefined) core.regs.r[1] = opts.r1 >>> 0;
  if (opts?.r2 !== undefined) core.regs.r[2] = opts.r2 >>> 0;
  if (opts?.r3 !== undefined) core.regs.r[3] = opts.r3 >>> 0;
  if (opts?.sp !== undefined) core.regs.sp = opts.sp >>> 0;
  if (opts?.c !== undefined) core.regs.C = opts.c;
  put16(chip, SRAM, insn);
  // Pad subsequent halfwords with NOP to be safe.
  put16(chip, SRAM + 2, 0xbf00);
  put16(chip, SRAM + 4, 0xbf00);
  core.executeInstruction();
  return {
    r0: core.regs.r[0],
    r1: core.regs.r[1],
    r2: core.regs.r[2],
    r3: core.regs.r[3],
    sp: core.regs.sp,
    pc: core.regs.pc,
    N: core.regs.N,
    Z: core.regs.Z,
    C: core.regs.C,
    V: core.regs.V,
    cycles: core.cycles,
  };
}

describe('Cortex-M33 Thumb-16 instruction execution', () => {
  describe('Data processing — immediate', () => {
    it('MOVS r0, #imm8', () => {
      const r = step(0x2042); // MOVS r0, #0x42
      expect(r.r0).toBe(0x42);
      expect(r.Z).toBe(false);
      expect(r.N).toBe(false);
    });
    it('MOVS r0, #0 sets Z', () => {
      const r = step(0x2000);
      expect(r.r0).toBe(0);
      expect(r.Z).toBe(true);
    });
    it('CMP r0, #imm8 sets flags correctly', () => {
      const r = step(0x2805, { r0: 10 }); // CMP r0, #5
      expect(r.Z).toBe(false);
      expect(r.C).toBe(true); // 10 >= 5
    });
    it('ADDS r0, #imm8', () => {
      const r = step(0x3010, { r0: 5 }); // ADDS r0, #0x10
      expect(r.r0).toBe(0x15);
    });
    it('SUBS r0, #imm8', () => {
      const r = step(0x3810, { r0: 0x20 }); // SUBS r0, #0x10
      expect(r.r0).toBe(0x10);
    });
  });

  describe('Data processing — register', () => {
    it('ADDS r0, r1, r2 (T1)', () => {
      const r = step(0x1888, { r1: 7, r2: 11 }); // ADDS r0, r1, r2
      // 0x1888 = 0001100 010 001 000 → ADDS Rd, Rn, Rm with Rm=r2,Rn=r1,Rd=r0
      expect(r.r0).toBe(18);
    });
    it('SUBS r0, r1, r2 (T1)', () => {
      const r = step(0x1a88, { r1: 30, r2: 12 }); // SUBS r0, r1, r2
      expect(r.r0).toBe(18);
    });
    it('ANDS r0, r1 (T2)', () => {
      const r = step(0x4008, { r0: 0xf0, r1: 0x3c }); // ANDS r0, r1
      expect(r.r0).toBe(0x30);
    });
    it('EORS r0, r1', () => {
      const r = step(0x4048, { r0: 0xff, r1: 0x0f }); // EORS r0, r1
      expect(r.r0).toBe(0xf0);
    });
    it('LSLS r0, r1, #2 (immediate)', () => {
      const r = step(0x0088, { r1: 0x3 }); // LSLS r0, r1, #2
      expect(r.r0).toBe(0xc);
    });
    it('LSRS r0, r1, #3 (immediate)', () => {
      const r = step(0x08c8, { r1: 0xff }); // LSRS r0, r1, #3
      expect(r.r0).toBe(0x1f);
    });
    it('MULS r0, r1', () => {
      const r = step(0x4348, { r0: 7, r1: 6 }); // MULS r0, r1
      expect(r.r0).toBe(42);
    });
    it('CMP r0, r1 (T1)', () => {
      const r = step(0x4288, { r0: 5, r1: 5 }); // CMP r0, r1
      expect(r.Z).toBe(true);
    });
  });

  // Register shift / carry-flag edge cases. Each instruction
  // is the 0b010000 data-processing register form: Rm = bits[5:3], Rdn = bits[2:0].
  //   LSLS r0,r1=0x4088  LSRS r0,r1=0x40C8  ASRS r0,r1=0x4108
  //   SBCS r0,r1=0x4188  ROR  r0,r1=0x41C8
  describe('Register shift / carry edge cases', () => {
    it('LSRS (register) by 0 leaves the result and C unchanged', () => {
      const r = step(0x40c8, { r0: 0x40000000, r1: 0, c: true });
      expect(r.r0).toBe(0x40000000);
      expect(r.C).toBe(true);
    });
    it('LSRS (register) by 4 still computes result + carry correctly', () => {
      const r = step(0x40c8, { r0: 0xff, r1: 4, c: false });
      expect(r.r0).toBe(0xf);
      expect(r.C).toBe(true); // last shifted-out bit (bit 3 of 0xff) = 1
    });

    it('ASRS (register) by 0 leaves the result and C unchanged', () => {
      const r = step(0x4108, { r0: 0x40000000, r1: 0, c: true });
      expect(r.r0).toBe(0x40000000);
      expect(r.C).toBe(true);
    });
    it('ASRS (register) by >=32 sign-extends and sets C from the sign bit', () => {
      const r = step(0x4108, { r0: 0x80000000, r1: 32, c: false });
      expect(r.r0).toBe(0xffffffff >>> 0);
      expect(r.C).toBe(true); // negative input → carry
    });

    it('ROR (register) by 0 leaves the result and C unchanged', () => {
      const r = step(0x41c8, { r0: 0x40000000, r1: 0, c: true });
      expect(r.r0).toBe(0x40000000);
      expect(r.C).toBe(true);
    });
    it('ROR (register) by 32 (non-zero, multiple of 32) sets C from bit31', () => {
      const r = step(0x41c8, { r0: 0x40000000, r1: 32, c: true });
      expect(r.r0).toBe(0x40000000);
      expect(r.C).toBe(false); // bit31 of input is 0
    });

    it('LSLS (register) by >32 yields result 0 and C=0', () => {
      const r = step(0x4088, { r0: 0xffffffff, r1: 33, c: true });
      expect(r.r0).toBe(0);
      expect(r.C).toBe(false);
    });
    it('LSLS (register) by 0 leaves the result and C unchanged', () => {
      const r = step(0x4088, { r0: 0xff, r1: 0, c: true });
      expect(r.r0).toBe(0xff);
      expect(r.C).toBe(true);
    });
    it('LSLS (register) by 32 sets C from bit0', () => {
      const r = step(0x4088, { r0: 1, r1: 32, c: false });
      expect(r.r0).toBe(0);
      expect(r.C).toBe(true);
    });

    it('SBCS carry is 0 when Rm=0xFFFFFFFF and C=0', () => {
      // r0 = r0 - r1 - NOT(C) = 5 - 0xFFFFFFFF - 1 = 5 (mod 2^32); borrow → C=0.
      const r = step(0x4188, { r0: 5, r1: 0xffffffff, c: false });
      expect(r.r0).toBe(5);
      expect(r.C).toBe(false);
    });
    it('SBCS normal subtract: no-borrow keeps C=1, borrow clears C', () => {
      // 10 - 3 - 0 (C=1) = 7, no borrow → C=1.
      expect(step(0x4188, { r0: 10, r1: 3, c: true }).r0).toBe(7);
      // 3 - 10 - 0 = -7 → 0xFFFFFFF9, borrow → C=0.
      const borrow = step(0x4188, { r0: 3, r1: 10, c: true });
      expect(borrow.r0).toBe(0xfffffff9 >>> 0);
      expect(borrow.C).toBe(false);
    });
  });

  describe('Memory access', () => {
    it('STR r0, [sp, #0] then LDR r1, [sp, #0]', () => {
      const { chip, core } = setup();
      core.regs.sp = SRAM + 0x100;
      core.regs.r[0] = 0xdeadbeef;
      put16(chip, SRAM, 0x9000); // STR r0, [sp, #0]
      put16(chip, SRAM + 2, 0x9900); // LDR r1, [sp, #0]
      put16(chip, SRAM + 4, 0xbf00); // NOP
      core.executeInstruction();
      core.executeInstruction();
      expect(core.regs.r[1]).toBe(0xdeadbeef >>> 0);
    });
    it('LDR (literal) loads PC-relative word', () => {
      const { chip, core } = setup();
      // LDR r0, [pc, #imm] reads from (PC+4) & ~3 + imm where PC is the LDR
      // instruction's address. In the executor, after the +2 PC advance,
      // PC = opcodePC + 2. nextPC = PC + 2 = opcodePC + 4. Aligned + imm.
      //
      // Place LDR at SRAM. We want to load from SRAM+8. With imm8=1 (<<2 = 4):
      // address = ((SRAM+4) & ~3) + 4 = SRAM + 4 + 4 = SRAM + 8. ✓
      put16(chip, SRAM, 0x4801); // LDR r0, [pc, #4]
      put16(chip, SRAM + 2, 0x0000); // padding so PC-aligned fetch is harmless
      // Place target data at SRAM + 8.
      chip.writeUint32(SRAM + 8, 0x12345678);
      core.executeInstruction();
      expect(core.regs.r[0]).toBe(0x12345678 >>> 0);
    });

    it('STR/LDR r0, [r1, #0] round-trip through an unaligned (non-word-aligned) address', () => {
      // The M33 permits LDR/STR (single) to access unaligned addresses in
      // Normal memory (ARMv8-M ARM B8.3 / RP2350 datasheet) — unlike
      // LDM/LDRD, which require alignment and fault otherwise.
      const { chip, core } = setup();
      core.regs.r[1] = SRAM + 0x101; // not 4-byte aligned
      core.regs.r[0] = 0xcafebabe;
      put16(chip, SRAM, 0x6008); // STR r0, [r1, #0]
      put16(chip, SRAM + 2, 0x680a); // LDR r2, [r1, #0]
      core.executeInstruction();
      core.executeInstruction();
      expect(core.regs.r[2]).toBe(0xcafebabe >>> 0);
    });

    it('STRH/LDRH r0, [r1, #0] round-trip through an unaligned (odd) address', () => {
      const { chip, core } = setup();
      core.regs.r[1] = SRAM + 0x101; // odd address
      core.regs.r[0] = 0xbabe;
      put16(chip, SRAM, 0x8008); // STRH r0, [r1, #0]
      put16(chip, SRAM + 2, 0x880a); // LDRH r2, [r1, #0]
      core.executeInstruction();
      core.executeInstruction();
      expect(core.regs.r[2]).toBe(0xbabe);
    });
  });

  describe('Branch instructions', () => {
    it('B (unconditional T2) takes the branch', () => {
      const { chip, core } = setup();
      put16(chip, SRAM, 0xe004); // B +imm where imm = signext(imm11<<1)
      put16(chip, SRAM + 2, 0xbf00);
      core.executeInstruction();
      // 0xe004 imm11=4, offset=8. Target = opcodePC + 4 + 8 = SRAM + 12
      // (the +4 is the standard "PC ahead" for 16-bit branches).
      expect(core.regs.pc).toBe(SRAM + 12);
    });
    it('B (cond) EQ not taken when Z=0', () => {
      const { chip, core } = setup();
      put16(chip, SRAM, 0xd004); // BEQ +4
      core.regs.Z = false;
      core.executeInstruction();
      // Not taken: PC = SRAM + 2 (just the 16-bit increment).
      expect(core.regs.pc).toBe(SRAM + 2);
    });
    it('B (cond) EQ taken when Z=1', () => {
      const { chip, core } = setup();
      put16(chip, SRAM, 0xd004); // BEQ +4
      core.regs.Z = true;
      core.executeInstruction();
      expect(core.regs.pc).toBe(SRAM + 2 + ((0x04 << 1) + 2));
    });
  });

  describe('M33-only Thumb-16 instructions', () => {
    it('CBZ r0 jumps when r0 is zero', () => {
      const { chip, core } = setup();
      // CBZ r0, +8: encoding = 0xb100 | (p<<11) | (i<<9) | (imm5<<3) | Rn
      // For offset 8: i:imm5:0 = 8 → i:imm5 = 4 → i=0, imm5=4. Rn=0.
      // 0xb100 | (4 << 3) = 0xb120.
      put16(chip, SRAM, 0xb120);
      core.regs.r[0] = 0;
      core.executeInstruction();
      // PC = opcodePC + 4 + 8 = SRAM + 12.
      expect(core.regs.pc).toBe(SRAM + 12);
    });
    it('CBZ r0 does not jump when r0 is nonzero', () => {
      const { chip, core } = setup();
      put16(chip, SRAM, 0xb120);
      core.regs.r[0] = 1;
      core.executeInstruction();
      expect(core.regs.pc).toBe(SRAM + 2);
    });
    it('CBNZ r0 jumps when r0 is nonzero', () => {
      const { chip, core } = setup();
      // CBNZ r0, +8 → 0xb920 (set bit 11 for nonzero).
      put16(chip, SRAM, 0xb920);
      core.regs.r[0] = 7;
      core.executeInstruction();
      expect(core.regs.pc).toBe(SRAM + 12);
    });
    it('IT instruction loads IT state', () => {
      const { chip, core } = setup();
      // IT EQ → 0xbfnf & 0xff: cond=EQ(0), mask=8 → 0xbf08.
      put16(chip, SRAM, 0xbf08);
      core.executeInstruction();
      expect(core.regs.itState).toBe(0x08);
    });

    // ITE NE (0xBF14): 1st instruction runs on NE, 2nd (else) on EQ. Uses
    // flag-neutral high-register MOVs (MOV r0,r2 / MOV r0,r3) so the tested
    // condition is not perturbed mid-block.
    function runIteNe(z: boolean): number {
      const { chip, core } = setup();
      core.regs.Z = z;
      core.regs.r[2] = 1;
      core.regs.r[3] = 2;
      core.regs.r[0] = 0;
      put16(chip, SRAM + 0, 0xbf14); // ITE NE
      put16(chip, SRAM + 2, 0x4610); // MOV r0, r2  (then / NE)
      put16(chip, SRAM + 4, 0x4618); // MOV r0, r3  (else / EQ)
      core.executeInstruction(); // IT
      core.executeInstruction(); // then
      core.executeInstruction(); // else
      return core.regs.r[0];
    }
    it('ITE NE executes only the THEN instruction when NE holds (Z=0)', () => {
      expect(runIteNe(false)).toBe(1);
    });
    it('ITE NE executes only the ELSE instruction when NE fails (Z=1)', () => {
      expect(runIteNe(true)).toBe(2);
    });

    // Several 16-bit encodings (ADDS/SUBS/ADCS/SBCS/ANDS/ORRS/EORS/BICS/MVNS/
    // MOVS/MULS/NEGS/LSLS/LSRS/ASRS/RORS — everything except CMN/CMP/TST)
    // suppress flag-setting when executed inside an IT block per ARMv8-M
    // ("setflags = !InITBlock()"), even though the raw 16-bit encoding is
    // identical to the always-flag-setting form used outside an IT block.
    it('ADDS inside "it eq" does not clobber Z when the condition passes', () => {
      const { chip, core } = setup();
      core.regs.Z = true; // "eq" condition holds
      core.regs.r[0] = 0;
      put16(chip, SRAM, 0xbf08); // IT EQ (1-instruction block)
      put16(chip, SRAM + 2, 0x3004); // ADDS r0, #4 (raw encoding; "addeq" in this IT context)
      put16(chip, SRAM + 4, 0xbf00); // NOP
      core.executeInstruction(); // IT
      core.executeInstruction(); // addeq r0,#4 — should execute (Z=true) but not touch flags
      expect(core.regs.r[0]).toBe(4); // condition passed, so the add did happen
      expect(core.regs.Z).toBe(true); // ...but flags must be unaffected
    });

    it('ADDS outside an IT block still sets flags normally', () => {
      const { chip, core } = setup();
      core.regs.Z = true;
      core.regs.r[0] = 0;
      put16(chip, SRAM, 0x3004); // ADDS r0, #4 (no IT block active)
      core.executeInstruction();
      expect(core.regs.r[0]).toBe(4);
      expect(core.regs.Z).toBe(false); // result is nonzero -> normal flag update
    });

    it('CPSID i (0xB672) sets PRIMASK', () => {
      const { chip, core } = setup();
      core.regs.primask = 0;
      put16(chip, SRAM, 0xb672);
      core.executeInstruction();
      expect(core.regs.primask).toBe(1);
    });
    it('CPSIE i (0xB662) clears PRIMASK', () => {
      const { chip, core } = setup();
      core.regs.primask = 1;
      put16(chip, SRAM, 0xb662);
      core.executeInstruction();
      expect(core.regs.primask).toBe(0);
    });
    it('CPSID f (0xB671) sets FAULTMASK without touching PRIMASK', () => {
      const { chip, core } = setup();
      core.regs.primask = 0;
      core.regs.faultmask = 0;
      put16(chip, SRAM, 0xb671);
      core.executeInstruction();
      expect(core.regs.faultmask).toBe(1);
      expect(core.regs.primask).toBe(0);
    });
  });

  describe('Stack operations', () => {
    it('PUSH {r0} / POP {r1} round-trips a value', () => {
      const { chip, core } = setup();
      core.regs.sp = SRAM + 0x100;
      core.regs.r[0] = 0x1234abcd;
      put16(chip, SRAM, 0xb401); // PUSH {r0}
      put16(chip, SRAM + 2, 0xbc02); // POP {r1}
      core.executeInstruction();
      core.executeInstruction();
      expect(core.regs.r[1]).toBe(0x1234abcd >>> 0);
    });
    it('PUSH {lr} / POP {pc} restores PC', () => {
      const { chip, core } = setup();
      core.regs.sp = SRAM + 0x100;
      core.regs.lr = 0x20000100;
      put16(chip, SRAM, 0xb500); // PUSH {lr}
      put16(chip, SRAM + 2, 0xbd00); // POP {pc}
      put16(chip, SRAM + 0x100 - 4, 0x0000);
      put16(chip, SRAM + 0x100 - 2, 0x2000);
      core.executeInstruction();
      core.executeInstruction();
      expect(core.regs.pc).toBe(0x20000100 & ~1);
    });
  });

  describe('Misc instructions', () => {
    it('NOP executes without changing anything', () => {
      const r = step(0xbf00, { r0: 0x42 });
      expect(r.r0).toBe(0x42);
      expect(r.pc).toBe(SRAM + 2);
    });
    it('REV r0, r1', () => {
      const r = step(0xba08, { r1: 0x11223344 }); // REV r0, r1
      expect(r.r0).toBe(0x44332211);
    });
    it('SXTB r0, r1 sign-extends low byte', () => {
      // SXTB r0, r1 = 0xb248 (Rm=r1=001, Rd=r0=000).
      const r = step(0xb248, { r1: 0x80 });
      expect(r.r0).toBe(0xffffff80 >>> 0);
    });
    it('MOV (high) r0, r1 — wide encoding', () => {
      // MOV r0, r1 = 0x4608 (Rm=r1=0001, Rd_lo=r0=000, D=0).
      const r = step(0x4608, { r1: 0x1234 });
      expect(r.r0).toBe(0x1234);
    });
    it('BX lr returns from a function call', () => {
      const { chip, core } = setup();
      core.regs.lr = SRAM + 0x100;
      put16(chip, SRAM, 0x4770); // BX lr
      core.executeInstruction();
      expect(core.regs.pc).toBe((SRAM + 0x100) & ~1);
    });
  });

  // ---- Thumb-16 misc ----
  describe('Thumb-16 misc', () => {
    it('ADD SP, SP, Rm does not force-align the SP result to 4 bytes', () => {
      // ADD (SP + register, high) T1: 0b01000100 D Rm Rdn.
      // ADD SP, SP, r0: D=1(SP→high), Rm=r0, Rdn_lo=5(SP=8+5).
      // opcode = 0x4400 | (1<<7) | (0<<3) | 5 = 0x4485.
      const r = step(0x4485, { sp: 0x20000001, r0: 2 });
      expect(r.sp).toBe(0x20000003); // raw sum, no &~0x3 alignment
    });

    it('MOV PC, Rm with EXC_RETURN triggers exception return', () => {
      // MOV (high register, T1) with Rd=PC and an EXC_RETURN value should
      // trigger exception return (like BX), not just write to PC.
      const { chip, core } = setup();
      chip.currentCore = 0;
      chip.writeUint32(0xe000ed08, SRAM); // VTOR
      // Set up as if we just entered a handler: IPSR=16 (IRQ 0), in Handler mode.
      core.regs.xpsr = (core.regs.xpsr & ~0x1ff) | 16;
      // We need to be in Handler mode for exceptionReturn to fire.
      // The bxWritePC checks inHandlerMode() and address>>>24 === 0xff.
      core.regs.r[0] = 0xfffffff9; // EXC_RETURN: return to Thread / MSP / no FP
      // Stack a basic frame so exceptionReturn has something to pop.
      const frameSp = SRAM + 0x1000;
      core.regs.msp = frameSp;
      core.regs.sp = frameSp; // r[13] must match MSP in Handler mode for banking
      chip.writeUint32(frameSp + 0, 0); // r0
      chip.writeUint32(frameSp + 4, 0); // r1
      chip.writeUint32(frameSp + 8, 0); // r2
      chip.writeUint32(frameSp + 12, 0); // r3
      chip.writeUint32(frameSp + 16, 0); // r12
      chip.writeUint32(frameSp + 20, 0); // lr
      chip.writeUint32(frameSp + 24, SRAM + 0x200); // return PC
      chip.writeUint32(frameSp + 28, 0x01000000); // xPSR (T-bit set)
      // MOV PC, R0: 0b01000110 D=1 Rm=r0 Rdn_lo=111 → opcode=0x4687.
      put16(chip, SRAM, 0x4687);
      core.PC = SRAM;
      core.executeInstruction();
      // Should have returned to Thread mode at the stacked PC.
      expect(core.regs.ipsr).toBe(0); // Thread mode
      expect(core.PC).toBe(SRAM + 0x200);
    });
  });
});
