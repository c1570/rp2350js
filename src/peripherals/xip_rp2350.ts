import { BasePeripheral, Peripheral } from './peripheral';

export class RPXIP extends BasePeripheral implements Peripheral {
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

export class RPXIPQMI extends BasePeripheral implements Peripheral {
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
