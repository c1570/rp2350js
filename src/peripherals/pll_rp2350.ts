import { IRPChip } from '../rpchip';
import { Float64 } from '../utils/types';
import { BasePeripheral, Peripheral } from './peripheral';
import { SaveStateStream } from '../utils/save-state';

// PLL_CS bits
const PLL_CS_BYPASS = 1 << 8;
const PLL_CS_REFDIV_MASK = 0x1f; // 5 bits on the RP2350 (6 on the RP2040, see pll.ts)

export class RP2350PLL<ChipType extends IRPChip = IRPChip>
  extends BasePeripheral<ChipType>
  implements Peripheral
{
  reg = [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, (1 << 12) + (1 << 16), 0];
  // Recomputed from reg[] by every write below: derived, so not saved.
  foutpostdiv = 1;

  private get fbdiv() {
    return this.reg[0x8];
  }

  private get postdiv1() {
    return (this.reg[0xc] >> 16) & 7;
  }

  private get postdiv2() {
    return (this.reg[0xc] >> 12) & 7;
  }

  /**
   * PLL output frequency, in Hz, derived from the current register values:
   * f_out = (f_ref / REFDIV * FBDIV) / (POSTDIV1 * POSTDIV2), bypassed to the raw
   * reference frequency while PLL_CS.BYPASS is set. This is what makes `RP2350.clkSys`
   * follow `set_sys_clock_khz()` and friends.
   */
  get frequency(): Float64 {
    const refFreq = this.rpchip.xoscFreq / (this.reg[0x0] & PLL_CS_REFDIV_MASK || 1);
    if (this.reg[0x0] & PLL_CS_BYPASS) {
      return refFreq;
    }
    return (refFreq * this.fbdiv) / ((this.postdiv1 || 1) * (this.postdiv2 || 1));
  }

  readUint32(offset: number) {
    if (offset === 0x0) return this.reg[0] | (1 << 31); // PLL is always locked
    if (offset <= 0xc) return this.reg[offset];
    return super.readUint32(offset);
  }

  writeUint32(offset: number, value: number) {
    let handled = false;
    switch (offset) {
      case 0x00:
      case 0x08:
      case 0x0c:
        this.reg[offset] = value;
        handled = true;
        break;
    }
    this.foutpostdiv = this.frequency;
    if (handled) {
      this.rpchip.updateClocks();
      this.rpchip.logger.info(
        this.name,
        `PLL write ${value} to 0x${offset.toString(16)}, foutpostdiv = ${this.foutpostdiv}`
      );
      return;
    }
    return super.writeUint32(offset, value);
  }

  transferState(s: SaveStateStream) {
    s.i32array(this.reg, 14);
  }
}
