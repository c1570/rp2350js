import { RP2350, CoreArch } from '../src';
import { USBCDC } from '../src/usb/cdc';
import { ConsoleLogger, LogLevel } from '../src/utils/logging';
import { bootrom_rp2350_A2 } from '../src/bootroms';
import { loadUF2, loadMicropythonFlashImage } from './load-flash';
import fs from 'fs';
import minimist from 'minimist';

const args = minimist(process.argv.slice(2), {
  string: ['image', 'expect-text'],
  boolean: ['gdb'],
});
const expectText = args['expect-text'];

const coreArch = (process.env['RP2350_CORE_ARCH'] || 'riscv') as CoreArch;
if (coreArch !== 'arm' && coreArch !== 'riscv') {
  throw new Error(`RP2350_CORE_ARCH=${coreArch} must be "arm" or "riscv"`);
}

const mcu = new RP2350(false, undefined, { coreArch });
mcu.loadBootrom(bootrom_rp2350_A2);
mcu.logger = new ConsoleLogger(LogLevel.Info);

mcu.uart[0].onByte = (value: number) => {
  process.stdout.write(new Uint8Array([value]));
};

const imageName =
  args.image ??
  (coreArch === 'arm'
    ? './demo/RPI_PICO2-20260406-v1.28.0.uf2'
    : './demo/RPI_PICO2-RISCV-20260406-v1.28.0.uf2');
console.log(`Loading uf2 image ${imageName}`);
loadUF2(imageName, mcu);

if (fs.existsSync('littlefs.img')) {
  console.log(`Loading littlefs image littlefs.img`);
  loadMicropythonFlashImage('littlefs.img', mcu);
}

const cdc = new USBCDC(mcu.usbCtrl);
cdc.onDeviceConnected = () => {
  cdc.sendSerialByte('\r'.charCodeAt(0));
  cdc.sendSerialByte('\n'.charCodeAt(0));
};

let currentLine = '';
cdc.onSerialData = (value) => {
  process.stdout.write(value);

  for (const byte of value) {
    const char = String.fromCharCode(byte);
    if (char === '\n') {
      if (expectText && currentLine.includes(expectText)) {
        console.log(`Expected text found: "${expectText}"`);
        console.log('TEST PASSED.');
        process.exit(0);
      }
      currentLine = '';
    } else {
      currentLine += char;
    }
  }
};

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.on('data', (chunk) => {
  // 24 is Ctrl+X
  if (chunk[0] === 24) {
    process.exit(0);
  }
  for (const byte of chunk) {
    cdc.sendSerialByte(byte);
  }
});

// Boot through the real bootrom rather than jumping to the firmware reset
// vector directly. reset() already performs the vectored hardware reset for
// either architecture (ARMv8-M: MSP/PC from VTOR=0's bootrom table; RISC-V:
// Hazard3's fixed reset vector 0x7dfc), so both cores start at the bootrom
// entry; it scans/verifies the flash IMAGE_DEF and hands off to firmware.
// RISC-V cores default to `stopped = false` and are already free-running;
// ARM cores default to `stopped = true` and need un-parking. (ARM core1
// parks itself in the bootrom via WFE, waiting for the SIO mailbox handshake,
// rather than being flagged "stopped" — matches real hardware.)
if (coreArch === 'arm') {
  mcu.armCore0.stopped = false;
  mcu.armCore1.stopped = false;
}

// Bounded batches yield to the event loop (cf. Simulator.execute()); a plain
// `while (1) { mcu.step(); }` would starve stdout flushing and stdin input.
function runBatch() {
  for (let i = 0; i < 1_000_000; i++) {
    mcu.step();
  }
  setImmediate(runBatch);
}
runBatch();
