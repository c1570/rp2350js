/**
 * RP2350 Cortex-M33 coprocessors: CP0 GPIOC, CP4/5 DCP, CP7 RCP.
 * See RP2350 datasheet §3.6.
 */
import { CortexM33Core } from './core';

const PIN_MASK = 0x3fffffff; // 30 GPIO pins.

/** Coprocessor dispatch entry point. */
export function coprocessorExecute(core: CortexM33Core, hw0: number, hw1: number): number {
  const coproc = (hw1 >>> 8) & 0xf;
  // CPACR enable check: 2 bits per coprocessor; access=0 → NOCP UsageFault.
  // (The FPU/CP10-11 path has its own check inside fpuExecute.)
  const access = (core.ppb().cpacr >>> (coproc * 2)) & 0x3;
  if (access === 0) {
    core.ppb().cfsr |= 1 << 21; // NOCP
    core.pendingFault = 0; // Fault.UsageFault
    return -1;
  }
  switch (coproc) {
    case 0:
      return cp0Gpioc(core, hw0, hw1);
    case 4:
    case 5:
      return cp45Dcp(core, hw0, hw1);
    case 7:
      return cp7Rcp(core, hw0, hw1);
    default:
      return -1;
  }
}

/** Check if the instruction is MCR/MRC (vs CDP). The T1 encoding has
 * hw0[15:12]=0xE; the T2 (unconditional) encoding has hw0[15:12]=0xF. */
function isMrcMcr(hw0: number, hw1: number): boolean {
  const top = (hw0 >>> 12) & 0xf;
  return (top === 0xe || top === 0xf) && (hw1 & 0x10) !== 0;
}

// ============================================================================
// CP0 — GPIO Coprocessor (GPIOC)
// ============================================================================

function cp0Gpioc(core: CortexM33Core, hw0: number, hw1: number): number {
  if (!isMrcMcr(hw0, hw1)) return 1; // CDP → NOP

  const opc1 = (hw0 >>> 5) & 0x7;
  const CRn = hw0 & 0xf;
  const opc2 = (hw1 >>> 5) & 0x7;
  const CRm = hw1 & 0xf;
  const Rt = (hw1 >>> 12) & 0xf;
  const isRead = ((hw0 >>> 4) & 1) !== 0; // L bit: 1=MRC (read), 0=MCR (write)
  const regs = core.regs;

  // Bank select: 0=LO OUT, 1=LO OE, 2=LO IN, 4=HI OUT, 5=HI OE, 6=HI IN.
  const isInput = opc1 === 2 || opc1 === 6;
  const isOe = opc1 === 1 || opc1 === 5;
  const isHi = opc1 >= 4;
  void isHi; // HI bank is RAZ/WI on RP2350.

  const sio = (
    core.chip as unknown as {
      sio: {
        readUint32: (offset: number, core: number) => number;
        writeUint32: (offset: number, value: number, core: number) => void;
      };
    }
  ).sio;

  // SIO GPIO register offsets (RP2350 layout — differs from RP2040).
  const GPIO_OUT = 0x010;
  const GPIO_OUT_SET = 0x018;
  const GPIO_OUT_CLR = 0x020;
  const GPIO_OUT_XOR = 0x028;
  const GPIO_OE = 0x030;
  const GPIO_OE_SET = 0x038;
  const GPIO_OE_CLR = 0x040;
  const GPIO_OE_XOR = 0x048;
  const GPIO_IN = 0x004;

  const baseOffset = isInput ? GPIO_IN : isOe ? GPIO_OE : GPIO_OUT;

  const isBulk = CRn === 0 && CRm === 0;
  if (isBulk) {
    if (isRead) {
      if (isInput) {
        regs.r[Rt] = sio.readUint32(GPIO_IN, core.coreIndex) & PIN_MASK;
      } else if (!isHi) {
        regs.r[Rt] = sio.readUint32(baseOffset, core.coreIndex) & PIN_MASK;
      } else {
        regs.r[Rt] = 0; // HI bank RAZ
      }
    } else {
      const val = regs.r[Rt] & PIN_MASK;
      if (!isInput && !isHi) {
        switch (opc2) {
          case 0:
            sio.writeUint32(baseOffset, val, core.coreIndex);
            break;
          case 1:
            sio.writeUint32(isOe ? GPIO_OE_SET : GPIO_OUT_SET, val, core.coreIndex);
            break;
          case 2:
            sio.writeUint32(isOe ? GPIO_OE_CLR : GPIO_OUT_CLR, val, core.coreIndex);
            break;
          case 3:
            sio.writeUint32(isOe ? GPIO_OE_XOR : GPIO_OUT_XOR, val, core.coreIndex);
            break;
        }
      }
    }
  } else {
    // Per-bit operation.
    const pin = (CRn << 4) | CRm;
    if (pin >= 30) {
      if (isRead) regs.r[Rt] = 0;
      return 1;
    }
    const bitMask = 1 << pin;
    if (isRead) {
      if (isInput) {
        regs.r[Rt] = (sio.readUint32(GPIO_IN, core.coreIndex) >> pin) & 1;
      } else {
        regs.r[Rt] = (sio.readUint32(baseOffset, core.coreIndex) >> pin) & 1;
      }
    } else {
      if (!isInput && !isHi) {
        switch (opc2) {
          case 4:
            // Per-bit "put": Rt[0]=1 → set only this pin; Rt[0]=0 → clear only
            // this pin. Must NOT do a bulk write (which zeroes every other pin).
            if (regs.r[Rt] & 1) {
              sio.writeUint32(isOe ? GPIO_OE_SET : GPIO_OUT_SET, bitMask, core.coreIndex);
            } else {
              sio.writeUint32(isOe ? GPIO_OE_CLR : GPIO_OUT_CLR, bitMask, core.coreIndex);
            }
            break;
          case 5:
            sio.writeUint32(isOe ? GPIO_OE_SET : GPIO_OUT_SET, bitMask, core.coreIndex);
            break;
          case 6:
            sio.writeUint32(isOe ? GPIO_OE_CLR : GPIO_OUT_CLR, bitMask, core.coreIndex);
            break;
          case 7:
            sio.writeUint32(isOe ? GPIO_OE_XOR : GPIO_OUT_XOR, bitMask, core.coreIndex);
            break;
        }
      }
    }
  }
  return 1;
}

// ============================================================================
// CP4/CP5 — Double-Precision Coprocessor (DCP)
// ============================================================================

// Saturating f64→i32 cast: NaN→0, out-of-range→MAX/MIN, in-range→truncation
// toward zero.
function f64ToI32Sat(d: number): number {
  if (isNaN(d)) return 0;
  if (d >= 2147483647) return 0x7fffffff;
  if (d <= -2147483648) return -2147483648;
  return Math.trunc(d) | 0;
}

// Saturating f64→u32 cast: NaN→0, negatives→0, out-of-range→MAX, in-range→
// truncation toward zero.
function f64ToU32Sat(d: number): number {
  if (isNaN(d) || d < 0) return 0;
  if (d >= 4294967296) return 0xffffffff;
  return Math.trunc(d) >>> 0;
}

function cp45Dcp(core: CortexM33Core, hw0: number, hw1: number): number {
  const st = core.ppb();

  if (isMrcMcr(hw0, hw1)) {
    // MCR/MRC transfer.
    const opc1 = (hw0 >>> 5) & 0x7;
    if (opc1 !== 0) return 1; // NOP for non-zero opc1
    const opc2 = (hw1 >>> 5) & 0x7;
    const CRm = hw1 & 0xf;
    const Rt = (hw1 >>> 12) & 0xf;
    const isRead = ((hw0 >>> 4) & 1) !== 0;
    const halfIdx = (CRm & 0x7) * 2 + (opc2 & 1);
    if (isRead) {
      core.regs.r[Rt] = st.dcpHalves[halfIdx] >>> 0;
    } else {
      st.dcpHalves[halfIdx] = core.regs.r[Rt] >>> 0;
    }
    return 1;
  }

  // CDP fields
  //   opc1=(hw0>>4)&0xf, CRn=hw0&0x7 (source #1)
  //   CRd=(hw1>>12)&0x7 (destination), opc2=(hw1>>5)&0x7, CRm=hw1&0x7 (source #2)
  const opc1 = (hw0 >>> 4) & 0xf;
  const opc2 = (hw1 >>> 5) & 0x7;
  const Rd = (hw1 >>> 12) & 0x7;
  const Rn = hw0 & 0x7;
  const Rm = hw1 & 0x7;

  const readDouble = (idx: number): number => {
    const lo = st.dcpHalves[idx * 2] >>> 0;
    const hi = st.dcpHalves[idx * 2 + 1] >>> 0;
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setUint32(0, lo, true);
    view.setUint32(4, hi, true);
    return view.getFloat64(0, true);
  };
  const writeDouble = (idx: number, val: number) => {
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setFloat64(0, val, true);
    st.dcpHalves[idx * 2] = view.getUint32(0, true);
    st.dcpHalves[idx * 2 + 1] = view.getUint32(4, true);
  };

  switch (opc1) {
    case 0: {
      // Arithmetic
      const a = readDouble(Rn);
      const b = readDouble(Rm);
      let result: number;
      switch (opc2) {
        case 0:
          result = a + b;
          break;
        case 1:
          result = a - b;
          break;
        case 2:
          result = a * b;
          break;
        case 3:
          // Native f64 division: finite/0 = ±Inf, 0/0 = NaN. No special-case.
          result = a / b;
          break;
        case 4:
          result = a < 0 ? NaN : Math.sqrt(a);
          break; // dsqrt (unary, uses Rn)
        default:
          return 1;
      }
      writeDouble(Rd, result);
      updateDcpStatus(st, result);
      return opc2 === 3 ? 18 : opc2 === 4 ? 28 : opc2 === 2 ? 5 : 4;
    }
    case 1: {
      // Compares
      const a = readDouble(Rn);
      const b = readDouble(Rm);
      let eq = false;
      switch (opc2) {
        case 0:
          eq = a === b;
          break;
        case 1:
          eq = a < b;
          break;
        case 2:
          eq = a <= b;
          break;
        case 3:
          eq = a > b;
          break;
        case 4:
          eq = a >= b;
          break;
        default:
          return 1;
      }
      st.dcpStatus = eq ? 1 : 0;
      return 4;
    }
    case 2: {
      // Conversions. Each updates the status register.
      switch (opc2) {
        case 0: {
          // i2d: half A of CRn holds an i32.
          const r = st.dcpHalves[Rn * 2] | 0;
          writeDouble(Rd, r);
          updateDcpStatus(st, r);
          return 4;
        }
        case 1: {
          // u2d: half A of CRn holds a u32.
          const r = st.dcpHalves[Rn * 2] >>> 0;
          writeDouble(Rd, r);
          updateDcpStatus(st, r);
          return 4;
        }
        case 2: {
          // d2i: saturating cast, not JS modular wrap (>>> 0 would silently wrap).
          const d = readDouble(Rn);
          st.dcpHalves[Rd * 2] = f64ToI32Sat(d) >>> 0;
          st.dcpHalves[Rd * 2 + 1] = 0;
          updateDcpStatus(st, d);
          return 4;
        }
        case 3: {
          // d2u: saturating cast.
          const d = readDouble(Rn);
          st.dcpHalves[Rd * 2] = f64ToU32Sat(d);
          st.dcpHalves[Rd * 2 + 1] = 0;
          updateDcpStatus(st, d);
          return 4;
        }
        case 4: {
          // d2f: f64 → f32, stored in half A; half B cleared.
          const d = readDouble(Rn);
          const buf = new ArrayBuffer(4);
          new DataView(buf).setFloat32(0, d, true);
          const f32bits = new DataView(buf).getUint32(0, true);
          st.dcpHalves[Rd * 2] = f32bits;
          st.dcpHalves[Rd * 2 + 1] = 0;
          updateDcpStatus(st, new DataView(buf).getFloat32(0, true));
          return 4;
        }
        case 5: {
          // f2d: f32 in half A of CRn → f64 in CRd.
          const buf = new ArrayBuffer(4);
          new DataView(buf).setUint32(0, st.dcpHalves[Rn * 2], true);
          const r = new DataView(buf).getFloat32(0, true);
          writeDouble(Rd, r);
          updateDcpStatus(st, r);
          return 4;
        }
        default:
          return 1;
      }
    }
    case 3: {
      // Status
      if (opc2 === 0) {
        // dcpstat_get
        st.dcpHalves[Rd * 2] = st.dcpStatus;
        st.dcpHalves[Rd * 2 + 1] = 0;
      } else if (opc2 === 1) {
        // dcpstat_clr
        st.dcpStatus = 0;
      }
      return 1;
    }
    default:
      return 1;
  }
}

// Sign-bit check: true for -0.0 and negative NaN too, where JS `val < 0`
// returns false.
const signBuf = new ArrayBuffer(8);
const signView = new DataView(signBuf);
function isSignNegative(val: number): boolean {
  signView.setFloat64(0, val, true);
  return (signView.getUint32(4, true) & 0x80000000) !== 0;
}

function updateDcpStatus(st: { dcpStatus: number }, val: number) {
  let s = 0;
  if (val === 0) s |= 1; // includes +0 and -0
  if (isSignNegative(val)) s |= 2;
  if (!isNaN(val) && !isFinite(val)) s |= 4; // infinity only (excludes NaN)
  if (isNaN(val)) s |= 8;
  st.dcpStatus = s;
}

// ============================================================================
// CP7 — Redundancy Coprocessor (RCP)
// ============================================================================

function cp7Rcp(core: CortexM33Core, hw0: number, hw1: number): number {
  const st = core.ppb();
  const hw0Hi = (hw0 >>> 8) & 0xff;
  const isMcrrMrrc = hw0Hi === 0xec || hw0Hi === 0xfc;

  if (isMcrrMrrc) {
    return cp7McrrMrrc(core, hw0, hw1, st);
  }
  // MCR/MRC/CDP family (0xEE or 0xFE prefix).
  if (!isMrcMcr(hw0, hw1)) {
    // CDP.
    const opc1 = (hw0 >>> 4) & 0xf;
    const opc2 = (hw1 >>> 5) & 0x7;
    if (opc1 === 0 && opc2 === 1) {
      // rcp_panic → NMI.
      core.pendingFault = 3; // Fault.Nmi
    }
    return 1;
  }

  const opc1 = (hw0 >>> 5) & 0x7;
  const opc2 = (hw1 >>> 5) & 0x7;
  const CRn = hw0 & 0xf;
  const CRm = hw1 & 0xf;
  const Rt = (hw1 >>> 12) & 0xf;
  const isRead = ((hw0 >>> 4) & 1) !== 0;
  const imm = (CRn << 4) | CRm;
  const regs = core.regs;

  switch (opc1) {
    case 0:
      if (opc2 === 1) {
        if (isRead) {
          // rcp_canary_get: R[t] = salt ^ 0xDEADBEEF (or 0 ^ 0xDEADBEEF if invalid).
          const salt = st.rcpSaltValid ? st.rcpSalt : 0;
          regs.r[Rt] = (salt ^ 0xdeadbeef) >>> 0;
        } else {
          // rcp_canary_check: assert R[t] == expected.
          const salt = st.rcpSaltValid ? st.rcpSalt : 0;
          if (regs.r[Rt] !== (salt ^ 0xdeadbeef) >>> 0) {
            core.pendingFault = 3; // Fault.Nmi
          }
        }
      }
      return 1;
    case 1:
      if (isRead && Rt === 15 && opc2 === 0 && CRn === 0 && CRm === 0) {
        // rcp_canary_status: N = salt_valid (1=valid), Z/C/V cleared.
        // Reference: xpsr = (xpsr & 0x0FFFFFFF) | (salt_valid ? N : 0).
        const n = st.rcpSaltValid ? 0x80000000 : 0;
        regs.xpsr = (regs.xpsr & 0x0fffffff) | n;
      } else if (!isRead && opc2 === 0 && CRn === 0 && CRm === 0) {
        // rcp_bvalid: assert R[t] is a valid boolean (0xa500a500 or 0x00c300c3).
        const v = regs.r[Rt] >>> 0;
        if (v !== 0xa500a500 && v !== 0x00c300c3) core.pendingFault = 3;
      }
      return 1;
    case 2:
      if (!isRead && opc2 === 0 && CRn === 0 && CRm === 0) {
        // rcp_btrue: assert R[t] == 0xa500a500.
        if (regs.r[Rt] >>> 0 !== 0xa500a500) core.pendingFault = 3;
      }
      return 1;
    case 3:
      if (!isRead && opc2 === 1 && CRn === 0 && CRm === 0) {
        // rcp_bfalse: assert R[t] == 0x00c300c3.
        if (regs.r[Rt] >>> 0 !== 0x00c300c3) core.pendingFault = 3;
      }
      return 1;
    case 4:
      if (!isRead && opc2 === 0) {
        // rcp_count_init.
        st.rcpCount = imm;
      }
      return 1;
    case 5:
      if (!isRead && opc2 === 1) {
        // rcp_count_check: assert counter == imm, then increment.
        if (st.rcpCount !== imm) {
          core.pendingFault = 3;
        } else {
          st.rcpCount = (st.rcpCount + 1) & 0xff;
        }
      }
      return 1;
    default:
      return 1; // NOP for unimplemented ops.
  }
}

function cp7McrrMrrc(
  core: CortexM33Core,
  hw0: number,
  hw1: number,
  st: { rcpSalt: number; rcpSaltValid: boolean }
): number {
  // L bit (hw0[4]): 0=MCRR (write), 1=MRRC (read). MRRC2 from CP7 is a NOP
  // per the reference (coprocessor.rs:676-679) — must not trigger rcp ops.
  if ((hw0 & 0x10) !== 0) return 1;
  // opc1 is hw1[7:4], CRm is hw1[3:0], Rt is hw1[15:12], Rt2 is hw0[3:0].
  const opc1 = (hw1 >>> 4) & 0xf;
  const CRm = hw1 & 0xf;
  const Rt = (hw1 >>> 12) & 0xf;
  const Rt2 = hw0 & 0xf;
  const regs = core.regs;

  switch (opc1) {
    case 7:
      if (CRm === 0) {
        // rcp_iequal: assert R[Rt] == R[Rt2].
        if (regs.r[Rt] !== regs.r[Rt2]) {
          core.pendingFault = 3; // Nmi
        }
      }
      return 1;
    case 8:
      // rcp_salt_core0 / rcp_salt_core1.
      if (CRm === 0) {
        st.rcpSalt = regs.r[Rt];
        st.rcpSaltValid = true;
      } else if (CRm === 1) {
        st.rcpSalt = regs.r[Rt];
        st.rcpSaltValid = true;
      }
      return 1;
    default:
      return 1; // NOP for unimplemented.
  }
}
