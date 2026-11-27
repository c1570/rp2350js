/* Quick headless boot test of the webfirmware SRAM image via the official loadFirmware path.
 * Runs until the END sentinel byte has left the UART, reporting pin activity and timings. */
import { RP2350 } from '../../../src/rp2350';
import { ConsoleLogger, LogLevel } from '../../../src/utils/logging';

const mcu = new RP2350();
mcu.logger = new ConsoleLogger(LogLevel.Error, true);
const result = mcu.loadFirmware(__dirname + '/build/webfirmware.hex');
console.log('loadFirmware:', JSON.stringify(result));

mcu.gpio[24].setInputValue(true); // button released
let serial = '';
let finishCycle = 0;
mcu.uart[0].onByte = (v) => {
  serial += String.fromCharCode(v);
  if (serial.endsWith('### END OF OUTPUT ###\r\n')) {
    finishCycle = mcu.core0.cycles;
    console.log(
      `--- END sentinel completed at cycle ${finishCycle} (${(finishCycle / 150000).toFixed(
        2
      )} ms @150MHz) ---`
    );
  }
  process.stdout.write(String.fromCharCode(v));
};

let lastPio = -1,
  lastCpu = -1;
const pinBits = () => {
  let pio = 0,
    cpu = 0;
  for (let i = 0; i < 8; i++) {
    pio |= (mcu.gpio[2 + i].value !== 0 ? 1 : 0) << i;
    cpu |= (mcu.gpio[16 + i].value !== 0 ? 1 : 0) << i;
  }
  return { pio, cpu };
};

let pressDone = false;
let releaseDone = false;
const pressAt = 4_000_000;
const releaseAt = 8_000_000;

let i = 0;
while (!finishCycle && i < 400_000_000) {
  mcu.step();
  i++;
  if (!pressDone && mcu.core0.cycles >= pressAt) {
    pressDone = true;
    console.log('--- pressing button ---');
    mcu.gpio[24].setInputValue(false);
  }
  if (!releaseDone && mcu.core0.cycles >= releaseAt) {
    releaseDone = true;
    console.log('--- releasing button ---');
    mcu.gpio[24].setInputValue(true);
  }
  if (i % 500000 === 0) {
    const { pio, cpu } = pinBits();
    if (pio !== lastPio || cpu !== lastCpu) {
      console.log(
        `cycle ${mcu.core0.cycles}: pio=0x${pio.toString(16).padStart(2, '0')} cpu=0x${cpu
          .toString(16)
          .padStart(2, '0')} btn=${mcu.gpio[24].value !== 0 ? 'up' : 'dn'}`
      );
      lastPio = pio;
      lastCpu = cpu;
    }
  }
}
const m0 = mcu.pio[0].machines[0];
console.log(
  `\nfinal: finish=${finishCycle} pio_pc=${m0.pc} enabled=${
    m0.enabled
  } core0_pc=0x${mcu.core0.PC.toString(16)} core1_pc=0x${mcu.core1.PC.toString(16)}`
);
if (!finishCycle) process.exit(1);
