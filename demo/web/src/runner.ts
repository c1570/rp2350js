/**
 * Emulation runner: owns the chip, the timeline, snapshots, serial log and the
 * rewind/seek machinery.
 *
 * Stepping model (ntc-run order): each step unit runs ONE core0 CPU instruction
 * (core1 catch-up happens inside stepCores()), then ticks the PIO one cycle at a
 * time, recording a logic-analyzer sample per cycle. A seek stops the PIO at
 * exactly the selected cycle: the final CPU instruction is split, and the leftover
 * PIO ticks are kept as `residual` (consumed first on the next step), so
 * rewind is cycle-accurate while the CPU only ever advances by whole instructions.
 *
 * Time axis: 0 .. the cycle when the firmware's serial output finishes (END
 * sentinel fully shifted out of UART0). Once the timeline is prepared, the chip
 * only ever moves through seek(): rewinds and long forward jumps restore the
 * nearest recorded snapshot and replay the remaining cycles; short forward hops
 * run the chip directly (it is deterministic either way).
 *
 * Snapshot cadence: every SNAPSHOT_EVERY_CYCLES cycles (~870 KB each, ~200 for
 * the full run). Snapshots are only garbage collected when the GPIO24 button
 * invalidates the recorded future — so a rewind replays at most one snapshot
 * interval, never from cycle 0.
 */
import { RP2350 } from '../../../src/rp2350';
import { Analyzer, COVERAGE_SLACK, VIEW_WINDOW } from './analyzer';
import { SnapshotStore, STATE_OMIT, Snapshot } from './snapshots';

export const END_SENTINEL = '### END OF OUTPUT ###\r\n'; // stdio_uart converts \n to \r\n
export const SNAPSHOT_EVERY_CYCLES = 100_000;

/** Cycles of analyzer history the view needs left of any position. */
const VIEW_MARGIN = VIEW_WINDOW / 2 + 100;

/** Next snapshot boundary strictly after `cycle`. */
function nextBoundary(cycle: number): number {
  return (Math.floor(cycle / SNAPSHOT_EVERY_CYCLES) + 1) * SNAPSHOT_EVERY_CYCLES;
}

export class Runner {
  /** Timeline position = completed PIO cycles. */
  cycle = 0;
  /** PIO ticks owed by the interrupted CPU instruction (consumed first on the next step). */
  residual = 0;
  /** True only during the initial run (main.ts), the one phase where the chip plays freely. */
  running = false;
  /** The END sentinel has been observed; the timeline ends at `finishedCycle`. */
  finished = false;
  finishedCycle: number | null = null;
  serialText = '';
  /** Host-side GPIO24 toggle state — the source of truth, reapplied after snapshot restores. */
  buttonDown = false;
  readonly snapshots = new SnapshotStore();
  private nextSnapshotCycle = 0;
  /** Set while speculating ahead for analyzer coverage: no snapshots, run state rolled back. */
  private speculating = false;

  constructor(readonly chip: RP2350, readonly analyzer: Analyzer) {}

  // --- serial -------------------------------------------------------------

  appendSerialByte(value: number): void {
    this.serialText += String.fromCharCode(value);
    if (this.finished || !this.serialText.endsWith(END_SENTINEL)) return;
    // The byte completed during the tick at position `cycle`; the timeline
    // position at which the full output exists is therefore cycle + 1.
    this.finished = true;
    this.finishedCycle = this.cycle + 1;
    this.running = false;
  }

  // --- snapshots ----------------------------------------------------------

  takeSnapshot(): void {
    const size = this.chip.serializeSize(STATE_OMIT); // varies with SRAM content (run-length encoded)
    const data = new Uint8Array(size);
    if (!this.chip.serialize(data, size, STATE_OMIT)) {
      throw new Error('chip.serialize() failed');
    }
    this.snapshots.add({
      cycle: this.cycle,
      residual: this.residual,
      serialText: this.serialText,
      data,
    });
  }

  /** Restore chip + timeline position from a snapshot (the host button state is kept). */
  private restore(snap: Snapshot): void {
    if (!this.chip.unserialize(snap.data, snap.data.length)) {
      throw new Error(`chip.unserialize() failed for the snapshot at cycle ${snap.cycle}`);
    }
    this.analyzer.resync(); // restores do not notify the pin listeners
    this.applyButton();
    this.cycle = snap.cycle;
    this.residual = snap.residual;
    this.serialText = snap.serialText; // whole prefix: valid in both time directions
    this.nextSnapshotCycle = nextBoundary(this.cycle);
  }

  // --- GPIO24 button --------------------------------------------------------

  /** Toggle the host-side GPIO24 button (pressed = low, pull-up). */
  setButton(pressed: boolean): void {
    this.buttonDown = pressed;
    this.applyButton();
  }

  /** Snapshots carry the pin as it was when they were taken; the physical button
   * keeps its current state across restores. */
  private applyButton(): void {
    this.chip.gpio[24].setInputValue(!this.buttonDown);
  }

  /** The button changed: drop the recorded future (snapshots, analyzer samples, finish marker). */
  invalidateFuture(): void {
    this.snapshots.invalidateAfter(this.cycle);
    this.analyzer.truncateAfter(this.cycle);
    if (this.finishedCycle !== null && this.finishedCycle > this.cycle) {
      this.finished = false;
      this.finishedCycle = null;
    }
    // The future changed (the button state feeds the cores): re-record it so the
    // dimmed region right of the marker reflects the new inputs.
    this.ensureFutureCoverage();
  }

  // --- transport ----------------------------------------------------------

  /** Start the initial run to the finish (called once, by main.ts). */
  play(): void {
    this.running = true;
    this.nextSnapshotCycle = nextBoundary(this.cycle);
  }

  /** Run step units until the wall-clock deadline or the finish. */
  runFor(deadline: number): void {
    for (let units = 0; this.running; units++) {
      if ((units & 0x3ff) === 0 && performance.now() >= deadline) break;
      this.stepInstruction(Infinity);
    }
  }

  /**
   * Advance exactly `n` cycles (the finish cycle is a hard stop once the output
   * is complete). Extends the timeline past the recorded region — the chip
   * simply runs on deterministically.
   */
  stepCycles(n: number): void {
    const end = this.finished ? Math.min(this.cycle + n, this.finishedCycle!) : this.cycle + n;
    this.runUntil(end);
  }

  /** Advance by one whole CPU instruction (positioning before the initial run). */
  stepOnce(): void {
    this.stepInstruction(Infinity);
  }

  /**
   * Seek to an exact PIO cycle. Rewinds need a snapshot; long forward jumps use
   * one too when the initial run recorded a snapshot beyond the current
   * position — replaying ≤ one snapshot interval from it beats running the
   * chip for the whole distance (seconds from the anchor to the far end).
   * A finish discovered speculatively is kept even after a rewind: it is a
   * deterministic property of the timeline (invalidateFuture() drops it).
   */
  seek(target: number): void {
    if (!Number.isFinite(target)) return;
    target = Math.max(0, target);
    if (target === this.cycle) return;
    const snap = this.snapshots.findBefore(target);
    if (
      target < this.cycle ||
      (snap !== null && snap.cycle > this.cycle && target - this.cycle > SNAPSHOT_EVERY_CYCLES)
    ) {
      this.restoreForReplay(target);
    }
    this.stepCycles(target - this.cycle);
    this.takeSnapshot();
    this.ensureFutureCoverage();
  }

  /**
   * Pick a snapshot to replay to `target` from, restore it, and reset the
   * analyzer recording if needed.
   *
   * The view needs VIEW_MARGIN cycles of history left of the target. A near
   * target (view fully in the retained ring) keeps the recording — history and
   * the recorded future stay untouched, and the replay overwrites the
   * re-recorded cycles in place. A far target (the ring lies ahead of it after
   * a deep rewind, or behind it after a long forward jump) restarts the
   * recording at the snapshot; if that snapshot is too close to the target to
   * rebuild the margin, the replay starts from the previous snapshot instead.
   */
  private restoreForReplay(target: number): void {
    const snap = this.snapshots.findBefore(target);
    if (!snap) throw new Error(`no snapshot at or before cycle ${target}`);
    const far = !this.analyzer.covers(target - VIEW_MARGIN, target + VIEW_WINDOW / 2);
    const base =
      far && snap.cycle > target - VIEW_MARGIN
        ? this.snapshots.findBefore(snap.cycle - 1) ?? snap
        : snap;
    this.restore(base);
    if (far) this.analyzer.restart();
  }

  /**
   * Ensure analyzer samples exist for the VIEW_WINDOW + COVERAGE_SLACK cycles
   * ahead of the current position, so the analyzer always shows past AND future
   * around the marker. Runs the chip forward speculatively — recording the
   * future trace (finish detection active, snapshots suppressed) — then rolls
   * the chip and the timeline position back. Cheap when the recorded future
   * already covers the view (⏩1 spam reuses the slack instead of re-running).
   */
  ensureFutureCoverage(): void {
    if (this.running) return; // the initial run records the real future anyway
    const specEnd = Math.min(
      this.cycle + VIEW_WINDOW + COVERAGE_SLACK,
      this.finishedCycle ?? Infinity
    );
    if (this.finished && this.cycle >= specEnd) return; // end of timeline
    if (this.analyzer.lastCycle >= specEnd - 1) return; // already covered

    const state = new Uint8Array(this.chip.serializeSize(STATE_OMIT));
    if (!this.chip.serialize(state, state.length, STATE_OMIT)) {
      throw new Error('chip.serialize() failed');
    }
    const { cycle, residual, serialText, nextSnapshotCycle } = this;
    this.speculating = true;
    this.runUntil(specEnd);
    this.speculating = false;
    this.chip.unserialize(state, state.length);
    this.analyzer.resync(); // restores do not notify the pin listeners
    this.cycle = cycle;
    this.residual = residual;
    this.serialText = serialText;
    this.nextSnapshotCycle = nextSnapshotCycle;
  }

  // --- stepping internals ---------------------------------------------------

  /** Run whole CPU instructions until the position reaches `end` or the finish. */
  private runUntil(end: number): void {
    while (this.cycle < end) {
      this.stepInstruction(end);
      if (this.finished && this.cycle >= this.finishedCycle!) break;
    }
  }

  /**
   * One CPU instruction (or the rest of an interrupted one) plus its PIO cycles,
   * but never past `until`; unticked cycles are owed back as `residual`.
   */
  private stepInstruction(until: number): void {
    const c = this.residual > 0 ? this.residual : this.chip.stepCores();
    this.residual = 0;
    this.tickPio(c, until);
  }

  /** Tick the PIO `c` cycles one at a time, recording a sample per cycle. */
  private tickPio(c: number, until: number): void {
    let n = Math.max(0, Math.min(c, until - this.cycle));
    for (let i = 0; i < n; i++) {
      this.chip.stepThings(1);
      this.analyzer.record(this.cycle);
      this.cycle++;
      this.residual = c - i - 1; // owed by the interrupted instruction: boundary snapshots must carry it
      this.maybeSnapshotCycle();
      if (this.finished && this.cycle >= this.finishedCycle!) {
        n = i + 1; // the finish cycle is a hard stop, even mid-instruction
        break;
      }
    }
    this.residual = c - n;
  }

  /** Boundary snapshots (exact, checked per ticked cycle); none while speculating. */
  private maybeSnapshotCycle(): void {
    if (this.speculating || this.cycle < this.nextSnapshotCycle) return;
    this.nextSnapshotCycle = nextBoundary(this.cycle);
    this.takeSnapshot();
  }

  /** Invariant: the chip's core0 cycle count is never behind the PIO timeline. */
  chipCyclesConsistent(): boolean {
    return this.chip.core[0].cycles === this.cycle + this.residual;
  }
}
