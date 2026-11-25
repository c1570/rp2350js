import { describe, expect, it } from 'vitest';
import {
  SaveStateStream,
  SAVE_STATE_ARCH_RISCV,
  SAVE_STATE_CHIP_RP2350,
  SAVE_STATE_FLAG_FLASH,
  SAVE_STATE_FLAG_FLASH_WRITTEN,
  SAVE_STATE_FLAG_PSRAM,
  SAVE_STATE_FLAG_PSRAM_WRITTEN,
  SAVE_STATE_HEADER_WORDS,
  readSaveStateHeader,
  stateF64Hi,
  stateF64Lo,
  writeSaveStateHeader,
} from './save-state';
import { Float64 } from './types';

const FLAGS = 0x3;

function wordsOf(data: Uint8Array) {
  return new Uint32Array(data.buffer, data.byteOffset, data.byteLength >>> 2);
}

function roundTrip<T>(
  wordCount: number,
  write: (s: SaveStateStream) => T,
  read: (s: SaveStateStream) => T
) {
  const data = new Uint8Array(wordCount * 4);
  const out = new SaveStateStream(true, false).attach(data, data.length);
  const written = write(out);
  expect(out.ok).toBe(true);
  const used = out.pos;
  const input = new SaveStateStream(false, false).attach(data, data.length);
  const result = read(input);
  expect(input.ok).toBe(true);
  expect(input.pos).toBe(used);
  return { written, result, data, used };
}

const doubles: Float64[] = [
  0,
  -0,
  1,
  -1,
  1.5,
  0.1,
  1 / 3,
  1e300,
  -1e300,
  Number.MIN_VALUE,
  Number.MAX_SAFE_INTEGER,
  4294967296 + 7,
  1e9 / 150e6,
  123456789.123456789,
  Infinity,
  -Infinity,
  NaN,
];

describe('SaveStateStream', () => {
  it('round-trips 32-bit values with their exact bit patterns', () => {
    const values = [0, 1, 0x7fffffff, 0x80000000, 0xffffffff, -1, 0xdeadbeef];
    const { written, result } = roundTrip<number[]>(
      values.length,
      (s) => values.map((v) => s.u32(v)),
      (s) => values.map(() => s.u32(0))
    );
    expect(written).toEqual(values);
    expect(result).toEqual(values.map((v) => v >>> 0));
  });

  it('i32 keeps the sign of plain number fields, like int32_t in C', () => {
    const values = [-1, -2147483648, -5, 0, 2147483647];
    const { written, result } = roundTrip<number[]>(
      values.length,
      (s) => values.map((v) => s.i32(v)),
      (s) => values.map(() => s.i32(0))
    );
    expect(written).toEqual(values);
    expect(result).toEqual(values);
  });

  it('reads back with the signedness of the declared type', () => {
    const data = new Uint8Array(8);
    const out = new SaveStateStream(true, false).attach(data, data.length);
    out.i32(0xffffffff);
    out.u32(0xffffffff);
    const input = new SaveStateStream(false, false).attach(data, data.length);
    expect(input.i32(0)).toBe(-1);
    expect(input.u32(0)).toBe(0xffffffff);
  });

  it('works in the symmetric field form x = s.u32(x)', () => {
    const transfer = (s: SaveStateStream) => {
      const fields = { a: 0x12345678, b: 5, c: 0xffffffff };
      fields.a = s.u32(fields.a);
      fields.b = s.u32(fields.b);
      fields.c = s.u32(fields.c);
      return fields;
    };
    const { written, result } = roundTrip(3, transfer, transfer);
    expect(written).toEqual({ a: 0x12345678, b: 5, c: 0xffffffff });
    expect(result).toEqual({ a: 0x12345678, b: 5, c: 0xffffffff });
  });

  it('round-trips booleans', () => {
    const transfer = (s: SaveStateStream) => [s.bool(true), s.bool(false), s.bool(true)];
    const { written, result } = roundTrip<boolean[]>(3, transfer, transfer);
    expect(written).toEqual([true, false, true]);
    expect(result).toEqual([true, false, true]);
  });

  it('round-trips doubles bit-exactly', () => {
    const { written, result, used } = roundTrip<number[]>(
      doubles.length * 2,
      (s) => doubles.map((d) => s.f64(d)),
      (s) => doubles.map(() => s.f64(0))
    );
    expect(used).toBe(doubles.length * 2);
    doubles.forEach((d, i) => {
      expect(stateF64Lo(written[i])).toBe(stateF64Lo(d));
      expect(stateF64Hi(written[i])).toBe(stateF64Hi(d));
      expect(stateF64Lo(result[i])).toBe(stateF64Lo(d));
      expect(stateF64Hi(result[i])).toBe(stateF64Hi(d));
    });
  });

  it('keeps 0 and -0 apart', () => {
    const { result } = roundTrip<number[]>(
      4,
      (s) => [s.f64(0), s.f64(-0)],
      (s) => [s.f64(1), s.f64(1)]
    );
    expect(stateF64Hi(result[0])).toBe(0);
    expect(stateF64Hi(result[1])).toBe(0x80000000);
  });

  it('round-trips Int53 values', () => {
    const values = [
      0,
      1,
      0x7fffffff,
      0x80000000,
      0xffffffff,
      4294967296,
      4294967296 + 7,
      2 ** 53 - 1,
    ];
    const { written, result } = roundTrip<number[]>(
      values.length * 2,
      (s) => values.map((v) => s.i53(v)),
      (s) => values.map(() => s.i53(0))
    );
    expect(written).toEqual(values);
    expect(result).toEqual(values);
  });

  it('round-trips typed arrays and plain arrays', () => {
    const transfer = (s: SaveStateStream) => {
      const a = Uint32Array.from([1, 0xffffffff, 0x80000000, 42]);
      const b = Int32Array.from([-1, 0x7fffffff, -2147483648]);
      const c: number[] = [5, -5, 0x12345678];
      const d = Uint16Array.from([0x1234, 0xffff, 0]);
      const e = Uint8Array.from([0, 1, 254, 255]);
      s.u32array(a, 4);
      s.i32array(b, 3);
      s.i32array(c, 3);
      s.u16array(d, 3);
      s.u8array(e, 3);
      s.u8array(e, 4);
      const tail = s.u32(0x13572468);
      return { a: Array.from(a), b: Array.from(b), c, d: Array.from(d), e: Array.from(e), tail };
    };
    const expected = {
      a: [1, 0xffffffff, 0x80000000, 42],
      b: [-1, 0x7fffffff, -2147483648],
      c: [5, -5, 0x12345678],
      d: [0x1234, 0xffff, 0],
      e: [0, 1, 254, 255],
      tail: 0x13572468,
    };
    const { written, result } = roundTrip(21, transfer, transfer);
    expect(written).toEqual(expected);
    expect(result).toEqual(expected);
  });

  it('zero-pads byte arrays to the next word', () => {
    const data = new Uint8Array(16).fill(0xaa);
    const s = new SaveStateStream(true, false).attach(data, data.length);
    s.u8array(Uint8Array.from([1, 2, 3]), 3);
    expect(s.pos).toBe(1);
    s.u32(0x11223344);
    expect(s.pos).toBe(2);
    expect(Array.from(data.subarray(0, 8))).toEqual([1, 2, 3, 0, 0x44, 0x33, 0x22, 0x11]);
  });

  it('fails cleanly when writing or reading past the buffer', () => {
    const data = new Uint8Array(12);
    const s = new SaveStateStream(true, false).attach(data, data.length);
    s.u32(1);
    s.u32(2);
    s.u32(3);
    expect(s.ok).toBe(true);
    s.u32(4);
    expect(s.ok).toBe(false);
    expect(Array.from(wordsOf(data))).toEqual([1, 2, 3]);

    const r = new SaveStateStream(false, false).attach(data, data.length);
    expect(r.u32(0)).toBe(1);
    expect(r.u32(0)).toBe(2);
    expect(r.u32(0)).toBe(3);
    expect(r.ok).toBe(true);
    expect(r.u32(7)).toBe(7);
    expect(r.ok).toBe(false);

    const tooLong = new SaveStateStream(true, false).attach(data, data.length);
    tooLong.u32array(new Uint32Array(4), 4);
    expect(tooLong.ok).toBe(false);
    const tooLongBytes = new SaveStateStream(true, false).attach(data, data.length);
    tooLongBytes.u8array(new Uint8Array(13), 13);
    expect(tooLongBytes.ok).toBe(false);
  });

  it('round-trips single-precision values as their raw bits', () => {
    // Signed zero, both infinities, a NaN, the smallest subnormal and the largest finite.
    const bits = new Uint32Array([
      0, 0x80000000, 0x7f800000, 0xff800000, 0x7fc00000, 0x00000001, 0x7f7fffff, 0x40490fdb,
    ]);
    const data = new Uint8Array(64);
    const out = new SaveStateStream(true, false).attach(data, data.length);
    out.f32array(new Float32Array(bits.buffer), 8);
    const copy = new Float32Array(8);
    const input = new SaveStateStream(false, false).attach(data, data.length);
    input.f32array(copy, 8);
    expect(Array.from(new Uint32Array(copy.buffer))).toEqual(Array.from(bits));
  });

  it('skip() reserves room when measuring and respects the buffer otherwise', () => {
    const measure = new SaveStateStream(true, true);
    measure.u32(1);
    measure.skip(100);
    expect(measure.pos).toBe(101);
    expect(measure.ok).toBe(true);

    const data = new Uint8Array(16);
    const real = new SaveStateStream(true, false).attach(data, data.length);
    real.skip(3);
    expect(real.pos).toBe(3);
    expect(real.ok).toBe(true);
    real.skip(2);
    expect(real.ok).toBe(false);
    expect(Array.from(data)).toEqual(new Array(16).fill(0));
  });

  it('measures the size of a transfer without touching memory or state', () => {
    const run = (s: SaveStateStream) => {
      const state = { n: 0x12345678, flag: false, time: 1.5 as Float64, big: 4294967299 };
      state.n = s.i32(state.n);
      state.flag = s.bool(state.flag);
      state.time = s.f64(state.time);
      state.big = s.i53(state.big);
      s.u32array(new Uint32Array(10), 10);
      s.u8array(new Uint8Array(6), 6);
      return state;
    };
    const buffer = new Uint8Array(256);
    const real = new SaveStateStream(true, false).attach(buffer, buffer.length);
    const expected = run(real);
    const measure = new SaveStateStream(true, true);
    const actual = run(measure);
    expect(measure.pos).toBe(real.pos);
    expect(actual).toEqual(expected);
    expect(actual.flag).toBe(false);
    expect(actual.time).toBe(1.5);
    expect(Array.from(buffer.subarray(0, 8))).toEqual([0x78, 0x56, 0x34, 0x12, 0, 0, 0, 0]);
  });

  describe('header', () => {
    const BOTH_STORED =
      SAVE_STATE_FLAG_FLASH |
      SAVE_STATE_FLAG_FLASH_WRITTEN |
      SAVE_STATE_FLAG_PSRAM |
      SAVE_STATE_FLAG_PSRAM_WRITTEN;

    const build = () => {
      const data = new Uint8Array(64);
      const s = new SaveStateStream(true, false).attach(data, data.length);
      writeSaveStateHeader(s, SAVE_STATE_CHIP_RP2350, SAVE_STATE_ARCH_RISCV, BOTH_STORED, 7, 9);
      s.u32(0xabcdef);
      s.u32(99);
      s.finish();
      return data;
    };

    const open = (data: Uint8Array, size = data.length) => {
      const s = new SaveStateStream(false, false).attach(data, size);
      return {
        s,
        totalWords: readSaveStateHeader(s, SAVE_STATE_CHIP_RP2350, SAVE_STATE_ARCH_RISCV),
      };
    };

    it('round-trips, including the flags and change counts', () => {
      const data = build();
      expect(wordsOf(data)[5]).toBe(2);
      const { s, totalWords } = open(data);
      expect(totalWords).toBe(2);
      expect(s.pos).toBe(SAVE_STATE_HEADER_WORDS);
      expect(s.flags).toBe(BOTH_STORED);
      expect(s.flashChanges).toBe(7);
      expect(s.psramChanges).toBe(9);
      expect(s.u32(0)).toBe(0xabcdef);
      expect(s.u32(0)).toBe(99);
    });

    it('rejects every mismatched header field', () => {
      const good = build();
      for (const index of [0, 1, 2, 3, 4, 5]) {
        const data = good.slice();
        wordsOf(data)[index] ^= 0x55555555;
        expect(open(data).totalWords).toBe(-1);
      }
    });

    it('rejects flags that do not make sense', () => {
      const good = build();
      const withFlags = (flags: number) => {
        const data = good.slice();
        wordsOf(data)[2] = flags;
        return open(data).totalWords;
      };
      // An image can be in the state only if it had been written.
      expect(withFlags(SAVE_STATE_FLAG_FLASH)).toBe(-1);
      expect(withFlags(SAVE_STATE_FLAG_FLASH_WRITTEN | SAVE_STATE_FLAG_PSRAM)).toBe(-1);
      // One image in, the other left out, is fine.
      expect(
        withFlags(
          SAVE_STATE_FLAG_FLASH | SAVE_STATE_FLAG_FLASH_WRITTEN | SAVE_STATE_FLAG_PSRAM_WRITTEN
        )
      ).toBe(2);
      // Unknown bits: a state from a newer format is not guessed at.
      expect(withFlags(BOTH_STORED | (1 << 4))).toBe(-1);
      // Written but left out is how a small state looks.
      expect(withFlags(SAVE_STATE_FLAG_FLASH_WRITTEN | SAVE_STATE_FLAG_PSRAM_WRITTEN)).toBe(2);
      expect(withFlags(0)).toBe(2);
    });

    it('rejects truncated buffers', () => {
      const data = build();
      const headerBytes = SAVE_STATE_HEADER_WORDS * 4;
      for (const size of [0, 4, headerBytes - 1, headerBytes + 4]) {
        expect(open(data, size).totalWords).toBe(-1);
      }
      expect(open(data, headerBytes + 8).totalWords).toBe(2);
    });
  });
});
