/**
 * Headless test of the web demo's runner machinery (no DOM): play to finish,
 * rewind via snapshots, cycle-exact seeks, residual handling, determinism
 * (identical serialized state whether a position was reached by playing or by
 * rewinding), and GPIO-button future invalidation.
 *
 * Run: npx ts-node --transpile-only demo/web/test/runner-test.ts
 */
import { RP2350 } from '../../../src/rp2350';
import { GPIOPinState } from '../../../src/gpio-pin';
import { ConsoleLogger, LogLevel } from '../../../src/utils/logging';
import { Analyzer } from '../src/analyzer';
import { loadSramFirmware } from '../src/firmware';
import {
  COVERAGE_SLACK,
  PIO_PIN_BASE,
  CPU_PIN_BASE,
  VIEW_WINDOW,
  describeSample,
} from '../src/analyzer';
import { Runner } from '../src/runner';
import { SnapshotStore } from '../src/snapshots';
import * as fs from 'fs';

let failures = 0;
function check(cond: boolean, what: string): void {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${what}`);
  if (!cond) failures++;
}

const hexText = fs.readFileSync(__dirname + '/../public/webfirmware.hex', 'utf-8');

function boot(): { chip: RP2350; runner: Runner; analyzer: Analyzer } {
  const chip = new RP2350();
  chip.logger = new ConsoleLogger(LogLevel.Error, true);
  loadSramFirmware(chip, hexText);
  chip.gpio[24].setInputValue(true);
  const analyzer = new Analyzer();
  analyzer.attach(chip);
  const runner = new Runner(chip, analyzer);
  chip.uart[0].onByte = (v) => runner.appendSerialByte(v);
  runner.setButton(false); // released (pull-up)
  runner.takeSnapshot();
  return { chip, runner, analyzer };
}

function playToFinish(runner: Runner): void {
  runner.play();
  let guard = 0;
  while (runner.running && runner.cycle < 200_000_000 && guard++ < 200_000) {
    runner.runFor(performance.now() + 12); // real-time frame budget, like the browser
    if (runner.finished) break;
  }
}

/** The 16 analyzer pins' live state as the analyzer's bit layout. */
function pinMask(chip: RP2350): number {
  let mask = 0;
  for (let i = 0; i < 8; i++) {
    if (chip.gpio[PIO_PIN_BASE + i].value === GPIOPinState.High) mask |= 1 << i;
    if (chip.gpio[CPU_PIN_BASE + i].value === GPIOPinState.High) mask |= 1 << (8 + i);
  }
  return mask;
}

function serializeChip(chip: RP2350): Uint8Array {
  const buf = new Uint8Array(chip.serializeSize());
  if (!chip.serialize(buf, buf.length)) throw new Error('serialize failed');
  return buf;
}

// --- 1. play to finish --------------------------------------------------------
{
  const { chip, runner, analyzer } = boot();
  playToFinish(runner);
  check(runner.finished, 'reached END sentinel');
  const finishCycle = runner.finishedCycle!;
  check(
    finishCycle > 5_000_000 && finishCycle < 100_000_000,
    `finish cycle is sane (${finishCycle})`
  );
  check(
    runner.cycle === runner.finishedCycle,
    `initial run stops exactly at the finish cycle (cycle=${runner.cycle})`
  );
  check(
    runner.snapshots.list.length >= 5,
    `snapshots taken while playing (${runner.snapshots.list.length})`
  );
  check(runner.serialText.endsWith('### END OF OUTPUT ###\r\n'), 'serial log ends with sentinel');
  check(!runner.serialText.includes('button=PRESSED'), 'unpressed run has no PRESSED status line');
  check(
    analyzer.firstCycle === 0 && analyzer.lastCycle === runner.cycle - 1,
    `analyzer covers cycle 0..${runner.cycle - 1} (first=${analyzer.firstCycle}, last=${
      analyzer.lastCycle
    })`
  );
  const serialAtFinish = runner.serialText;
  const stateAtFinish = serializeChip(chip);

  // --- 2. rewind on the same runner -------------------------------------------
  const T = 10_000_000;
  runner.seek(T);
  check(runner.cycle === T, `seek lands exactly on cycle ${T} (got ${runner.cycle})`);
  check(
    chip.core[0].cycles === runner.cycle + runner.residual,
    `core/PIO consistency at pause (core=${chip.core[0].cycles}, pio=${runner.cycle}, residual=${runner.residual})`
  );
  check(runner.serialText.length < serialAtFinish.length, 'serial truncated on rewind');
  check(
    runner.finished && runner.finishedCycle === finishCycle,
    'finish marker kept across a rewind (deterministic timeline end)'
  );
  // Far rewind (target neighborhood aged out of the 32k ring): the recording
  // re-bases at the replayed region so the view around the marker stays filled.
  // the re-based recording speculates VIEW_WINDOW+SLACK past the target so the
  // view always shows past AND future around the marker
  check(
    analyzer.lastCycle === runner.cycle + VIEW_WINDOW + COVERAGE_SLACK - 1,
    `analyzer re-based with future coverage (last=${analyzer.lastCycle})`
  );
  check(analyzer.sampleAt(runner.cycle - 1) !== undefined, 'cycles before the marker are covered');
  check(
    analyzer.sampleAt(runner.cycle + 400) !== undefined,
    'cycles after the marker are covered (speculated future)'
  );

  // far rewind to an arbitrary (non-snapshot-boundary) cycle also leaves the
  // view fully covered — no disappearing traces
  const t2 = Math.floor(finishCycle / 2);
  runner.seek(t2);
  check(
    runner.cycle === t2 &&
      analyzer.sampleAt(t2 - 1) !== undefined &&
      analyzer.sampleAt(t2 - 500) !== undefined,
    `far rewind to arbitrary cycle ${t2} keeps the view covered`
  );

  runner.seek(runner.finishedCycle ?? finishCycle);
  check(runner.cycle === finishCycle, 'seek forward again to finish');
  check(runner.serialText === serialAtFinish, 'serial identical after rewind+replay (determinism)');
  check(
    Buffer.compare(Buffer.from(serializeChip(chip)), Buffer.from(stateAtFinish)) === 0,
    'chip state identical after rewind+replay to finish (determinism)'
  );

  // The analyzer mask follows the GPIO listeners, which a save-state restore
  // does not notify: after a rewind it must be re-derived from the pins, or
  // every sample recorded from here on carries the pre-restore pin state
  // (the PIO/core1 counters at the finish, e.g. 0x929b) into the boot phase.
  runner.seek(5000); // boot phase: PIO not yet running, core1 not launched — all low
  check(pinMask(chip) === 0, 'all 16 analyzer pins are low during boot');
  check(
    analyzer.mask === pinMask(chip) &&
      analyzer.sampleAt(5000) === 0 &&
      analyzer.sampleAt(4999) === 0,
    `analyzer mask re-synced after the restore (mask=0x${analyzer.mask.toString(16)})`
  );
  runner.seek(T);

  // NEAR rewind (target inside the retained ring): history is preserved —
  // including the recorded future beyond the new position (no truncation).
  runner.seek(finishCycle - 2000);
  check(runner.cycle === finishCycle - 2000, 'near rewind lands exactly');
  check(
    analyzer.lastCycle === finishCycle - 1,
    `near rewind retains history+future (last=${analyzer.lastCycle})`
  );
  check(analyzer.sampleAt(finishCycle - 1) !== undefined, 'old frontier sample still readable');
}

// --- 3. two independent boots: seek-to-end must equal play-to-end ---------------
{
  const a = boot();
  playToFinish(a.runner);
  const bufA = serializeChip(a.chip);

  const b = boot();
  playToFinish(b.runner);
  const bFinish = b.runner.finishedCycle!;
  b.runner.seek(5_000_000); // deep rewind (crosses many snapshots)
  b.runner.seek(bFinish); // ...and back to the end
  const bufB = serializeChip(b.chip);
  check(
    Buffer.compare(Buffer.from(bufA), Buffer.from(bufB)) === 0,
    'chip state identical: played-to-end vs rewound-around-to-end'
  );
  check(a.runner.serialText === b.runner.serialText, 'serial identical across rewind detour');
}

// --- 4. button invalidation ------------------------------------------------------
{
  const { chip: c2, analyzer: a2, runner: r2 } = boot();
  playToFinish(r2);
  const finish0 = r2.finishedCycle!;
  check(r2.snapshots.list.length >= 2, 'snapshots exist before invalidation');
  r2.seek(2_000_000);
  r2.setButton(true); // press (host-side)
  r2.invalidateFuture();
  check(
    r2.snapshots.list.every((s) => s.cycle <= 2_000_000),
    'future snapshots dropped'
  );
  check(
    a2.lastCycle === 2_000_000 + VIEW_WINDOW + COVERAGE_SLACK - 1,
    `analyzer future dropped and re-recorded near the press (${a2.lastCycle})`
  );
  check(!r2.finished, 'finished cleared (old end was in the invalidated future)');

  // stepping forward with the button held: core1 must decrement
  r2.stepCycles(3_000_000); // crosses several status lines, button held
  check(r2.cycle === 5_000_000, `stepped exactly 3M cycles (${r2.cycle})`);
  check(
    r2.buttonDown && !c2.gpio[24].inputValue,
    'button reads pressed after speculative run + rollback'
  );
  r2.setButton(false); // release again
  playToFinish(r2);
  check(r2.finished, 'new run finishes after invalidation');
  check(r2.serialText.includes('button=PRESSED'), 'new run serial shows PRESSED status line');
  check(
    r2.finishedCycle !== finish0,
    `finish moved (button time shifted it: ${finish0} -> ${r2.finishedCycle})`
  );
}
// --- 5. cycle-exact stepping + residual -------------------------------------------
{
  const { runner: r3 } = boot();
  playToFinish(r3); // build up a frontier first: seek() stays within recorded time
  const finish3 = r3.finishedCycle!;
  for (const t of [1234, 999_999, 1_000_001, Math.floor(finish3 / 2), finish3 - 2]) {
    r3.seek(t);
    check(
      r3.cycle === t && r3.chipCyclesConsistent(),
      `seek(${t}) exact + consistent (cycle=${r3.cycle}, residual=${r3.residual})`
    );
    const before = r3.cycle;
    r3.stepCycles(7);
    // stepping clamps at the finish cycle once the output is complete
    check(
      r3.cycle === Math.min(before + 7, finish3),
      `step +7 from ${before} exact (cycle=${r3.cycle})`
    );
    check(r3.chipCyclesConsistent(), 'residual bookkeeping consistent after step');
  }
}

// --- 6. snapshot store: sorted insert, dedup, lookups -------------------------
{
  const store = new SnapshotStore(500);
  const snap = (cycle: number) => ({ cycle, residual: 0, serialLen: 0, data: new Uint8Array(0) });
  const cycles = () => store.list.map((s) => s.cycle).join();
  check(store.findBefore(0) === null, 'empty store: findBefore is null');
  for (const c of [0, 1100, 600]) store.add(snap(c)); // unsorted input
  check(cycles() === '0,600,1100', 'snapshots kept sorted by cycle');
  store.add(snap(900)); // 300 above 600 AND 200 below 1100: both are within dedup
  check(cycles() === '0,900', 'dedup replaces every snapshot within range (density stays bounded)');
  store.add(snap(1200)); // 300 above 900: replaces it, nothing else in range
  check(cycles() === '0,1200', 'dedup replaces the single neighbor in range');
  const before = store.list[1];
  store.add(snap(1200)); // exact hit
  check(cycles() === '0,1200' && store.list[1] !== before, 'exact-cycle add replaces in place');
  check(
    store.findBefore(-1) === null &&
      store.findBefore(0)?.cycle === 0 &&
      store.findBefore(1199)?.cycle === 0 &&
      store.findBefore(1200)?.cycle === 1200,
    'findBefore: greatest snapshot at or before the cycle'
  );
  store.invalidateAfter(1200);
  check(cycles() === '0,1200', 'invalidateAfter keeps the boundary snapshot');
  store.invalidateAfter(0);
  check(cycles() === '0', 'invalidateAfter drops everything after the cycle');
}

// --- 7. analyzer sample description (popover text) --------------------------
{
  const { analyzer: a7, runner: r7 } = boot();
  playToFinish(r7);
  const T = 10_000_000;
  r7.seek(T);
  const lane = 8; // GPIO16: core1's counter bit 0 toggles every count
  const bit = 1 << lane;
  const level = (c: number) => ((a7.sampleAt(c) ?? 0) & bit) !== 0;
  // Independent edge scan around T (the ring covers T-32768 .. T+1999 here).
  let prevEdge = -1;
  for (let c = T; c > T - 4000; c--)
    if (level(c) !== level(c - 1)) {
      prevEdge = c;
      break;
    }
  let nextEdge = -1;
  for (let c = T + 1; c < T + 1999; c++)
    if (level(c) !== level(c - 1)) {
      nextEdge = c;
      break;
    }
  check(
    prevEdge > 0 && nextEdge > 0,
    `found bracketing edges independently (${prevEdge}, ${nextEdge})`
  );
  const text = describeSample(a7, lane, T);
  check(
    text.startsWith(`GPIO16 is ${level(T) ? 'HIGH' : 'LOW'} at cycle ${T}. `) &&
      text.includes(`${level(T) ? 'Positive' : 'Negative'} edge at cycle ${prevEdge}`) &&
      text.includes(`${level(T) ? 'negative' : 'positive'} edge at cycle ${nextEdge}`),
    `description names both bracketing edges with the right direction (${text})`
  );
  // At the ring's left edge the previous edge is unknown: omitted, not invented.
  const first = a7.windowStart();
  const left = describeSample(a7, lane, first);
  check(
    /^GPIO16 is (HIGH|LOW) at cycle \d+\. (Positive|Negative) edge at cycle \d+\.$/.test(left) &&
      !left.includes(`cycle ${first - 1}`),
    `previous edge omitted at the ring start (${left})`
  );
  check(
    describeSample(a7, lane, a7.lastCycle + 1) ===
      `GPIO16 has no recorded sample at cycle ${a7.lastCycle + 1}.`,
    'no sample -> explicit message'
  );
}

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
