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
