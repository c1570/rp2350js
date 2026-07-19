/**
 * IEEE 754 single-precision flag computation for VFPv5-SP.
 *
 * JS `number` is binary64; we use Math.fround for binary32 rounding but must
 * detect exceptional cases explicitly since JS loses sign-of-zero and NaN
 * payload semantics.
 */

const INF = Infinity;
const NEG_INF = -Infinity;
const QNAN = NaN;

/** FPSCR exception flag bits. */
export const FPSCR_IOC = 1 << 0; // invalid operation
export const FPSCR_DZC = 1 << 1; // divide by zero
export const FPSCR_OFC = 1 << 2; // overflow
export const FPSCR_UFC = 1 << 3; // underflow
export const FPSCR_IXC = 1 << 4; // inexact
export const FPSCR_IDC = 1 << 7; // input denormal

/** Read FPSCR flags (NZCV at bits [31:28], QC at 27). */
export function getFpscrNzcv(fpscr: number): { N: boolean; Z: boolean; C: boolean; V: boolean } {
  return {
    N: (fpscr & 0x80000000) !== 0,
    Z: (fpscr & 0x40000000) !== 0,
    C: (fpscr & 0x20000000) !== 0,
    V: (fpscr & 0x10000000) !== 0,
  };
}

/** Pack N/Z/C/V into FPSCR bits [31:28]. */
export function setFpscrNzcv(
  fpscr: number,
  n: boolean,
  z: boolean,
  c: boolean,
  v: boolean
): number {
  return (
    (fpscr & ~0xf0000000) |
    (n ? 0x80000000 : 0) |
    (z ? 0x40000000 : 0) |
    (c ? 0x20000000 : 0) |
    (v ? 0x10000000 : 0)
  );
}

/** Check if a float32 value is denormal (subnormal). */
function isDenormal(f: number): boolean {
  return f !== 0 && Math.abs(f) < 1.1754943508222875e-38; // smallest normal
}

/** Check FZ (flush-to-zero) and set IDC if input was denormal. */
export function checkInput(f: number, fpscr: number): [number, number] {
  if (isDenormal(f)) {
    // IDC accumulates on ANY denormal input, regardless of FZ (ARM §B3.4.4).
    fpscr |= FPSCR_IDC;
    if ((fpscr & 0x100) !== 0) {
      // FZ=1: flush to signed zero, preserving the sign bit.
      return [f < 0 ? -0 : 0, fpscr];
    }
  }
  return [f, fpscr];
}

/**
 * VFP compare (VCMP/VCMP.E). Sets FPSCR NZCV.
 * On M33: compares with NaN (unordered) → N=0 Z=0 C=1 V=1, plus IOC.
 */
export function f32cmp(fpscr: number, a: number, b: number): number {
  if (isNaN(a) || isNaN(b)) {
    // Unordered: N=0 Z=0 C=1 V=1 (C set so BGE/BHI see unordered as true).
    fpscr = setFpscrNzcv(fpscr, false, false, true, true);
    return fpscr | FPSCR_IOC;
  }
  let n: boolean, z: boolean, c: boolean, v: boolean;
  if (a < b) {
    [n, z, c, v] = [true, false, false, false];
  } else if (a > b) {
    [n, z, c, v] = [false, false, true, false];
  } else {
    [n, z, c, v] = [false, true, true, false];
  }
  return setFpscrNzcv(fpscr, n, z, c, v);
}

/** F32 add/sub/mul/div with IEEE flag detection. */
export function f32add(fpscr: number, a: number, b: number): [number, number] {
  [a, fpscr] = checkInput(a, fpscr);
  [b, fpscr] = checkInput(b, fpscr);
  let result = Math.fround(a + b);
  [result, fpscr] = postProcess(result, a, b, fpscr, 'add');
  return [result, fpscr];
}

export function f32sub(fpscr: number, a: number, b: number): [number, number] {
  return f32add(fpscr, a, -b);
}

export function f32mul(fpscr: number, a: number, b: number): [number, number] {
  [a, fpscr] = checkInput(a, fpscr);
  [b, fpscr] = checkInput(b, fpscr);
  let result = Math.fround(a * b);
  [result, fpscr] = postProcess(result, a, b, fpscr, 'mul');
  return [result, fpscr];
}

export function f32div(fpscr: number, a: number, b: number): [number, number] {
  [a, fpscr] = checkInput(a, fpscr);
  [b, fpscr] = checkInput(b, fpscr);
  if (b === 0 && a !== 0 && !isNaN(a)) {
    fpscr |= FPSCR_DZC;
    // Native a/b yields a correctly-signed infinity (JS division preserves the
    // sign of the zero divisor, unlike a Math.sign() product).
    return [a / b, fpscr];
  }
  let result = Math.fround(a / b);
  [result, fpscr] = postProcess(result, a, b, fpscr, 'div');
  return [result, fpscr];
}

/**
 * Fused multiply-add family (VFMA/VFMS/VFNMA/VFNMS): `signedAddend +/-
 * (a*b)`, computed with a *single* rounding step. `a*b` is exact in
 * double-precision JS math (the exact product of two float32-valued inputs
 * always fits in a double's 53-bit mantissa), so rounding only the final sum
 * via Math.fround reproduces real fused semantics — unlike separate
 * VMUL+VADD, which would round the product to float32 first.
 */
export function f32fma(
  fpscr: number,
  addend: number,
  a: number,
  b: number,
  negateAddend: boolean,
  negateProduct: boolean
): [number, number] {
  [addend, fpscr] = checkInput(addend, fpscr);
  [a, fpscr] = checkInput(a, fpscr);
  [b, fpscr] = checkInput(b, fpscr);
  // 0 * Infinity is invalid regardless of the addend (matches f32mul/postProcess's check).
  if ((a === 0 || b === 0) && (Math.abs(a) === INF || Math.abs(b) === INF)) {
    fpscr |= FPSCR_IOC;
  }
  let product = a * b;
  if (negateProduct) product = -product;
  const signedAddend = negateAddend ? -addend : addend;
  const result = Math.fround(signedAddend + product);
  return postProcess(result, signedAddend, product, fpscr, 'add');
}

export function f32sqrt(fpscr: number, a: number): [number, number] {
  [a, fpscr] = checkInput(a, fpscr);
  if (a < 0 && !isNaN(a)) {
    return [QNAN, fpscr | FPSCR_IOC];
  }
  let result = Math.fround(Math.sqrt(a));
  [result, fpscr] = postProcess(result, a, 0, fpscr, 'sqrt');
  return [result, fpscr];
}

/** Detect overflow/underflow/inexact and update flags. */
function postProcess(
  result: number,
  a: number,
  b: number,
  fpscr: number,
  op: string
): [number, number] {
  if (isNaN(result)) {
    if (
      op === 'mul' &&
      (a === 0 || b === 0) &&
      (a === INF || b === INF || a === NEG_INF || b === NEG_INF)
    ) {
      fpscr |= FPSCR_IOC;
    }
    return [result, fpscr];
  }
  if (Math.abs(result) === INF) {
    fpscr |= FPSCR_OFC | FPSCR_IXC;
    return [result, fpscr];
  }
  if (isDenormal(result)) {
    if (fpscr & 0x100) {
      // Flush-to-zero: return signed zero.
      fpscr |= FPSCR_UFC | FPSCR_IDC;
      return [result < 0 ? -0 : 0, fpscr];
    }
    fpscr |= FPSCR_UFC | FPSCR_IXC;
    return [result, fpscr];
  }
  return [result, fpscr];
}
