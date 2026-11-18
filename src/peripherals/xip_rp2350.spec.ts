import { describe, expect, it } from 'vitest';
import { RP2350 } from '../rp2350';

// QMI direct-mode flash model (bootrom flash_range_erase/program path).
// CS is bitbanged through the IO_QSPI SS pad OUTOVER field, exactly like the
// bootrom: OUTOVER=2 (drive low) asserts, OUTOVER=3 (drive high) deasserts.

const QMI = 0x400d0000;
const QMI_TX = QMI + 0x04;
const QMI_RX = QMI + 0x08;
const SS_CTRL = 0x40030000 + 0x1c; // GPIO_QSPI_SS_CTRL
const NOPUSH = 0x100000; // QMI_DIRECT_TX_NOPUSH (bit 20)

function setup() {
  const chip = new RP2350();
  const cs = (on: boolean) => {
    chip.writeUint32(SS_CTRL, 0x1f | ((on ? 2 : 3) << 12));
    chip.writeUint32(QMI, 0); // the model samples CS lazily on QMI writes
  };
  const tx = (b: number) => chip.writeUint32(QMI_TX, b);
  return { chip, cs, tx };
}

describe('RP2350 QMI direct-mode flash model', () => {
  it('SECTOR_ERASE fills the 4KiB sector with 0xff and only that sector', () => {
    const { chip, cs, tx } = setup();
    chip.flash.fill(0x00, 0x3f000, 0x42000);
    cs(true);
    tx(0x20); // SECTOR_ERASE
    tx(0x04);
    tx(0x00);
    tx(0x00); // addr 0x040000
    cs(false);
    expect(chip.flash.slice(0x40000, 0x41000).every((b) => b === 0xff)).toBe(true);
    expect(chip.flash[0x3f000]).toBe(0x00); // previous sector untouched
    expect(chip.flash[0x41000]).toBe(0x00); // next sector untouched
  });

  it('PAGE_PROGRAM ANDs into erased flash (NOR), READ clocks bytes back', () => {
    const { chip, cs, tx } = setup();
    chip.flash.fill(0xff, 0x40010, 0x40020);
    cs(true);
    tx(0x02); // PAGE_PROGRAM
    tx(0x04);
    tx(0x00);
    tx(0x10); // addr 0x040010
    tx(0x0f);
    tx(0xf0); // data
    cs(false);
    expect(chip.flash[0x40010]).toBe(0x0f); // 0xff & 0x0f
    expect(chip.flash[0x40011]).toBe(0xf0);
    while (((chip.readUint32(QMI) >>> 16) & 1) === 0) {
      chip.readUint32(QMI_RX); // drain programming dummies (RXEMPTY = bit 16)
    }
    cs(true);
    tx(0x03); // READ
    tx(0x04);
    tx(0x00);
    tx(0x10); // addr
    tx(0x00);
    tx(0x00); // two data clocks
    cs(false);
    expect((chip.readUint32(QMI) >>> 18) & 7).toBe(3); // CSR RXLEVEL: opcode dummy + 2 data
    expect(chip.readUint32(QMI_RX)).toBe(0xff); // dummy from the opcode push
    expect(chip.readUint32(QMI_RX)).toBe(0x0f);
    expect(chip.readUint32(QMI_RX)).toBe(0xf0);
  });

  it('RDSR reports WEL after WREN (WIP always 0 — synchronous model)', () => {
    const { chip, cs, tx } = setup();
    cs(true);
    tx(0x06 | NOPUSH); // WREN, don't push to RX
    tx(0x05 | NOPUSH); // RDSR, don't push
    tx(0x00); // status clock → one RX push
    cs(false);
    expect(chip.readUint32(QMI_RX)).toBe(0x02); // WEL=1, WIP=0
  });
});

describe('RP2350 PSRAM (QMI CS1 + XIP window 0x11000000)', () => {
  const ASSERT_CS1N = 0x08;
  const EN = 0x01;

  it('answers the APS6404L READ ID sequence (KGD 0x5d, EID 0x52)', () => {
    const chip = new RP2350();
    const rx: number[] = [];
    chip.writeUint32(QMI, EN | ASSERT_CS1N);
    chip.writeUint32(QMI_TX, 0x9f);
    for (let i = 0; i < 6; i++) chip.writeUint32(QMI_TX, 0xff);
    for (let i = 0; i < 7; i++) rx.push(chip.readUint32(QMI_RX));
    chip.writeUint32(QMI, EN);
    expect(rx[4]).toBe(0x0d); // MFID
    expect(rx[5]).toBe(0x5d);
    expect(rx[6]).toBe(0x52);
  });

  const AUTO_CS1N = 0x80;

  function readId(chip: RP2350, pushes: number) {
    chip.writeUint32(QMI_TX, 0x9f);
    for (let i = 1; i < pushes; i++) chip.writeUint32(QMI_TX, 0xff);
    const rx: number[] = [];
    for (let i = 0; i < pushes; i++) rx.push(chip.readUint32(QMI_RX));
    return rx;
  }

  it('a CSR write that keeps ASSERT_CS1N set (e.g. CLKDIV change) does not restart the frame', () => {
    const chip = new RP2350();
    chip.writeUint32(QMI, EN | ASSERT_CS1N);
    chip.writeUint32(QMI_TX, 0x9f);
    for (let i = 0; i < 3; i++) chip.writeUint32(QMI_TX, 0xff);
    chip.writeUint32(QMI, EN | ASSERT_CS1N | (30 << 22));
    for (let i = 0; i < 3; i++) chip.writeUint32(QMI_TX, 0xff);
    const rx: number[] = [];
    for (let i = 0; i < 7; i++) rx.push(chip.readUint32(QMI_RX));
    expect(rx.slice(4)).toEqual([0x0d, 0x5d, 0x52]);
  });

  it('deasserting and reasserting ASSERT_CS1N starts a fresh frame', () => {
    const chip = new RP2350();
    chip.writeUint32(QMI, EN | ASSERT_CS1N);
    expect(readId(chip, 7)[5]).toBe(0x5d);
    chip.writeUint32(QMI, EN);
    chip.writeUint32(QMI, EN | ASSERT_CS1N);
    expect(readId(chip, 7)[5]).toBe(0x5d);
  });

  it('AUTO_CS1N: pushes back-to-back form one frame, observing the drained FIFO ends it', () => {
    const chip = new RP2350();
    chip.writeUint32(QMI, EN | AUTO_CS1N);
    expect(readId(chip, 7).slice(4)).toEqual([0x0d, 0x5d, 0x52]);
    chip.readUint32(QMI); // software waits for !BUSY: CS1 deasserts
    expect(readId(chip, 7).slice(4)).toEqual([0x0d, 0x5d, 0x52]);
  });

  it('maps 8MiB of read/write memory at 0x11000000, separate from flash', () => {
    const chip = new RP2350();
    chip.flash[0] = 0x11;
    chip.writeUint32(0x11000000, 0xdeadbeef);
    chip.writeUint16(0x11000104, 0x1234);
    chip.writeUint8(0x117fffff, 0x5a);
    expect(chip.readUint32(0x11000000)).toBe(0xdeadbeef);
    expect(chip.readUint16(0x11000104)).toBe(0x1234);
    expect(chip.readUint8(0x117fffff)).toBe(0x5a);
    expect(chip.readUint8(0x10000000)).toBe(0x11); // flash untouched
    expect(chip.readUint32(0x15000000)).toBe(0xdeadbeef); // uncached alias
    expect(chip.readUint32(0x1d000000)).toBe(0xdeadbeef); // uncached + untranslated alias
    chip.writeUint32(0x1d000008, 0xcafef00d);
    expect(chip.readUint32(0x11000008)).toBe(0xcafef00d);
  });

  it('cache-maintenance writes (0x18000000 alias) never touch PSRAM', () => {
    const chip = new RP2350();
    chip.writeUint32(0x11000000, 0x12345678);
    chip.writeUint8(0x19000000, 0); // xip_cache_clean_range() style op on the CS1 window
    chip.writeUint32(0x19000000, 0);
    expect(chip.readUint32(0x11000000)).toBe(0x12345678);
  });

  it('executes code written to PSRAM (decode cache is invalidated on writes)', () => {
    const chip = new RP2350();
    const cpu = chip.core0;
    chip.writeUint32(0x11000000, 0x00100093); // addi x1, x0, 1
    cpu.pc = 0x11000000;
    cpu.executeInstruction();
    expect(cpu.getRegisterU(1)).toBe(1);
    chip.writeUint32(0x11000000, 0x00200093); // addi x1, x0, 2
    cpu.pc = 0x11000000;
    cpu.executeInstruction();
    expect(cpu.getRegisterU(1)).toBe(2);
  });
});
