import { IRPChip } from '../rpchip';
import { BasePeripheral, Peripheral } from './peripheral';

// IO_QSPI pin block (QSPI flash pads + USB PHY debug pads).
//
// Only the pin STATUS/CTRL registers (0x00-0x3C) are modelled, as stored
// values with hardware reset defaults (STATUS=0, CTRL=0x1F/FUNCSEL=XIP).
// This is load-bearing for the bootrom's flash routines: they gate
// erase/program on the SD1 input-override field and bitbang chip-select
// through these registers, so the previous all-ones reads made every
// flash_range_erase/program a silent no-op.
const PIN_REGS_BYTES = 0x40;

export class RPIOQSPI<ChipType extends IRPChip = IRPChip>
  extends BasePeripheral<ChipType>
  implements Peripheral
{
  private regs = new Uint32Array(PIN_REGS_BYTES >>> 2);

  constructor(rpchip: ChipType, name: string) {
    super(rpchip, name);
    for (let i = 0; i < this.regs.length; i += 2) {
      this.regs[i] = 0x0; // STATUS
      this.regs[i + 1] = 0x1f; // CTRL (FUNCSEL=XIP, no overrides)
    }
  }

  /** Raw stored register value (no side effects), for QMI chip-select tracking. */
  readReg(offset: number) {
    return offset < PIN_REGS_BYTES ? this.regs[offset >>> 2] : 0;
  }

  readUint32(offset: number) {
    if (offset < PIN_REGS_BYTES) {
      return this.regs[offset >>> 2];
    }
    return super.readUint32(offset);
  }

  writeUint32(offset: number, value: number) {
    if (offset < PIN_REGS_BYTES) {
      this.regs[offset >>> 2] = value >>> 0;
      return;
    }
    super.writeUint32(offset, value);
  }
}
