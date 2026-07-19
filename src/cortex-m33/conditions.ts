import { M33Registers } from './registers';

/**
 * Evaluate an ARM condition code (cond[3:0]) against the current APSR flags.
 *
 * Table per ARMv7-M Architecture Reference Manual §A8.3 (identical on ARMv8-M).
 * cond >= 0xE (AL / unconditional-with-IT-suffix) always passes.
 *
 * @param regs  current register file
 * @param cond  condition code nibble (0x0..0xF)
 * @returns true if the instruction should execute
 */
export function conditionPassed(regs: M33Registers, cond: number): boolean {
  switch (cond & 0xf) {
    case 0x0:
      return regs.Z; // EQ
    case 0x1:
      return !regs.Z; // NE
    case 0x2:
      return regs.C; // CS / HS
    case 0x3:
      return !regs.C; // CC / LO
    case 0x4:
      return regs.N; // MI
    case 0x5:
      return !regs.N; // PL
    case 0x6:
      return regs.V; // VS
    case 0x7:
      return !regs.V; // VC
    case 0x8:
      return regs.C && !regs.Z; // HI
    case 0x9:
      return !regs.C || regs.Z; // LS
    case 0xa:
      return regs.N === regs.V; // GE
    case 0xb:
      return regs.N !== regs.V; // LT
    case 0xc:
      return !regs.Z && regs.N === regs.V; // GT
    case 0xd:
      return regs.Z || regs.N !== regs.V; // LE
    case 0xe:
      return true; // AL
    default:
      return true; // 0xF — unconditional or IT-suffix escape
  }
}
