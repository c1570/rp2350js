import { describe, expect, it } from 'vitest';
import { RP2040 } from '../rp2040';
import { RP2040RTC } from './rtc';

// RP2040RTC's register layout, as the SDK's hardware_rtc uses it.
const SETUP0 = 0x04; // year[23:12] month[11:8] day[4:0]
const SETUP1 = 0x08; // dotw[26:24] hour[21:16] min[15:8] sec[5:0]
const CTRL = 0x0c;
const RTC1 = 0x18; // year / month / day
const RTC0 = 0x1c; // dotw / hour / min / sec
const LOAD = 0x10;
const ENABLE = 0x01;

function load(rtc: RP2040RTC, date: Date) {
  // `date` is read in UTC: the RTC is a wall clock, and the model must not depend on
  // the host's timezone.
  rtc.writeUint32(
    SETUP0,
    (date.getUTCFullYear() << 12) | ((date.getUTCMonth() + 1) << 8) | date.getUTCDate()
  );
  rtc.writeUint32(
    SETUP1,
    (date.getUTCDay() << 24) |
      (date.getUTCHours() << 16) |
      (date.getUTCMinutes() << 8) |
      date.getUTCSeconds()
  );
  rtc.writeUint32(CTRL, LOAD);
  rtc.writeUint32(CTRL, ENABLE);
}

describe('RP2040RTC', () => {
  it('starts at 2021-01-01 00:00:00, a Friday', () => {
    const rtc = new RP2040RTC(new RP2040(), 'RTC');
    expect(rtc.readUint32(RTC1)).toBe((2021 << 12) | (1 << 8) | 1);
    expect(rtc.readUint32(RTC0)).toBe((5 << 24) | (0 << 16) | (0 << 8) | 0);
  });

  it('reads back a loaded date and keeps time from there', () => {
    const chip = new RP2040();
    const rtc = new RP2040RTC(chip, 'RTC');
    load(rtc, new Date(Date.UTC(2024, 5, 15, 13, 40, 59)));
    expect(rtc.readUint32(RTC1)).toBe((2024 << 12) | (6 << 8) | 15);
    expect(rtc.readUint32(RTC0)).toBe((6 << 24) | (13 << 16) | (40 << 8) | 59);
    expect(rtc.readUint32(CTRL) & LOAD).toBe(0);

    chip.clock.tick(1.5e9); // one and a half seconds
    expect(rtc.readUint32(RTC0)).toBe((6 << 24) | (13 << 16) | (41 << 8) | 0);
  });

  it('agrees with the calendar over a wide range of dates', () => {
    const rtc = new RP2040RTC(new RP2040(), 'RTC');
    // Leap days, century years (1900 and 2100 are not leap years, 2000 is), the day
    // before the epoch, and an LCG's worth of dates in between.
    const dates = [
      new Date(Date.UTC(1969, 11, 31, 23, 59, 59)),
      new Date(Date.UTC(1969, 11, 31)),
      new Date(Date.UTC(1970, 0, 1)),
      new Date(Date.UTC(2000, 1, 29, 12, 0, 0)),
      new Date(Date.UTC(1900, 2, 1)),
      new Date(Date.UTC(2100, 2, 1)),
      new Date(Date.UTC(2024, 1, 29, 23, 59, 59)),
    ];
    let seed = 12345;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let i = 0; i < 400; i++) {
      const day = Math.floor((next() / 0x7fffffff) * 47000); // ~128 years
      const second = Math.floor((next() / 0x7fffffff) * 86400);
      dates.push(new Date(Date.UTC(1970, 0, 1) + day * 86400000 + second * 1000));
    }
    for (const date of dates) {
      load(rtc, date);
      expect([rtc.readUint32(RTC1), rtc.readUint32(RTC0)], date.toISOString()).toEqual([
        (date.getUTCFullYear() << 12) | ((date.getUTCMonth() + 1) << 8) | date.getUTCDate(),
        (date.getUTCDay() << 24) |
          (date.getUTCHours() << 16) |
          (date.getUTCMinutes() << 8) |
          date.getUTCSeconds(),
      ]);
    }
  });
});
