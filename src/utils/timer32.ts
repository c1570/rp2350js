import { IClock } from '../clock/clock';

export enum TimerMode {
  Increment,
  Decrement,
  ZigZag,
}

export class Timer32 {
  private baseValue = 0;
  private baseNanos = 0;
  private topValue = 0xffffffff;
  private prescalerValue = 1;
  private timerMode = TimerMode.Increment;
  private enabled = true;
  readonly listeners: (() => void)[] = [];

  constructor(readonly label: string, readonly clock: IClock, private baseFreq: number) {}

  reset() {
    this.baseNanos = this.clock.nanos;
    this.baseValue = 0;
    this.updated();
  }

  set(value: number, zigZagDown = false) {
    this.baseValue = zigZagDown ? this.topValue * 2 - value : value;
    this.baseNanos = this.clock.nanos;
    this.updated();
  }

  /**
   * Advances the counter by the given amount. Note that this will
   * decrease the counter if the timer is running in Decrement mode.
   *
   * @param delta The value to add to the counter. Can be negative.
   */
  advance(delta: number) {
    this.baseValue += delta;
  }

  get rawCounter() {
    const { baseFreq, prescalerValue, baseNanos, baseValue, enabled, timerMode } = this;
    if (!baseFreq || !prescalerValue || !enabled) {
      return this.baseValue;
    }
    const zigzag = timerMode == TimerMode.ZigZag;
    const ticks = ((this.clock.nanos - baseNanos) / 1e9) * (baseFreq / prescalerValue);
    const topModulo = zigzag ? this.topValue * 2 : this.topValue + 1;
    const delta = timerMode == TimerMode.Decrement ? topModulo - (ticks % topModulo) : ticks;
    let currentValue = Math.round(baseValue + delta);
    if (this.topValue != 0xffffffff) {
      currentValue %= topModulo;
    }
    return currentValue;
  }

  get counter() {
    let currentValue = this.rawCounter;
    if (this.timerMode == TimerMode.ZigZag && currentValue > this.topValue) {
      currentValue = this.topValue * 2 - currentValue;
    }
    return currentValue >>> 0;
  }

  get top() {
    return this.topValue;
  }

  set top(value: number) {
    const { counter } = this;
    this.topValue = value;
    this.set(counter <= this.topValue ? counter : 0);
  }

  get frequency() {
    return this.baseFreq;
  }

  set frequency(value: number) {
    this.baseValue = this.counter;
    this.baseNanos = this.clock.nanos;
    this.baseFreq = value;
    this.updated();
  }

  get prescaler() {
    return this.prescalerValue;
  }

  set prescaler(value: number) {
    this.baseValue = this.counter;
    this.baseNanos = this.clock.nanos;
    this.enabled = this.prescalerValue !== 0;
    this.prescalerValue = value;
    this.updated();
  }

  toNanos(cycles: number) {
    const { baseFreq, prescalerValue } = this;
    return (cycles * 1e9) / (baseFreq / prescalerValue);
  }

  get enable() {
    return this.enabled;
  }

  set enable(value: boolean) {
    if (value !== this.enabled) {
      if (value) {
        this.baseNanos = this.clock.nanos;
      } else {
        this.baseValue = this.counter;
      }
      this.enabled = value;
      this.updated();
    }
  }

  get mode() {
    return this.timerMode;
  }

  set mode(value: TimerMode) {
    if (this.timerMode !== value) {
      const { counter } = this;
      this.timerMode = value;
      this.set(counter);
    }
  }

  private updated() {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export class Timer32PeriodicAlarm {
  private targetValue = 0;
  private enabled = false;
  private clockAlarm;
  private warnedZeroInterval = false;

  constructor(readonly label: string, readonly timer: Timer32, readonly callback: () => void) {
    this.clockAlarm = this.timer.clock.createAlarm(this.handleAlarm);
    timer.listeners.push(this.update);
  }

  get enable() {
    return this.enabled;
  }

  set enable(value: boolean) {
    if (value !== this.enabled) {
      this.enabled = value;
      if (value && this.timer.enable) {
        this.schedule();
      } else {
        this.cancel();
      }
    }
  }

  get target() {
    return this.targetValue;
  }

  set target(value: number) {
    if (value === this.targetValue) {
      return;
    }
    this.targetValue = value;
    if (this.enabled && this.timer.enable) {
      this.cancel();
      this.schedule();
    }
  }

  handleAlarm = () => {
    this.callback();
    if (this.enabled && this.timer.enable) {
      this.schedule();
    }
  };

  update = () => {
    this.cancel();
    if (this.enabled && this.timer.enable) {
      this.schedule();
    }
  };

  private schedule() {
    const { timer, targetValue } = this;
    const { top, mode, rawCounter } = timer;
    let cycleDelta;
    if (mode === TimerMode.ZigZag) {
      // A phase-correct counter crosses the target twice per 2*top period,
      // once per slope; schedule whichever crossing comes first. A distance
      // of 0 means "firing right now" and wraps to the next crossing.
      const period = top * 2 || 1;
      const distance = (crossing: number) => {
        const d = (crossing - rawCounter) % period;
        return d <= 0 ? d + period : d;
      };
      cycleDelta = Math.min(distance(targetValue), distance(period - targetValue));
    } else {
      // Delta in the counter's own direction of travel. rawCounter is
      // unwrapped for full-width (top=0xffffffff) timers and biased +period
      // in Decrement mode, so the raw delta can be off by whole periods in
      // either direction; normalize with a Euclidean modulo (a `>>> 0` just
      // reinterprets the sign bit). A delta of 0 (already at target) means a
      // full period, not a 0ns refire loop.
      const period = top + 1;
      cycleDelta = mode === TimerMode.Decrement ? rawCounter - targetValue : targetValue - rawCounter;
      cycleDelta = ((cycleDelta % period) + period) % period;
      if (cycleDelta === 0) {
        cycleDelta = period;
      }
    }
    if (targetValue > top) {
      // Skip alarm
      return;
    }
    const cyclesToAlarm = cycleDelta;
    const nanosToAlarm = timer.toNanos(cyclesToAlarm);
    if (nanosToAlarm <= 0 && !this.warnedZeroInterval) {
      this.warnedZeroInterval = true;
      console.warn(
        `Timer32PeriodicAlarm(${this.label}): scheduling with a ${nanosToAlarm}ns interval (target=${targetValue}, rawCounter=${rawCounter}); this may cause an infinite reschedule loop`,
      );
    }
    this.clockAlarm.schedule(nanosToAlarm);
  }

  private cancel() {
    this.clockAlarm.cancel();
  }
}
