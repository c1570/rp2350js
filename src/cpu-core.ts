/**
 * Shared execution/scheduling surface for the two CPU cores modelled in this
 * project: the RP2040's Cortex-M0 core (CortexM0Core) and the RP2350's
 * Hazard3 RISC-V core (CPU).
 *
 * This interface intentionally captures ONLY the execution/scheduling
 * boundary -- not the register model. The ARM r0-15/xPSR/M-system registers
 * and the RISC-V x0-31/CSR sets are genuinely irreconcilable and remain
 * per-architecture (each architecture needs its own target.xml). Consumers
 * that need the register model should be typed to the concrete core class.
 */
export interface ICpuCore {
  /** Core index (0/1); unifies coreNumber (ARM) and mhartid (RISC-V). */
  readonly coreIndex: number;
  /** Cycle counter; written by peripherals (e.g. sio-core divider penalty). */
  cycles: number;
  /** Program counter -- readable AND writable. */
  PC: number;
  /** True while parked in a WFI/WFE-style wait. */
  waiting: boolean;
  /** True when a WFE event has been latched but not yet consumed. */
  eventRegistered: boolean;
  /**
   * Set by interrupt sources (NVIC, SysTick, peripheral IRQs) when pending
   * state changes; consumed and cleared by the core's exception-arbitration
   * path on the next instruction. Both the RISC-V CPU and the ARM cores
   * (CortexM0Core, CortexM33Core) own this field.
   */
  interruptsUpdated: boolean;
  /** Sibling core, used for SEV (send-event) inter-core wakeup. */
  otherCore: ICpuCore;
  /** Advance the core by one instruction; returns the elapsed cycle count. */
  executeInstruction(): number;
  /** Reset the core to its post-boot state. */
  reset(): void;
  /** Send-event: wake the sibling if it's sleeping, else latch a pending event. */
  fireSEV(): void;
  /**
   * Assert or deassert a hardware interrupt on this core. Architecture-neutral:
   * ARM cores route into NVIC pending bits; RISC-V cores route into meifa/meipa.
   * Already implemented by CortexM0Core and the RISC-V CPU; formalized on the
   * interface so chip-level code (RP2350.setInterrupt) can call it uniformly.
   */
  setInterrupt(irq: number, value: boolean): void;
}
