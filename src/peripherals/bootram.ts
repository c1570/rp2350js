import { IRPChip } from '../rpchip';
import { BasePeripheral, Peripheral } from './peripheral';
import { SaveStateStream } from '../utils/save-state';

const BOOTLOCK_ST = 0x808;
const BOOTLOCK0 = 0x80c;
const BOOTLOCK7 = 0x828;

const WRITE_ONCE0 = 0x800;
const WRITE_ONCE1 = 0x804;

// Everything below the register block falls through to the RAM array. The SDK's
// bootram variables live above 0x400: a JS array grows to hold them, but the C build's
// fixed array does not, and those accesses overran it.
const BOOTRAM_BYTES = 0x800;
const BOOTRAM_WORDS = BOOTRAM_BYTES >>> 2;

export class RPBootRAM<ChipType extends IRPChip = IRPChip>
  extends BasePeripheral<ChipType>
  implements Peripheral
{
  private bootram: number[] = Array(BOOTRAM_WORDS).fill(0);
  write_once = [0, 0];
  spinLock = 0;

  byteAddressable() {
    return true;
  }

  readUint32(offset: number) {
    if (offset >= BOOTLOCK0 && offset <= BOOTLOCK7) {
      const bitIndexMask = 1 << ((offset - BOOTLOCK0) / 4);
      if (this.spinLock & bitIndexMask) {
        return 0;
      } else {
        this.spinLock |= bitIndexMask;
        return bitIndexMask;
      }
    }
    if (offset == BOOTLOCK_ST) return this.spinLock;
    if (offset >= WRITE_ONCE0 && offset <= WRITE_ONCE1) {
      return this.write_once[(offset - WRITE_ONCE0) >>> 2];
    }
    const index = offset >>> 2;
    return index < BOOTRAM_WORDS ? this.bootram[index] : 0;
  }

  writeUint32(offset: number, value: number) {
    if (offset >= BOOTLOCK0 && offset <= BOOTLOCK7) {
      const bitIndexMask = ~(1 << ((offset - BOOTLOCK0) / 4));
      this.spinLock &= bitIndexMask;
      return;
    }
    if (offset >= WRITE_ONCE0 && offset <= WRITE_ONCE1) {
      this.write_once[(offset - WRITE_ONCE0) >>> 2] |= value;
      return;
    }
    if (offset < BOOTRAM_BYTES) {
      this.bootram[offset >>> 2] = value;
    }
  }

  transferState(s: SaveStateStream) {
    s.i32array(this.bootram, BOOTRAM_WORDS);
    s.i32array(this.write_once, 2);
    this.spinLock = s.i32(this.spinLock);
  }
}
