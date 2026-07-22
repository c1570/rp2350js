/**
 * Cortex-M33 FPU (CP10/CP11, VFPv5-SP) instruction executor.
 *   Sd = (Vd << 1) | D  where Vd=hw1[15:12], D=hw0[6]
 *   Sn = (Vn << 1) | N  where Vn=hw0[3:0],   N=hw1[7]
 *   Sm = (Vm << 1) | M  where Vm=hw1[3:0],    M=hw1[5]
 */

import { CortexM33Core } from './core';
import * as fpu from './fpu-helpers';

function getSd(hw0: number, hw1: number): number {
  return (((hw1 >>> 12) & 0xf) << 1) | ((hw0 >>> 6) & 1);
}
function getSn(hw0: number, hw1: number): number {
  return ((hw0 & 0xf) << 1) | ((hw1 >>> 7) & 1);
}
function getSm(hw0: number, hw1: number): number {
  return ((hw1 & 0xf) << 1) | ((hw1 >>> 5) & 1);
}

export function fpuExecute(core: CortexM33Core, hw0: number, hw1: number): number {
  const regs = core.regs;
  let fpscr = regs.fpscr;
  const coproc = (hw1 >>> 8) & 0xf;
  if (coproc !== 10 && coproc !== 11) return -1;

  // CPACR check.
  if ((core.ppb().cpacr & (0x3 << 20)) !== 0x3 << 20) {
    core.ppb().cfsr |= 1 << 21; // NOCP
    return -1; // caller dispatches UsageFault via pendingFault
  }

  // Three-register data processing: hw0[7:4] = opc1 (VADD/VSUB opc1=0x3 with
  // hw1[6] distinguishing add/sub, VMUL opc1=0x2, VDIV opc1=0x8). Bit1 of
  // this nibble is hw0 bit6, the D bit from Sd's encoding (see getSd), not
  // part of the opcode — mask it out, or an odd Sd flips VDIV's opc1
  // (0b1000) to 0b1100 and the dispatch below is missed entirely.
  const opc1 = (hw0 >>> 4) & 0xb;

  // Three-register arithmetic: only for data-processing prefix (hw0[15:8]=0xee).
  if ((hw0 & 0xff00) === 0xee00 && (opc1 === 0x3 || opc1 === 0x2 || opc1 === 0x8)) {
    const sd = getSd(hw0, hw1);
    const sn = getSn(hw0, hw1);
    const sm = getSm(hw0, hw1);
    const a = regs.s[sn];
    const b = regs.s[sm];
    let result: number;
    if (opc1 === 0x3) {
      // VADD (hw1[6]=0) or VSUB (hw1[6]=1).
      const sub = (hw1 & 0x40) !== 0;
      [result, fpscr] = sub ? fpu.f32sub(fpscr, a, b) : fpu.f32add(fpscr, a, b);
    } else if (opc1 === 0x2) {
      // VMUL (hw1[6]=0) or VNMUL (hw1[6]=1). The negate is a pure sign flip
      // applied after the multiply (no exception-flag change), per FPNeg §A2.2.6.
      const negate = (hw1 & 0x40) !== 0;
      [result, fpscr] = fpu.f32mul(fpscr, a, b);
      if (negate) result = -result;
    } else {
      // VDIV.
      [result, fpscr] = fpu.f32div(fpscr, a, b);
    }
    regs.s[sd] = Math.fround(result);
    regs.fpscr = fpscr;
    return 1;
  }

  // Fused multiply-add family: VFMA/VFMS (opc1=0xa) and VFNMA/VFNMS
  // (opc1=0x9), same D-bit-masked `opc1` as the three-register group above.
  // hw1[6] negates the product in both families; opc1=0x9 additionally
  // negates the addend:
  //   Sd = Sd + Sn*Sm       (VFMA,  opc1=0xa, hw1[6]=0)
  //   Sd = Sd + (-Sn)*Sm    (VFMS,  opc1=0xa, hw1[6]=1)
  //   Sd = -Sd + (-Sn)*Sm   (VFNMA, opc1=0x9, hw1[6]=1)
  //   Sd = -Sd + Sn*Sm      (VFNMS, opc1=0x9, hw1[6]=0)
  // opc1=0xa also matches VMSR (hw0=0xeee1's D-masked nibble is also 0xa),
  // so this additionally requires hw1[4]=0, the data-processing/
  // register-transfer discriminator.
  if ((hw0 & 0xff00) === 0xee00 && (opc1 === 0xa || opc1 === 0x9) && (hw1 & 0x10) === 0) {
    const sd = getSd(hw0, hw1);
    const sn = getSn(hw0, hw1);
    const sm = getSm(hw0, hw1);
    const negateAddend = opc1 === 0x9; // VFNMA/VFNMS
    const negateProduct = (hw1 & 0x40) !== 0; // VFMS/VFNMA (hw1[6]=1 in both families)
    [regs.s[sd], fpscr] = fpu.f32fma(
      fpscr,
      regs.s[sd],
      regs.s[sn],
      regs.s[sm],
      negateAddend,
      negateProduct
    );
    regs.fpscr = fpscr;
    return 1;
  }

  // hw0[7:4] = 0xb: VMOV imm (hw1[6]=0) or unary/misc (hw1[6]=1), only for
  // the data-processing prefix (hw0[15:8]=0xee). The group check masks OUT
  // bit6 (the D bit from Sd's encoding, see getSd) rather than comparing the
  // whole nibble — comparing the raw nibble only matches 0xb when Sd is even
  // (D=0) and misses every odd-Sd unary op (VABS/VNEG/VSQRT/VMOV/VCMP). The
  // broadened bit7/5/4 mask is also satisfied by VMRS/VMOV-Rt<->Sn
  // (register-transfer, e.g. VMRS hw0=0xeef1), so this additionally requires
  // hw1[4]=0, the data-processing/register-transfer discriminator.
  if ((hw0 & 0xff00) === 0xee00 && (hw0 & 0xb0) === 0xb0 && (hw1 & 0x10) === 0) {
    const op2Lo = (hw1 >>> 6) & 1;
    const sd = getSd(hw0, hw1);
    const sm = getSm(hw0, hw1);

    if (op2Lo === 0) {
      // VMOV.F32 Sd, #imm. imm8 = (hw0[3:0] << 4) | hw1[3:0].
      const imm8 = ((hw0 & 0xf) << 4) | (hw1 & 0xf);
      const sign = (imm8 >>> 7) & 1;
      const b = (imm8 >>> 6) & 1;
      const notB = b ^ 1;
      const repB = b ? 0x1f : 0;
      const payload = imm8 & 0x3f;
      const bits = ((sign << 31) | (notB << 30) | (repB << 25) | (payload << 19)) >>> 0;
      const buf = new ArrayBuffer(4);
      new DataView(buf).setUint32(0, bits, true);
      regs.s[sd] = new DataView(buf).getFloat32(0, true);
      return 1;
    }

    // Unary/misc: opcode = (hw0[3:0], hw1[7]).
    const opc3 = hw0 & 0xf;
    const nBit = (hw1 >>> 7) & 1;
    let result: number;
    if (opc3 === 0 && nBit === 1) {
      result = Math.fround(Math.abs(regs.s[sm]));
      regs.s[sd] = result;
    } else if (opc3 === 1 && nBit === 1) {
      [result, fpscr] = fpu.f32sqrt(fpscr, regs.s[sm]);
      regs.s[sd] = result;
    } else if (opc3 === 1 && nBit === 0) {
      result = Math.fround(-regs.s[sm]);
      regs.s[sd] = result;
    } else if (opc3 === 4 || opc3 === 5) {
      // VCMP.F32 Sd, Sm (opc3=4) or VCMP.F32 Sd, #0.0 (opc3=5, Sm field
      // unused/must be 0). hw1[7] additionally distinguishes VCMP from the
      // signaling-NaN VCMPE form in both cases; not modeled — same
      // simplification the existing register-register VCMP already made
      // (f32cmp treats every NaN as invalid regardless of E).
      const operand2 = opc3 === 5 ? 0 : regs.s[sm];
      fpscr = fpu.f32cmp(fpscr, regs.s[sd], operand2);
    } else if (opc3 === 0 && nBit === 0) {
      regs.s[sd] = regs.s[sm];
    } else if (opc3 === 0x8) {
      // VCVT.F32.{U32,S32} Sd, Sm — int-to-float. `regs.s[sm]` holds the
      // source as a bit-reinterpreted integer (however it got there, e.g. a
      // preceding `VMOV Sm, Rt`), not a real float value, so reinterpret its
      // bits as an integer before converting — Math.fround(regs.s[sm]) would
      // wrongly treat the bit pattern as if it were already a float.
      // hw1[7]: 1 = signed (S32), 0 = unsigned (U32).
      const signed = (hw1 >>> 7) & 1;
      const buf = new ArrayBuffer(4);
      const dv = new DataView(buf);
      dv.setFloat32(0, regs.s[sm], true);
      const bits = dv.getUint32(0, true);
      regs.s[sd] = Math.fround(signed ? bits | 0 : bits >>> 0);
    } else if (opc3 === 0xa) {
      // VCVT.F32.{S32,U32} Sd, Sm, #fbits — fixed-point-to-float (the
      // "integer" form opc3=0x8 does no scaling). hw1[7]=1 signed, 0 unsigned.
      // fbits = 32 - esc, esc = 2*hw1[3:0] + hw1[5]. The source operand is
      // bit-reinterpreted from Sm; for this encoding Sm shares fields with
      // the scale so we use Sd as Sm (matches all firmware instances).
      const signed = (hw1 >>> 7) & 1;
      const esc = 2 * (hw1 & 0xf) + ((hw1 >>> 5) & 1);
      const fbits = 32 - esc;
      const src = regs.s[sd];
      const buf = new ArrayBuffer(4);
      const dv = new DataView(buf);
      dv.setFloat32(0, src, true);
      const bits = dv.getUint32(0, true);
      const intVal = signed ? bits | 0 : bits >>> 0;
      const scale = Math.pow(2, fbits);
      regs.s[sd] = Math.fround(intVal / scale);
      regs.fpscr = fpscr;
      return 1;
    } else if (opc3 === 0xc || opc3 === 0xd) {
      // VCVT.{U32,S32}.F32 Sd, Sm — float-to-int, round-toward-zero form
      // (hw1[7]=1; the FPSCR-rounding-mode "VCVTR" form is hw1[7]=0 and isn't
      // implemented — real toolchains emit round-toward-zero for C-style
      // int-truncation semantics, which is what MicroPython/CPython need).
      // opc3 bit0: 0=unsigned dest (U32, 0xc), 1=signed dest (S32, 0xd).
      // Per ARM FPToFixed: NaN converts to 0 (+IOC); out-of-range saturates
      // to the destination type's min/max (+IOC).
      const signed = opc3 === 0xd;
      const src = regs.s[sm];
      let intVal: number;
      if (Number.isNaN(src)) {
        intVal = 0;
        fpscr |= fpu.FPSCR_IOC;
      } else {
        const truncated = Math.trunc(src);
        const [min, max] = signed ? [-0x80000000, 0x7fffffff] : [0, 0xffffffff];
        if (truncated < min) {
          intVal = min;
          fpscr |= fpu.FPSCR_IOC;
        } else if (truncated > max) {
          intVal = max;
          fpscr |= fpu.FPSCR_IOC;
        } else {
          intVal = truncated;
        }
      }
      const buf = new ArrayBuffer(4);
      const dv = new DataView(buf);
      dv.setUint32(0, intVal >>> 0, true);
      // Sd stores the integer result bit-reinterpreted as a float, matching
      // the same convention `regs.s[]` already uses elsewhere in this file
      // (e.g. VMOV Sn,Rt) — a later `VMOV Rt, Sd` reads it back out.
      regs.s[sd] = dv.getFloat32(0, true);
    } else {
      return -1;
    }
    regs.fpscr = fpscr;
    return 1;
  }

  // MCRR/MRRC VMOV (two ARM regs ↔ two FP regs). hw0[7:4]=0100 (MCRR, ARM→FP)
  // or 0101 (MRRC, FP→ARM). opc1=hw1[7:4]=1, CRm=hw1[3:0] encodes the starting
  // S register. Rt2=hw0[3:0], Rt=hw1[15:12], coproc=hw1[11:8]=10.
  if (((hw0 & 0xfff0) === 0xec40 || (hw0 & 0xfff0) === 0xec50) && coproc === 10) {
    const isLoad = (hw0 >>> 4) & 1; // 0=MCRR(ARM→FP), 1=MRRC(FP→ARM)
    const rt = (hw1 >>> 12) & 0xf;
    const rt2 = hw0 & 0xf;
    const crm = hw1 & 0xf;
    const sn = ((crm & 1) << 4) | ((crm >>> 1) << 1);
    const sm = sn + 1;
    const buf = new ArrayBuffer(4);
    const dv = new DataView(buf);
    if (isLoad) {
      // MRRC: FP → ARM
      dv.setFloat32(0, regs.s[sn], true);
      regs.r[rt] = dv.getUint32(0, true);
      dv.setFloat32(0, regs.s[sm], true);
      regs.r[rt2] = dv.getUint32(0, true);
    } else {
      // MCRR: ARM → FP
      dv.setUint32(0, regs.r[rt] >>> 0, true);
      regs.s[sn] = dv.getFloat32(0, true);
      dv.setUint32(0, regs.r[rt2] >>> 0, true);
      regs.s[sm] = dv.getFloat32(0, true);
    }
    return 1;
  }

  // Register-transfer group: hw0[11:8]=0xE with hw1[4]=1 (the MCR/MRC form).
  // opc_hi = hw0[7:5]: 0b111 → VMRS/VMSR (FPSCR), else VMOV Sn<->Rt.
  // The L bit hw0[4] selects direction (0 = ARM→coproc, 1 = coproc→ARM).
  if ((hw0 & 0x0f00) === 0x0e00 && (hw1 & 0x10) !== 0) {
    const opcHi = (hw0 >>> 5) & 0x7;
    const l = (hw0 >>> 4) & 1;
    const rt = (hw1 >>> 12) & 0xf;
    if (opcHi === 0b111) {
      // VMRS (L=1) / VMSR (L=0).
      if (l === 1) {
        if (rt === 15) {
          // VMRS APSR_nzcv, FPSCR — copy FPSCR NZCV into APSR.
          const f = fpu.getFpscrNzcv(fpscr);
          regs.xpsr =
            (regs.xpsr & ~0xf0000000) |
            (f.N ? 0x80000000 : 0) |
            (f.Z ? 0x40000000 : 0) |
            (f.C ? 0x20000000 : 0) |
            (f.V ? 0x10000000 : 0);
        } else {
          regs.r[rt] = fpscr;
        }
      } else {
        regs.fpscr = regs.r[rt];
      }
      return 2;
    }
    // VMOV Sn, Rt (L=0) / VMOV Rt, Sn (L=1). Sn is independent of Rt.
    const sn = getSn(hw0, hw1);
    const buf = new ArrayBuffer(4);
    if (l === 0) {
      new DataView(buf).setUint32(0, regs.r[rt], true);
      regs.s[sn] = new DataView(buf).getFloat32(0, true);
    } else {
      new DataView(buf).setFloat32(0, regs.s[sn], true);
      regs.r[rt] = new DataView(buf).getUint32(0, true);
    }
    return 1;
  }

  // VLDR/VSTR (single register). Encoding: hw0 = 1110_1101_P_U_D_W_L_Rn with
  // P=1, W=0 (bits[15:8]=0xED, bit5=0). U=hw0[7] selects add/subtract, D=hw0[6]
  // is part of Sd, L=hw0[4] is load/store. (VPUSH has W=1 so is excluded here.)
  if ((hw0 & 0xff00) === 0xed00 && (hw0 & 0x20) === 0) {
    const isLoad = (hw0 & 0x10) !== 0; // L bit
    const u = (hw0 & 0x80) !== 0; // U bit (add/subtract), NOT a low Rn bit
    const sd = getSd(hw0, hw1);
    const rn = hw0 & 0xf;
    const imm8 = hw1 & 0xff;
    const offset = imm8 << 2;
    // PC-relative uses Align(PC,4); regs.pc already reads as opcodePC+4.
    const base = rn === 15 ? (regs.pc & ~0x3) >>> 0 : regs.r[rn];
    const addr = (u ? base + offset : base - offset) >>> 0;
    const buf = new ArrayBuffer(4);
    if (isLoad) {
      new DataView(buf).setUint32(0, core.chip.readUint32(addr), true);
      regs.s[sd] = new DataView(buf).getFloat32(0, true);
    } else {
      new DataView(buf).setFloat32(0, regs.s[sd], true);
      core.chip.writeUint32(addr, new DataView(buf).getUint32(0, true));
    }
    return 2;
  }

  // VLDM/VSTM (load/store multiple single-precision registers). General form
  // that covers VPUSH/VPOP and arbitrary base registers. The 0xec/0xed prefix
  // plus coproc=10 identifies this class, EXCLUDING MCRR/MRRC (VMOV
  // two-register) which shares the prefix but has hw0[7:5]=0b010/0b11.
  // Fields: U=hw0[7], D=hw0[6], W=hw0[5], L=hw0[4], Rn=hw0[3:0];
  // hw1: Vd[15:12], coproc[11:8], imm8[7:0].
  // Verified against `arm-none-eabi-as`.
  if (
    ((hw0 & 0xff00) === 0xec00 || (hw0 & 0xff00) === 0xed00) &&
    coproc === 10 &&
    ((hw0 >>> 5) & 0x7) >= 0b100
  ) {
    const u = (hw0 >>> 7) & 1;
    const w = (hw0 >>> 5) & 1;
    const isLoad = (hw0 >>> 4) & 1;
    const rn = hw0 & 0xf;
    const sd = getSd(hw0, hw1);
    const count = hw1 & 0xff;
    let addr = u ? regs.r[rn] >>> 0 : (regs.r[rn] - count * 4) >>> 0;
    const buf = new ArrayBuffer(4);
    const dv = new DataView(buf);
    for (let i = 0; i < count; i++) {
      if (isLoad) {
        dv.setUint32(0, core.chip.readUint32(addr), true);
        regs.s[sd + i] = dv.getFloat32(0, true);
      } else {
        dv.setFloat32(0, regs.s[sd + i], true);
        core.chip.writeUint32(addr, dv.getUint32(0, true));
      }
      addr = (addr + 4) >>> 0;
    }
    if (w) {
      regs.r[rn] = u ? (regs.r[rn] + count * 4) >>> 0 : (regs.r[rn] - count * 4) >>> 0;
    }
    return 2;
  }

  // VPUSH/VPOP: hw0 is always 0xed2d (VPUSH) or 0xecbd (VPOP).
  if (hw0 === 0xed2d) {
    const sd = getSd(hw0, hw1);
    const imm8 = hw1 & 0xff;
    let addr = (regs.sp - imm8 * 4) >>> 0;
    const buf = new ArrayBuffer(4);
    for (let i = 0; i < imm8; i++) {
      new DataView(buf).setFloat32(0, regs.s[sd + i], true);
      core.chip.writeUint32(addr, new DataView(buf).getUint32(0, true));
      addr = (addr + 4) >>> 0;
    }
    regs.sp = (regs.sp - imm8 * 4) >>> 0;
    return 2;
  }
  if (hw0 === 0xecbd) {
    const sd = getSd(hw0, hw1);
    const imm8 = hw1 & 0xff;
    let addr = regs.sp;
    const buf = new ArrayBuffer(4);
    for (let i = 0; i < imm8; i++) {
      new DataView(buf).setUint32(0, core.chip.readUint32(addr), true);
      regs.s[sd + i] = new DataView(buf).getFloat32(0, true);
      addr = (addr + 4) >>> 0;
    }
    regs.sp = (regs.sp + imm8 * 4) >>> 0;
    return 2;
  }

  // VSEL{cc}.F32 Sd, Sn, Sm — ARMv8-M-specific conditional select: Sd = Sn if
  // cc holds, else Sm. Distinct top-level prefix (hw0[15:8]=0xfe, not the
  // 0xee data-processing prefix every other instruction in this file uses),
  // so it can't collide with any D-bit/opc1 ambiguity above. Only 4
  // conditions are encodable (hw0[5:4]): EQ, VS, GE, GT — evaluated against
  // the *APSR* condition flags (regs.N/Z/C/V, same ones a normal conditional
  // branch reads), not FPSCR's comparison flags.
  if ((hw0 & 0xff00) === 0xfe00) {
    const cc = (hw0 >>> 4) & 0x3;
    const sd = getSd(hw0, hw1);
    const sn = getSn(hw0, hw1);
    const sm = getSm(hw0, hw1);
    let condHolds: boolean;
    switch (cc) {
      case 0: // EQ
        condHolds = regs.Z;
        break;
      case 1: // VS
        condHolds = regs.V;
        break;
      case 2: // GE
        condHolds = regs.N === regs.V;
        break;
      default: // GT
        condHolds = !regs.Z && regs.N === regs.V;
        break;
    }
    regs.s[sd] = condHolds ? regs.s[sn] : regs.s[sm];
    return 1;
  }

  return -1;
}
