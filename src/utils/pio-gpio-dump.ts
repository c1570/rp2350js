/**
 * Shared PIO/GPIO dump formatters.
 *
 * Used by three transports that previously each had their own (drifting)
 * copy of the same code:
 *   - `src/utils/emulator-controller.ts` (rp2_emu CLI + MCP shim)
 *   - `src/gdb/riscv-gdb-server.ts`      (`monitor pio` / `monitor gpio`)
 *   - `src/gdb/arm-gdb-server.ts`        (`monitor pio` / `monitor gpio`)
 *
 * Per-PIO `gpiobase`, SM pin routing (in/out/set/sideset/jmp base, with
 * absolute chip-pin numbers, counts, wrap), and shift direction (left/right)
 * are included on every SM line so all transports see the same rich view.
 */

import { IRPChip } from '../rpchip';

const GPIO_FUNC_NAMES = [
  'SPI',
  'UART',
  'I2C',
  'XIP',
  'PWM',
  'SIO',
  'PIO0',
  'PIO1',
  'PIO2',
  'CLK',
  'USB',
];

function gpioFuncName(f: number): string {
  return GPIO_FUNC_NAMES[f] ?? `FUNC${f}`;
}

/**
 * Format PIO state (all instances, or just one if `instance` is a valid index)
 * as a human-readable multi-line string (no trailing newline).
 *
 * Pass `instance = undefined` (or any out-of-range value) to dump all
 * instances. A valid index dumps only that one.
 */
export function formatPioDump(chip: IRPChip, instance?: number): string {
  const pios = chip.pio;
  const lines: string[] = [];
  const indices =
    instance != null && instance >= 0 && instance < pios.length
      ? [instance]
      : pios.map((_, i) => i);

  for (const i of indices) {
    const pio = pios[i];
    const gb = pio.gpiobase;
    lines.push(`=== PIO${i} (gpiobase=${gb}) ===`);
    // Absolute pin helper: a PIO-relative pin gets the chip pin number.
    const abs = (rel: number) => `GP${rel + gb}`;
    for (let sm = 0; sm < pio.machines.length; sm++) {
      const m = pio.machines[sm];
      lines.push(
        `  SM${sm}: pc=${m.pc} x=0x${(m.x >>> 0).toString(16)} y=0x${(m.y >>> 0).toString(16)}` +
          ` enabled=${m.enabled ? 1 : 0} waiting=${m.waiting ? 1 : 0}` +
          ` tx=${m.txFIFO.itemCount}/${m.txFIFO.size} rx=${m.rxFIFO.itemCount}/${m.rxFIFO.size}` +
          ` instr=0x${(pio.instructions[m.pc] >>> 0).toString(16).padStart(8, '0')}`
      );
      lines.push(
        `    ISR=0x${(m.inputShiftReg >>> 0).toString(16).padStart(8, '0')} (${(
          m.inputShiftReg >>> 0
        )
          .toString(2)
          .padStart(32, '0')}) ${m.inputShiftCount}/${m.pushThreshold} bits` +
          (m.shiftCtrl & (1 << 16) ? ' autopush' : '') +
          ` shift=${m.shiftCtrl & (1 << 18) ? 'right' : 'left'}`
      );
      lines.push(
        `    OSR=0x${(m.outputShiftReg >>> 0).toString(16).padStart(8, '0')} (${(
          m.outputShiftReg >>> 0
        )
          .toString(2)
          .padStart(32, '0')}) ${m.outputShiftCount}/${m.pullThreshold} bits` +
          (m.shiftCtrl & (1 << 17) ? ' autopull' : '') +
          ` shift=${m.shiftCtrl & (1 << 19) ? 'right' : 'left'}`
      );
      // Pin routing & control: relative pin from PINCTRL/EXECCTRL, absolute
      // chip pin in parens (relative + gpiobase).
      lines.push(
        `    pins: in_base=${m.inBase}(${abs(m.inBase)})` +
          ` out_base=${m.outBase}(${abs(m.outBase)})` +
          ` set_base=${m.setBase}(${abs(m.setBase)})` +
          ` sideset_base=${m.sidesetBase}(${abs(m.sidesetBase)})` +
          ` jmp_pin=${m.jmpPin}(${abs(m.jmpPin)})` +
          ` out_count=${m.outCount} set_count=${m.setCount} sideset_count=${m.sidesetCount}` +
          ` wrap=${m.wrapBottom}-${m.wrapTop}`
      );
    }
  }
  return lines.join('\n');
}

/**
 * Format GPIO pin state (function, in/out/oe/irq, pullups/pulldowns, plus
 * a binary summary of all input and output values) as a human-readable
 * multi-line string (no trailing newline).
 */
export function formatGpioDump(chip: IRPChip): string {
  const pins = chip.gpio;
  const n = pins.length;
  const lines: string[] = [`=== GPIO (${n} pins) ===`];
  for (let i = 0; i < n; i++) {
    const p = pins[i];
    lines.push(
      `  GP${i.toString().padStart(2)} ${gpioFuncName(p.functionSelect).padEnd(5)}` +
        ` in=${p.inputValue ? 1 : 0} out=${p.outputValue ? 1 : 0} oe=${p.outputEnable ? 1 : 0}` +
        ` irq=${p.irqValue ? 1 : 0} pu=${p.pullupEnabled ? 1 : 0} pd=${p.pulldownEnabled ? 1 : 0}`
    );
  }
  // Summary: input/output bitmasks as a binary string, MSB = highest pin.
  let inBits = '';
  let outBits = '';
  for (let i = 0; i < n; i++) {
    inBits = (pins[i].inputValue ? '1' : '0') + inBits;
    outBits = (pins[i].outputValue ? '1' : '0') + outBits;
  }
  lines.push(`  inputs:  ${inBits}`);
  lines.push(`  outputs: ${outBits}`);
  return lines.join('\n');
}
