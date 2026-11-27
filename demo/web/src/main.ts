/**
 * Web demo entry point: boots the RP2350 with the no_flash webfirmware image,
 * wires the runner/UI together and drives the invisible initial run.
 */
import { RP2350 } from '../../../src/rp2350';
import { ConsoleLogger, LogLevel } from '../../../src/utils/logging';
import { Analyzer } from './analyzer';
import { findSymbolAddr } from './disasm-cpu';
import { loadSramFirmware } from './firmware';
import { Runner } from './runner';
import { UI } from './ui';

const CHUNK_MS = 12; // wall time per work chunk spent emulating

/**
 * Call `chunk` repeatedly until it returns false, yielding to the browser
 * between calls. A MessageChannel task loop rather than requestAnimationFrame:
 * rAF caps the duty cycle at budget / frame interval (~72% at 60 Hz, far less
 * when the browser throttles rAF) and stops entirely in background tabs, whereas
 * posted messages keep the main thread busy with CHUNK_MS-sized chunks and still
 * let the browser paint and process input in between.
 */
function workLoop(chunk: () => boolean): void {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    try {
      if (chunk()) channel.port2.postMessage(null);
    } catch (err) {
      fail(err);
    }
  };
  channel.port2.postMessage(null);
}

function fail(err: unknown): void {
  document.getElementById('app')!.textContent = `boot failed: ${err}`;
  console.error(err);
}

async function fetchText(path: string): Promise<string> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`failed to fetch ${path}: ${res.status}`);
  return res.text();
}

async function boot(): Promise<void> {
  const [hexText, disText] = await Promise.all([
    fetchText('webfirmware.hex'),
    fetchText('webfirmware.dis'),
  ]);

  const chip = new RP2350(); // RISC-V (default coreArch)
  chip.logger = new ConsoleLogger(LogLevel.Error, true);
  const loadBase = loadSramFirmware(chip, hexText);
  console.log(`firmware: SRAM image, loadBase=0x${loadBase.toString(16)}`);

  const analyzer = new Analyzer();
  analyzer.attach(chip);
  const runner = new Runner(chip, analyzer);
  chip.uart[0].onByte = (value) => runner.appendSerialByte(value);
  runner.setButton(false); // released (internal pull-up)

  const ui = new UI(chip, runner, analyzer);
  ui.setDisassembly(disText);

  // Position the timeline where the demo starts: step whole instructions until
  // core0 enters <main> (its address comes from the .dis annotations).
  // Equality, not a range check: crt0 calls <runtime_init>, which sits ABOVE
  // <main> in the image, so a numeric comparison would overshoot into it. The
  // jal into <main> lands exactly on its first instruction.
  const anchorAddr = findSymbolAddr(disText, 'main');
  if (anchorAddr === null) throw new Error('<main> not found in webfirmware.dis');
  runner.takeSnapshot(); // pristine post-boot state: the timeline starts at cycle 0
  let guard = 0;
  while (chip.core[0].PC !== anchorAddr) {
    if (++guard > 2_000_000) throw new Error('core0 never reached <main>');
    runner.stepOnce();
  }
  const anchorCycle = runner.cycle;
  runner.takeSnapshot(); // exact restore point for the post-run rewind

  // Invisible initial run: play the whole timeline to the finish, taking
  // boundary snapshots, then rewind to the anchor and hand over to the user.
  // From here on the chip only moves through user actions (UI → Runner.seek).
  ui.beginPrepare();
  runner.play();
  workLoop(() => {
    ui.prepareProgress(runner.cycle);
    runner.runFor(performance.now() + CHUNK_MS);
    if (runner.running) return true;
    runner.seek(anchorCycle);
    ui.endPrepare();
    return false;
  });
}

boot().catch(fail);
