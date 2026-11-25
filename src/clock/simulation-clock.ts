import { AlarmCallback, IAlarm, IClock } from './clock.js';
import { Float64 } from '../utils/types';
import { SaveStateStream } from '../utils/save-state';

const ALARM_REGISTRY_CAPACITY = 256;

export class ClockAlarm implements IAlarm {
  next: ClockAlarm | null = null;
  nanos: Float64 = 0;
  scheduled = false;
  // Index in SimulationClock.alarms, by which a save state refers to the alarm.
  // -1 for an unregistered alarm: one the host created after the chip sealed the clock.
  id = -1;

  constructor(private readonly clock: SimulationClock, readonly callback: AlarmCallback) {}

  schedule(deltaNanos: Float64): void {
    if (this.scheduled) {
      this.cancel();
    }
    this.clock.linkAlarm(deltaNanos, this);
  }

  cancel(): void {
    this.clock.unlinkAlarm(this);
    this.scheduled = false;
  }
}

export class SimulationClock implements IClock {
  private nextAlarm: ClockAlarm | null = null;

  // Float64 (not `number`): a nanosecond counter as plain `number` compiles to C
  // `int32_t`, overflowing after ~2.15s of simulated uptime. Float64 emits
  // `double`, matching JS's actual runtime type exactly (no truncation).
  private nanosCounter: Float64 = 0;

  // The chip's own alarms, in creation order, up to seal(). Each gets a stable index a
  // save state can refer to; the creation order depends only on the chip's construction,
  // so identically-built chips assign the same indices.
  readonly alarms = new Array<ClockAlarm>(ALARM_REGISTRY_CAPACITY);
  alarmCount = 0;
  private sealed = false;

  constructor(readonly frequency = 125e6) {}

  get nanos(): Float64 {
    return this.nanosCounter;
  }

  getNanos(): Float64 {
    return this.nanosCounter;
  }

  get micros(): Float64 {
    return this.nanos / 1000;
  }

  // Called by the chip constructor once its peripherals exist. Alarms created later
  // belong to host code: they are not registered, so any number of short-lived host
  // timers neither grows the registry nor the save state. A pending one is cancelled,
  // not restored, by unserialize().
  seal() {
    this.sealed = true;
  }

  createAlarm(callback: AlarmCallback): IAlarm {
    const alarm = new ClockAlarm(this, callback);
    if (this.sealed) {
      return alarm;
    }
    if (this.alarmCount >= ALARM_REGISTRY_CAPACITY) {
      throw new Error(`SimulationClock: more than ${ALARM_REGISTRY_CAPACITY} alarms`);
    }
    alarm.id = this.alarmCount;
    this.alarms[this.alarmCount] = alarm;
    this.alarmCount++;
    return alarm;
  }

  transferState(s: SaveStateStream) {
    if (s.serializing) {
      // At most every registered alarm is queued, once each. Reserve that ceiling so
      // the measured size never depends on how many happen to be pending.
      if (s.measuring) {
        s.skip(4 + 4 * this.alarmCount);
        return;
      }
      s.f64(this.nanosCounter);
      s.u32(this.alarmCount);
      // `let` + `while` rather than a `for` initializer: cts2c types a variable declared
      // there as int32_t instead of inferring ClockAlarm* from `this.nextAlarm`.
      let queueLength = 0;
      let queued = this.nextAlarm;
      while (queued) {
        if (queued.id >= 0) {
          queueLength++;
        }
        queued = queued.next;
      }
      s.u32(queueLength);
      for (let i = 0; i < this.alarmCount; i++) {
        const alarm = this.alarms[i];
        // Saved for every alarm, queued or not: tick() leaves `scheduled` set on a
        // fired alarm, so the flag and queue membership legitimately disagree.
        s.f64(alarm.nanos);
        s.u32(alarm.scheduled ? 1 : 0);
      }
      // The queue in order; unregistered (host) alarms are left out.
      queued = this.nextAlarm;
      while (queued) {
        if (queued.id >= 0) {
          s.u32(queued.id);
        }
        queued = queued.next;
      }
      return;
    }
    // Reads pass a dummy value: it is only stored when serializing.
    const nanos = s.f64(0);
    const alarmCount = s.u32(0);
    const queueLength = s.u32(0);
    if (alarmCount > this.alarmCount || queueLength > alarmCount) {
      s.ok = false;
      return;
    }
    // Empty the live queue whole, host alarms included: only registered ones come back.
    let queued = this.nextAlarm;
    while (queued) {
      const next: ClockAlarm | null = queued.next;
      queued.next = null;
      queued.scheduled = false;
      queued = next;
    }
    this.nextAlarm = null;
    this.nanosCounter = nanos;
    for (let i = 0; i < this.alarmCount; i++) {
      this.alarms[i].next = null;
      this.alarms[i].scheduled = false;
    }
    for (let i = 0; i < alarmCount; i++) {
      const alarm = this.alarms[i];
      alarm.nanos = s.f64(0);
      alarm.scheduled = s.u32(0) !== 0;
    }
    let tail: ClockAlarm | null = null;
    for (let i = 0; i < queueLength; i++) {
      const id = s.u32(0);
      if (id >= alarmCount) {
        s.ok = false;
        return;
      }
      const alarm = this.alarms[id];
      // An alarm linked twice corrupts the queue; adjacent duplicates form a cycle
      // that hangs tick().
      if (alarm.next || alarm === tail) {
        s.ok = false;
        return;
      }
      if (tail) {
        tail.next = alarm;
      } else {
        this.nextAlarm = alarm;
      }
      tail = alarm;
    }
  }

  linkAlarm(nanos: Float64, alarm: ClockAlarm) {
    alarm.nanos = this.nanos + nanos;
    let alarmListItem = this.nextAlarm;
    let lastItem = null;
    while (alarmListItem && alarmListItem.nanos < alarm.nanos) {
      lastItem = alarmListItem;
      alarmListItem = alarmListItem.next;
    }
    if (lastItem) {
      lastItem.next = alarm;
      alarm.next = alarmListItem;
    } else {
      this.nextAlarm = alarm;
      alarm.next = alarmListItem;
    }
    alarm.scheduled = true;
    return alarm;
  }

  unlinkAlarm(alarm: ClockAlarm) {
    let alarmListItem = this.nextAlarm;
    if (!alarmListItem) {
      return false;
    }
    let lastItem = null;
    while (alarmListItem) {
      if (alarmListItem === alarm) {
        if (lastItem) {
          lastItem.next = alarmListItem.next;
        } else {
          this.nextAlarm = alarmListItem.next;
        }
        return true;
      }
      lastItem = alarmListItem;
      alarmListItem = alarmListItem.next;
    }
    return false;
  }

  tick(deltaNanos: Float64) {
    const targetNanos: Float64 = this.nanosCounter + deltaNanos;
    let alarm = this.nextAlarm;
    while (alarm && alarm.nanos <= targetNanos) {
      this.nextAlarm = alarm.next;
      this.nanosCounter = alarm.nanos;
      alarm.callback.fire();
      alarm = this.nextAlarm;
    }
    this.nanosCounter = targetNanos;
  }

  get nanosToNextAlarm(): Float64 {
    if (this.nextAlarm) {
      return this.nextAlarm.nanos - this.nanos;
    }
    return 0;
  }
}
