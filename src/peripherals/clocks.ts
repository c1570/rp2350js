import { IRPChip } from '../rpchip';
import { BasePeripheral, Peripheral } from './peripheral';

const CLK_REF_CTRL = 0x30;
const CLK_REF_SELECTED = 0x38;
const CLK_SYS_CTRL = 0x3c;
const CLK_SYS_SELECTED = 0x44;

export class RPClocks extends BasePeripheral implements Peripheral {
  refCtrl = 0;
  sysCtrl = 0;
  clk_fc0_status = 0;

  constructor(rp2040: IRPChip, name: string) {
    super(rp2040, name);
    switch (rp2040.identifier) {
      case 'rp2040':
        this.clk_fc0_status = 0x98;
        break;
      case 'rp2350':
        this.clk_fc0_status = 0xa4;
        break;
      default:
        throw new Error('Unknown chip id');
    }
  }

  readUint32(offset: number) {
    switch (offset) {
      case CLK_REF_CTRL:
        return this.refCtrl;
      case CLK_REF_SELECTED:
        return 1 << (this.refCtrl & 0x03);
      case CLK_SYS_CTRL:
        return this.sysCtrl;
      case CLK_SYS_SELECTED:
        return 1 << (this.sysCtrl & 0x01);
      case this.clk_fc0_status:
        return 0b10001; // done, passed
    }
    return super.readUint32(offset);
  }

  writeUint32(offset: number, value: number): void {
    switch (offset) {
      case CLK_REF_CTRL:
        this.refCtrl = value;
        break;
      case CLK_SYS_CTRL:
        this.sysCtrl = value;
        break;
      default:
        super.writeUint32(offset, value);
        break;
    }
  }
}
