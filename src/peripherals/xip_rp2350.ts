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

const QMI_CSR_RW_MASK =
  0xc0000000 | // RXDELAY
  0x3fc00000 | // CLKDIV
  0x80 | // AUTO_CS1N
  0x40 | // AUTO_CS0N
  0x08 | // ASSERT_CS1N
  0x04 | // ASSERT_CS0N
  0x01; // EN

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
  /** Wired by RP2350 after construction; reads the SS pad override that the
   * bootrom bitbangs for chip-select (cts2c: no dynamic peripheral lookup). */
  ioQspi: RPIOQSPI<ChipType> | null = null;
  /** Chip-select is asserted via QMI ASSERT_CS0N or the IO_QSPI SS output
   * override (OUTOVER=LOW), which is how the bootrom bitbangs CS. */
  private csNow(): boolean {
    if ((this.directCsr & 0x04) !== 0) {
      return true;
    }
    return this.ioQspi !== null && ((this.ioQspi.readReg(0x1c) >>> 12) & 0x3) === 0x2;
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
  private addrBytes = new Uint8Array(3);
  private addrBytesCount = 0;
  private addr = 0;
  private progBytes = new Uint8Array(256);
  private progBytesCount = 0;
  private readKind: 'none' | 'status' | 'rdid' = 'none';
  private rdidIdx = 0;
  private readAddr = 0;
  private dummySkip = 0;
  private wel = false;
  private rxFifo = new Uint8Array(32);
  private rxFifoHead = 0;
  private rxFifoCount = 0;

  readUint32(offset: number) {
    if (offset === QMI_DIRECT_CSR) {
      // BUSY is never set (we complete transfers synchronously); TX FIFO is
      // always empty (we consume pushes immediately). RX status is live.
      const rxEmpty = this.rxFifoCount === 0;
      return (
        ((this.directCsr & QMI_CSR_RW_MASK) |
          (this.directCsrEn ? DIRECT_CSR_EN : 0) |
          DIRECT_CSR_TXEMPTY |
          (rxEmpty ? DIRECT_CSR_RXEMPTY : 0) |
          ((this.rxFifoCount & 0x7) << 18)) >>>
        0
      );
    }
    if (offset === QMI_DIRECT_RX) {
      // RX FIFO pop; empty reads return 0 (undefined on real h/w).
      if (this.rxFifoCount > 0) {
        const byte = this.rxFifo[this.rxFifoHead];
        this.rxFifoHead = (this.rxFifoHead + 1) & 31;
        this.rxFifoCount--;
        return byte;
      }
      return 0;
    }
    return super.readUint32(offset);
  }

  writeUint32(offset: number, value: number) {
    if (offset === QMI_DIRECT_CSR) {
      this.directCsr = value & QMI_CSR_RW_MASK;
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

  // Fetch-decode caches key off flash contents but XIP writes bypass
  // writeUint*, so erase/program must invalidate explicitly or executing
  // newly programmed code runs stale decodes. RP2040's impl is a no-op.
  private invalidateFlash(base: number, len: number) {
    this.rpchip.invalidateFlashDecode(base, len);
  }

  private endTransaction() {
    this.csActive = false;
    if (this.cmd === 0x20 && this.addrBytesCount === 3) {
      // SECTOR_ERASE (4KiB, address-aligned)
      const base = this.addr & ~0xfff;
      for (let i = base; i < base + 0x1000; i++) {
        this.rpchip.flash[i] = 0xff;
      }
      this.invalidateFlash(base, 0x1000);
    } else if (this.cmd === 0x02 && this.addrBytesCount === 3) {
      // PAGE_PROGRAM: NOR flash clears bits only; wraps within the page.
      // (Full 256B pages already applied + invalidated incrementally in
      // spiByte; this covers the partial-page tail at CS deassert.)
      const pageBase = this.addr & ~0xff;
      for (let i = 0; i < this.progBytesCount; i++) {
        const at = pageBase + ((this.addr + i) & 0xff);
        this.rpchip.flash[at] &= this.progBytes[i];
      }
      this.invalidateFlash(pageBase, 0x100);
    }
    this.cmd = null;
    this.readKind = 'none';
  }

  private pushRx(byte: number) {
    if (this.rxFifoCount < 32) {
      this.rxFifo[(this.rxFifoHead + this.rxFifoCount) & 31] = byte & 0xff;
      this.rxFifoCount++;
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
      this.addrBytesCount = 0;
      this.progBytesCount = 0;
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
        case 0x9f: // RDID (W25Q128 JEDEC ID: EF 40 18, repeating)
          this.readKind = 'rdid';
          this.rdidIdx = 0;
          break;
        case 0x20: // SECTOR_ERASE
        case 0x02: // PAGE_PROGRAM
        case 0x03: // READ
        case 0x0b: // FAST_READ (one dummy byte after address)
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
    if (this.readKind === 'rdid') {
      // W25Q128 JEDEC ID, repeating. Index advances on every clock (pushed
      // or not) so NOPUSH clocks stay in step, mirroring the READ path.
      const slot = this.rdidIdx % 3;
      this.rdidIdx++;
      if (!nopush) {
        this.pushRx(slot === 0 ? 0xef : slot === 1 ? 0x40 : 0x18);
      }
      return;
    }
    if (this.cmd === 0x03 || this.cmd === 0x0b) {
      if (this.addrBytesCount < 3) {
        this.addrBytes[this.addrBytesCount++] = byte;
        if (this.addrBytesCount === 3) {
          this.readAddr = (this.addrBytes[0] << 16) | (this.addrBytes[1] << 8) | this.addrBytes[2];
        }
      } else if (this.dummySkip > 0) {
        this.dummySkip--;
      } else if (!nopush) {
        this.pushRx(this.rpchip.flash[this.readAddr]);
        this.readAddr = (this.readAddr + 1) & 0xffffff;
      } else {
        this.readAddr = (this.readAddr + 1) & 0xffffff;
      }
      return;
    }
    if (this.cmd === 0x20 || this.cmd === 0x02) {
      if (this.addrBytesCount < 3) {
        this.addrBytes[this.addrBytesCount++] = byte;
        if (this.addrBytesCount === 3) {
          this.addr = (this.addrBytes[0] << 16) | (this.addrBytes[1] << 8) | this.addrBytes[2];
          if (this.cmd === 0x20) {
            // SECTOR_ERASE (4KiB, address-aligned)
            const base = this.addr & ~0xfff;
            for (let i = base; i < base + 0x1000; i++) {
              this.rpchip.flash[i] = 0xff;
            }
            this.invalidateFlash(base, 0x1000);
            this.cmd = null;
          }
        }
      } else if (this.cmd === 0x02) {
        // PAGE_PROGRAM: NOR flash clears bits only; wraps within the page.
        // Applied incrementally so partial pages still stick. The bootrom
        // issues page-sized PROGRAM commands (256B), after which the parser
        // returns to opcode mode for the next command.
        const pageBase = this.addr & ~0xff;
        const at = pageBase + ((this.addr + this.progBytesCount) & 0xff);
        this.rpchip.flash[at] &= byte;
        this.progBytes[this.progBytesCount++] = byte;
        if (this.progBytesCount >= 256) {
          this.invalidateFlash(pageBase, 0x100);
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
