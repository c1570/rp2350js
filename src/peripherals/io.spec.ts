import { describe, expect, it } from 'vitest';
import { IRQ } from '../irq';
import { RP2040 } from '../rp2040';

const IO_BANK0_BASE = 0x40014000;

const INTR0 = 0xf0;
const PROC0_INTE0 = 0x100;
const PROC0_INTF0 = 0x110;
const PROC0_INTS0 = 0x120;

// Bit position of each interrupt condition inside a PROC0_INT/INTR entry.
const LEVEL_LOW = 0;
const EDGE_HIGH = 3;

const IO_IRQ_BANK0_BIT = 1 << IRQ.IO_BANK0;

/** Bit for `pin` / `event` in the INTR/PROC0_INTE/PROC0_INTF/PROC0_INTS registers. */
function irqBit(pin: number, event: number) {
  return (1 << ((pin & 7) * 4 + event)) >>> 0;
}

/** Address of the 8-pin register bank containing `pin`. */
function bank(base: number, pin: number) {
  return IO_BANK0_BASE + base + (pin >>> 3) * 4;
}

function irqPending(chip: RP2040, core: 0 | 1) {
  return !!(chip.core[core].pendingInterrupts & IO_IRQ_BANK0_BIT);
}

describe('RP2040 IO_BANK0 GPIO interrupts', () => {
  it('round-trips PROC0_INTE0 enable bits for pins 0-7', () => {
    const chip = new RP2040();
    const value = irqBit(5, EDGE_HIGH);
    chip.writeUint32(bank(PROC0_INTE0, 5), value);
    expect(chip.readUint32(bank(PROC0_INTE0, 5))).toBe(value >>> 0);
    expect(chip.gpio[5].irqEnableMask).toBe(1 << EDGE_HIGH);
  });

  it('maps pins 8-15 to PROC0_INTE1 rather than INTE0', () => {
    const chip = new RP2040();
    const value = irqBit(8, EDGE_HIGH);
    chip.writeUint32(bank(PROC0_INTE0, 8), value); // PROC0_INTE1
    expect(chip.readUint32(IO_BANK0_BASE + PROC0_INTE0 + 0x4)).toBe(value >>> 0);
    expect(chip.readUint32(IO_BANK0_BASE + PROC0_INTE0)).toBe(0);
  });

  it('maps pins 24-29 to PROC0_INTE3', () => {
    const chip = new RP2040();
    const value = irqBit(29, EDGE_HIGH);
    chip.writeUint32(bank(PROC0_INTE0, 29), value); // PROC0_INTE3 at 0x10c
    expect(chip.readUint32(IO_BANK0_BASE + PROC0_INTE0 + 3 * 4)).toBe(value >>> 0);
  });

  it('captures an enabled rising edge in INTR and asserts IO_IRQ_BANK0', () => {
    const chip = new RP2040();
    const pin = chip.gpio[5];
    pin.padValue |= 0x40; // IE: enable the input buffer

    chip.writeUint32(bank(PROC0_INTE0, 5), irqBit(5, EDGE_HIGH));
    pin.setInputValue(true);

    expect(chip.readUint32(bank(INTR0, 5)) & irqBit(5, EDGE_HIGH)).toBeTruthy();
    expect(chip.readUint32(bank(PROC0_INTS0, 5)) & irqBit(5, EDGE_HIGH)).toBeTruthy();
    expect(irqPending(chip, 0)).toBe(true);
    expect(irqPending(chip, 1)).toBe(true);
  });

  it('asserts IO_IRQ_BANK0 for an edge on a high-bank pin (GPIO29)', () => {
    const chip = new RP2040();
    const pin = chip.gpio[29];
    pin.padValue |= 0x40;

    chip.writeUint32(bank(PROC0_INTE0, 29), irqBit(29, EDGE_HIGH));
    pin.setInputValue(true);

    expect(chip.readUint32(bank(INTR0, 29)) & irqBit(29, EDGE_HIGH)).toBeTruthy();
    expect(chip.readUint32(bank(PROC0_INTS0, 29)) & irqBit(29, EDGE_HIGH)).toBeTruthy();
    expect(irqPending(chip, 0)).toBe(true);
  });

  it('does not assert IO_IRQ_BANK0 for an edge that is not enabled', () => {
    const chip = new RP2040();
    const pin = chip.gpio[5];
    pin.padValue |= 0x40;

    pin.setInputValue(true);

    expect(irqPending(chip, 0)).toBe(false);
  });

  it('clears the raw edge bit and deasserts IO_IRQ_BANK0 when INTR is written 1', () => {
    const chip = new RP2040();
    const pin = chip.gpio[5];
    pin.padValue |= 0x40;

    chip.writeUint32(bank(PROC0_INTE0, 5), irqBit(5, EDGE_HIGH));
    pin.setInputValue(true);
    expect(irqPending(chip, 0)).toBe(true);

    chip.writeUint32(bank(INTR0, 5), irqBit(5, EDGE_HIGH));

    expect(chip.readUint32(bank(INTR0, 5)) & irqBit(5, EDGE_HIGH)).toBe(0);
    expect(irqPending(chip, 0)).toBe(false);
  });

  it('reports status-after-mask in PROC0_INTS1 for pins 8-15', () => {
    const chip = new RP2040();
    const pin = chip.gpio[8];
    pin.padValue |= 0x40;

    chip.writeUint32(bank(PROC0_INTE0, 8), irqBit(8, EDGE_HIGH));
    pin.setInputValue(true);

    expect(chip.readUint32(bank(PROC0_INTS0, 8)) & irqBit(8, EDGE_HIGH)).toBeTruthy();
    expect(irqPending(chip, 0)).toBe(true);
  });

  it('forces an interrupt through PROC0_INTF without any pin activity', () => {
    const chip = new RP2040();
    const forced = irqBit(0, LEVEL_LOW);

    chip.writeUint32(bank(PROC0_INTF0, 0), forced);

    expect(chip.readUint32(bank(PROC0_INTF0, 0))).toBe(forced >>> 0);
    expect(chip.readUint32(bank(PROC0_INTS0, 0)) & forced).toBeTruthy();
    expect(irqPending(chip, 0)).toBe(true);

    chip.writeUint32(bank(PROC0_INTF0, 0), 0);
    expect(chip.readUint32(bank(PROC0_INTS0, 0)) & forced).toBe(0);
    expect(irqPending(chip, 0)).toBe(false);
  });

  it('tracks level-low in PROC0_INTS and clears it when the pin goes high', () => {
    const chip = new RP2040();
    const pin = chip.gpio[4];
    pin.padValue |= 0x40; // IE: enable the input buffer

    chip.writeUint32(bank(PROC0_INTE0, 4), irqBit(4, LEVEL_LOW));
    pin.setInputValue(false);
    expect(chip.readUint32(bank(PROC0_INTS0, 4)) & irqBit(4, LEVEL_LOW)).toBeTruthy();
    expect(irqPending(chip, 0)).toBe(true);

    pin.setInputValue(true);
    expect(chip.readUint32(bank(PROC0_INTS0, 4)) & irqBit(4, LEVEL_LOW)).toBe(0);
    expect(irqPending(chip, 0)).toBe(false);
  });
});
