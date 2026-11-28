import { GPIOPin } from './gpio-pin';
import { IClock } from './clock/clock';
import { ICpuCore } from './cpu-core';
import { Float64 } from './utils/types';
import { Logger } from './utils/logging';
import { RPPIO } from './peripherals/pio';

/**
 * Notified after clk_sys changes. Listeners that cache a frequency derived from
 * clk_sys (PIO clock dividers, for instance) use this to re-derive it.
 *
 * An interface (not `() => void`) because cts2c targets C: like AlarmCallback, it
 * transpiles to vtable dispatch, where a bare function type would degrade to void*.
 * There is no unsubscribe — see `addClockListener` on the chip classes.
 */
export interface ClockListener {
  onClockChange(clkSys: number, oldClkSys: number): void;
}

export interface IRPChip {
  readonly identifier: string; // "rp2040" or "rp2350"

  logger: Logger;
  loadBootrom(bootromData: Uint32Array): void;
  readonly disassembly: string;
  loadDisassembly(dis: string): void;
  onTrace(coreNumber: number, pc: number, tag: string): void;

  /** CPU cores; core[0] == core0, core[1] == core1. */
  readonly core: ICpuCore[];
  /** Index (0/1) of the core currently executing — selects SIO/PPB core view. */
  currentCore: number;

  readonly qspi: Array<GPIOPin>;
  readonly gpio: Array<GPIOPin>;
  gpioValues(start_index: number): number;
  gpioRawOutputValue(index: number): boolean;
  gpioRawOutputEnable(index: number): boolean;
  gpioInputValueHasBeenSet(index: number): void;
  /** Called when a PIO state machine is enabled or disabled. */
  updatePioActiveLists(): void;

  readonly pio: Array<RPPIO>;

  readonly flash: Uint8Array;
  readonly sram: Uint8Array;

  /**
   * Drop cached instruction decodes covering a flash byte range (offsets
   * into {@link flash}). RP2350 implements it (fetch-decode cache); RP2040
   * has no decode cache and implements it as a no-op.
   */
  invalidateFlashDecode(address: number, len: number): void;

  readonly usbDPRAM: Uint8Array;
  readonly usbDPRAMView: DataView;

  readonly cycles: number;
  readonly clkSys: number;
  readonly clkPeri: number;

  /** Crystal oscillator frequency, in Hz. 12 MHz on the Raspberry Pi Pico boards. */
  xoscFreq: number;
  /** Ring oscillator frequency, in Hz. Varies with voltage/temperature on real silicon. */
  roscFreq: number;

  /** PLL_SYS output frequency, in Hz, derived from its divider registers. */
  getPllSysFrequency(): Float64;
  /** PLL_USB output frequency, in Hz, derived from its divider registers. */
  getPllUsbFrequency(): Float64;

  /**
   * Recomputes `clkSys` and `clkPeri` from the PLL and CLOCKS registers and updates the
   * peripherals derived from them. Until firmware configures the clock tree, each keeps
   * its default. Called by the PLL and CLOCKS peripherals when their registers change.
   */
  updateClocks(): void;

  readUint32(address: number): number;
  readUint16(address: number): number;
  readUint8(address: number): number;
  writeUint32(address: number, value: number): void;
  writeUint8(address: number, value: number): void;
  writeUint16(address: number, value: number): void;

  dma_clearDREQ(dreq: number): void;
  dma_setDREQ(dreq: number): void;
  clock: IClock;

  reset(): void;
  setInterrupt(irq: number, value: boolean): void;
  setInterruptCore(irq: number, value: boolean, core: number): void;
  updateIOInterrupt(): void;

  stepCores(): void;
  stepThings(cycles: number): void;
  step(): void;

  /** Portability limits of the save state, as SERIALIZATION_QUIRK_* flags. */
  getSerializationQuirks(): number;
  /**
   * Upper bound on the state size in bytes for the given SAVE_STATE_OMIT_* bits. Never
   * larger than an earlier value for the same bits, so a buffer can be allocated once.
   * A state usually needs less; its header records the exact size, which
   * readSaveStateHeader() reads back.
   */
  serializeSize(omit?: number): number;
  /**
   * Writes the state to `data`. `size` must be the buffer's real length, which is not
   * recoverable in C. Returns false if the buffer is too small, in which case `data` is
   * left unusable as a state: unserialize() rejects it rather than restoring a torn one.
   *
   * `omit` (SAVE_STATE_OMIT_*) leaves the flash or PSRAM image out of the state, for a
   * caller who knows nothing will write it. The chip leaves both out on its own until
   * something first writes them: before that they are the firmware image, 24 MiB that
   * cannot have changed. unserialize() keeps an omitted image as it finds it, and
   * refuses the state if the image has been written since the snapshot.
   */
  serialize(data: Uint8Array, size: number, omit?: number): boolean;
  /**
   * Restores a state written by serialize(). Returns false, without touching the chip,
   * if the state's header does not match this chip. Covers the chip only: anything the
   * host attached (callbacks, alarms created on chip.clock) is not saved, and a pending
   * host alarm is cancelled rather than restored. A plain-number register comes back
   * in its int32 form: the same 32 bits, which every use treats as a bit pattern.
   */
  unserialize(data: Uint8Array, size: number): boolean;
}
