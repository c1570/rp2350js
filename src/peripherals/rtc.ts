import { IRPChip } from '../rpchip';
import { BasePeripheral, Peripheral } from './peripheral';
import { Float64 } from '../utils/types';
import { SaveStateStream } from '../utils/save-state';

const RTC_SETUP0 = 0x04;
const RTC_SETUP1 = 0x08;
const RTC_CTRL = 0x0c;
const IRQ_SETUP_0 = 0x10;
const RTC_RTC1 = 0x18;
const RTC_RTC0 = 0x1c;

const RTC_ENABLE_BITS = 0x01;
const RTC_ACTIVE_BITS = 0x2;
const RTC_LOAD_BITS = 0x10;

const SETUP_0_YEAR_SHIFT = 12;
const SETUP_0_YEAR_MASK = 0xfff;
const SETUP_0_MONTH_SHIFT = 8;
const SETUP_0_MONTH_MASK = 0xf;
const SETUP_0_DAY_SHIFT = 0;
const SETUP_0_DAY_MASK = 0x1f;

const SETUP_1_DOTW_SHIFT = 24;
const SETUP_1_DOTW_MASK = 0x7;
const SETUP_1_HOUR_SHIFT = 16;
const SETUP_1_HOUR_MASK = 0x1f;
const SETUP_1_MIN_SHIFT = 8;
const SETUP_1_MIN_MASK = 0x3f;
const SETUP_1_SEC_SHIFT = 0;
const SETUP_1_SEC_MASK = 0x3f;

const RTC_0_YEAR_SHIFT = 12;
const RTC_0_YEAR_MASK = 0xfff;
const RTC_0_MONTH_SHIFT = 8;
const RTC_0_MONTH_MASK = 0xf;
const RTC_0_DAY_SHIFT = 0;
const RTC_0_DAY_MASK = 0x1f;

const RTC_1_DOTW_SHIFT = 24;
const RTC_1_DOTW_MASK = 0x7;
const RTC_1_HOUR_SHIFT = 16;
const RTC_1_HOUR_MASK = 0x1f;
const RTC_1_MIN_SHIFT = 8;
const RTC_1_MIN_MASK = 0x3f;
const RTC_1_SEC_SHIFT = 0;
const RTC_1_SEC_MASK = 0x3f;

// Float64: a day is 86.4 million ms, which does not fit an int32 once multiplied by days.
const MS_PER_DAY: Float64 = 86400000;
// 00:00:00 UTC on 2021-01-01, in milliseconds since the epoch. A literal rather than
// Date.UTC(): cts2c has no Date support, and the C build needs the very same number.
const DEFAULT_BASELINE_MS: Float64 = 1609459200000;

/** Milliseconds since the epoch at 00:00:00 UTC on that civil date (proleptic Gregorian). */
function civilDateToMillis(year: number, month: number, day: number): Float64 {
  // Howard Hinnant's days_from_civil: shifts the year to start in March, so leap days
  // land at the end of the year, then counts 400-, 100- and 4-year cycles.
  const y: Float64 = month <= 2 ? year - 1 : year;
  const era: Float64 = Math.floor(y / 400);
  const yoe: Float64 = y - era * 400;
  const doy: Float64 = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe: Float64 = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  const days: Float64 = era * 146097 + doe - 719468;
  return days * MS_PER_DAY;
}

export class RP2040RTC<ChipType extends IRPChip = IRPChip>
  extends BasePeripheral<ChipType>
  implements Peripheral
{
  setup0 = 0;
  setup1 = 0;
  rtc1 = 0;
  rtc0 = 0;
  ctrl = 0;
  // The wall clock the RTC was last set to, as milliseconds since the epoch, and the
  // emulated time (nanoseconds) that corresponded to it. Numbers rather than a Date:
  // the model is then the same in every timezone, and the C build can have one too.
  baselineMs: Float64 = DEFAULT_BASELINE_MS;
  baselineNanos: Float64 = 0;

  readUint32(offset: number) {
    switch (offset) {
      case RTC_SETUP0:
        return this.setup0;
      case RTC_SETUP1:
        return this.setup1;
      case RTC_CTRL:
        return this.ctrl;
      case IRQ_SETUP_0:
        return 0;
      case RTC_RTC1:
      case RTC_RTC0: {
        // The civil date and time, in UTC, of the wall clock now.
        const ms: Float64 =
          this.baselineMs + (this.rpchip.clock.getNanos() - this.baselineNanos) / 1_000_000;
        // Math.floor, not truncation: dates before 1970 give a negative `ms`.
        const days = Math.floor(ms / MS_PER_DAY);
        // The day start as a double, explicitly: `days * MS_PER_DAY` would be an int32
        // product in the C build (cts2c emits MS_PER_DAY as an enum constant) and
        // overflow, where JS has no such limit.
        const dayStart: Float64 = Math.floor(ms / MS_PER_DAY) * MS_PER_DAY;
        const timeOfDay: Float64 = ms - dayStart;
        // Howard Hinnant's civil_from_days, the inverse of civilDateToMillis().
        const z = days + 719468;
        const era = Math.floor(z / 146097);
        const doe = z - era * 146097;
        const yoe = Math.floor(
          (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365
        );
        const y = yoe + era * 400;
        const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
        const mp = Math.floor((5 * doy + 2) / 153);
        const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
        const month = mp + (mp < 10 ? 3 : -9);
        const year = y + (month <= 2 ? 1 : 0);
        const hour = Math.floor(timeOfDay / 3600000);
        const minute = Math.floor(timeOfDay / 60000) % 60;
        const second = Math.floor(timeOfDay / 1000) % 60;
        // 1970-01-01 was a Thursday.
        const dotw = (((days + 4) % 7) + 7) % 7;
        if (offset === RTC_RTC1) {
          return (
            ((year & RTC_0_YEAR_MASK) << RTC_0_YEAR_SHIFT) |
            ((month & RTC_0_MONTH_MASK) << RTC_0_MONTH_SHIFT) |
            ((day & RTC_0_DAY_MASK) << RTC_0_DAY_SHIFT)
          );
        }
        return (
          ((dotw & RTC_1_DOTW_MASK) << RTC_1_DOTW_SHIFT) |
          ((hour & RTC_1_HOUR_MASK) << RTC_1_HOUR_SHIFT) |
          ((minute & RTC_1_MIN_MASK) << RTC_1_MIN_SHIFT) |
          ((second & RTC_1_SEC_MASK) << RTC_1_SEC_SHIFT)
        );
      }
      default:
        break;
    }
    return super.readUint32(offset);
  }

  writeUint32(offset: number, value: number) {
    switch (offset) {
      case RTC_SETUP0:
        this.setup0 = value;
        break;
      case RTC_SETUP1:
        this.setup1 = value;
        break;
      case RTC_CTRL:
        // Though RTC_LOAD_BITS is type SC and should be cleared on next cycle, pico-sdk write
        // RTC_LOAD_BITS & RTC_ENABLE_BITS seperatly.
        // https://github.com/raspberrypi/pico-sdk/blob/master/src/rp2_common/hardware_rtc/rtc.c#L76-L80
        if (value & RTC_LOAD_BITS) {
          this.ctrl |= RTC_LOAD_BITS;
        }
        if (value & RTC_ENABLE_BITS) {
          this.ctrl |= RTC_ENABLE_BITS;
          this.ctrl |= RTC_ACTIVE_BITS;
          if (this.ctrl & RTC_LOAD_BITS) {
            const year = (this.setup0 >> SETUP_0_YEAR_SHIFT) & SETUP_0_YEAR_MASK;
            const month = (this.setup0 >> SETUP_0_MONTH_SHIFT) & SETUP_0_MONTH_MASK;
            const day = (this.setup0 >> SETUP_0_DAY_SHIFT) & SETUP_0_DAY_MASK;
            const hour = (this.setup1 >> SETUP_1_HOUR_SHIFT) & SETUP_1_HOUR_MASK;
            const min = (this.setup1 >> SETUP_1_MIN_SHIFT) & SETUP_1_MIN_MASK;
            const sec = (this.setup1 >> SETUP_1_SEC_SHIFT) & SETUP_1_SEC_MASK;
            this.baselineMs =
              civilDateToMillis(year, month, day) + ((hour * 60 + min) * 60 + sec) * 1000;
            this.baselineNanos = this.rpchip.clock.getNanos();
            this.ctrl &= ~RTC_LOAD_BITS;
          }
        } else {
          this.ctrl &= ~RTC_ENABLE_BITS;
          this.ctrl &= ~RTC_ACTIVE_BITS;
        }
        break;
      default:
        super.writeUint32(offset, value);
    }
  }

  transferState(s: SaveStateStream) {
    this.setup0 = s.i32(this.setup0);
    this.setup1 = s.i32(this.setup1);
    this.rtc1 = s.i32(this.rtc1);
    this.rtc0 = s.i32(this.rtc0);
    this.ctrl = s.i32(this.ctrl);
    this.baselineMs = s.f64(this.baselineMs);
    this.baselineNanos = s.f64(this.baselineNanos);
  }
}
