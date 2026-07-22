import { IGDBTarget } from './gdb/gdb-target';
import { RP2040 } from './rp2040';

export class Simulator implements IGDBTarget {
  executeTimer: ReturnType<typeof setTimeout> | null = null;
  rp2040: RP2040;
  stopped = true;

  constructor() {
    this.rp2040 = new RP2040();
    this.rp2040.onBreak = () => this.stop();
  }

  execute() {
    const { rp2040 } = this;

    this.executeTimer = null;
    this.stopped = false;
    const cycleNanos = 1e9 / 125_000_000; // 125 MHz
    for (let i = 0; i < 1000000 && !this.stopped; i++) {
      if (rp2040.core0.waiting) {
        const { nanosToNextAlarm } = rp2040.clock;
        rp2040.clock.tick(nanosToNextAlarm);
        i += nanosToNextAlarm / cycleNanos;
      } else {
        const cycles = rp2040.core0.executeInstruction();
        rp2040.clock.tick(cycles * cycleNanos);
      }
    }
    if (!this.stopped) {
      this.executeTimer = setTimeout(() => this.execute(), 0);
    }
  }

  stop() {
    this.stopped = true;
    if (this.executeTimer != null) {
      clearTimeout(this.executeTimer);
      this.executeTimer = null;
    }
  }

  get executing() {
    return !this.stopped;
  }
}
