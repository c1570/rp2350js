import { describe, expect, it } from 'vitest';
import { RP2040 } from '../rp2040';
import { RP2350 } from '../rp2350';

const MHz = 1_000_000;

// RP2040 register bases
const RP2040_CLOCKS_BASE = 0x40008000;
const RP2040_PLL_SYS_BASE = 0x40028000;
const RP2040_PLL_USB_BASE = 0x4002c000;
const RP2040_UART0_BASE = 0x40034000;

// RP2350 register bases
const RP2350_CLOCKS_BASE = 0x40010000;
const RP2350_PLL_SYS_BASE = 0x40050000;
const RP2350_PLL_USB_BASE = 0x40058000;
const RP2350_UART0_BASE = 0x40070000;

// CLOCKS register offsets. The GPOUT0-3, CLK_REF, CLK_SYS and CLK_PERI groups sit at
// the same offsets on both chips; the later groups differ (see the spec below).
const CLK_REF_CTRL = 0x30;
const CLK_REF_DIV = 0x34;
const CLK_SYS_CTRL = 0x3c;
const CLK_SYS_DIV = 0x40;
const CLK_PERI_CTRL = 0x48;
const CLK_PERI_DIV = 0x4c;

// PLL register offsets
const PLL_CS = 0x00;
const PLL_FBDIV_INT = 0x08;
const PLL_PRIM = 0x0c;

const UARTIBRD = 0x24;
const UARTFBRD = 0x28;

/** CLK_REF_CTRL.SRC = xosc_clksrc */
const CLK_REF_SRC_XOSC = 0x2;
/** CLK_SYS_CTRL.SRC = clksrc_clk_sys_aux */
const CLK_SYS_SRC_AUX = 0x1;
/** CLK_SYS_CTRL.AUXSRC = clksrc_pll_sys */
const CLK_SYS_AUXSRC_PLL_SYS = 0x0 << 5;
/** CLK_SYS_CTRL.AUXSRC = xosc_clksrc */
const CLK_SYS_AUXSRC_XOSC = 0x3 << 5;
/** CLK_SYS_CTRL.AUXSRC = clksrc_gpin0 */
const CLK_SYS_AUXSRC_GPIN0 = 0x4 << 5;
/** CLK_PERI_CTRL.ENABLE */
const CLK_PERI_ENABLE = 1 << 11;
/** CLK_PERI_CTRL.AUXSRC = clk_sys */
const CLK_PERI_AUXSRC_CLK_SYS = 0x0 << 5;
/** CLK_PERI_CTRL.AUXSRC = clksrc_pll_usb */
const CLK_PERI_AUXSRC_PLL_USB = 0x2 << 5;
/** RP2350 CLK_PERI_DIV.INT = 2 (bits 17:16; the RP2040 has no clk_peri divider) */
const RP2350_CLK_PERI_DIV_2 = 2 << 16;

interface PLLConfig {
  refdiv?: number;
  fbdiv?: number;
  postdiv1?: number;
  postdiv2?: number;
}

/** Configures a PLL the way pico-sdk's `pll_init()` does. */
function initPll(chip: RP2040 | RP2350, base: number, config: PLLConfig = {}) {
  const { refdiv = 1, fbdiv = 125, postdiv1 = 6, postdiv2 = 2 } = config;
  chip.writeUint32(base + PLL_CS, refdiv);
  chip.writeUint32(base + PLL_FBDIV_INT, fbdiv);
  chip.writeUint32(base + PLL_PRIM, (postdiv1 << 16) | (postdiv2 << 12));
}

/**
 * Configures PLL_SYS, then points clk_ref at the crystal and clk_sys at PLL_SYS, as
 * `clocks_init()` / `set_sys_clock_khz()` do.
 */
function setSysClock(
  chip: RP2040 | RP2350,
  clocksBase: number,
  pllBase: number,
  pllConfig: PLLConfig = {}
) {
  initPll(chip, pllBase, pllConfig);
  chip.writeUint32(clocksBase + CLK_REF_CTRL, CLK_REF_SRC_XOSC);
  chip.writeUint32(clocksBase + CLK_SYS_CTRL, CLK_SYS_SRC_AUX | CLK_SYS_AUXSRC_PLL_SYS);
}

describe('RPClocks (RP2040)', () => {
  it('should default to 125 MHz until the firmware configures the clock tree', () => {
    const rp2040 = new RP2040();
    expect(rp2040.clkSys).toEqual(125 * MHz);
  });

  it('should compute a 200 MHz clk_sys, the arduino-pico default for the Pico', () => {
    // VCO = 12 MHz / 1 * 100 = 1200 MHz, / (6 * 1) = 200 MHz
    const rp2040 = new RP2040();
    setSysClock(rp2040, RP2040_CLOCKS_BASE, RP2040_PLL_SYS_BASE, {
      fbdiv: 100,
      postdiv1: 6,
      postdiv2: 1,
    });
    expect(rp2040.clkSys).toEqual(200 * MHz);
  });

  it('should apply the CLK_SYS_DIV integer and fractional divisor', () => {
    const rp2040 = new RP2040();
    setSysClock(rp2040, RP2040_CLOCKS_BASE, RP2040_PLL_SYS_BASE);
    rp2040.writeUint32(RP2040_CLOCKS_BASE + CLK_SYS_DIV, (2 << 8) | 128); // divide by 2.5
    expect(rp2040.clkSys).toEqual(50 * MHz);
  });

  it('should treat a CLK_SYS_DIV integer part of 0 as a divide by 2^16', () => {
    const rp2040 = new RP2040();
    setSysClock(rp2040, RP2040_CLOCKS_BASE, RP2040_PLL_SYS_BASE);
    rp2040.writeUint32(RP2040_CLOCKS_BASE + CLK_SYS_DIV, 0);
    // clkSys is an int32 field (in the C build too), so the sub-Hz fraction drops.
    expect(rp2040.clkSys).toEqual(Math.trunc((125 * MHz) / 0x10000));
  });

  it('should run clk_sys straight off the crystal when AUXSRC selects xosc', () => {
    const rp2040 = new RP2040();
    rp2040.writeUint32(RP2040_CLOCKS_BASE + CLK_SYS_CTRL, CLK_SYS_SRC_AUX | CLK_SYS_AUXSRC_XOSC);
    expect(rp2040.clkSys).toEqual(12 * MHz);
  });

  it('should follow clk_ref when CLK_SYS_CTRL.SRC selects it', () => {
    const rp2040 = new RP2040();
    rp2040.writeUint32(RP2040_CLOCKS_BASE + CLK_REF_CTRL, CLK_REF_SRC_XOSC);
    rp2040.writeUint32(RP2040_CLOCKS_BASE + CLK_REF_DIV, 2 << 8);
    rp2040.writeUint32(RP2040_CLOCKS_BASE + CLK_SYS_CTRL, 0); // SRC = clk_ref
    expect(rp2040.clkSys).toEqual(6 * MHz);
  });

  it('should keep the last known good frequency for clock sources we do not model', () => {
    const rp2040 = new RP2040();
    setSysClock(rp2040, RP2040_CLOCKS_BASE, RP2040_PLL_SYS_BASE, {
      fbdiv: 100,
      postdiv1: 6,
      postdiv2: 1,
    });
    rp2040.writeUint32(RP2040_CLOCKS_BASE + CLK_SYS_CTRL, CLK_SYS_SRC_AUX | CLK_SYS_AUXSRC_GPIN0);
    expect(rp2040.clkSys).toEqual(200 * MHz);
  });

  it('should notify clock listeners when clk_sys changes', () => {
    const rp2040 = new RP2040();
    const calls: Array<[number, number]> = [];
    rp2040.addClockListener({
      onClockChange: (clkSys, oldClkSys) => calls.push([clkSys, oldClkSys]),
    });
    setSysClock(rp2040, RP2040_CLOCKS_BASE, RP2040_PLL_SYS_BASE, {
      fbdiv: 100,
      postdiv1: 6,
      postdiv2: 1,
    });
    expect(calls.at(-1)).toEqual([200 * MHz, 12 * MHz]);
  });

  it('should not notify clock listeners when clk_sys is unchanged', () => {
    const rp2040 = new RP2040();
    setSysClock(rp2040, RP2040_CLOCKS_BASE, RP2040_PLL_SYS_BASE, {
      fbdiv: 100,
      postdiv1: 6,
      postdiv2: 1,
    });
    let calls = 0;
    rp2040.addClockListener({ onClockChange: () => calls++ });
    // Re-selecting the same source leaves clk_sys at 200 MHz
    rp2040.writeUint32(RP2040_CLOCKS_BASE + CLK_SYS_CTRL, CLK_SYS_SRC_AUX | CLK_SYS_AUXSRC_PLL_SYS);
    expect(calls).toEqual(0);
  });

  it('should keep the last known good frequency while the clk_peri generator is stopped', () => {
    const rp2040 = new RP2040();
    initPll(rp2040, RP2040_PLL_USB_BASE, { fbdiv: 40, postdiv1: 5, postdiv2: 2 });
    rp2040.writeUint32(RP2040_CLOCKS_BASE + CLK_PERI_CTRL, CLK_PERI_AUXSRC_PLL_USB); // ENABLE clear
    expect(rp2040.clkPeri).toEqual(125 * MHz);
  });

  it('should retune systick and the PWM timers when clk_sys changes', () => {
    const rp2040 = new RP2040();
    setSysClock(rp2040, RP2040_CLOCKS_BASE, RP2040_PLL_SYS_BASE, {
      fbdiv: 100,
      postdiv1: 6,
      postdiv2: 1,
    });
    expect(rp2040.ppb.systickTimer.frequency).toEqual(200 * MHz);
    expect(rp2040.pwm.channels[0].timer.frequency).toEqual(200 * MHz);
  });
});

describe('RPClocks (RP2350)', () => {
  it('should default to 150 MHz until the firmware configures the clock tree', () => {
    const rp2350 = new RP2350();
    expect(rp2350.clkSys).toEqual(150 * MHz);
  });

  it('should compute a 150 MHz clk_sys, the RP2350 boot and pico-sdk default', () => {
    // VCO = 12 MHz / 1 * 125 = 1500 MHz, / (5 * 2) = 150 MHz
    const rp2350 = new RP2350();
    initPll(rp2350, RP2350_PLL_SYS_BASE, { fbdiv: 125, postdiv1: 5, postdiv2: 2 });
    rp2350.writeUint32(RP2350_CLOCKS_BASE + CLK_REF_CTRL, CLK_REF_SRC_XOSC);
    rp2350.writeUint32(RP2350_CLOCKS_BASE + CLK_SYS_CTRL, CLK_SYS_SRC_AUX | CLK_SYS_AUXSRC_PLL_SYS);
    expect(rp2350.clkSys).toEqual(150 * MHz);
  });

  it('should apply the RP2350 16.16 CLK_SYS_DIV integer and fractional divisor', () => {
    const rp2350 = new RP2350();
    initPll(rp2350, RP2350_PLL_SYS_BASE, { fbdiv: 125, postdiv1: 5, postdiv2: 2 });
    rp2350.writeUint32(RP2350_CLOCKS_BASE + CLK_REF_CTRL, CLK_REF_SRC_XOSC);
    rp2350.writeUint32(RP2350_CLOCKS_BASE + CLK_SYS_CTRL, CLK_SYS_SRC_AUX | CLK_SYS_AUXSRC_PLL_SYS);
    rp2350.writeUint32(RP2350_CLOCKS_BASE + CLK_SYS_DIV, (2 << 16) | 0x8000); // divide by 2.5
    expect(rp2350.clkSys).toEqual(60 * MHz);
  });

  it('should treat a CLK_SYS_DIV integer part of 0 as a divide by 2^16', () => {
    const rp2350 = new RP2350();
    initPll(rp2350, RP2350_PLL_SYS_BASE, { fbdiv: 125, postdiv1: 5, postdiv2: 2 });
    rp2350.writeUint32(RP2350_CLOCKS_BASE + CLK_REF_CTRL, CLK_REF_SRC_XOSC);
    rp2350.writeUint32(RP2350_CLOCKS_BASE + CLK_SYS_CTRL, CLK_SYS_SRC_AUX | CLK_SYS_AUXSRC_PLL_SYS);
    rp2350.writeUint32(RP2350_CLOCKS_BASE + CLK_SYS_DIV, 0);
    // clkSys is an int32 field (in the C build too), so the sub-Hz fraction drops.
    expect(rp2350.clkSys).toEqual(Math.trunc((150 * MHz) / 0x10000));
  });

  it('should run clk_sys straight off the crystal when AUXSRC selects xosc', () => {
    const rp2350 = new RP2350();
    rp2350.writeUint32(RP2350_CLOCKS_BASE + CLK_SYS_CTRL, CLK_SYS_SRC_AUX | CLK_SYS_AUXSRC_XOSC);
    expect(rp2350.clkSys).toEqual(12 * MHz);
  });

  it('should follow clk_ref when CLK_SYS_CTRL.SRC selects it, dividing per RP2350 CLK_REF_DIV', () => {
    const rp2350 = new RP2350();
    rp2350.writeUint32(RP2350_CLOCKS_BASE + CLK_REF_CTRL, CLK_REF_SRC_XOSC);
    rp2350.writeUint32(RP2350_CLOCKS_BASE + CLK_REF_DIV, 2 << 16); // RP2350 INT is bits 23:16
    rp2350.writeUint32(RP2350_CLOCKS_BASE + CLK_SYS_CTRL, 0); // SRC = clk_ref
    expect(rp2350.clkSys).toEqual(6 * MHz);
  });

  it('should keep the last known good frequency for clock sources we do not model', () => {
    const rp2350 = new RP2350();
    initPll(rp2350, RP2350_PLL_SYS_BASE, { fbdiv: 125, postdiv1: 5, postdiv2: 2 });
    rp2350.writeUint32(RP2350_CLOCKS_BASE + CLK_REF_CTRL, CLK_REF_SRC_XOSC);
    rp2350.writeUint32(RP2350_CLOCKS_BASE + CLK_SYS_CTRL, CLK_SYS_SRC_AUX | CLK_SYS_AUXSRC_PLL_SYS);
    rp2350.writeUint32(RP2350_CLOCKS_BASE + CLK_SYS_CTRL, CLK_SYS_SRC_AUX | CLK_SYS_AUXSRC_GPIN0);
    expect(rp2350.clkSys).toEqual(150 * MHz);
  });

  it('should retune the ARM cores’ systick timers when clk_sys changes', () => {
    const rp2350 = new RP2350({ coreArch: 'arm' });
    initPll(rp2350, RP2350_PLL_SYS_BASE, { fbdiv: 100, postdiv1: 6, postdiv2: 1 });
    rp2350.writeUint32(RP2350_CLOCKS_BASE + CLK_REF_CTRL, CLK_REF_SRC_XOSC);
    rp2350.writeUint32(RP2350_CLOCKS_BASE + CLK_SYS_CTRL, CLK_SYS_SRC_AUX | CLK_SYS_AUXSRC_PLL_SYS);
    expect(rp2350.clkSys).toEqual(200 * MHz);
    expect(rp2350.ppb!.coreState[0].systickTimer.frequency).toEqual(200 * MHz);
    expect(rp2350.ppb!.coreState[1].systickTimer.frequency).toEqual(200 * MHz);
    expect(rp2350.pwm.channels[0].timer.frequency).toEqual(200 * MHz);
  });

  it('should notify clock listeners when clk_sys changes', () => {
    const rp2350 = new RP2350();
    const calls: Array<[number, number]> = [];
    rp2350.addClockListener({
      onClockChange: (clkSys, oldClkSys) => calls.push([clkSys, oldClkSys]),
    });
    initPll(rp2350, RP2350_PLL_SYS_BASE, { fbdiv: 125, postdiv1: 5, postdiv2: 2 });
    rp2350.writeUint32(RP2350_CLOCKS_BASE + CLK_REF_CTRL, CLK_REF_SRC_XOSC);
    rp2350.writeUint32(RP2350_CLOCKS_BASE + CLK_SYS_CTRL, CLK_SYS_SRC_AUX | CLK_SYS_AUXSRC_PLL_SYS);
    expect(calls.at(-1)).toEqual([150 * MHz, 12 * MHz]);
  });

  it('should not notify clock listeners when clk_sys is unchanged', () => {
    const rp2350 = new RP2350();
    initPll(rp2350, RP2350_PLL_SYS_BASE, { fbdiv: 125, postdiv1: 5, postdiv2: 2 });
    rp2350.writeUint32(RP2350_CLOCKS_BASE + CLK_REF_CTRL, CLK_REF_SRC_XOSC);
    rp2350.writeUint32(RP2350_CLOCKS_BASE + CLK_SYS_CTRL, CLK_SYS_SRC_AUX | CLK_SYS_AUXSRC_PLL_SYS);
    let calls = 0;
    rp2350.addClockListener({ onClockChange: () => calls++ });
    // Re-selecting the same source leaves clk_sys at 150 MHz
    rp2350.writeUint32(RP2350_CLOCKS_BASE + CLK_SYS_CTRL, CLK_SYS_SRC_AUX | CLK_SYS_AUXSRC_PLL_SYS);
    expect(calls).toEqual(0);
  });
});

describe('RPClocks: clk_peri (RP2040)', () => {
  /** Configures PLL_USB the way pico-sdk's `clocks_init()` does: 12 / 1 * 40 / (5 * 2) = 48 MHz */
  function initPllUsb(rp2040: RP2040) {
    initPll(rp2040, RP2040_PLL_USB_BASE, { fbdiv: 40, postdiv1: 5, postdiv2: 2 });
  }

  it('should follow clk_sys when AUXSRC selects it', () => {
    const rp2040 = new RP2040();
    setSysClock(rp2040, RP2040_CLOCKS_BASE, RP2040_PLL_SYS_BASE, {
      fbdiv: 100,
      postdiv1: 6,
      postdiv2: 1,
    });
    rp2040.writeUint32(
      RP2040_CLOCKS_BASE + CLK_PERI_CTRL,
      CLK_PERI_ENABLE | CLK_PERI_AUXSRC_CLK_SYS
    );
    expect(rp2040.clkPeri).toEqual(200 * MHz);
  });

  it('should run at 48 MHz off the USB PLL, as arduino-pico does above 125 MHz', () => {
    const rp2040 = new RP2040();
    initPllUsb(rp2040);
    setSysClock(rp2040, RP2040_CLOCKS_BASE, RP2040_PLL_SYS_BASE, {
      fbdiv: 100,
      postdiv1: 6,
      postdiv2: 1,
    });
    rp2040.writeUint32(
      RP2040_CLOCKS_BASE + CLK_PERI_CTRL,
      CLK_PERI_ENABLE | CLK_PERI_AUXSRC_PLL_USB
    );
    expect(rp2040.clkPeri).toEqual(48 * MHz);
  });

  it('should keep the last known good frequency while the clock generator is stopped', () => {
    const rp2040 = new RP2040();
    initPllUsb(rp2040);
    rp2040.writeUint32(RP2040_CLOCKS_BASE + CLK_PERI_CTRL, CLK_PERI_AUXSRC_PLL_USB); // ENABLE clear
    expect(rp2040.clkPeri).toEqual(125 * MHz);
  });

  it('should re-notify the UART when clk_peri changes after the divider is set', () => {
    const rp2040 = new RP2040();
    initPllUsb(rp2040);
    // uart_init(uart0, 115200) against a 48 MHz clk_peri: 48e6 / (16 * 115200) = 26.0417
    rp2040.writeUint32(RP2040_UART0_BASE + UARTIBRD, 26);
    rp2040.writeUint32(RP2040_UART0_BASE + UARTFBRD, 3);
    const seen: number[] = [];
    rp2040.uart[0].onBaudRateChange = (baudRate) => seen.push(baudRate);
    rp2040.writeUint32(
      RP2040_CLOCKS_BASE + CLK_PERI_CTRL,
      CLK_PERI_ENABLE | CLK_PERI_AUXSRC_PLL_USB
    );
    expect(seen).toEqual([115177]); // 48e6 / (26.046875 * 16), rounded
  });

  it('should not notify a UART whose divider the firmware has not set yet', () => {
    const rp2040 = new RP2040();
    initPllUsb(rp2040);
    let calls = 0;
    rp2040.uart[0].onBaudRateChange = () => calls++;
    rp2040.writeUint32(
      RP2040_CLOCKS_BASE + CLK_PERI_CTRL,
      CLK_PERI_ENABLE | CLK_PERI_AUXSRC_PLL_USB
    );
    expect(calls).toEqual(0);
  });
});

describe('RPClocks: clk_peri (RP2350)', () => {
  /** Configures PLL_USB the way pico-sdk's `clocks_init()` does: 12 / 1 * 40 / (5 * 2) = 48 MHz */
  function initPllUsb(rp2350: RP2350) {
    initPll(rp2350, RP2350_PLL_USB_BASE, { fbdiv: 40, postdiv1: 5, postdiv2: 2 });
  }

  /** Configures PLL_SYS to the 150 MHz RP2350 boot default, as `clocks_init()` does. */
  function setSysClock150(rp2350: RP2350) {
    initPll(rp2350, RP2350_PLL_SYS_BASE, { fbdiv: 125, postdiv1: 5, postdiv2: 2 });
    rp2350.writeUint32(RP2350_CLOCKS_BASE + CLK_REF_CTRL, CLK_REF_SRC_XOSC);
    rp2350.writeUint32(RP2350_CLOCKS_BASE + CLK_SYS_CTRL, CLK_SYS_SRC_AUX | CLK_SYS_AUXSRC_PLL_SYS);
  }

  it('should follow clk_sys when AUXSRC selects it', () => {
    const rp2350 = new RP2350();
    setSysClock150(rp2350);
    rp2350.writeUint32(
      RP2350_CLOCKS_BASE + CLK_PERI_CTRL,
      CLK_PERI_ENABLE | CLK_PERI_AUXSRC_CLK_SYS
    );
    expect(rp2350.clkPeri).toEqual(150 * MHz);
  });

  it('should run at 48 MHz off the USB PLL', () => {
    const rp2350 = new RP2350();
    initPllUsb(rp2350);
    setSysClock150(rp2350);
    rp2350.writeUint32(
      RP2350_CLOCKS_BASE + CLK_PERI_CTRL,
      CLK_PERI_ENABLE | CLK_PERI_AUXSRC_PLL_USB
    );
    expect(rp2350.clkPeri).toEqual(48 * MHz);
  });

  it('should apply the RP2350 CLK_PERI_DIV integer divisor, which the RP2040 lacks', () => {
    const rp2350 = new RP2350();
    initPllUsb(rp2350);
    setSysClock150(rp2350);
    rp2350.writeUint32(
      RP2350_CLOCKS_BASE + CLK_PERI_CTRL,
      CLK_PERI_ENABLE | CLK_PERI_AUXSRC_PLL_USB
    );
    rp2350.writeUint32(RP2350_CLOCKS_BASE + CLK_PERI_DIV, RP2350_CLK_PERI_DIV_2); // divide by 2
    expect(rp2350.clkPeri).toEqual(24 * MHz);
  });

  it('should keep the last known good frequency while the clock generator is stopped', () => {
    const rp2350 = new RP2350();
    initPllUsb(rp2350);
    rp2350.writeUint32(RP2350_CLOCKS_BASE + CLK_PERI_CTRL, CLK_PERI_AUXSRC_PLL_USB); // ENABLE clear
    expect(rp2350.clkPeri).toEqual(150 * MHz);
  });

  it('should re-notify the UART when clk_peri changes after the divider is set', () => {
    const rp2350 = new RP2350();
    initPllUsb(rp2350);
    rp2350.writeUint32(RP2350_UART0_BASE + UARTIBRD, 26);
    rp2350.writeUint32(RP2350_UART0_BASE + UARTFBRD, 3);
    const seen: number[] = [];
    rp2350.uart[0].onBaudRateChange = (baudRate) => seen.push(baudRate);
    rp2350.writeUint32(
      RP2350_CLOCKS_BASE + CLK_PERI_CTRL,
      CLK_PERI_ENABLE | CLK_PERI_AUXSRC_PLL_USB
    );
    expect(seen).toEqual([115177]);
  });

  it('should not notify a UART whose divider the firmware has not set yet', () => {
    const rp2350 = new RP2350();
    initPllUsb(rp2350);
    let calls = 0;
    rp2350.uart[0].onBaudRateChange = () => calls++;
    rp2350.writeUint32(
      RP2350_CLOCKS_BASE + CLK_PERI_CTRL,
      CLK_PERI_ENABLE | CLK_PERI_AUXSRC_PLL_USB
    );
    expect(calls).toEqual(0);
  });
});
