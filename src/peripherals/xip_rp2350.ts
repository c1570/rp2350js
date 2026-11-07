import { IRPChip } from '../rpchip';
import { BasePeripheral, Peripheral } from './peripheral';
import { RPIOQSPI } from './io_qspi_rp2350';

const QMI_DIRECT_CSR = 0x00;
const QMI_DIRECT_TX = 0x04;
const QMI_DIRECT_RX = 0x08;

const DIRECT_CSR_RESET = 0x01800000;
const DIRECT_CSR_BUSY = 1 << 1;
const DIRECT_CSR_TXEMPTY = 1 << 11;
const DIRECT_CSR_TXFULL = 1 << 10;
const DIRECT_CSR_RXEMPTY = 1 << 16;
const DIRECT_CSR_RXFULL = 1 << 17;
const DIRECT_CSR_EN = 1 << 0;

/**
 * RP2350 QSPI Memory Interface (QMI).
 * Reference: RP2350 datasheet §12.14.
 * Models the direct-mode CSR/TX/RX FIFOs as always-empty/never-busy
 * so the bootrom's polling loops complete. The memory-mapped XIP
 * window (0x10000000+) is handled by the chip's flash array directly.
 */
export class RPXIPQMI<ChipType extends IRPChip = IRPChip>
  extends BasePeripheral<ChipType>
  implements Peripheral
{
  private directCsr = DIRECT_CSR_RESET;
  private directCsrEn = false;

  // --- Minimal SPI flash model for direct mode ---
  // Tracks chip-select and interprets each CS-framed byte stream as one SPI
  // transaction (WREN/WRDI/RDSR/SECTOR_ERASE/PAGE_PROGRAM/READ). Transfers
  // complete synchronously, so BUSY is never set. This is what makes the
  // bootrom's flash_range_erase/program actually program chip.flash instead
  // of silently doing nothing.
  private csActive = false;
  private ioQspi: RPIOQSPI<ChipType> | null | undefined;
  /** Chip-select is asserted via QMI ASSERT_CS0N or the IO_QSPI SS output
   * override (OUTOVER=LOW), which is how the bootrom bitbangs CS. */
  private csNow(): boolean {
    if ((this.directCsr & 0x04) !== 0) {
      return true;
    }
    if (this.ioQspi === undefined) {
      const p = (this.rpchip as unknown as { peripherals?: Record<number, unknown> })
        .peripherals?.[0x40030];
      this.ioQspi = p instanceof RPIOQSPI ? (p as RPIOQSPI<ChipType>) : null;
    }
    return !!this.ioQspi && ((this.ioQspi.readReg(0x1c) >>> 12) & 0x3) === 0x2;
  }
  private syncCs() {
    const cs = this.csNow();
    if (cs && !this.csActive) {
      this.beginTransaction();
    } else if (!cs && this.csActive) {
      this.endTransaction();
    }
  }
  private cmd: number | null = null;
  private addrBytes: number[] = [];
  private addr = 0;
  private progBytes: number[] = [];
  private readKind: 'none' | 'status' | 'data' = 'none';
  private readAddr = 0;
  private dummySkip = 0;
  private wel = false;
  private rxFifo: number[] = [];

  private static readonly CSR_RW_MASK =
    0xc0000000 | // RXDELAY
    0x3fc00000 | // CLKDIV
    0x80 | // AUTO_CS1N
    0x40 | // AUTO_CS0N
    0x08 | // ASSERT_CS1N
    0x04 | // ASSERT_CS0N
    0x01; // EN

  readUint32(offset: number) {
    if (offset === QMI_DIRECT_CSR) {
      // BUSY is never set (we complete transfers synchronously); TX FIFO is
      // always empty (we consume pushes immediately). RX status is live.
      const rxEmpty = this.rxFifo.length === 0;
      return (
        ((this.directCsr & RPXIPQMI.CSR_RW_MASK) |
          (this.directCsrEn ? DIRECT_CSR_EN : 0) |
          DIRECT_CSR_TXEMPTY |
          (rxEmpty ? DIRECT_CSR_RXEMPTY : 0) |
          ((this.rxFifo.length & 0x7) << 18)) >>>
        0
      );
    }
    if (offset === QMI_DIRECT_RX) {
      // RX FIFO pop; empty reads return 0 (undefined on real h/w).
      return this.rxFifo.length ? this.rxFifo.shift()! : 0;
    }
    return super.readUint32(offset);
  }

  writeUint32(offset: number, value: number) {
    if (offset === QMI_DIRECT_CSR) {
      this.directCsr = value & RPXIPQMI.CSR_RW_MASK;
      this.directCsrEn = !!(value & DIRECT_CSR_EN);
      this.syncCs();
      return;
    }
    if (offset === QMI_DIRECT_TX) {
      // DIRECT_TX record: NOPUSH/OE/DWIDTH/IWIDTH/DATA. Widths only affect
      // the pads; for flash contents only the clocked bytes matter.
      const wide = !!(value & 0x40000);
      const nopush = !!(value & 0x100000);
      const data = value & 0xffff;
      this.spiByte(data & 0xff, nopush);
      if (wide) {
        this.spiByte((data >>> 8) & 0xff, nopush);
      }
      return;
    }
    super.writeUint32(offset, value);
  }

  private beginTransaction() {
    // Chip-select assert edge: do NOT reset the parser here. The bootrom
    // clocks command bytes with CS deasserted and asserts CS only for the
    // data clocks that follow, so an assert-edge reset would wipe a just
    // received opcode (e.g. RDSR) before its status clocks arrive.
    this.csActive = true;
  }

  private endTransaction() {
    this.csActive = false;
    if (this.cmd === 0x20 && this.addrBytes.length === 3) {
      // SECTOR_ERASE (4KiB, address-aligned)
      const base = this.addr & ~0xfff;
      this.rpchip.flash.fill(0xff, base, base + 0x1000);
    } else if (this.cmd === 0x02 && this.addrBytes.length === 3) {
      // PAGE_PROGRAM: NOR flash clears bits only; wraps within the page.
      const pageBase = this.addr & ~0xff;
      for (let i = 0; i < this.progBytes.length; i++) {
        const at = pageBase + ((this.addr + i) & 0xff);
        this.rpchip.flash[at] &= this.progBytes[i];
      }
    }
    this.cmd = null;
    this.readKind = 'none';
  }

  private pushRx(byte: number) {
    if (this.rxFifo.length < 32) {
      this.rxFifo.push(byte & 0xff);
    }
  }

  private statusByte() {
    // WIP=0 (synchronous), WEL tracked.
    return this.wel ? 0x02 : 0x00;
  }

  private spiByte(byte: number, nopush: boolean) {
    this.syncCs();
    // NOTE: bytes are parsed as a continuous stream regardless of
    // chip-select. The bootrom frames groups with CS edges (which reset the
    // parser via begin/endTransaction) but clocks command bytes outside of
    // them; gating on CS would drop every command. RX pushes still follow
    // the hardware rule (one push per non-NOPUSH record) so the bootrom's
    // count-exact drain loops terminate with the right depth.
    if (this.cmd === null) {
      this.cmd = byte;
      this.addrBytes = [];
      this.progBytes = [];
      this.dummySkip = 0;
      switch (byte) {
        case 0x06: // WREN
          this.wel = true;
          this.cmd = null;
          break;
        case 0x04: // WRDI
          this.wel = false;
          this.cmd = null;
          break;
        case 0x05: // RDSR
          this.readKind = 'status';
          break;
        case 0x20: // SECTOR_ERASE
        case 0x02: // PAGE_PROGRAM
        case 0x03: // READ
        case 0x0b: // FAST_READ (one dummy byte after address)
        case 0x9f: // RDID (clock out zeros, as before: no push)
          if (byte === 0x0b) {
            this.dummySkip = 1;
          }
          this.readKind = 'none';
          break;
        default:
          // Unknown single-byte opcode (or wire noise): ignore.
          this.cmd = null;
          break;
      }
      if (!nopush) {
        // A pushed command byte clocks undefined MISO on h/w; the bootrom's
        // count-exact pumps consume it, so push a dummy to keep depth exact.
        this.pushRx(0xff);
      }
      return;
    }
    if (this.readKind === 'status') {
      if (!nopush) {
        this.pushRx(this.statusByte());
      }
      return;
    }
    if (this.cmd === 0x03 || this.cmd === 0x0b) {
      if (this.addrBytes.length < 3) {
        this.addrBytes.push(byte);
        if (this.addrBytes.length === 3) {
          this.readAddr =
            (this.addrBytes[0] << 16) | (this.addrBytes[1] << 8) | this.addrBytes[2];
        }
      } else if (this.dummySkip > 0) {
        this.dummySkip--;
      } else if (!nopush) {
        this.pushRx(this.rpchip.flash[this.readAddr % this.rpchip.flash.length]);
        this.readAddr++;
      } else {
        this.readAddr++;
      }
      return;
    }
    if (this.cmd === 0x20 || this.cmd === 0x02) {
      if (this.addrBytes.length < 3) {
        this.addrBytes.push(byte);
        if (this.addrBytes.length === 3) {
          this.addr =
            (this.addrBytes[0] << 16) | (this.addrBytes[1] << 8) | this.addrBytes[2];
          if (this.cmd === 0x20) {
            // SECTOR_ERASE (4KiB, address-aligned)
            const base = this.addr & ~0xfff;
            this.rpchip.flash.fill(0xff, base, base + 0x1000);
            this.cmd = null;
          }
        }
      } else if (this.cmd === 0x02) {
        // PAGE_PROGRAM: NOR flash clears bits only; wraps within the page.
        // Applied incrementally so partial pages still stick. The bootrom
        // issues page-sized PROGRAM commands (256B), after which the parser
        // returns to opcode mode for the next command.
        const pageBase = this.addr & ~0xff;
        const at = pageBase + ((this.addr + this.progBytes.length) & 0xff);
        this.rpchip.flash[at] &= byte;
        this.progBytes.push(byte);
        if (this.progBytes.length >= 256) {
          this.cmd = null;
        }
      }
      if (!nopush) {
        this.pushRx(0xff);
      }
      return;
    }
    if (!nopush) {
      this.pushRx(0xff);
    }
  }
}

/** Legacy XIP peripheral (kept for any existing imports). */
export class RPXIP<ChipType extends IRPChip = IRPChip>
  extends BasePeripheral<ChipType>
  implements Peripheral
{
  protected regs = new Uint32Array(1024);

  readUint32(offset: number) {
    super.readUint32(offset);
    return this.regs[offset];
  }

  writeUint32(offset: number, value: number) {
    super.writeUint32(offset, value);
    this.regs[offset] = value;
  }
}
