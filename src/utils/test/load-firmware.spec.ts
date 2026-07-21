/**
 * Tests for the bootrom-based firmware loading path.
 *
 * Verifies that:
 *   - The RP2350 constructor auto-loads the bundled A2 bootrom.
 *   - The RP2040 constructor auto-loads the B1 bootrom.
 *   - RP2350.loadFirmware() drives the bootrom end-to-end:
 *       * For SRAM images, sets up the watchdog-scratch vectored-boot
 *         handshake so the bootrom scans SRAM for an IMAGE_DEF and extracts
 *         the real entry PC + SP from the picobin block items.
 *       * For flash images, lets the bootrom do its normal flash scan.
 *   - The bootrom's chosen entry matches the pico-sdk layout (e.g.
 *     0x20000222 = `_reset_handler` for current SRAM builds, not the
 *     historical hardcoded 0x20000220).
 *   - GPIO toggling works end-to-end through the bootrom for SRAM images.
 *   - Both RISC-V and ARM architectures support the bootrom-based path
 *     (ARM may need more emulator work for full firmware, but the load
 *     mechanism itself must not regress).
 *   - Vectored-boot scratch layout matches what `s_varm_api_reboot`
 *     in `vendor_docs/pico-bootrom-rp2350/src/main/arm/varm_apis.c` emits.
 */

import { describe, expect, test } from 'vitest';
import { RP2350 } from '../../rp2350';
import { RP2040 } from '../../rp2040';
import { GPIOPinState } from '../../gpio-pin';
import {
  setupVectoredRamBoot,
  loadFirmware,
  loadFirmwareFromHex,
  loadFirmwareFromUF2,
} from '../load-firmware';

// RISC-V reset vector (Hazard3 hardware reset, in bootrom space).
const RISCV_RESET_VECTOR = 0x7dfc;

// Watchdog scratch register addresses on RP2350 (WATCHDOG_BASE + 0x0c + i*4).
const WATCHDOG_SCRATCH = (i: number) => 0x400d800c + i * 4;

describe('bootrom auto-load', () => {
  test('RP2350 constructor auto-loads the bundled A2 bootrom', () => {
    const chip = new RP2350();
    // First bootrom word of the A2 image (little-endian read of bytes
    // 0x0,0x1,0x2,0x3). Sanity-check that *something* got loaded.
    const firstWord = chip.bootrom[0];
    expect(firstWord).not.toBe(0);
    // Bootrom is non-trivial in size — make sure it's actually populated.
    const nonZero = chip.bootrom.reduce((acc, w) => acc + (w !== 0 ? 1 : 0), 0);
    expect(nonZero).toBeGreaterThan(1000);
  });

  test('RP2040 constructor auto-loads the B1 bootrom', () => {
    const chip = new RP2040();
    const nonZero = chip.bootrom.reduce((acc, w) => acc + (w !== 0 ? 1 : 0), 0);
    expect(nonZero).toBeGreaterThan(500);
  });

  test('RP2350 core reset vector is in bootrom space after construction', () => {
    const chip = new RP2350();
    // RISC-V cores start at the fixed Hazard3 reset vector inside bootrom.
    expect(chip.core[0].PC).toBe(RISCV_RESET_VECTOR);
    expect(chip.core[1].PC).toBe(RISCV_RESET_VECTOR);
  });

  test('loadBootrom() still works as an override', () => {
    const chip = new RP2350();
    const fake = new Uint32Array(chip.bootrom.length);
    fake[0] = 0xdeadbeef;
    chip.loadBootrom(fake);
    expect(chip.bootrom[0]).toBe(0xdeadbeef);
  });
});

describe('setupVectoredRamBoot', () => {
  test('writes the vectored-boot handshake into watchdog scratch[2..7]', () => {
    const chip = new RP2350();
    setupVectoredRamBoot(chip, 0x20000000, 0x40000);
    // Layout produced by s_varm_api_reboot() for REBOOT_TYPE_RAM_IMAGE:
    //   scratch[2] = p0 = window_base
    //   scratch[3] = p1 = window_size
    //   scratch[4] = VECTORED_BOOT_MAGIC
    //   scratch[5] = REBOOT_TO_MAGIC_PC ^ -VECTORED_BOOT_MAGIC
    //   scratch[6] = BOOT_TYPE_RAM_IMAGE
    //   scratch[7] = REBOOT_TO_MAGIC_PC
    expect(chip.readUint32(WATCHDOG_SCRATCH(2))).toBe(0x20000000);
    expect(chip.readUint32(WATCHDOG_SCRATCH(3))).toBe(0x40000);
    expect(chip.readUint32(WATCHDOG_SCRATCH(4))).toBe(0xb007c0d3);
    // Validation check (see varm_boot_path.c:931-934):
    //   (pc_mod ^ -magic) == pc, with -magic = (-0xb007c0d3) >>> 0 = 0x4ff83f2d
    const pcMod = chip.readUint32(WATCHDOG_SCRATCH(5)) >>> 0;
    const pc = chip.readUint32(WATCHDOG_SCRATCH(7)) >>> 0;
    const negMagic = -0xb007c0d3 >>> 0;
    expect((pcMod ^ negMagic) >>> 0).toBe(pc);
    expect(chip.readUint32(WATCHDOG_SCRATCH(6))).toBe(0x3); // BOOT_TYPE_RAM_IMAGE
    expect(pc).toBe(0xb007c0d3); // REBOOT_TO_MAGIC_PC == VECTORED_BOOT_MAGIC
  });

  test('is a no-op for non-RP2350 chips', () => {
    // RP2040 has no vectored-boot mechanism; setupVectoredRamBoot should
    // bail out before touching anything. We verify by checking that the
    // helper returned without writing the magic to RP2040's watchdog
    // scratch[4] (the validation check the helper would have performed
    // first on an RP2350).
    const chip = new RP2040();
    const before = chip.readUint32(0x4000401c); // RP2040 WATCHDOG SCRATCH4
    setupVectoredRamBoot(chip as any, 0x20000000, 0x40000);
    const after = chip.readUint32(0x4000401c);
    expect(after).toBe(before); // unchanged
  });
});

describe('loadFirmwareFromHex / loadFirmwareFromUF2', () => {
  test('inspectHex detects SRAM target from extended-linear-address records', () => {
    const chip = new RP2350();
    const result = loadFirmwareFromHex(
      chip,
      // Minimal Intel HEX with one data byte at 0x20000000.
      ':020000042000DA\n' + ':0100000000FF\n' + ':00000001FF\n'
    );
    expect(result.useSram).toBe(true);
    expect(result.loadBase).toBe(0x20000000);
  });

  test('inspectHex detects flash target', () => {
    const chip = new RP2350();
    const result = loadFirmwareFromHex(
      chip,
      ':020000041000EA\n' + ':0100000000FF\n' + ':00000001FF\n'
    );
    expect(result.useSram).toBe(false);
    expect(result.loadBase).toBe(0x10000000);
  });

  test('writes payload bytes to the correct region', () => {
    const chip = new RP2350();
    loadFirmwareFromHex(chip, ':020000042000DA\n' + ':040000001122334455\n' + ':00000001FF\n');
    expect(chip.sram[0]).toBe(0x11);
    expect(chip.sram[1]).toBe(0x22);
    expect(chip.sram[2]).toBe(0x33);
    expect(chip.sram[3]).toBe(0x44);
  });

  test('UF2 detection picks SRAM vs flash from the first block', () => {
    const chip = new RP2350();
    const result = loadFirmwareFromUF2(chip, 'demo/riscv_blink/blink_simple.uf2');
    expect(result.useSram).toBe(true);
    expect(result.loadBase).toBe(0x20000000);
  });
});

describe('RP2350.loadFirmware end-to-end (RISC-V)', () => {
  test('boots SRAM image via vectored-boot handoff, reaches firmware entry', () => {
    const chip = new RP2350();
    chip.loadFirmware('demo/riscv_blink/blink_simple.hex');
    // Run enough steps for the bootrom to scan, validate, and launch.
    let firstFwStep = -1;
    let firstFwPc = -1;
    for (let i = 0; i < 200_000; i++) {
      chip.step();
      const pc = chip.core[0].PC;
      if (pc >= 0x20000000 && pc < 0x20040000) {
        if (firstFwStep < 0) {
          firstFwStep = i;
          firstFwPc = pc;
        }
        break;
      }
    }
    expect(firstFwStep).toBeGreaterThan(0);
    // The bootrom-extracted entry for current pico-sdk builds is
    // 0x20000222 (_reset_handler, just past the embedded block).
    expect(firstFwPc).toBe(0x20000222);
  });

  test('vectored-boot scratch is set after loadFirmware for SRAM image', () => {
    const chip = new RP2350();
    chip.loadFirmware('demo/riscv_blink/blink_simple.hex');
    expect(chip.readUint32(WATCHDOG_SCRATCH(4))).toBe(0xb007c0d3); // magic
    expect(chip.readUint32(WATCHDOG_SCRATCH(2))).toBe(0x20000000); // window_base
  });

  test('vectored-boot scratch is NOT set for flash image (normal flash scan)', () => {
    const chip = new RP2350();
    chip.loadFirmware('demo/riscv_timer/hello_timer.hex');
    // No vectored-boot magic.
    expect(chip.readUint32(WATCHDOG_SCRATCH(4))).toBe(0);
  });

  test('SRAM blink firmware toggles GPIO through bootrom path', () => {
    const chip = new RP2350();
    chip.loadFirmware('demo/riscv_blink/blink_simple.hex');
    let toggles = 0;
    chip.gpio[2].addListener((s: GPIOPinState, o: GPIOPinState) => {
      if (s === 1 && o === 0) toggles++;
    });
    for (let i = 0; i < 1_000_000 && toggles === 0; i++) chip.step();
    expect(toggles).toBeGreaterThan(0);
  });

  test('flash firmware reaches flash entry through bootrom flash scan', () => {
    const chip = new RP2350();
    chip.loadFirmware('demo/riscv_timer/hello_timer.hex');
    let firstFlash = -1;
    for (let i = 0; i < 500_000; i++) {
      chip.step();
      const pc = chip.core[0].PC;
      if (pc >= 0x10000036 && pc < 0x10400000) {
        firstFlash = i;
        break;
      }
    }
    expect(firstFlash).toBeGreaterThan(0);
  });

  test('PIO blink firmware boots and configures PIO via bootrom path', () => {
    const chip = new RP2350();
    chip.loadFirmware('demo/riscv_pio_blink/pio_blink.hex');
    let gpio3Toggles = 0;
    chip.gpio[3].addListener((s: GPIOPinState, o: GPIOPinState) => {
      if (s === 1 && o === 0) gpio3Toggles++;
    });
    for (let i = 0; i < 2_000_000 && gpio3Toggles === 0; i++) chip.step();
    expect(gpio3Toggles).toBeGreaterThan(0);
  });
});

describe('RP2350.loadFirmware end-to-end (ARM)', () => {
  test('ARM chip loads flash firmware without error', () => {
    // blink_simple is a flash image built for the RP2350 ARM M33 core
    // (PICO_PLATFORM=rp2350-arm-s). The loadFirmware mechanism itself must
    // not regress. Verify the load completes. It's a flash image
    // (use_sram=false), so no vectored-boot scratch setup.
    const chip = new RP2350(false, undefined, { coreArch: 'arm' });
    const result = chip.loadFirmware('demo/m33_blink/blink_simple.uf2');
    expect(result.useSram).toBe(false);
    // No vectored-boot magic for flash images.
    expect(chip.readUint32(WATCHDOG_SCRATCH(4))).toBe(0);
    // ARM core should be at its reset vector (in bootrom space).
    expect(chip.core[0].PC).toBeLessThan(0x10000);
  });

  test('ARM flash firmware reaches flash entry through bootrom flash scan', () => {
    // The bootrom flash scan should hand off to the firmware's
    // _reset_handler (0x1000015a for this build of blink_simple).
    const chip = new RP2350(false, undefined, { coreArch: 'arm' });
    chip.loadFirmware('demo/m33_blink/blink_simple.hex');
    let firstFlash = -1;
    for (let i = 0; i < 500_000; i++) {
      chip.step();
      const pc = chip.core[0].PC;
      if (pc >= 0x1000015a && pc < 0x10000200) {
        firstFlash = i;
        break;
      }
    }
    expect(firstFlash).toBeGreaterThan(0);
  });
});

describe('loadFirmware helper (top-level)', () => {
  test('delegates to UF2 path for .uf2 files', () => {
    const chip = new RP2350();
    const result = loadFirmware(chip, 'demo/riscv_blink/blink_simple.uf2');
    expect(result.format).toBe('uf2');
    expect(result.useSram).toBe(true);
  });

  test('delegates to HEX path for .hex files', () => {
    const chip = new RP2350();
    const result = loadFirmware(chip, 'demo/riscv_blink/blink_simple.hex');
    expect(result.format).toBe('hex');
    expect(result.useSram).toBe(true);
  });

  test('initChip=false writes payload but leaves cores untouched', () => {
    const chip = new RP2350();
    const pcBefore = chip.core[0].PC;
    const result = loadFirmware(chip, 'demo/riscv_blink/blink_simple.hex', {
      initChip: false,
    });
    expect(result.useSram).toBe(true);
    // Payload should be written to SRAM.
    expect(chip.sram[0]).not.toBe(0xff);
    // Cores should NOT have been reset (PC unchanged).
    expect(chip.core[0].PC).toBe(pcBefore);
    // Vectored-boot scratch should NOT have been written.
    expect(chip.readUint32(WATCHDOG_SCRATCH(4))).toBe(0);
  });

  test('entryPc bypasses bootrom handoff and sets PC directly', () => {
    const chip = new RP2350();
    loadFirmware(chip, 'demo/riscv_blink/blink_simple.hex', {
      entryPc: 0x20000abc,
    });
    // Both cores should be at the explicit entry PC.
    expect(chip.core[0].PC).toBe(0x20000abc);
    expect(chip.core[1].PC).toBe(0x20000abc);
    // Vectored-boot scratch should NOT have been written (entry override
    // skips the bootrom handoff entirely).
    expect(chip.readUint32(WATCHDOG_SCRATCH(4))).toBe(0);
  });

  test('entryPc works for flash images too', () => {
    const chip = new RP2350();
    loadFirmware(chip, 'demo/riscv_timer/hello_timer.hex', {
      entryPc: 0x10000100,
    });
    expect(chip.core[0].PC).toBe(0x10000100);
  });

  test('default (initChip=true, no entryPc) sets up vectored boot for SRAM', () => {
    const chip = new RP2350();
    loadFirmware(chip, 'demo/riscv_blink/blink_simple.hex');
    expect(chip.readUint32(WATCHDOG_SCRATCH(4))).toBe(0xb007c0d3);
  });
});
