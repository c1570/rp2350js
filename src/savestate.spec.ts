import * as fs from 'fs';
import { describe, expect, it } from 'vitest';
import { RP2040 } from './rp2040';
import { RP2350 } from './rp2350';
import { bootrom_rp2350_A2 } from './bootroms';
import { GPIOPinState } from './gpio-pin';
import { loadHex } from './utils/load-hex';
import { ConsoleLogger, LogLevel } from './utils/logging';
import { Fault, NO_PENDING_FAULT } from './cortex-m33/core';
import {
  SAVE_STATE_FLAG_FLASH,
  SAVE_STATE_FLAG_FLASH_WRITTEN,
  SAVE_STATE_FLAG_PSRAM,
  SAVE_STATE_FLAG_PSRAM_WRITTEN,
  SAVE_STATE_HEADER_WORDS,
  SAVE_STATE_OMIT_FLASH,
  SAVE_STATE_OMIT_PSRAM,
  SERIALIZATION_QUIRK_CORE_VARIABLE_SIZE,
  SERIALIZATION_QUIRK_ENDIAN_DEPENDENT,
  SERIALIZATION_QUIRK_INCOMPLETE,
  SERIALIZATION_QUIRK_MUST_INITIALIZE,
  SERIALIZATION_QUIRK_SINGLE_SESSION,
} from './utils/save-state';

interface FirmwareImage {
  name: string;
  file: string;
  /** Loaded into SRAM with the cores started by hand; otherwise an image in flash. */
  sram: boolean;
  /** An ARM image: the chip boots it through the bootrom. */
  arm?: boolean;
  pins: number[];
  pc: number;
  warmup: number;
  replay: number;
  timeout: number;
}

// Which chip an image is for. Siblings rather than a base and a subtype, so that a
// list mixing them stays a union instead of collapsing onto the RP2350's type.
interface Rp2350Firmware extends FirmwareImage {
  rp2040?: false;
}

interface Rp2040Firmware extends FirmwareImage {
  rp2040: true;
}

type Firmware = Rp2350Firmware | Rp2040Firmware;

const blinkSimple: Rp2350Firmware = {
  name: 'blink_simple',
  pins: [2, 25],
  file: './demo/riscv_blink/blink_simple.hex',
  sram: true,
  pc: 0x20000220,
  warmup: 150000,
  replay: 350000,
  timeout: 5000,
};

const helloTimer: Rp2350Firmware = {
  name: 'hello_timer',
  file: './demo/riscv_timer/hello_timer.hex',
  pins: [2, 25],
  sram: false,
  pc: 0x10000036,
  warmup: 1500000,
  replay: 9000000,
  timeout: 5000,
};

// The RP2040's own image. It prints "Hello, world!" over UART at steps 32037-32230,
// one byte every ten steps, then idles. The snapshot lands just after "He", so the
// replay window has the rest of the message to re-emit.
const helloSerialRp2040: Rp2040Firmware = {
  name: 'hello_serial (RP2040)',
  file: './demo/hello_serial_rp2040/hello_serial.hex',
  rp2040: true,
  pins: [25],
  sram: false,
  pc: 0,
  warmup: 32050,
  replay: 500000,
  timeout: 5000,
};

// Drives a PIO state machine; the pin edges it produces are the replay trace.
const pioBlink: Rp2350Firmware = {
  name: 'pio_blink',
  file: './demo/riscv_pio_blink/pio_blink.hex',
  pins: [3, 32],
  sram: true,
  pc: 0x20000220,
  warmup: 300000,
  replay: 1700000,
  timeout: 5000,
};

// Boots through the bootrom into flash, then sleeps on SysTick. The LED (pin 25)
// toggles every 37.5M steps, so the warm-up ends just before its first falling edge.
const armBlink: Rp2350Firmware = {
  name: 'm33_blink (ARM)',
  file: './demo/m33_blink/blink_simple.hex',
  pins: [25],
  sram: false,
  arm: true,
  pc: 0,
  warmup: 37000000,
  replay: 1500000,
  timeout: 30000,
};

type TestChip = RP2350 | RP2040;

type ChipOf<F extends Firmware> = F extends Rp2040Firmware ? RP2040 : RP2350;

// Callers get the concrete chip type; the body copes with either.
function newChip<F extends Firmware>(firmware: F): ChipOf<F>;
function newChip(firmware: Firmware): TestChip {
  if (firmware.rp2040) {
    const chip = new RP2040({ loadFirmware: firmware.file });
    chip.logger = new ConsoleLogger(LogLevel.Error, true);
    return chip;
  }
  const chip = new RP2350({ coreArch: firmware.arm ? 'arm' : 'riscv' });
  chip.logger = new ConsoleLogger(LogLevel.Error, true);
  if (firmware.arm) {
    chip.loadFirmware(firmware.file);
    return chip;
  }
  chip.loadBootrom(bootrom_rp2350_A2);
  const hex = fs.readFileSync(firmware.file, 'utf-8');
  loadHex(hex, firmware.sram ? chip.sram : chip.flash, firmware.sram ? 0x20000000 : 0x10000000);
  chip.core0.pc = chip.core1.pc = firmware.pc;
  return chip;
}

function stateBuffer(chip: TestChip) {
  return new Uint8Array(chip.serializeSize());
}

function usedBytes(data: Uint8Array) {
  // The body size is header word 5.
  const totalWords = new Uint32Array(data.buffer, data.byteOffset, SAVE_STATE_HEADER_WORDS)[5];
  return (SAVE_STATE_HEADER_WORDS + totalWords) * 4;
}

function headerOf(data: Uint8Array) {
  return Array.from(new Uint32Array(data.buffer, data.byteOffset, SAVE_STATE_HEADER_WORDS));
}

const PSRAM = 0x15000000; // cached PSRAM window: XIP chip select 1
const OMIT_BOTH = SAVE_STATE_OMIT_FLASH | SAVE_STATE_OMIT_PSRAM;

// The QMI direct-mode protocol the bootrom uses to program flash: CS is driven through
// the QSPI SS pad, command bytes go through QMI_DIRECT_TX (see xip_rp2350.spec.ts).
function programFlashByte(chip: RP2350, address: number, byte: number) {
  const cs = (on: boolean) => {
    chip.writeUint32(0x40030000 + 0x1c, 0x1f | ((on ? 2 : 3) << 12));
    chip.writeUint32(0x400d0000, 0);
  };
  cs(true);
  for (const b of [0x02, address >>> 16, (address >>> 8) & 0xff, address & 0xff, byte]) {
    chip.writeUint32(0x400d0004, b);
  }
  cs(false);
}

function fnv1a(seed: number, bytes: Uint8Array) {
  let hash = seed >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function digest(chip: TestChip) {
  const hash = fnv1a(0x811c9dc5, chip.sram);
  let coreState: unknown;
  if (chip instanceof RP2040) {
    coreState = [
      chip.core0.registers,
      chip.core1.registers,
      chip.core0.PC >>> 0,
      chip.core1.PC >>> 0,
      chip.core0.cycles,
      chip.core1.cycles,
    ];
  } else if (chip.isArmCore) {
    // S registers by raw bits: NaNs and signed zeros do not survive JSON.
    coreState = [chip.armCore0, chip.armCore1].map((core) => [
      core.regs.r,
      new Uint32Array(core.regs.s.buffer, core.regs.s.byteOffset, 32),
      // As 32-bit patterns: a restore hands plain number fields back in their int32
      // form, which is the same register.
      core.regs.xpsr >>> 0,
      core.regs.msp >>> 0,
      core.regs.psp >>> 0,
      core.regs.control >>> 0,
      core.regs.fpscr >>> 0,
      core.PC >>> 0,
      core.cycles,
    ]);
  } else {
    coreState = [
      chip.core0.regs,
      chip.core1.regs,
      chip.core0.csrs,
      chip.core0.pc,
      chip.core1.pc,
      chip.core0.cycles,
      chip.core1.cycles,
    ];
  }
  const text = JSON.stringify([
    hash,
    coreState,
    chip.clock.nanos,
    chip.sio.gpioValue,
    chip.sio.gpioOutputEnable,
    chip.gpioValues(0),
    chip.gpioValues(32),
  ]);
  return `${fnv1a(0x811c9dc5, new TextEncoder().encode(text)).toString(16)}`;
}

class HostIo {
  step = 0;
  gpioEdges: string[] = [];
  uart = '';

  attach(chip: TestChip, pins: number[]) {
    for (const pin of pins) {
      chip.gpio[pin].addListener((state: GPIOPinState) => {
        this.gpioEdges.push(`${this.step}:${pin}:${state}`);
      });
    }
    chip.uart[0].onByte = (value: number) => {
      this.uart += String.fromCharCode(value);
    };
  }

  reset(step: number) {
    this.step = step;
    this.gpioEdges = [];
    this.uart = '';
  }

  run(chip: TestChip, steps: number) {
    for (let i = 0; i < steps; i++) {
      chip.step();
      this.step++;
    }
  }

  view() {
    return { step: this.step, gpioEdges: this.gpioEdges.slice(), uart: this.uart };
  }
}

function setup<F extends Firmware>(firmware: F): { chip: ChipOf<F>; io: HostIo } {
  const chip = newChip(firmware);
  const io = new HostIo();
  io.attach(chip, firmware.pins);
  return { chip, io };
}

function warm<F extends Firmware>(firmware: F): { chip: ChipOf<F>; io: HostIo } {
  const { chip, io } = setup(firmware);
  io.run(chip, firmware.warmup);
  // Host log restarts here, so recorded events cover the replay window only.
  io.reset(firmware.warmup);
  return { chip, io };
}

const IO_BANK0 = 0x40028000;
const UART0 = 0x40070000;
const TIMER0 = 0x400b0000;
const WATCHDOG = 0x400d8000;

function pokeSideRegisters(chip: RP2350) {
  chip.sio.writeUint32(0x54, 0x11223344, 0);
  chip.sio.writeUint32(0x54, 0x55667788, 0);
  chip.sio.writeUint32(0x60, 100, 0);
  chip.sio.writeUint32(0x64, 7, 0);
  chip.sio.writeUint32(0x68, -100, 1);
  chip.sio.writeUint32(0x6c, 7, 1);
  chip.sio.writeUint32(0x80, 0x12345678, 0);
  chip.sio.writeUint32(0x88, 0x100, 0);
  chip.sio.writeUint32(0xac, 4 | (2 << 5), 0);
  chip.sio.writeUint32(0xc0, 0xabcdef01, 1);
  chip.sio.writeUint32(0x1b8, 500000, 0);
  chip.writeUint32(TIMER0 + 0x10, chip.readUint32(TIMER0 + 0x0c) + 5000);
  chip.writeUint32(TIMER0 + 0x40, 0xf);
  chip.writeUint32(UART0 + 0x24, 65);
  chip.writeUint32(UART0 + 0x28, 3);
  chip.writeUint32(UART0 + 0x38, 0x7ff);
  chip.writeUint32(WATCHDOG + 0x10, 0xdeadbeef);
  chip.writeUint32(WATCHDOG + 0x14, 0x12345678);
  chip.writeUint32(IO_BANK0 + 5 * 8 + 4, (2 << 8) | 3);
  chip.gpio[7].setInputValue(true);
  chip.qspi[2].padValue = 0x5a;
  chip.uart[0].feedByte(0x55);
  chip.uart[1].feedByte(0x66);
}

// Compared as 32-bit register values: unserialize hands plain number fields back in
// their int32 form, and the JS divider model keeps a fractional quotient.
function probeSideRegisters(chip: RP2350) {
  const values = [
    chip.sio.readUint32(0x70, 0),
    chip.sio.readUint32(0x74, 0),
    chip.sio.readUint32(0x70, 1),
    chip.sio.readUint32(0x74, 1),
    chip.sio.readUint32(0x78, 0),
    chip.sio.readUint32(0x78, 1),
    chip.sio.readUint32(0x50, 0),
    chip.sio.readUint32(0x50, 1),
    chip.sio.readUint32(0x80, 0),
    chip.sio.readUint32(0xa0, 0),
    chip.sio.readUint32(0xa8, 0),
    chip.sio.readUint32(0xc0, 1),
    chip.sio.readUint32(0xe0, 1),
    chip.sio.readUint32(0x1b8, 0),
    chip.sio.readUint32(0x10, 0),
    chip.readUint32(TIMER0 + 0x10),
    chip.readUint32(TIMER0 + 0x20),
    chip.readUint32(TIMER0 + 0x40),
    chip.readUint32(UART0 + 0x24),
    chip.readUint32(UART0 + 0x28),
    chip.readUint32(UART0 + 0x38),
    chip.readUint32(WATCHDOG + 0x10),
    chip.readUint32(WATCHDOG + 0x14),
    chip.gpio[5].ctrl,
    chip.gpio[7].inputValue ? 1 : 0,
    chip.gpioValues(0),
    chip.qspi[2].padValue,
  ];
  return JSON.stringify(values.map((value) => value >>> 0));
}

describe('save state contract', () => {
  it('restores register state that the replay firmware does not touch', () => {
    const { chip, io } = warm(blinkSimple);
    pokeSideRegisters(chip);
    expect(chip.sio.readUint32(0x78, 0)).toBe(3);
    expect(Number.isInteger(chip.sio.readUint32(0x70, 0))).toBe(false);
    const before = probeSideRegisters(chip);
    expect(before).toContain(JSON.stringify(14));
    expect(before).toContain(JSON.stringify(0xdeadbeef));
    const data = stateBuffer(chip);
    expect(chip.serialize(data, data.length)).toBe(true);

    expect(chip.uart[0].readUint32(0)).toBe(0x55);
    expect(chip.uart[1].readUint32(0)).toBe(0x66);
    chip.sio.writeUint32(0x54, 0, 0);
    chip.sio.readUint32(0x58, 1);
    chip.writeUint32(WATCHDOG + 0x10, 1);
    io.run(chip, 50000);
    expect(probeSideRegisters(chip)).not.toBe(before);

    expect(chip.unserialize(data, data.length)).toBe(true);
    expect(probeSideRegisters(chip)).toBe(before);
    expect(chip.uart[0].readUint32(0)).toBe(0x55);
    expect(chip.uart[1].readUint32(0)).toBe(0x66);
  });

  it('reads register fields back in their int32 form, as the C build holds them', () => {
    // 0xabcdef00 is written as an unsigned JS number and comes back signed.
    const chip = newChip(blinkSimple);
    chip.sio.writeUint32(0x60, 100, 0);
    chip.sio.writeUint32(0x64, 7, 0);
    chip.writeUint32(IO_BANK0 + 5 * 8 + 4, 0xabcdef00);
    const data = stateBuffer(chip);
    expect(chip.serialize(data, data.length)).toBe(true);
    expect(chip.gpio[5].ctrl).toBe(0xabcdef00);
    expect(chip.unserialize(data, data.length)).toBe(true);
    expect(chip.gpio[5].ctrl).toBe(0xabcdef00 | 0);
    expect(chip.sio.readUint32(0x70, 0)).toBe(14);
    expect(chip.gpio[5].functionSelect).toBe(0);
    expect(chip.readUint32(IO_BANK0 + 5 * 8 + 4) >>> 0).toBe(0xabcdef00);
  });
  it('reports its serialization quirks', () => {
    const chip = new RP2350();
    const quirks = chip.getSerializationQuirks();
    // Every peripheral and the RISC-V cores are covered; see savestate-coverage.spec.ts.
    expect(quirks & SERIALIZATION_QUIRK_INCOMPLETE).toBe(0);
    expect(quirks & SERIALIZATION_QUIRK_ENDIAN_DEPENDENT).toBeTruthy();
    expect(quirks & SERIALIZATION_QUIRK_SINGLE_SESSION).toBeTruthy();
    expect(quirks & SERIALIZATION_QUIRK_MUST_INITIALIZE).toBe(0);
    expect(quirks & SERIALIZATION_QUIRK_CORE_VARIABLE_SIZE).toBe(0);
  });

  it('keeps serializeSize() stable for a given set of omitted images', () => {
    const { chip, io } = warm(blinkSimple);
    const before = chip.serializeSize();
    const small = chip.serializeSize(OMIT_BOTH);
    expect(before % 4).toBe(0);
    // With nothing omitted the bound covers flash and PSRAM even before anything has
    // written them, so it can never grow later.
    expect(before).toBeGreaterThan(520 * 1024 + 16 * 1024 * 1024 + 8 * 1024 * 1024);
    expect(small).toBeGreaterThan(520 * 1024);
    expect(small).toBeLessThan(1024 * 1024);

    const data = new Uint8Array(before);
    expect(chip.serialize(data, data.length)).toBe(true);
    expect(usedBytes(data)).toBeLessThanOrEqual(small);
    io.run(chip, 100000);
    expect(chip.serializeSize()).toBe(before);
    expect(chip.serializeSize(OMIT_BOTH)).toBe(small);
  });

  it('does not perturb execution', () => {
    // Both run transferState() on the live chip.
    const { chip, io } = warm(blinkSimple);
    io.run(chip, 100000);
    const reference = { digest: digest(chip), io: io.view() };
    const { chip: measured, io: measuredIo } = warm(blinkSimple);
    measured.serializeSize();
    measured.serialize(stateBuffer(measured), measured.serializeSize());
    measured.unserialize(stateBuffer(measured), 0);
    measuredIo.run(measured, 100000);
    expect({ digest: digest(measured), io: measuredIo.view() }).toEqual(reference);
  });

  it('refuses a buffer that is too small', () => {
    // Only an honest size is checked: one that overstates the buffer is a contract
    // violation, which cannot be detected in C.
    const { chip } = warm(blinkSimple);
    const full = stateBuffer(chip);
    expect(chip.serialize(full, full.length)).toBe(true);
    const data = full.slice(0, usedBytes(full) - 4);
    expect(chip.serialize(data, data.length)).toBe(false);
    // Between the real size and the bound there is only unused room: still enough.
    const nearlyFull = full.slice(0, full.length - 4);
    expect(chip.serialize(nearlyFull, nearlyFull.length)).toBe(true);
    const tiny = new Uint8Array(8);
    expect(chip.serialize(tiny, tiny.length)).toBe(false);
  });

  it.each([blinkSimple, helloSerialRp2040])(
    'writes exactly the reported number of bytes and leaves the rest of the buffer alone: $name',
    (firmware) => {
      const { chip } = warm(firmware);
      const data = stateBuffer(chip).fill(0xa5);
      expect(chip.serialize(data, data.length)).toBe(true);
      const used = usedBytes(data);
      expect(used).toBeLessThanOrEqual(data.length);
      const rest = new Uint32Array(data.buffer, data.byteOffset + used, (data.length - used) >>> 2);
      expect(rest.some((word) => word !== 0xa5a5a5a5)).toBe(false);
    }
  );

  it('refuses states with a foreign or truncated header without touching the chip', () => {
    const { chip, io } = warm(blinkSimple);
    const data = stateBuffer(chip);
    expect(chip.serialize(data, data.length)).toBe(true);
    const snapshot = digest(chip);
    io.run(chip, 200000);
    const untouched = { digest: digest(chip), io: io.view() };

    expect(chip.unserialize(new Uint8Array(data.length).fill(0xaa), data.length)).toBe(false);
    expect(chip.unserialize(data, usedBytes(data) - 4)).toBe(false);
    expect(chip.unserialize(data, 0)).toBe(false);
    // Every header word but the body size, which has its own test below: flags, and
    // the change counts of the images the state left out.
    for (const index of [0, 1, 2, 3, 4, 6, 7]) {
      const foreign = data.slice();
      new Uint32Array(foreign.buffer)[index] ^= 0x00010001;
      expect(chip.unserialize(foreign, foreign.length)).toBe(false);
    }
    expect({ digest: digest(chip), io: io.view() }).toEqual(untouched);

    // Trimming only unused room past the real size is still a complete state.
    expect(chip.unserialize(data, data.length - 4)).toBe(true);
    expect(digest(chip)).toBe(snapshot);
  });

  it('rejects a header whose size disagrees with the body', () => {
    // The header itself is valid here, so the body is read in full before the
    // mismatch shows: this is the one rejection that is not side-effect free.
    const { chip } = warm(blinkSimple);
    const data = stateBuffer(chip);
    expect(chip.serialize(data, data.length)).toBe(true);
    for (const mask of [1, 0x10000]) {
      const tampered = data.slice();
      new Uint32Array(tampered.buffer)[5] ^= mask;
      expect(chip.unserialize(tampered, tampered.length)).toBe(false);
    }
    expect(chip.unserialize(data, data.length)).toBe(true);
  });

  it('restores onto a fresh chip, which then serializes to the same bytes', () => {
    const { chip } = warm(helloTimer);
    const data = stateBuffer(chip);
    expect(chip.serialize(data, data.length)).toBe(true);
    const fresh = newChip(helloTimer);
    expect(fresh.unserialize(data, data.length)).toBe(true);
    const again = stateBuffer(fresh);
    expect(fresh.serialize(again, again.length)).toBe(true);
    expect(again.subarray(0, usedBytes(data))).toEqual(data.subarray(0, usedBytes(data)));
    expect(digest(fresh)).toBe(digest(chip));
  });

  it('keeps ARM and RISC-V states apart', () => {
    const arm = newChip(armBlink);
    const riscv = newChip(blinkSimple);
    for (const chip of [arm, riscv]) {
      expect(chip.getSerializationQuirks() & SERIALIZATION_QUIRK_INCOMPLETE).toBe(0);
    }
    const armState = stateBuffer(arm);
    const riscvState = stateBuffer(riscv);
    expect(arm.serialize(armState, armState.length)).toBe(true);
    expect(riscv.serialize(riscvState, riscvState.length)).toBe(true);

    const riscvBefore = digest(riscv);
    expect(riscv.unserialize(armState, armState.length)).toBe(false);
    expect(digest(riscv)).toBe(riscvBefore);
    const armBefore = digest(arm);
    expect(arm.unserialize(riscvState, riscvState.length)).toBe(false);
    expect(digest(arm)).toBe(armBefore);
  });

  it('is complete on RP2040, and keeps its states apart from the RP2350', () => {
    const rp2040 = newChip(helloSerialRp2040);
    const rp2350 = newChip(blinkSimple);
    for (const chip of [rp2040, rp2350]) {
      expect(chip.getSerializationQuirks() & SERIALIZATION_QUIRK_INCOMPLETE).toBe(0);
    }
    expect(rp2040.serializeSize(SAVE_STATE_OMIT_FLASH)).toBeLessThan(1024 * 1024);
    expect(rp2040.serializeSize()).toBeGreaterThan(16 * 1024 * 1024);

    const state2040 = stateBuffer(rp2040);
    expect(rp2040.serialize(state2040, state2040.length)).toBe(true);
    expect(headerOf(state2040)[3]).toBe(0); // the chip id
    expect(headerOf(state2040)[2]).toBe(0); // flash not written yet: left out
    expect(usedBytes(state2040)).toBeLessThan(1024 * 1024);
    const state2350 = stateBuffer(rp2350);
    expect(rp2350.serialize(state2350, state2350.length)).toBe(true);
    const before = [digest(rp2040), digest(rp2350)];
    expect(rp2350.unserialize(state2040, state2040.length)).toBe(false);
    expect(rp2040.unserialize(state2350, state2350.length)).toBe(false);
    expect([digest(rp2040), digest(rp2350)]).toEqual(before);
  });
});

// Snapshots taken while a peripheral has work in flight: the queued clock alarm, the
// channel registers and any buffered data all have to come back for the replay to
// finish the same way.
describe('replay determinism with work in flight', () => {
  const SRC = 0x20060000;
  const DST = 0x20061000;
  const USB = 0x50100000;
  const ADC = 0x400a0000;
  const USB_BUF_AVAILABLE = 1 << 10;

  it('finishes a DMA transfer the same way after unserialize', () => {
    const { chip, io } = warm(blinkSimple);
    [0x11, 0x2233, 0x445566, 0x778899aa].forEach((word, i) => chip.writeUint32(SRC + 4 * i, word));
    chip.writeUint32(0x50000000, SRC);
    chip.writeUint32(0x50000004, DST);
    chip.writeUint32(0x50000008, 4);
    chip.writeUint32(0x5000000c, 1 | (1 << 6) | (1 << 4) | (0x3f << 17) | (2 << 2));
    expect(chip.readUint32(0x5000000c) & (1 << 26)).toBeTruthy();

    const data = stateBuffer(chip);
    expect(chip.serialize(data, data.length)).toBe(true);
    const probe = () =>
      [0, 1, 2, 3]
        .map((i) => chip.readUint32(DST + 4 * i) >>> 0)
        .concat([0xc, 0x0, 0x4, 0x8].map((at) => chip.readUint32(0x50000000 + at) >>> 0));
    io.run(chip, 5000);
    const finished = probe();
    expect(finished.slice(0, 4)).toEqual([0x11, 0x2233, 0x445566, 0x778899aa]);
    expect(finished[4] & (1 << 26)).toBe(0);

    for (let i = 0; i < 4; i++) {
      chip.writeUint32(DST + 4 * i, 0);
    }
    chip.writeUint32(0x50000008, 99);
    expect(chip.unserialize(data, data.length)).toBe(true);
    io.run(chip, 5000);
    expect(probe()).toEqual(finished);
  });

  it('completes a started ADC conversion with the captured input after unserialize', () => {
    const { chip, io } = warm(blinkSimple);
    chip.adc.channelValues[2] = 0x9ab;
    chip.writeUint32(ADC, 1 | (1 << 2) | (2 << 12));
    expect(chip.readUint32(ADC) & (1 << 8)).toBe(0);

    const data = stateBuffer(chip);
    expect(chip.serialize(data, data.length)).toBe(true);
    io.run(chip, 5000);
    const result = chip.readUint32(ADC + 4);
    expect(result).toBe(0x9ab);

    chip.adc.channelValues[2] = 0x123;
    chip.writeUint32(ADC, 1 | (1 << 2) | (2 << 12));
    io.run(chip, 5000);
    expect(chip.readUint32(ADC + 4)).toBe(0x123);

    expect(chip.unserialize(data, data.length)).toBe(true);
    io.run(chip, 5000);
    expect(chip.readUint32(ADC + 4)).toBe(result);
  });

  it('finishes an RP2040 DMA transfer the same way after unserialize', () => {
    const { chip, io } = warm(helloSerialRp2040);
    // Far above anything hello_serial uses, and clear of its stack at the top of SRAM.
    const src = 0x20030000;
    const dst = 0x20038000;
    [0x11, 0x2233, 0x445566, 0x778899aa].forEach((word, i) => chip.writeUint32(src + 4 * i, word));
    chip.writeUint32(0x50000000, src); // READ_ADDR (without it: the bootrom's vectors)
    chip.writeUint32(0x50000004, dst); // WRITE_ADDR
    chip.writeUint32(0x50000008, 4); // TRANS_COUNT
    // RP2040 CTRL: TREQ_SEL is bits 15..20, INCR_WRITE bit 5, BUSY bit 24.
    const ctrl = 1 | (1 << 5) | (1 << 4) | (0x3f << 15) | (2 << 2);
    chip.writeUint32(0x5000000c, ctrl);
    expect(chip.readUint32(0x5000000c) & (1 << 24)).toBeTruthy();

    const data = stateBuffer(chip);
    expect(chip.serialize(data, data.length)).toBe(true);
    io.run(chip, 5000);
    const finished = [0, 1, 2, 3].map((i) => chip.readUint32(dst + 4 * i) >>> 0);
    expect(finished).toEqual([0x11, 0x2233, 0x445566, 0x778899aa]);
    expect(chip.readUint32(0x5000000c) & (1 << 24)).toBe(0);

    for (let i = 0; i < 4; i++) {
      chip.writeUint32(dst + 4 * i, 0);
    }
    chip.writeUint32(0x50000008, 99);
    expect(chip.unserialize(data, data.length)).toBe(true);
    expect(chip.readUint32(0x5000000c) & (1 << 24)).toBeTruthy(); // busy again
    expect(chip.readUint32(0x50000008) >>> 0).toBe(4); // four units to go, again
    io.run(chip, 5000);
    expect([0, 1, 2, 3].map((i) => chip.readUint32(dst + 4 * i) >>> 0)).toEqual(finished);
  });

  it('counts an RP2040 flash write, and leaves flash out before it', () => {
    const source = warm(helloSerialRp2040).chip;
    const small = stateBuffer(source);
    expect(source.serialize(small, small.length)).toBe(true);
    expect(headerOf(small)[2]).toBe(0);
    expect(headerOf(small)[6]).toBe(1); // the one change so far: loading the firmware

    source.writeUint32(0x10150000, 0x5a5a5a5a); // a store into the flash window
    const full = stateBuffer(source);
    expect(source.serialize(full, full.length)).toBe(true);
    expect(headerOf(full)[2]).toBe(SAVE_STATE_FLAG_FLASH | SAVE_STATE_FLAG_FLASH_WRITTEN);
    expect(headerOf(full)[6]).toBe(2);
    expect(usedBytes(full) - usedBytes(small)).toBe(16 * 1024 * 1024);

    const fresh = newChip(helloSerialRp2040);
    expect(fresh.readUint32(0x10150000)).toBe(0xffffffff);
    expect(fresh.unserialize(full, full.length)).toBe(true);
    expect(fresh.readUint32(0x10150000)).toBe(0x5a5a5a5a);
  });

  it('still saves and restores when the host overran an endpoint buffer slot', () => {
    // schedule() stores the host's length as given and silently drops what does not
    // fit the 1 KiB slot; that must not turn into a failed serialize().
    const { chip } = warm(blinkSimple);
    chip.usbCtrl.endpointReadDone(1, new Uint8Array(5000).fill(0x5a), 5000);
    const data = stateBuffer(chip);
    expect(chip.serialize(data, data.length)).toBe(true);
    expect(chip.unserialize(data, data.length)).toBe(true);
  });

  it('delivers a pending USB endpoint buffer again after unserialize', () => {
    const { chip, io } = warm(blinkSimple);
    const writes: number[][] = [];
    const record = (endpoint: number, buffer: Uint8Array, length: number) => {
      writes.push([endpoint, ...buffer.subarray(0, length)]);
    };
    chip.usbCtrl.onEndpointWrite = record;
    const size = chip.serializeSize();

    chip.writeUint32(USB + 0x08, 0x40);
    const queue = (first: number) => {
      for (let i = 0; i < 4; i++) {
        chip.usbDPRAM[0x40 + i] = first + i;
      }
      chip.writeUint32(USB + 0x88, 4 | USB_BUF_AVAILABLE);
    };
    queue(0xa0);
    // Pending buffers are variable-size state: the size must not depend on them.
    expect(chip.serializeSize()).toBe(size);

    const data = stateBuffer(chip);
    expect(chip.serialize(data, data.length)).toBe(true);
    const status = () => [chip.readUint32(USB + 0x88) >>> 0, chip.readUint32(USB + 0x58) >>> 0];
    io.run(chip, 20000);
    const first = { writes: writes.slice(), status: status() };
    expect(first.writes).toEqual([[1, 0xa0, 0xa1, 0xa2, 0xa3]]);

    queue(0xb0);
    io.run(chip, 20000);
    expect(writes).toEqual([
      [1, 0xa0, 0xa1, 0xa2, 0xa3],
      [1, 0xb0, 0xb1, 0xb2, 0xb3],
    ]);

    expect(chip.unserialize(data, data.length)).toBe(true);
    io.run(chip, 20000);
    expect(writes.slice(2)).toEqual(first.writes);
    expect(status()).toEqual(first.status);

    // A fresh chip has none of the pool slots yet; unserialize() must create them.
    const fresh = setup(blinkSimple);
    const freshWrites: number[][] = [];
    fresh.chip.usbCtrl.onEndpointWrite = (endpoint, buffer, length) => {
      freshWrites.push([endpoint, ...buffer.subarray(0, length)]);
    };
    expect(fresh.chip.unserialize(data, data.length)).toBe(true);
    fresh.io.run(fresh.chip, 20000);
    expect(freshWrites).toEqual(first.writes);
  });
});

describe('memory images', () => {
  it('leaves flash and PSRAM out of the state until something writes them', () => {
    const { chip } = warm(blinkSimple);
    const plain = stateBuffer(chip);
    expect(chip.serialize(plain, plain.length)).toBe(true);
    expect(headerOf(plain)[2]).toBe(0);
    expect(headerOf(plain).slice(6)).toEqual([0, 0]);
    expect(usedBytes(plain)).toBeLessThan(1024 * 1024);

    chip.writeUint32(PSRAM, 0x12345678);
    const withPsram = stateBuffer(chip);
    expect(chip.serialize(withPsram, withPsram.length)).toBe(true);
    expect(headerOf(withPsram)[2]).toBe(SAVE_STATE_FLAG_PSRAM | SAVE_STATE_FLAG_PSRAM_WRITTEN);
    expect(headerOf(withPsram)[7]).toBe(1);
    expect(usedBytes(withPsram) - usedBytes(plain)).toBe(8 * 1024 * 1024);

    // Erased flash well past the firmware image, programmed through the emulated QMI.
    expect(chip.flash[0x110000]).toBe(0xff);
    programFlashByte(chip, 0x110000, 0x5a);
    expect(chip.flash[0x110000]).toBe(0x5a);
    const withBoth = stateBuffer(chip);
    expect(chip.serialize(withBoth, withBoth.length)).toBe(true);
    expect(headerOf(withBoth)[2]).toBe(
      SAVE_STATE_FLAG_FLASH |
        SAVE_STATE_FLAG_FLASH_WRITTEN |
        SAVE_STATE_FLAG_PSRAM |
        SAVE_STATE_FLAG_PSRAM_WRITTEN
    );
    expect(headerOf(withBoth)[6]).toBe(1);
    expect(usedBytes(withBoth) - usedBytes(withPsram)).toBe(16 * 1024 * 1024);
  });

  it('restores a stored image onto a chip where it differs', () => {
    const source = warm(blinkSimple).chip;
    programFlashByte(source, 0x110000, 0x5a);
    source.writeUint32(PSRAM + 4, 0xfeed);
    const data = stateBuffer(source);
    expect(source.serialize(data, data.length)).toBe(true);

    const fresh = newChip(blinkSimple);
    expect(fresh.flash[0x110000]).toBe(0xff);
    expect(fresh.psram[4]).toBe(0);
    expect(fresh.unserialize(data, data.length)).toBe(true);
    expect(fresh.flash[0x110000]).toBe(0x5a);
    expect(fresh.readUint32(PSRAM + 4)).toBe(0xfeed);
    // The restored chip knows the images are written now: its own states carry them.
    const again = stateBuffer(fresh);
    expect(fresh.serialize(again, again.length)).toBe(true);
    expect(headerOf(again)).toEqual(headerOf(data));
  });

  it('refuses a state that left an image out once it has been written again', () => {
    const { chip, io } = warm(blinkSimple);
    chip.writeUint32(PSRAM, 1);
    const size = chip.serializeSize(SAVE_STATE_OMIT_PSRAM);
    const data = new Uint8Array(size);
    expect(chip.serialize(data, size, SAVE_STATE_OMIT_PSRAM)).toBe(true);
    expect(headerOf(data)[2]).toBe(SAVE_STATE_FLAG_PSRAM_WRITTEN);
    const snapshot = digest(chip);

    // Unchanged since the snapshot: accepted, and PSRAM is left exactly as it is.
    io.run(chip, 1000);
    expect(chip.unserialize(data, size)).toBe(true);
    expect(digest(chip)).toBe(snapshot);
    expect(chip.readUint32(PSRAM)).toBe(1);

    // Written again since the snapshot: the state no longer describes this chip's
    // PSRAM, so it is refused and nothing else is touched either.
    chip.writeUint32(PSRAM + 8, 0x77);
    const untouched = digest(chip);
    expect(chip.unserialize(data, size)).toBe(false);
    expect(digest(chip)).toBe(untouched);
    expect(chip.readUint32(PSRAM + 8)).toBe(0x77);
  });

  it('counts a firmware reload, so states from before it are refused', () => {
    const source = warm(blinkSimple).chip;
    const data = stateBuffer(source);
    expect(source.serialize(data, data.length)).toBe(true);
    const reloaded = newChip(blinkSimple);
    reloaded.loadFirmware('demo/riscv_blink/blink_simple.hex');
    expect(reloaded.unserialize(data, data.length)).toBe(false);
  });
});

describe('ARM core state', () => {
  it('keeps a pending UsageFault pending, where the C build used to lose it', () => {
    const { chip, io } = warm(armBlink);
    const core = chip.armCore0;
    // The firmware sleeps in WFI between SysTick ticks, and a sleeping core executes
    // nothing: wait for a tick so there is an instruction to deliver the fault after.
    for (let i = 0; core.waiting && i < 1000000; i++) {
      chip.step();
    }
    expect(core.waiting).toBe(false);
    core.pendingFault = Fault.UsageFault;
    const data = stateBuffer(chip);
    expect(chip.serialize(data, data.length)).toBe(true);
    core.pendingFault = Fault.Nmi;
    expect(chip.unserialize(data, data.length)).toBe(true);
    expect(core.pendingFault).toBe(Fault.UsageFault);

    io.run(chip, 1);
    expect(core.pendingFault).toBe(NO_PENDING_FAULT);
    // UsageFault is not enabled here, so it escalates to HardFault.
    expect(core.regs.ipsr).toBe(3);
    expect(core.regs.inHandlerMode()).toBe(true);
  });

  it('saves the single-precision registers as their exact bits', () => {
    // Signed zero, ±Infinity, a NaN, the smallest subnormal and the largest finite.
    const bits = new Uint32Array([
      0, 0x80000000, 0x7f800000, 0xff800000, 0x7fc00000, 0x00000001, 0x7f7fffff, 0x40490fdb,
    ]);
    const chip = newChip(armBlink);
    chip.armCore0.regs.s.set(new Float32Array(bits.buffer));
    const data = stateBuffer(chip);
    expect(chip.serialize(data, data.length)).toBe(true);

    const fresh = newChip(armBlink);
    expect(fresh.unserialize(data, data.length)).toBe(true);
    const restored = new Uint32Array(fresh.armCore0.regs.s.buffer);
    expect(Array.from(restored.slice(0, 8))).toEqual(Array.from(bits));
  });
});

describe.each([blinkSimple, helloTimer, pioBlink, armBlink, helloSerialRp2040])(
  'replay determinism: $name',
  (firmware) => {
    it(
      'replays identically on the same chip after unserialize',
      () => {
        const reference = warm(firmware);
        reference.io.run(reference.chip, firmware.replay);
        const expected = { digest: digest(reference.chip), io: reference.io.view() };

        const { chip, io } = warm(firmware);
        const data = stateBuffer(chip);
        expect(chip.serialize(data, data.length)).toBe(true);
        io.reset(firmware.warmup);
        io.run(chip, firmware.replay);
        const first = { digest: digest(chip), io: io.view() };
        expect(first).toEqual(expected);

        io.run(chip, firmware.replay);
        expect(chip.unserialize(data, data.length)).toBe(true);
        io.reset(firmware.warmup);
        io.run(chip, firmware.replay);
        expect({ digest: digest(chip), io: io.view() }).toEqual(expected);
      },
      firmware.timeout
    );

    it(
      'replays identically on a fresh chip after unserialize',
      () => {
        const source = warm(firmware);
        const data = stateBuffer(source.chip);
        expect(source.chip.serialize(data, data.length)).toBe(true);

        const target = setup(firmware);
        expect(target.chip.unserialize(data, data.length)).toBe(true);
        source.io.reset(firmware.warmup);
        target.io.reset(firmware.warmup);
        source.io.run(source.chip, firmware.replay);
        target.io.run(target.chip, firmware.replay);
        expect(target.io.view()).toEqual(source.io.view());
        expect(digest(target.chip)).toBe(digest(source.chip));
      },
      firmware.timeout
    );

    it(
      'replays identically with flash and PSRAM left out explicitly',
      () => {
        const reference = warm(firmware);
        reference.io.run(reference.chip, firmware.replay);
        const expected = { digest: digest(reference.chip), io: reference.io.view() };

        const { chip, io } = warm(firmware);
        const size = chip.serializeSize(OMIT_BOTH);
        const data = new Uint8Array(size);
        expect(chip.serialize(data, size, OMIT_BOTH)).toBe(true);
        expect(usedBytes(data)).toBeLessThanOrEqual(size);
        io.run(chip, firmware.replay);
        expect(chip.unserialize(data, size)).toBe(true);
        io.reset(firmware.warmup);
        io.run(chip, firmware.replay);
        expect({ digest: digest(chip), io: io.view() }).toEqual(expected);
      },
      firmware.timeout
    );

    it(
      'actually exercises the host-visible output',
      () => {
        const { chip, io } = warm(firmware);
        io.reset(firmware.warmup);
        io.run(chip, firmware.replay);
        const view = io.view();
        // Pins that only change pull state at boot do not count as output.
        const toggles = view.gpioEdges.filter(
          (edge) => !edge.endsWith(':4') && !edge.endsWith(':3')
        );
        expect(toggles.length + view.uart.length).toBeGreaterThan(0);
      },
      firmware.timeout
    );
  }
);
