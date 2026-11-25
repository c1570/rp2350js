import { describe, expect, test } from 'vitest';
import { AlarmCallback } from './clock';
import { SimulationClock } from './simulation-clock';
import { SaveStateStream } from '../utils/save-state';

class Recorder implements AlarmCallback {
  constructor(private readonly name: string, private readonly log: string[]) {}

  fire() {
    this.log.push(this.name);
  }
}

function scheduleQueue(clock: SimulationClock, log: string[]) {
  const a = clock.createAlarm(new Recorder('a', log));
  const b = clock.createAlarm(new Recorder('b', log));
  const c = clock.createAlarm(new Recorder('c', log));
  const d = clock.createAlarm(new Recorder('d', log));
  a.schedule(10);
  b.schedule(5);
  // Same deadline as `a`: whatever order the queue gives the two must survive a round trip.
  c.schedule(10);
  d.schedule(100);
}

const SNAPSHOT_AT = 7;
const WORDS = 64;

function save(clock: SimulationClock) {
  const data = new Uint8Array(WORDS * 4);
  const s = new SaveStateStream(true, false).attach(data, data.length);
  clock.transferState(s);
  expect(s.ok).toBe(true);
  return data;
}

function load(clock: SimulationClock, data: Uint8Array) {
  const s = new SaveStateStream(false, false).attach(data, data.length);
  clock.transferState(s);
  return s.ok;
}

function referenceRun() {
  const log: string[] = [];
  const clock = new SimulationClock();
  scheduleQueue(clock, log);
  clock.tick(SNAPSHOT_AT);
  const before = log.slice();
  clock.tick(3);
  const atTie = log.slice();
  clock.tick(90);
  return { log, before, atTie };
}

describe('SimulationClock.transferState', () => {
  test('replays from the snapshot exactly like the uninterrupted run', () => {
    const { log, before, atTie } = referenceRun();
    expect(before).toEqual(['b']);
    expect(atTie.length).toBeGreaterThan(before.length);

    const actual: string[] = [];
    const clock = new SimulationClock();
    scheduleQueue(clock, actual);
    clock.tick(SNAPSHOT_AT);
    const data = save(clock);
    clock.tick(100);
    expect(actual).toEqual(log);
    const diverged = actual.length;

    expect(load(clock, data)).toBe(true);
    expect(clock.nanos).toBe(SNAPSHOT_AT);
    clock.tick(2.5);
    expect(actual.slice(diverged)).toEqual([]);
    clock.tick(0.5);
    expect(actual.slice(diverged)).toEqual(atTie.slice(before.length));
    clock.tick(90);
    expect(actual.slice(diverged)).toEqual(log.slice(before.length));
    expect(clock.nanos).toBe(100);
  });

  test('restores onto another clock that created the same alarms', () => {
    const { log, before, atTie } = referenceRun();
    const source: string[] = [];
    const clockA = new SimulationClock();
    scheduleQueue(clockA, source);
    clockA.tick(SNAPSHOT_AT);
    const data = save(clockA);

    const actual: string[] = [];
    const clockB = new SimulationClock();
    scheduleQueue(clockB, actual);
    clockB.tick(1);
    expect(load(clockB, data)).toBe(true);
    expect(clockB.nanos).toBe(SNAPSHOT_AT);
    clockB.tick(3);
    expect(actual).toEqual(atTie.slice(before.length));
    clockB.tick(90);
    expect(actual).toEqual(log.slice(before.length));
  });

  test('a clock with extra alarms accepts the state and leaves them unscheduled', () => {
    const { log } = referenceRun();
    const actual: string[] = [];
    const clock = new SimulationClock();
    scheduleQueue(clock, actual);
    const data = save(clock);
    clock.tick(100);
    const diverged = actual.length;
    const extraLog: string[] = [];
    clock.createAlarm(new Recorder('x', extraLog)).schedule(1);

    expect(load(clock, data)).toBe(true);
    clock.tick(100);
    expect(extraLog).toEqual([]);
    expect(actual.slice(diverged)).toEqual(log);
  });

  test('rejects a state that needs more alarms than this clock has', () => {
    const clock = new SimulationClock();
    scheduleQueue(clock, []);
    const smaller = new SimulationClock();
    smaller.createAlarm(new Recorder('only', []));
    expect(load(smaller, save(clock))).toBe(false);
  });

  test('rejects a state that puts one alarm in the queue twice', () => {
    const clock = new SimulationClock();
    scheduleQueue(clock, []);
    const data = save(clock);
    const words = new Uint32Array(data.buffer);
    // nanos, alarmCount, queueLength, then 4 alarms of (nanos, scheduled); the queue ids follow.
    const firstId = 2 + 2 + 3 * 4;
    expect(words[firstId + 1]).not.toBe(words[firstId]);
    words[firstId + 1] = words[firstId];
    expect(load(clock, data)).toBe(false);
  });

  test('alarms the host creates after seal() are unregistered and unlimited', () => {
    const clock = new SimulationClock();
    scheduleQueue(clock, []);
    clock.seal();
    for (let i = 0; i < 1000; i++) {
      clock.createAlarm(new Recorder(`host${i}`, []));
    }
    expect(clock.alarmCount).toBe(4);
    expect(clock.alarms[3].id).toBe(3);
  });

  test('a pending host alarm is cancelled by a restore, not replayed', () => {
    const log: string[] = [];
    const hostLog: string[] = [];
    const clock = new SimulationClock();
    scheduleQueue(clock, log);
    clock.seal();
    clock.createAlarm(new Recorder('host', hostLog)).schedule(3);

    const data = save(clock);
    clock.tick(7);
    expect(hostLog).toEqual(['host']);
    expect(log).toEqual(['b']);

    expect(load(clock, data)).toBe(true);
    clock.tick(100);
    expect(hostLog).toEqual(['host']);
    expect(log).toEqual(['b', 'b', 'c', 'a', 'd']);
  });

  test('has a state size that does not depend on how many alarms are pending', () => {
    const build = (pending: number) => {
      const clock = new SimulationClock();
      const alarms = [
        clock.createAlarm(new Recorder('a', [])),
        clock.createAlarm(new Recorder('b', [])),
        clock.createAlarm(new Recorder('c', [])),
      ];
      clock.seal();
      for (let i = 0; i < pending; i++) {
        alarms[i].schedule(10);
      }
      return clock;
    };
    const measure = (clock: SimulationClock) => {
      const s = new SaveStateStream(true, true);
      clock.transferState(s);
      return s.pos;
    };
    expect(measure(build(3))).toBe(measure(build(0)));
    const real = new SaveStateStream(true, false).attach(new Uint8Array(4096), 4096);
    build(3).transferState(real);
    expect(real.pos).toBeLessThanOrEqual(measure(build(0)));
  });

  test('gives alarms ids in creation order', () => {
    const clock = new SimulationClock();
    const alarms = [
      clock.createAlarm(new Recorder('a', [])),
      clock.createAlarm(new Recorder('b', [])),
    ];
    expect(alarms[0]).not.toBe(alarms[1]);
    expect(clock.alarmCount).toBe(2);
    expect(clock.alarms[0]).toBe(alarms[0]);
    expect(clock.alarms[1]).toBe(alarms[1]);
  });
});
