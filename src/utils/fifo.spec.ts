import { describe, expect, it } from 'vitest';
import { FIFO } from './fifo';
import { SaveStateStream } from './save-state';

describe('FIFO', () => {
  it('should successfully push and pull 4 items', () => {
    const fifo = new FIFO(3);
    expect(fifo.empty).toBe(true);
    fifo.push(1);
    expect(fifo.empty).toBe(false);
    fifo.push(2);
    expect(fifo.itemCount).toBe(2);
    expect(fifo.full).toBe(false);
    fifo.push(3);
    expect(fifo.full).toBe(true);
    expect(fifo.pull()).toBe(1);
    expect(fifo.full).toBe(false);
    fifo.push(4);
    expect(fifo.full).toBe(true);
    expect(fifo.pull()).toBe(2);
    expect(fifo.pull()).toBe(3);
    expect(fifo.empty).toBe(false);
    expect(fifo.itemCount).toBe(1);
    expect(fifo.pull()).toBe(4);
    expect(fifo.full).toBe(false);
    expect(fifo.empty).toBe(true);
  });

  describe('peek()', () => {
    it(`should return the next item in the FIFO without affecting the FIFO's content`, () => {
      const fifo = new FIFO(3);
      expect(fifo.empty).toBe(true);
      fifo.push(10);
      expect(fifo.empty).toBe(false);
      fifo.push(20);
      expect(fifo.peek()).toBe(10);
      expect(fifo.itemCount).toBe(2);
      expect(fifo.pull()).toBe(10);
    });
  });

  describe('items', () => {
    it(`should return an array with all the FIFO's content`, () => {
      const fifo = new FIFO(3);
      expect(fifo.empty).toBe(true);
      fifo.push(10);
      fifo.push(20);
      fifo.push(30);
      fifo.pull();
      expect(fifo.items).toEqual([20, 30]);
    });
  });
});

describe('transferState', () => {
  it('should round-trip the content and the read position', () => {
    const fifo = new FIFO(4);
    fifo.push(1);
    fifo.push(2);
    fifo.push(3);
    fifo.pull();
    const data = new Uint8Array(64);
    const out = new SaveStateStream(true, false).attach(data, data.length);
    fifo.transferState(out);
    expect(out.ok).toBe(true);

    fifo.reset();
    fifo.push(9);
    const input = new SaveStateStream(false, false).attach(data, data.length);
    fifo.transferState(input);
    expect(input.ok).toBe(true);
    expect(fifo.items).toEqual([2, 3]);
    expect(fifo.itemCount).toBe(2);
    fifo.push(4);
    fifo.push(5);
    expect(fifo.full).toBe(true);
  });

  it('should reject inconsistent indices', () => {
    const fifo = new FIFO(4);
    fifo.push(7);
    const data = new Uint8Array(64);
    const out = new SaveStateStream(true, false).attach(data, data.length);
    fifo.transferState(out);
    new Uint32Array(data.buffer)[0] = 4;
    const input = new SaveStateStream(false, false).attach(data, data.length);
    fifo.transferState(input);
    expect(input.ok).toBe(false);
  });
});
