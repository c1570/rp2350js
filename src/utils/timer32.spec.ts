import { describe, expect, test } from 'vitest';
import { SimulationClock } from '../clock/simulation-clock';
import { Timer32, Timer32PeriodicAlarm, TimerMode } from './timer32';
import { SaveStateStream } from './save-state';

// 1 MHz timer: 1 cycle = 1 µs = 1000 ns.
const FREQ = 1e6;
const US = 1000; // nanos

// top+1 cycles for a full-width timer — mathematically 0x100000000, but schedule()'s
// "already at target" bump uses 0xffffffff (one short) since 2**32 doesn't fit a 32-bit
// type in the C transpile. See schedule()'s comment.
const FULL_PERIOD = 0xffffffff;

function setup(mode: TimerMode, top = 0xffffffff) {
  const clock = new SimulationClock();
  const timer = new Timer32('test', clock, FREQ);
  timer.mode = mode;
  timer.top = top;
  let fires = 0;
  const alarm = new Timer32PeriodicAlarm('test_alarm', timer, { fire: () => fires++ });
  return { clock, timer, alarm, fireCount: () => fires };
}

describe('Timer32PeriodicAlarm.schedule', () => {
  test('increment: target ahead fires exactly on target', () => {
    const { clock, timer, alarm, fireCount } = setup(TimerMode.Increment, 0xffff);
    timer.set(100);
    alarm.target = 350;
    alarm.enable = true;
    clock.tick(249 * US);
    expect(fireCount()).toBe(0);
    clock.tick(2 * US);
    expect(fireCount()).toBe(1);
  });

  test('increment: target behind waits for wraparound', () => {
    const { clock, timer, alarm, fireCount } = setup(TimerMode.Increment, 0xffff);
    timer.set(200);
    alarm.target = 100;
    alarm.enable = true;
    // 0x10000 - 200 + 100 cycles to the wrapped target
    clock.tick((0x10000 - 100 - 1) * US);
    expect(fireCount()).toBe(0);
    clock.tick(2 * US);
    expect(fireCount()).toBe(1);
  });

  test('increment full-width: counter exactly at target schedules a full period (no 0ns refire)', () => {
    const { clock, timer, alarm, fireCount } = setup(TimerMode.Increment);
    timer.set(1234);
    alarm.target = 1234;
    alarm.enable = true;
    clock.tick(1);
    expect(fireCount()).toBe(0); // a 0ns-refire bug would have fired instantly
    // "already at target" waits FULL_PERIOD cycles (one short of 2**32).
    const periodNanos = FULL_PERIOD * US;
    clock.tick(periodNanos - 1 - 2);
    expect(fireCount()).toBe(0);
    clock.tick(2);
    expect(fireCount()).toBe(1);
  });

  test('increment full-width: counter more than one period past target still schedules correctly', () => {
    const { clock, timer, alarm, fireCount } = setup(TimerMode.Increment);
    // rawCounter is not wrapped for full-width timers, so it can legitimately
    // sit multiple periods past the 32-bit target value.
    timer.set(FULL_PERIOD + 5);
    alarm.target = 10;
    alarm.enable = true;
    clock.tick(4 * US);
    expect(fireCount()).toBe(0); // instant refire would show here
    clock.tick(2 * US);
    expect(fireCount()).toBe(1); // (10 - 5) mod 2^32 = 5 cycles
  });

  test('decrement: counts down to target', () => {
    const { clock, timer, alarm, fireCount } = setup(TimerMode.Decrement, 0xffffff);
    timer.set(1000);
    alarm.target = 400;
    alarm.enable = true;
    clock.tick(599 * US);
    expect(fireCount()).toBe(0);
    clock.tick(2 * US);
    expect(fireCount()).toBe(1);
  });

  test('decrement: counter exactly at target schedules a full period', () => {
    const { clock, timer, alarm, fireCount } = setup(TimerMode.Decrement, 0xffffff);
    timer.set(500);
    alarm.target = 500;
    alarm.enable = true;
    clock.tick(1 * US);
    expect(fireCount()).toBe(0);
    clock.tick((0x1000000 - 2) * US);
    expect(fireCount()).toBe(0);
    clock.tick(2 * US);
    expect(fireCount()).toBe(1);
  });

  test('decrement full-width: schedules without the +period rawCounter bias', () => {
    // Decrement-mode rawCounter is computed as baseValue + (period - ticks %
    // period), i.e. biased a full period high until wrapped -- for a
    // full-width timer that wrap never happens in rawCounter itself.
    const { clock, timer, alarm, fireCount } = setup(TimerMode.Decrement);
    timer.set(1000);
    alarm.target = 400;
    alarm.enable = true;
    clock.tick(599 * US);
    expect(fireCount()).toBe(0);
    clock.tick(2 * US);
    expect(fireCount()).toBe(1); // biased scheduling would be 2^32 cycles late
  });

  test('target above top never fires', () => {
    const { clock, timer, alarm, fireCount } = setup(TimerMode.Increment, 0xffff);
    timer.set(0);
    alarm.target = 0x20000;
    alarm.enable = true;
    clock.tick(0x30000 * US);
    expect(fireCount()).toBe(0);
  });

  test('periodic refire: fires once per period', () => {
    const { clock, timer, alarm, fireCount } = setup(TimerMode.Increment, 999);
    timer.set(0);
    alarm.target = 500;
    alarm.enable = true;
    clock.tick(3500 * US);
    expect(fireCount()).toBe(4); // at 500, 1500, 2500, 3500 µs
  });

  test('zigzag: fires at both crossings of the target, once per slope', () => {
    const { clock, timer, alarm, fireCount } = setup(TimerMode.ZigZag, 100);
    timer.set(0);
    alarm.target = 30;
    alarm.enable = true;
    // Counter path: 0..100..0 over a 200-cycle period; crossings of 30 at
    // rawCounter 30 (up), 170 (down), 230 (up), 370 (down), ...
    clock.tick(29 * US);
    expect(fireCount()).toBe(0);
    clock.tick(2 * US); // 31
    expect(fireCount()).toBe(1);
    clock.tick(138 * US); // 169
    expect(fireCount()).toBe(1);
    clock.tick(2 * US); // 171
    expect(fireCount()).toBe(2);
    clock.tick(58 * US); // 229
    expect(fireCount()).toBe(2);
    clock.tick(2 * US); // 231
    expect(fireCount()).toBe(3);
    clock.tick(138 * US); // 369
    expect(fireCount()).toBe(3);
    clock.tick(2 * US); // 371
    expect(fireCount()).toBe(4);
  });

  test('zigzag: target at top fires once per period, at the peak', () => {
    const { clock, timer, alarm, fireCount } = setup(TimerMode.ZigZag, 100);
    timer.set(0);
    alarm.target = 100;
    alarm.enable = true;
    clock.tick(99 * US);
    expect(fireCount()).toBe(0);
    clock.tick(2 * US); // 101
    expect(fireCount()).toBe(1);
    clock.tick(198 * US); // 299
    expect(fireCount()).toBe(1);
    clock.tick(2 * US); // 301
    expect(fireCount()).toBe(2);
  });

  test('zigzag: target 0 fires once per period, at the bottom', () => {
    const { clock, timer, alarm, fireCount } = setup(TimerMode.ZigZag, 100);
    timer.set(0);
    alarm.target = 0;
    alarm.enable = true;
    clock.tick(199 * US);
    expect(fireCount()).toBe(0);
    clock.tick(2 * US); // 201
    expect(fireCount()).toBe(1);
    clock.tick(198 * US); // 399
    expect(fireCount()).toBe(1);
    clock.tick(2 * US); // 401
    expect(fireCount()).toBe(2);
  });

  test('zigzag: starting on the down slope schedules the up-slope crossing next', () => {
    const { clock, timer, alarm, fireCount } = setup(TimerMode.ZigZag, 100);
    timer.set(30, true); // down slope at counter 30 (rawCounter 170)
    expect(timer.counter).toBe(30);
    alarm.target = 30;
    alarm.enable = true;
    // Exactly on a crossing now; the next one is the up-slope crossing at
    // rawCounter 230, i.e. 60 cycles away.
    clock.tick(59 * US);
    expect(fireCount()).toBe(0);
    clock.tick(2 * US);
    expect(fireCount()).toBe(1);
  });
});

describe('Timer32.transferState', () => {
  test('round-trips the timer, its periodic alarm and the clock it is scheduled on', () => {
    const clock = new SimulationClock();
    const timer = new Timer32('t', clock, FREQ);
    timer.top = 1000;
    let fires = 0;
    const alarm = new Timer32PeriodicAlarm('a', timer, { fire: () => fires++ });
    alarm.target = 150;
    alarm.enable = true;
    timer.set(100);
    clock.tick(20 * US);
    expect(timer.counter).toBe(120);

    const data = new Uint8Array(256);
    const out = new SaveStateStream(true, false).attach(data, data.length);
    clock.transferState(out);
    timer.transferState(out);
    alarm.transferState(out);
    expect(out.ok).toBe(true);

    timer.top = 7;
    timer.mode = TimerMode.Decrement;
    timer.prescaler = 4;
    timer.set(3);
    timer.enable = false;
    alarm.target = 1;
    alarm.enable = false;
    clock.tick(500 * US);
    expect(fires).toBe(0);

    const input = new SaveStateStream(false, false).attach(data, data.length);
    clock.transferState(input);
    timer.transferState(input);
    alarm.transferState(input);
    expect(input.ok).toBe(true);
    expect(clock.nanos).toBe(20 * US);
    expect(timer.counter).toBe(120);
    expect(timer.top).toBe(1000);
    expect(timer.prescaler).toBe(1);
    expect(timer.mode).toBe(TimerMode.Increment);
    expect(timer.enable).toBe(true);
    expect(timer.frequency).toBe(FREQ);
    expect(alarm.target).toBe(150);
    expect(alarm.enable).toBe(true);

    clock.tick(29 * US);
    expect(fires).toBe(0);
    clock.tick(1 * US);
    expect(fires).toBe(1);
  });
});
