import { Float32, Float64, Int53, Uint32 } from './types';

export const SERIALIZATION_QUIRK_INCOMPLETE = 1 << 0;
export const SERIALIZATION_QUIRK_MUST_INITIALIZE = 1 << 1;
export const SERIALIZATION_QUIRK_CORE_VARIABLE_SIZE = 1 << 2;
export const SERIALIZATION_QUIRK_FRONT_VARIABLE_SIZE = 1 << 3;
export const SERIALIZATION_QUIRK_SINGLE_SESSION = 1 << 4;
export const SERIALIZATION_QUIRK_ENDIAN_DEPENDENT = 1 << 5;
export const SERIALIZATION_QUIRK_PLATFORM_DEPENDENT = 1 << 6;

export const SAVE_STATE_MAGIC = 0x52505353;
export const SAVE_STATE_VERSION = 2;
// Header flags. _FLASH/_PSRAM: the image is in the state. _WRITTEN: something had
// written the image when the state was taken, so it no longer equals the firmware
// image. An image that is not in the state is left alone by unserialize(), which is
// exact only while nothing has written it since: the header's change count says.
export const SAVE_STATE_FLAG_FLASH = 1 << 0;
export const SAVE_STATE_FLAG_PSRAM = 1 << 1;
export const SAVE_STATE_FLAG_FLASH_WRITTEN = 1 << 2;
export const SAVE_STATE_FLAG_PSRAM_WRITTEN = 1 << 3;
const SAVE_STATE_KNOWN_FLAGS =
  SAVE_STATE_FLAG_FLASH |
  SAVE_STATE_FLAG_PSRAM |
  SAVE_STATE_FLAG_FLASH_WRITTEN |
  SAVE_STATE_FLAG_PSRAM_WRITTEN;
export const SAVE_STATE_CHIP_RP2040 = 0;
export const SAVE_STATE_CHIP_RP2350 = 1;
export const SAVE_STATE_ARCH_RISCV = 0;
export const SAVE_STATE_ARCH_ARM = 1;

// Bits for serializeSize() and serialize(): leave that image out of the state.
export const SAVE_STATE_OMIT_FLASH = 1 << 0;
export const SAVE_STATE_OMIT_PSRAM = 1 << 1;

// Header words: magic, version, flags, chip, core arch, body size in words (patched by
// finish()), then the flash and PSRAM change counts.
const HEADER_TOTAL_WORDS = 5;
export const SAVE_STATE_HEADER_WORDS = 8;

// Reinterprets a Float64 as its two uint32 halves (and back) via a shared backing
// buffer, and a Float32 as its raw bits. Module-scope: cts2c replaces these functions
// with memcpy-based C bodies (see cts2c.js), so they only run under Node and need no
// per-instance state.
const f32Scratch = new Float32Array(1);
const f32BitsScratch = new Uint32Array(f32Scratch.buffer);
const f64Scratch = new Float64Array(1);
const u32Scratch = new Uint32Array(f64Scratch.buffer);

export function stateF64Lo(v: Float64): number {
  f64Scratch[0] = v;
  return u32Scratch[0];
}

export function stateF64Hi(v: Float64): number {
  f64Scratch[0] = v;
  return u32Scratch[1];
}

export function stateF64From(lo: number, hi: number): Float64 {
  u32Scratch[0] = lo;
  u32Scratch[1] = hi;
  return f64Scratch[0];
}

export function stateF32ToBits(v: Float32): number {
  f32Scratch[0] = v;
  return f32BitsScratch[0];
}

export function stateF32FromBits(bits: number): Float32 {
  f32BitsScratch[0] = bits;
  return f32Scratch[0];
}

/**
 * Word-aligned little-endian stream over a caller-provided buffer, shared by every
 * `transferState()`. Symmetric: each method stores `v` and returns it when serializing,
 * and returns the stored value when unserializing, so a field is one line —
 * `this.x = s.i32(this.x)` — and save/load order can never drift.
 */
export class SaveStateStream {
  // Byte and 32-bit views of the same buffer: `new Uint32Array(x.buffer)` becomes a
  // plain pointer cast in C, so nothing is copied.
  bytes: Uint8Array;
  words: Uint32Array;
  pos = 0;
  // Tracked separately: typed-array length is erased in C.
  size = 0;
  // Set by the header writer or reader: which memory images the state carries
  // (SAVE_STATE_FLAG_*), and the change counts recorded for the ones it leaves out.
  flags = 0;
  flashChanges = 0;
  psramChanges = 0;
  // Cleared instead of throwing: cts2c turns `throw` into abort().
  ok = true;
  readonly serializing: boolean;
  // Dry run for serializeSize(): advances `pos` only. Every method must still return
  // `v` untouched, because callers assign the result straight back to the field.
  readonly measuring: boolean;

  constructor(serializing: boolean, measuring: boolean) {
    this.serializing = serializing;
    this.measuring = measuring;
    this.bytes = new Uint8Array(4);
    this.words = new Uint32Array(this.bytes.buffer);
  }

  attach(data: Uint8Array, size: number): SaveStateStream {
    this.bytes = data;
    this.words = new Uint32Array(data.buffer);
    this.size = size >>> 2;
    this.pos = 0;
    return this;
  }

  // For fields typed `Uint32` (C: uint32_t): reads back unsigned.
  u32(v: Uint32): Uint32 {
    const p = this.pos;
    this.pos = p + 1;
    if (this.measuring) {
      return v;
    }
    if (p >= this.size) {
      this.ok = false;
      return v;
    }
    if (this.serializing) {
      this.words[p] = v;
      return v;
    }
    return this.words[p];
  }

  // For plain `number` fields (C: int32_t): reads back signed, so a restored JS field
  // holds exactly what the C build holds. The emulator writes such values in both
  // number forms, so it cannot depend on their sign; savestate-coverage.spec.ts limits
  // the fields where the form may change to a reviewed list.
  i32(v: number): number {
    const p = this.pos;
    this.pos = p + 1;
    if (this.measuring) {
      return v;
    }
    if (p >= this.size) {
      this.ok = false;
      return v;
    }
    if (this.serializing) {
      this.words[p] = v;
      return v;
    }
    return this.words[p] | 0;
  }

  bool(v: boolean): boolean {
    const word = this.u32(v ? 1 : 0);
    if (this.measuring) {
      return v;
    }
    return word !== 0;
  }

  f64(v: Float64): Float64 {
    const lo = this.u32(stateF64Lo(v));
    const hi = this.u32(stateF64Hi(v));
    if (this.measuring) {
      return v;
    }
    return stateF64From(lo, hi);
  }

  i53(v: Int53): Int53 {
    return this.f64(v);
  }

  u32array(a: Uint32Array, len: number) {
    const p = this.pos;
    this.pos = p + len;
    if (this.measuring) {
      return;
    }
    if (p + len > this.size) {
      this.ok = false;
      return;
    }
    const { words } = this;
    if (this.serializing) {
      for (let i = 0; i < len; i++) {
        words[p + i] = a[i];
      }
    } else {
      for (let i = 0; i < len; i++) {
        a[i] = words[p + i];
      }
    }
  }

  // Own copy of u32array's loop: delegating would pass int32_t* where it wants uint32_t*.
  i32array(a: Int32Array | number[], len: number) {
    const p = this.pos;
    this.pos = p + len;
    if (this.measuring) {
      return;
    }
    if (p + len > this.size) {
      this.ok = false;
      return;
    }
    const { words } = this;
    if (this.serializing) {
      for (let i = 0; i < len; i++) {
        words[p + i] = a[i];
      }
    } else {
      for (let i = 0; i < len; i++) {
        a[i] = words[p + i] | 0;
      }
    }
  }

  // Raw bits, not numeric values: only the bits are exact for a Float32Array.
  f32array(a: Float32Array, len: number) {
    for (let i = 0; i < len; i++) {
      a[i] = stateF32FromBits(this.u32(stateF32ToBits(a[i])));
    }
  }

  u16array(a: Uint16Array, len: number) {
    for (let i = 0; i < len; i++) {
      a[i] = this.u32(a[i]);
    }
  }

  u8array(a: Uint8Array, len: number) {
    const start = this.pos * 4;
    const padded = (len + 3) & ~3;
    this.pos += padded >>> 2;
    if (this.measuring) {
      return;
    }
    if (this.pos > this.size) {
      this.ok = false;
      return;
    }
    const { bytes } = this;
    if (this.serializing) {
      for (let i = 0; i < len; i++) {
        bytes[start + i] = a[i];
      }
      for (let i = len; i < padded; i++) {
        // Zeroed so JS and C states are byte-identical.
        bytes[start + i] = 0;
      }
    } else {
      for (let i = 0; i < len; i++) {
        a[i] = bytes[start + i];
      }
    }
  }

  // Reserves room without writing it, for a variable-size section that must still
  // be counted at its maximum when measuring.
  skip(words: number) {
    this.pos += words;
    if (!this.measuring && this.pos > this.size) {
      this.ok = false;
    }
  }

  finish() {
    if (this.ok) {
      this.words[HEADER_TOTAL_WORDS] = this.pos - SAVE_STATE_HEADER_WORDS;
    }
  }
}

export function writeSaveStateHeader(
  s: SaveStateStream,
  chipId: number,
  coreArch: number,
  flags: number,
  flashChanges: number,
  psramChanges: number
) {
  s.flags = flags;
  s.u32(SAVE_STATE_MAGIC);
  s.u32(SAVE_STATE_VERSION);
  s.u32(flags);
  s.u32(chipId);
  s.u32(coreArch);
  s.u32(0);
  s.u32(flashChanges);
  s.u32(psramChanges);
}

// Validated before any state is written, so a rejected state leaves the chip untouched.
// Leaves the header's flags and change counts on the stream. Returns the body size the
// header announces, in words, for the caller to check against what it then reads; -1 if
// the state is not for this chip.
export function readSaveStateHeader(s: SaveStateStream, chipId: number, coreArch: number): number {
  const magic = s.u32(0);
  const version = s.u32(0);
  s.flags = s.u32(0);
  const chip = s.u32(0);
  const arch = s.u32(0);
  const totalWords = s.u32(0);
  s.flashChanges = s.u32(0);
  s.psramChanges = s.u32(0);
  if (
    magic !== SAVE_STATE_MAGIC ||
    version !== SAVE_STATE_VERSION ||
    chip !== chipId ||
    arch !== coreArch ||
    (s.flags & ~SAVE_STATE_KNOWN_FLAGS) !== 0 ||
    // An image in the state is one that had been written.
    (s.flags & SAVE_STATE_FLAG_FLASH && !(s.flags & SAVE_STATE_FLAG_FLASH_WRITTEN)) ||
    (s.flags & SAVE_STATE_FLAG_PSRAM && !(s.flags & SAVE_STATE_FLAG_PSRAM_WRITTEN)) ||
    SAVE_STATE_HEADER_WORDS + totalWords > s.size
  ) {
    return -1;
  }
  return s.ok ? totalWords : -1;
}
