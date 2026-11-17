import { describe, expect, it } from 'vitest';
import { IRQ2350 } from '../irq_rp2350';
import { RP2350 } from '../rp2350';

const IO_BANK0_BASE = 0x40028000;

const INTR0 = 0x230;
const PROC0_INTE0 = 0x248;
const PROC0_INTF0 = 0x260;
const PROC0_INTS0 = 0x278;

// Bit position of each interrupt condition inside a PROC*_INT/INTR entry.
const LEVEL_LOW = 0;
const LEVEL_HIGH = 1;
const EDGE_HIGH = 3;

/** Bit for `pin` / `event` in the INTR/PROC0_INTE/PROC0_INTF/PROC0_INTS registers. */
function irqBit(pin: number, event: number) {
  return (1 << ((pin & 7) * 4 + event)) >>> 0;
}

/** Address of the 8-pin register bank containing `pin`. */
function bank(base: number, pin: number) {
  return IO_BANK0_BASE + base + (pin >>> 3) * 4;
}

describe('RP2350 IO_BANK0 GPIO interrupts', () => {
  it('round-trips PROC0_INTE0 enable bits for pins 0-7', () => {
    const chip = new RP2350();
    const value = irqBit(5, EDGE_HIGH);
    chip.writeUint32(bank(PROC0_INTE0, 5), value);
    expect(chip.readUint32(bank(PROC0_INTE0, 5))).toBe(value >>> 0);
    expect(chip.gpio[5].irqEnableMask).toBe(1 << EDGE_HIGH);
  });

  it('maps pins 8-15 to PROC0_INTE1 rather than INTE0', () => {
    const chip = new RP2350();
    const value = irqBit(8, EDGE_HIGH);
    chip.writeUint32(bank(PROC0_INTE0, 8), value); // PROC0_INTE1
    expect(chip.readUint32(IO_BANK0_BASE + PROC0_INTE0 + 0x4)).toBe(value >>> 0);
    expect(chip.readUint32(IO_BANK0_BASE + PROC0_INTE0)).toBe(0);
  });

  it('maps pins 40-47 to PROC0_INTE5', () => {
    const chip = new RP2350();
    const value = irqBit(40, EDGE_HIGH);
    chip.writeUint32(bank(PROC0_INTE0, 40), value); // PROC0_INTE5 at 0x25c
    expect(chip.readUint32(IO_BANK0_BASE + PROC0_INTE0 + 5 * 4)).toBe(value >>> 0);
  });

  it('captures and acknowledges a high-bank edge through INTR5/PROC0_INTS5', () => {
    const chip = new RP2350();
    const pin = chip.gpio[40];
    pin.padValue |= 0x40; // IE: enable the input buffer

    // PROC0_INTE5 is at 0x25c, INTR5 at 0x240, PROC0_INTS5 at 0x28c.
    chip.writeUint32(bank(PROC0_INTE0, 40), irqBit(40, EDGE_HIGH));
    pin.setInputValue(true);

    // Exact values: a bad decoder that falls through to 0xffffffff must fail.
    expect(chip.readUint32(bank(INTR0, 40))).toBe(
      (irqBit(40, EDGE_HIGH) | irqBit(40, LEVEL_HIGH)) >>> 0
    );
    expect(chip.readUint32(bank(PROC0_INTS0, 40))).toBe(irqBit(40, EDGE_HIGH) >>> 0);
    expect(chip.core0.meipa[IRQ2350.IO_IRQ_BANK0]).toBeTruthy();

    chip.writeUint32(bank(INTR0, 40), irqBit(40, EDGE_HIGH));

    expect(chip.readUint32(bank(INTR0, 40))).toBe(irqBit(40, LEVEL_HIGH) >>> 0);
    expect(chip.readUint32(bank(PROC0_INTS0, 40))).toBe(0);
    expect(chip.core0.meipa[IRQ2350.IO_IRQ_BANK0]).toBeFalsy();
  });

  it('captures an enabled rising edge in INTR and asserts IO_IRQ_BANK0', () => {
    const chip = new RP2350();
    const pin = chip.gpio[5];
    pin.padValue |= 0x40; // IE: enable the input buffer

    chip.writeUint32(bank(PROC0_INTE0, 5), irqBit(5, EDGE_HIGH));
    pin.setInputValue(true);

    expect(chip.readUint32(bank(INTR0, 5)) & irqBit(5, EDGE_HIGH)).toBeTruthy();
    expect(chip.readUint32(bank(PROC0_INTS0, 5)) & irqBit(5, EDGE_HIGH)).toBeTruthy();
    expect(chip.core0.meipa[IRQ2350.IO_IRQ_BANK0]).toBeTruthy();
    expect(chip.core1.meipa[IRQ2350.IO_IRQ_BANK0]).toBeTruthy();
  });

  it('does not assert IO_IRQ_BANK0 for an edge that is not enabled', () => {
    const chip = new RP2350();
    const pin = chip.gpio[5];
    pin.padValue |= 0x40;

    pin.setInputValue(true);

    expect(chip.core0.meipa[IRQ2350.IO_IRQ_BANK0]).toBeFalsy();
  });

  it('clears the raw edge bit and deasserts IO_IRQ_BANK0 when INTR is written 1', () => {
    const chip = new RP2350();
    const pin = chip.gpio[5];
    pin.padValue |= 0x40;

    chip.writeUint32(bank(PROC0_INTE0, 5), irqBit(5, EDGE_HIGH));
    pin.setInputValue(true);
    expect(chip.core0.meipa[IRQ2350.IO_IRQ_BANK0]).toBeTruthy();

    chip.writeUint32(bank(INTR0, 5), irqBit(5, EDGE_HIGH));

    expect(chip.readUint32(bank(INTR0, 5)) & irqBit(5, EDGE_HIGH)).toBe(0);
    expect(chip.core0.meipa[IRQ2350.IO_IRQ_BANK0]).toBeFalsy();
  });

  it('reports status-after-mask in PROC0_INTS1 for pins 8-15', () => {
    const chip = new RP2350();
    const pin = chip.gpio[8];
    pin.padValue |= 0x40;

    chip.writeUint32(bank(PROC0_INTE0, 8), irqBit(8, EDGE_HIGH));
    pin.setInputValue(true);

    expect(chip.readUint32(bank(PROC0_INTS0, 8)) & irqBit(8, EDGE_HIGH)).toBeTruthy();
    expect(chip.core0.meipa[IRQ2350.IO_IRQ_BANK0]).toBeTruthy();
  });

  it('forces an interrupt through PROC0_INTF without any pin activity', () => {
    const chip = new RP2350();
    const forced = irqBit(0, LEVEL_LOW);

    chip.writeUint32(bank(PROC0_INTF0, 0), forced);

    expect(chip.readUint32(bank(PROC0_INTF0, 0))).toBe(forced >>> 0);
    expect(chip.readUint32(bank(PROC0_INTS0, 0)) & forced).toBeTruthy();
    expect(chip.core0.meipa[IRQ2350.IO_IRQ_BANK0]).toBeTruthy();

    chip.writeUint32(bank(PROC0_INTF0, 0), 0);
    expect(chip.readUint32(bank(PROC0_INTS0, 0)) & forced).toBe(0);
    expect(chip.core0.meipa[IRQ2350.IO_IRQ_BANK0]).toBeFalsy();
  });

  it('tracks level-low in PROC0_INTS and clears it when the pin goes high', () => {
    const chip = new RP2350();
    const pin = chip.gpio[4];
    pin.padValue |= 0x40; // IE: enable the input buffer

    chip.writeUint32(bank(PROC0_INTE0, 4), irqBit(4, LEVEL_LOW));
    pin.setInputValue(false);
    expect(chip.readUint32(bank(PROC0_INTS0, 4)) & irqBit(4, LEVEL_LOW)).toBeTruthy();
    expect(chip.core0.meipa[IRQ2350.IO_IRQ_BANK0]).toBeTruthy();

    pin.setInputValue(true);
    expect(chip.readUint32(bank(PROC0_INTS0, 4)) & irqBit(4, LEVEL_LOW)).toBe(0);
    expect(chip.core0.meipa[IRQ2350.IO_IRQ_BANK0]).toBeFalsy();
  });
});
