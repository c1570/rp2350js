const filename = 'demo/riscv_blink/blink_simple';
const log_gpios = true;

import * as fs from 'fs';
import { RP2350 } from '../src';
import { GPIOPinState } from '../src/gpio-pin';
import { GDBTCPServer } from '../src/gdb/gdb-tcp-server';
import { RISCVGDBServer } from '../src/gdb/riscv-gdb-server';

const mcu = new RP2350();
mcu.loadFirmware(`${filename}.hex`);

const disassembly =
  fs.readFileSync('./demo/bootrom_rp2350.dis', 'utf-8') + fs.readFileSync(`${filename}.dis`);
mcu.loadDisassembly(disassembly);

//const gdbServer = new GDBTCPServer(new RISCVGDBServer(mcu), 3333);
//console.log(`GDB Server ready! Listening on port ${gdbServer.port}`);

mcu.uart[0].onByte = (value: number) => {
  process.stdout.write(new Uint8Array([value]));
};

// make GPIOs see their own output values as input
for (let i = 0; i < 11; i++) {
  if (log_gpios) {
    mcu.gpio[i].addListener((state: GPIOPinState, oldState: GPIOPinState) => {
      mcu.gpio[i].setInputValue(state == 1);
      console.log(`GPIO ${i}: ${state == 1}`);
    });
  } else {
    mcu.gpio[i].addListener((state: GPIOPinState, oldState: GPIOPinState) =>
      mcu.gpio[i].setInputValue(state == 1)
    );
  }
}

let dodisass = 0;
let nextTimeUpdate = 0;
try {
  while (1) {
    if (dodisass) mcu.core0.printDisassembly();
    mcu.step();
    if (mcu.cycles > nextTimeUpdate) {
      console.log(`Time: ${((mcu.cycles / 40000000) >>> 0) / 10} secs`);
      nextTimeUpdate += 40000000;
    }
  }
} catch (e) {
  console.error(`Cycles: ${mcu.cycles}, ${e}`);
  throw e;
}
