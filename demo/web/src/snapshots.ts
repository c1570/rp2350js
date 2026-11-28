/**
 * Snapshot store for cycle-accurate rewind.
 *
 * Each snapshot is a full chip state (~870 KB with flash/PSRAM omitted — they are
 * never written by the RAM-resident firmware) plus runner-level metadata: the
 * timeline position (completed PIO cycles), the residual PIO ticks owed by an
 * interrupted CPU instruction, and the serial output length at that point.
 */
import { SAVE_STATE_OMIT_FLASH, SAVE_STATE_OMIT_PSRAM } from '../../../src/utils/save-state';

export const STATE_OMIT = SAVE_STATE_OMIT_FLASH | SAVE_STATE_OMIT_PSRAM;

/** Snapshot metadata + full chip state at a timeline position. */
export interface Snapshot {
  /** Timeline position: completed PIO cycles at the snapshot point. */
  cycle: number;
  /** PIO cycles still owed by the CPU instruction that was interrupted for the seek. */
  residual: number;
  /** Serial output up to this point (a sliced string — shares storage with the full log). */
  serialText: string;
  data: Uint8Array;
}

/**
 * Snapshots sorted by cycle. There is deliberately NO capacity eviction: entries
 * are only ever dropped by invalidateAfter() when the GPIO24 button invalidates
 * the recorded future.
 */
export class SnapshotStore {
  readonly list: Snapshot[] = [];

  /**
   * A new snapshot replaces every existing one closer than this (manual stepping
   * and seek targets), so any two snapshots stay at least this far apart.
   */
  constructor(private readonly dedupCycles = 500) {}

  /** First index whose cycle is >= `cycle` (list stays sorted if inserted there). */
  private lowerBound(cycle: number): number {
    let lo = 0;
    let hi = this.list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.list[mid].cycle < cycle) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  add(snapshot: Snapshot): void {
    const list = this.list;
    const lo = this.lowerBound(snapshot.cycle);
    // Replace every neighbor within dedupCycles (none, the previous one, the next
    // one, or both when the new one squeezes between them) — the list stays sorted.
    const from = lo > 0 && snapshot.cycle - list[lo - 1].cycle < this.dedupCycles ? lo - 1 : lo;
    const to = lo < list.length && list[lo].cycle - snapshot.cycle < this.dedupCycles ? lo + 1 : lo;
    list.splice(from, to - from, snapshot);
  }

  /** Greatest snapshot at or before `cycle`. */
  findBefore(cycle: number): Snapshot | null {
    return this.list[this.lowerBound(cycle + 1) - 1] ?? null;
  }

  /** Drop everything recorded after `cycle` (GPIO button toggled: that future is gone). */
  invalidateAfter(cycle: number): void {
    this.list.length = this.lowerBound(cycle + 1);
  }
}
