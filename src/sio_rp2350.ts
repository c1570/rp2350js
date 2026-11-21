import type { RP2350 } from './rp2350';
import { AlarmCallback, IAlarm } from './clock/clock';
import { RPSIOCore } from './sio-core';
import { FIFO } from './utils/fifo';
import { Float64, Uint32 } from './utils/types';

const CPUID = 0x000;

// RISC-V platform timer (mtime/mtimecmp), memory-mapped via SIO. mtime is
// shared between cores; mtimecmp/mtimecmph are core-local (RP2350 datasheet
// / hardware_regs/sio.h). The interrupt (SIO_IRQ_MTIMECMP) is asserted
// whenever mtime >= mtimecmp, and is what tud_task()'s scheduling loop (and
// other periodic bare-metal polling) relies on to wake from `wfi`.
const MTIME_CTRL = 0x1a4;
const MTIME = 0x1b0;
const MTIMEH = 0x1b4;
const MTIMECMP = 0x1b8;
const MTIMECMPH = 0x1bc;
const MTIME_CTRL_EN = 1 << 0;
const MTIME_CTRL_FULLSPEED = 1 << 1;
const MTIME_FREQUENCY = 1_000_000; // 1 MHz tick rate (functional approximation)
const MTIME_NANOS_PER_TICK: Float64 = 1e9 / MTIME_FREQUENCY;
const TWO32: Float64 = 0x100000000;
// Beyond this many ticks a compare value is unreachable in practice (and no longer exact as a double).
const MTIME_MAX_SCHEDULABLE_TICKS: Float64 = 9007199254740992; // 2**53

// GPIO
const GPIO_IN = 0x004; // Input value for GPIO pins
const GPIO_HI_IN = 0x008; // Input value for QSPI pins

const GPIO_OUT = 0x010; // GPIO output value
const GPIO_OUT_SET = 0x018; // GPIO output value set
const GPIO_OUT_CLR = 0x020; // GPIO output value clear
const GPIO_OUT_XOR = 0x028; // GPIO output value XOR
const GPIO_OE = 0x030; // GPIO output enable
const GPIO_OE_SET = 0x038; // GPIO output enable set
const GPIO_OE_CLR = 0x040; // GPIO output enable clear
const GPIO_OE_XOR = 0x048; // GPIO output enable XOR

const GPIO_HI_OUT = 0x014; // GPIO32..47, QSPI, USB output value
const GPIO_HI_OUT_SET = 0x01c; // GPIO32..47, QSPI, USB output value set
const GPIO_HI_OUT_CLR = 0x024; // GPIO32..47, QSPI, USB output value clear
const GPIO_HI_OUT_XOR = 0x02c; // GPIO32..47, QSPI, USB output value XOR
const GPIO_HI_OE = 0x034; // GPIO32..47, QSPI, USB output enable
const GPIO_HI_OE_SET = 0x03c; // GPIO32..47, QSPI, USB output enable set
const GPIO_HI_OE_CLR = 0x044; // GPIO32..47, QSPI, USB output enable clear
const GPIO_HI_OE_XOR = 0x04c; // GPIO32..47, QSPI, USB output enable XOR

const GPIO_MASK = 0x3fffffff;

//SPINLOCK
const SPINLOCK_ST = 0x5c;
const SPINLOCK0 = 0x100;
const SPINLOCK31 = 0x17c;

/** Fires the per-core mtimecmp interrupt; a dedicated class (rather than RP2350SIO
 * implementing AlarmCallback itself) since there are two per-core alarms. */
class MtimecmpAlarmCallback implements AlarmCallback {
  constructor(private readonly sio: RP2350SIO, private readonly core: number) {}

  fire() {
    this.sio.mtimecmpReached(this.core);
  }
}

export class RP2350SIO {
  gpioValue = 0;
  gpioOutputEnable = 0;
  gpioHiValue = 0;
  gpioHiOutputEnable = 0;
  spinLock = 0;
  readonly sioCore: [RPSIOCore, RPSIOCore];

  // mtime: shared free-running 64-bit counter, derived from the simulation clock:
  // mtime = mtimeBaseValue + whole ticks since mtimeBaseNanos (while enabled).
  // mtimecmp/mtimecmph are core-local per the datasheet.
  private mtimeBaseValue: Float64 = 0;
  private mtimeBaseNanos: Float64 = 0;
  private mtimeEnabled = true;
  // Length of one mtime tick, in nanoseconds: 1000 at 1 MHz, or 1e9/clkSys
  // when MTIME_CTRL.FULLSPEED runs the timer directly from the system clock.
  private mtimeNanosPerTick: Float64 = MTIME_NANOS_PER_TICK;
  private mtimeCtrl = 0x0000000d; // reset value: DBGPAUSE_CORE1/0=1, FULLSPEED=0, EN=1
  // Two fields rather than a tuple: cts2c cannot build an array literal of interface values.
  private readonly mtimecmpAlarm0: IAlarm;
  private readonly mtimecmpAlarm1: IAlarm;
  // Uint32 (not number): cts2c infers number[] as int32_t[], so a compare with
  // bit 31 set (or the 0xffffffff reset value) became negative in the C build
  // and made mtimecmp look already-reached — an MTIP interrupt storm.
  private readonly mtimecmpLow: [Uint32, Uint32] = [0xffffffff, 0xffffffff];
  // The datasheet resets mtimecmph to 0xffffffff too; 0 keeps lo-only writes working and
  // the compare value (0xffffffff ticks, ~71 minutes) is just as unreachable in practice.
  private readonly mtimecmpHigh: [Uint32, Uint32] = [0, 0];

  constructor(
    private readonly rpchip: RP2350,
    readonly sio_proc0_irq: number,
    readonly sio_proc1_irq: number,
    readonly sio_mtimecmp_irq: number = sio_proc0_irq
  ) {
    const rxFIFO = new FIFO(8);
    const txFIFO = new FIFO(8);
    this.sioCore = [
      new RPSIOCore(rpchip, rxFIFO, txFIFO, sio_proc0_irq, sio_proc1_irq, 0, 1),
      new RPSIOCore(rpchip, txFIFO, rxFIFO, sio_proc1_irq, sio_proc0_irq, 1, 0),
    ];

    this.mtimecmpAlarm0 = rpchip.clock.createAlarm(new MtimecmpAlarmCallback(this, 0));
    this.mtimecmpAlarm1 = rpchip.clock.createAlarm(new MtimecmpAlarmCallback(this, 1));
  }

  private mtimecmpAlarm(cpuCore: number): IAlarm {
    return cpuCore === 0 ? this.mtimecmpAlarm0 : this.mtimecmpAlarm1;
  }

  private mtimeNow(): Float64 {
    if (!this.mtimeEnabled) {
      return this.mtimeBaseValue;
    }
    const elapsed: Float64 = this.rpchip.clock.nanos - this.mtimeBaseNanos;
    return this.mtimeBaseValue + Math.floor(elapsed / this.mtimeNanosPerTick);
  }

  private setMtime(value: Float64) {
    this.mtimeBaseValue = value;
    this.mtimeBaseNanos = this.rpchip.clock.nanos;
    this.updateMtimecmp(0);
    this.updateMtimecmp(1);
  }

  private mtimecmpValue(cpuCore: number): Float64 {
    // The explicit >>> 0 keeps the halves unsigned even if a caller/transpile
    // path narrows them to int32_t.
    return (this.mtimecmpHigh[cpuCore] >>> 0) * TWO32 + (this.mtimecmpLow[cpuCore] >>> 0);
  }

  /** Alarm callback: mtime has reached this core's mtimecmp. */
  mtimecmpReached(cpuCore: number) {
    this.rpchip.setInterruptCore(this.sio_mtimecmp_irq, true, cpuCore);
    this.rpchip.core[cpuCore].setTimerInterrupt(true);
  }

  /** Re-evaluates the level-sensitive mtime >= mtimecmp condition for a core and
   * schedules the crossing. Called whenever mtime, mtimecmp or MTIME_CTRL change
   * (writing mtimecmp is how firmware acknowledges and reschedules the tick). */
  private updateMtimecmp(cpuCore: number) {
    const alarm = this.mtimecmpAlarm(cpuCore);
    alarm.cancel();
    const compare = this.mtimecmpValue(cpuCore);
    const reached = this.mtimeNow() >= compare;
    this.rpchip.setInterruptCore(this.sio_mtimecmp_irq, reached, cpuCore);
    this.rpchip.core[cpuCore].setTimerInterrupt(reached);
    if (
      !reached &&
      this.mtimeEnabled &&
      compare - this.mtimeBaseValue < MTIME_MAX_SCHEDULABLE_TICKS
    ) {
      const sinceBase: Float64 = this.rpchip.clock.nanos - this.mtimeBaseNanos;
      const delta: Float64 = (compare - this.mtimeBaseValue) * this.mtimeNanosPerTick - sinceBase;
      alarm.schedule(delta);
    }
  }

  readUint32(offset: number, cpuCore: number): number {
    if (offset >= SPINLOCK0 && offset <= SPINLOCK31) {
      const bitIndexMask = 1 << ((offset - SPINLOCK0) / 4);
      if (this.spinLock & bitIndexMask) {
        return 0;
      } else {
        this.spinLock |= bitIndexMask;
        return bitIndexMask;
      }
    }
    switch (offset) {
      case GPIO_IN:
        return this.rpchip.gpioValues(0);
      case GPIO_HI_IN: {
        // RP2350: QSPI pins at bits 31:26, GPIO32+ at bits 25:0.
        // QSPI_SCLK=bit31, QSPI_SS=bit27, QSPI_SD0=bit28, QSPI_SD1=bit29.
        const { qspi } = this.rpchip;
        let result = 0;
        for (let qspiIndex = 0; qspiIndex < qspi.length; qspiIndex++) {
          if (qspi[qspiIndex].inputValue) {
            result |= 1 << qspiIndex;
          }
        }
        result <<= 26;
        result |= this.rpchip.gpioValues(32);
        return result;
      }
      case GPIO_OUT:
        return this.gpioValue;
      case GPIO_OE:
        return this.gpioOutputEnable;
      case GPIO_HI_OUT:
        return this.gpioHiValue;
      case GPIO_HI_OE:
        return this.gpioHiOutputEnable;
      case GPIO_OUT_SET:
      case GPIO_OUT_CLR:
      case GPIO_OUT_XOR:
      case GPIO_OE_SET:
      case GPIO_OE_CLR:
      case GPIO_OE_XOR:
      case GPIO_HI_OUT_SET:
      case GPIO_HI_OUT_CLR:
      case GPIO_HI_OUT_XOR:
      case GPIO_HI_OE_SET:
      case GPIO_HI_OE_CLR:
      case GPIO_HI_OE_XOR:
        return 0; // TODO verify with silicone
      case CPUID:
        return cpuCore;
      case SPINLOCK_ST:
        return this.spinLock;
      case MTIME_CTRL:
        return this.mtimeCtrl;
      case MTIME:
        return Math.floor(this.mtimeNow()) % TWO32 >>> 0;
      case MTIMEH:
        return Math.floor(this.mtimeNow() / TWO32) >>> 0;
      case MTIMECMP:
        return this.mtimecmpLow[cpuCore];
      case MTIMECMPH:
        return this.mtimecmpHigh[cpuCore];
    }
    // Divider, Interpolator, FIFO get handled per core in sio-core
    return this.sioCore[cpuCore].readUint32(offset);
  }

  writeUint32(offset: number, value: number, cpuCore: number) {
    if (offset >= SPINLOCK0 && offset <= SPINLOCK31) {
      const bitIndexMask = ~(1 << ((offset - SPINLOCK0) / 4));
      this.spinLock &= bitIndexMask;
      return;
    }
    const prevGpioValue = this.gpioValue;
    const prevGpioOutputEnable = this.gpioOutputEnable;
    const prevGpioHiValue = this.gpioHiValue;
    const prevGpioHiOutputEnable = this.gpioHiOutputEnable;
    switch (offset) {
      case GPIO_OUT:
        this.gpioValue = value & GPIO_MASK;
        break;
      case GPIO_OUT_SET:
        this.gpioValue |= value & GPIO_MASK;
        break;
      case GPIO_OUT_CLR:
        this.gpioValue &= ~value;
        break;
      case GPIO_OUT_XOR:
        this.gpioValue ^= value & GPIO_MASK;
        break;
      case GPIO_OE:
        this.gpioOutputEnable = value & GPIO_MASK;
        break;
      case GPIO_OE_SET:
        this.gpioOutputEnable |= value & GPIO_MASK;
        break;
      case GPIO_OE_CLR:
        this.gpioOutputEnable &= ~value;
        break;
      case GPIO_OE_XOR:
        this.gpioOutputEnable ^= value & GPIO_MASK;
        break;
      case GPIO_HI_OUT:
        this.gpioHiValue = value & GPIO_MASK;
        break;
      case GPIO_HI_OUT_SET:
        this.gpioHiValue |= value & GPIO_MASK;
        break;
      case GPIO_HI_OUT_CLR:
        this.gpioHiValue &= ~value;
        break;
      case GPIO_HI_OUT_XOR:
        this.gpioHiValue ^= value & GPIO_MASK;
        break;
      case GPIO_HI_OE:
        this.gpioHiOutputEnable = value & GPIO_MASK;
        break;
      case GPIO_HI_OE_SET:
        this.gpioHiOutputEnable |= value & GPIO_MASK;
        break;
      case GPIO_HI_OE_CLR:
        this.gpioHiOutputEnable &= ~value;
        break;
      case GPIO_HI_OE_XOR:
        this.gpioHiOutputEnable ^= value & GPIO_MASK;
        break;
      case MTIME_CTRL: {
        const timingMask = MTIME_CTRL_EN | MTIME_CTRL_FULLSPEED;
        const timingChanged = (value & timingMask) !== (this.mtimeCtrl & timingMask);
        this.mtimeCtrl = value;
        // Redundant writes (or DBGPAUSE-only changes) must not cancel and
        // reschedule both mtimecmp alarms — some firmware does this in a loop.
        if (!timingChanged) {
          break;
        }
        const enable = !!(value & MTIME_CTRL_EN);
        // Rebase so the count is continuous across the enable change.
        this.mtimeBaseValue = this.mtimeNow();
        this.mtimeBaseNanos = this.rpchip.clock.nanos;
        this.mtimeEnabled = enable;
        // FULLSPEED runs mtime from the system clock instead of the 1 MHz
        // system-level timer tick. The rebase above captured the count at the
        // old rate, so changing the tick length here leaves mtime continuous.
        this.mtimeNanosPerTick =
          value & MTIME_CTRL_FULLSPEED ? 1e9 / this.rpchip.clkSys : MTIME_NANOS_PER_TICK;
        this.updateMtimecmp(0);
        this.updateMtimecmp(1);
        break;
      }
      case MTIME:
        this.setMtime(Math.floor(this.mtimeNow() / TWO32) * TWO32 + (value >>> 0));
        break;
      case MTIMEH:
        this.setMtime((value >>> 0) * TWO32 + (Math.floor(this.mtimeNow()) % TWO32));
        break;
      case MTIMECMPH:
        this.mtimecmpHigh[cpuCore] = value >>> 0;
        this.updateMtimecmp(cpuCore);
        break;
      case MTIMECMP:
        this.mtimecmpLow[cpuCore] = value >>> 0;
        this.updateMtimecmp(cpuCore);
        break;
      default:
        // Divider, Interpolator, FIFO get handled per core in sio-core
        this.sioCore[cpuCore].writeUint32(offset, value);
    }

    let pinsToUpdate =
      (this.gpioValue ^ prevGpioValue) | (this.gpioOutputEnable ^ prevGpioOutputEnable);
    const { gpio } = this.rpchip;
    if (pinsToUpdate) {
      for (let gpioIndex = 0; gpioIndex < 32; gpioIndex++) {
        if (pinsToUpdate & (1 << gpioIndex)) {
          gpio[gpioIndex].checkForUpdates();
        }
      }
    }

    pinsToUpdate =
      (this.gpioHiValue ^ prevGpioHiValue) | (this.gpioHiOutputEnable ^ prevGpioHiOutputEnable);
    if (pinsToUpdate) {
      for (let gpioIndex = 32; gpioIndex < gpio.length; gpioIndex++) {
        if (pinsToUpdate & (1 << (gpioIndex - 32))) {
          gpio[gpioIndex].checkForUpdates();
        }
      }
    }
    //TODO qspi pins
  }

  getPinValue(index: number) {
    if (index < 32) {
      return !!(this.gpioValue & (1 << index));
    } else if (index < 48) {
      return !!(this.gpioHiValue & (1 << (index - 32)));
    }
    //TODO qspi pins
    return false;
  }

  getOutputEnabled(index: number) {
    if (index < 32) {
      return !!(this.gpioOutputEnable & (1 << index));
    } else if (index < 48) {
      return !!(this.gpioHiOutputEnable & (1 << (index - 32)));
    }
    //TODO qspi pins
    return false;
  }
}
