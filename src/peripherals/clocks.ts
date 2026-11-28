import { IRPChip } from '../rpchip';
import { Float64 } from '../utils/types';
import { BasePeripheral, Peripheral } from './peripheral';
import { SaveStateStream } from '../utils/save-state';

// Register offsets shared by both chips. The GPOUT0-3, CLK_REF, CLK_SYS and CLK_PERI
// groups sit at the same addresses on the RP2040 and the RP2350; the later groups
// (USB/ADC/RTC-vs-HSTX/RESUS/FC0) move around, and get per-chip offsets below.
const CLK_GPOUT0_CTRL = 0x00;
const CLK_GPOUT0_DIV = 0x04;
const CLK_GPOUT0_SELECTED = 0x8;
const CLK_GPOUT1_CTRL = 0x0c;
const CLK_GPOUT1_DIV = 0x10;
const CLK_GPOUT1_SELECTED = 0x14;
const CLK_GPOUT2_CTRL = 0x18;
const CLK_GPOUT2_DIV = 0x01c;
const CLK_GPOUT2_SELECTED = 0x20;
const CLK_GPOUT3_CTRL = 0x24;
const CLK_GPOUT3_DIV = 0x28;
const CLK_GPOUT3_SELECTED = 0x2c;
const CLK_REF_CTRL = 0x30;
const CLK_REF_DIV = 0x34;
const CLK_REF_SELECTED = 0x38;
const CLK_SYS_CTRL = 0x3c;
const CLK_SYS_DIV = 0x40;
const CLK_SYS_SELECTED = 0x44;
const CLK_PERI_CTRL = 0x48;
const CLK_PERI_DIV = 0x4c;
const CLK_PERI_SELECTED = 0x50;

// CLK_REF_CTRL: SRC is the same on both chips (rosc/aux/xosc, +lposc on RP2350,
// which we do not model); AUXSRC uses the same encoding (pll_usb/gpin0/gpin1, and
// on the RP2350 pll_usb_primary_ref_opcg, which we also do not model).
const CLK_REF_CTRL_SRC_MASK = 0x3;
const CLK_REF_CTRL_SRC_ROSC = 0x0;
const CLK_REF_CTRL_SRC_AUX = 0x1;
const CLK_REF_CTRL_SRC_XOSC = 0x2;
const CLK_REF_CTRL_AUXSRC_SHIFT = 5;
const CLK_REF_CTRL_AUXSRC_MASK = 0x3;
const CLK_REF_CTRL_AUXSRC_PLL_USB = 0x0;

// CLK_SYS_CTRL (identical on both chips)
const CLK_SYS_CTRL_SRC_MASK = 0x1;
const CLK_SYS_CTRL_SRC_REF = 0x0;
const CLK_SYS_CTRL_AUXSRC_SHIFT = 5;
const CLK_SYS_CTRL_AUXSRC_MASK = 0x7;
const CLK_SYS_CTRL_AUXSRC_PLL_SYS = 0x0;
const CLK_SYS_CTRL_AUXSRC_PLL_USB = 0x1;
const CLK_SYS_CTRL_AUXSRC_ROSC = 0x2;
const CLK_SYS_CTRL_AUXSRC_XOSC = 0x3;

/**
 * RP2040/RP2350 CLOCKS peripheral.
 *
 * Registers that only latch a value (GPOUT, USB, ADC and the RP2040 RTC / RP2350 HSTX
 * clock groups) are stored for read-back; the clk_ref and clk_sys generators are
 * actually derived, so `clkSys` follows `set_sys_clock_khz()` and friends:
 *
 *   clk_ref = src / REF_DIV.INT      (src = rosc, xosc, or aux: pll_usb)
 *   clk_sys = clk_ref / CLK_SYS_DIV  (or an aux source: pll_sys, pll_usb, rosc, xosc)
 *
 * Per-chip differences live in the readonly layout fields set by the constructor: the
 * later register groups move, the CLK_REF_DIV INT field widens from 2 to 8 bits, and
 * the general clock dividers go from 24.8 fixed point (RP2040) to 16.16 (RP2350).
 */
export class RPClocks<ChipType extends IRPChip = IRPChip>
  extends BasePeripheral<ChipType>
  implements Peripheral
{
  gpout0Ctrl = 0;
  gpout0Div = 0;
  gpout1Ctrl = 0;
  gpout1Div = 0;
  gpout2Ctrl = 0;
  gpout2Div = 0;
  gpout3Ctrl = 0;
  gpout3Div = 0;
  refCtrl = 0;
  refDiv = 0;
  sysCtrl = 0;
  sysDiv = 0;
  periCtrl = 0;
  periDiv = 0;
  usbCtrl = 0;
  usbDiv = 0;
  adcCtrl = 0;
  adcDiv = 0;
  // Fourth general-purpose clock group: RTC on the RP2040, HSTX on the RP2350.
  rtcCtrl = 0;
  rtcDiv = 0;
  // Fixed by the chip type; readonly so the save-state coverage test can tell.
  readonly clkFc0StatusOffset: number = 0;
  /** Offset of CLK_USB_CTRL (USB clock group: ctrl/div/selected at +0/+4/+8). */
  readonly clkUsbCtrlOffset: number = 0;
  /** Offset of CLK_ADC_CTRL (ADC clock group: ctrl/div/selected at +0/+4/+8). */
  readonly clkAdcCtrlOffset: number = 0;
  /** Offset of CLK_RTC_CTRL (RP2040) / CLK_HSTX_CTRL (RP2350), ctrl/div/selected. */
  readonly clkRtcCtrlOffset: number = 0;
  /** Offset of CLK_SYS_RESUS_CTRL; status follows at +4. */
  readonly clkResusCtrlOffset: number = 0;
  /** CLK_REF_DIV.INT shift: bits 9:8 on the RP2040, bits 23:16 on the RP2350. */
  readonly refDivIntShift: number = 0;
  /** CLK_REF_DIV.INT field mask. */
  readonly refDivIntMask: number = 0;
  /** CLK_x_DIV fixed-point split: INT is bits 31:8 on the RP2040, bits 31:16 on the RP2350. */
  readonly clkDivIntShift: number = 0;
  /** CLK_x_DIV fractional field mask: 0xff (24.8) on the RP2040, 0xffff (16.16) on the RP2350. */
  readonly clkDivFracMask: number = 0;
  /** Whether clk_peri has a divider (CLK_PERI_DIV): RP2350 yes, RP2040 no. */
  readonly clkPeriHasDiv: boolean = false;

  constructor(rpchip: ChipType, name: string) {
    super(rpchip, name);
    // Dynamic switch case offset — use if/else instead for C compatibility
    if (rpchip.identifier === 'rp2350') {
      this.clkFc0StatusOffset = 0xa4;
      this.clkUsbCtrlOffset = 0x60;
      this.clkAdcCtrlOffset = 0x6c;
      this.clkRtcCtrlOffset = 0x54; // HSTX clock
      this.clkResusCtrlOffset = 0x84;
      this.refDivIntShift = 16;
      this.refDivIntMask = 0xff0000;
      this.clkDivIntShift = 16;
      this.clkDivFracMask = 0xffff;
      this.clkPeriHasDiv = true;
    } else {
      this.clkFc0StatusOffset = 0x98;
      this.clkUsbCtrlOffset = 0x54;
      this.clkAdcCtrlOffset = 0x60;
      this.clkRtcCtrlOffset = 0x6c; // RTC clock
      this.clkResusCtrlOffset = 0x78;
      this.refDivIntShift = 8;
      this.refDivIntMask = 0x300;
      this.clkDivIntShift = 8;
      this.clkDivFracMask = 0xff;
      this.clkPeriHasDiv = false;
    }
    // Reset values for the dividers that matter, in each chip's fixed-point format.
    const divReset = 1 << this.clkDivIntShift;
    this.gpout0Div = divReset;
    this.gpout1Div = divReset;
    this.gpout2Div = divReset;
    this.gpout3Div = divReset;
    this.refDiv = 1 << this.refDivIntShift;
    this.sysDiv = divReset;
    this.periDiv = divReset;
    this.usbDiv = divReset;
    this.adcDiv = divReset;
    this.rtcDiv = divReset;
  }

  /** clk_ref frequency, in Hz. GPIN0/GPIN1 and (RP2350) LPOSC are not modelled and yield 0. */
  get refFreq(): Float64 {
    return this.refSourceFreq / this.refDivisor();
  }

  /** clk_sys frequency, in Hz. GPIN0/GPIN1 are not modelled and yield 0. */
  get sysFreq(): Float64 {
    return this.sysSourceFreq / this.clockDivisor(this.sysDiv);
  }

  private get refSourceFreq(): Float64 {
    switch (this.refCtrl & CLK_REF_CTRL_SRC_MASK) {
      case CLK_REF_CTRL_SRC_ROSC:
        return this.rpchip.roscFreq;
      case CLK_REF_CTRL_SRC_XOSC:
        return this.rpchip.xoscFreq;
      case CLK_REF_CTRL_SRC_AUX: {
        const auxsrc = (this.refCtrl >>> CLK_REF_CTRL_AUXSRC_SHIFT) & CLK_REF_CTRL_AUXSRC_MASK;
        return auxsrc === CLK_REF_CTRL_AUXSRC_PLL_USB ? this.rpchip.getPllUsbFrequency() : 0;
      }
      default:
        return 0;
    }
  }

  private get sysSourceFreq(): Float64 {
    if ((this.sysCtrl & CLK_SYS_CTRL_SRC_MASK) === CLK_SYS_CTRL_SRC_REF) {
      return this.refFreq;
    }
    switch ((this.sysCtrl >>> CLK_SYS_CTRL_AUXSRC_SHIFT) & CLK_SYS_CTRL_AUXSRC_MASK) {
      case CLK_SYS_CTRL_AUXSRC_PLL_SYS:
        return this.rpchip.getPllSysFrequency();
      case CLK_SYS_CTRL_AUXSRC_PLL_USB:
        return this.rpchip.getPllUsbFrequency();
      case CLK_SYS_CTRL_AUXSRC_ROSC:
        return this.rpchip.roscFreq;
      case CLK_SYS_CTRL_AUXSRC_XOSC:
        return this.rpchip.xoscFreq;
      default:
        return 0;
    }
  }

  /**
   * Decodes a CLK_SYS_DIV/CLK_GPOUTx_DIV value: 24.8 fixed point on the RP2040, 16.16 on
   * the RP2350. INT = 0 means divide by 2^16.
   */
  private clockDivisor(div: number): Float64 {
    const int = div >>> this.clkDivIntShift;
    return int ? int + (div & this.clkDivFracMask) / (this.clkDivFracMask + 1) : 0x10000;
  }

  /** Decodes CLK_REF_DIV, which has no fractional part on either chip. */
  private refDivisor(): Float64 {
    const int =
      (this.refDiv >>> this.refDivIntShift) & (this.refDivIntMask >>> this.refDivIntShift);
    return int ? int : 0x10000;
  }

  readUint32(offset: number) {
    if (offset === this.clkFc0StatusOffset) {
      return 0b10001; // done, passed
    }
    // The later clock groups move between the chips; ctrl/div/selected at +0/+4/+8.
    if (offset === this.clkUsbCtrlOffset) {
      return this.usbCtrl & 0b100110000110011100000;
    }
    if (offset === this.clkUsbCtrlOffset + 4) {
      return this.usbDiv;
    }
    if (offset === this.clkUsbCtrlOffset + 8) {
      return 1;
    }
    if (offset === this.clkAdcCtrlOffset) {
      return this.adcCtrl & 0b100110000110011100000;
    }
    if (offset === this.clkAdcCtrlOffset + 4) {
      return this.adcDiv & (0x3 << this.clkDivIntShift); // INT only, no frac
    }
    if (offset === this.clkAdcCtrlOffset + 8) {
      return 1;
    }
    if (offset === this.clkRtcCtrlOffset) {
      return this.rtcCtrl & 0b100110000110011100000;
    }
    if (offset === this.clkRtcCtrlOffset + 4) {
      return this.rtcDiv & (0x3 << this.clkDivIntShift); // INT only, no frac
    }
    if (offset === this.clkRtcCtrlOffset + 8) {
      return 1;
    }
    if (offset === this.clkResusCtrlOffset) {
      return 0xff;
    }
    if (offset === this.clkResusCtrlOffset + 4) {
      return 0; /* clock resus not implemented */
    }
    switch (offset) {
      case CLK_GPOUT0_CTRL:
        return this.gpout0Ctrl & 0b100110001110111100000;
      case CLK_GPOUT0_DIV:
        return this.gpout0Div;
      case CLK_GPOUT0_SELECTED:
        return 1;
      case CLK_GPOUT1_CTRL:
        return this.gpout1Ctrl & 0b100110001110111100000;
      case CLK_GPOUT1_DIV:
        return this.gpout1Div;
      case CLK_GPOUT1_SELECTED:
        return 1;
      case CLK_GPOUT2_CTRL:
        return this.gpout2Ctrl & 0b100110001110111100000;
      case CLK_GPOUT2_DIV:
        return this.gpout2Div;
      case CLK_GPOUT2_SELECTED:
        return 1;
      case CLK_GPOUT3_CTRL:
        return this.gpout3Ctrl & 0b100110001110111100000;
      case CLK_GPOUT3_DIV:
        return this.gpout3Div;
      case CLK_GPOUT3_SELECTED:
        return 1;
      case CLK_REF_CTRL:
        return this.refCtrl & 0b000001100011;
      case CLK_REF_DIV:
        return this.refDiv & this.refDivIntMask; // INT divisor only: no frac on either chip
      case CLK_REF_SELECTED:
        return 1 << (this.refCtrl & 0x03);
      case CLK_SYS_CTRL:
        return this.sysCtrl & 0b000011100001;
      case CLK_SYS_DIV:
        return this.sysDiv;
      case CLK_SYS_SELECTED:
        return 1 << (this.sysCtrl & 0x01);
      case CLK_PERI_CTRL:
        return this.periCtrl & 0b110011100000;
      case CLK_PERI_DIV:
        return this.periDiv;
      case CLK_PERI_SELECTED:
        return 1;
    }
    return super.readUint32(offset);
  }

  writeUint32(offset: number, value: number): void {
    // The later clock groups move between the chips; ctrl/div at +0/+4.
    if (offset === this.clkUsbCtrlOffset) {
      this.usbCtrl = value;
      return;
    }
    if (offset === this.clkUsbCtrlOffset + 4) {
      this.usbDiv = value;
      return;
    }
    if (offset === this.clkAdcCtrlOffset) {
      this.adcCtrl = value;
      return;
    }
    if (offset === this.clkAdcCtrlOffset + 4) {
      this.adcDiv = value;
      return;
    }
    if (offset === this.clkRtcCtrlOffset) {
      this.rtcCtrl = value;
      return;
    }
    if (offset === this.clkRtcCtrlOffset + 4) {
      this.rtcDiv = value;
      return;
    }
    if (offset === this.clkResusCtrlOffset) {
      return; /* clock resus not implemented */
    }
    switch (offset) {
      case CLK_GPOUT0_CTRL:
        this.gpout0Ctrl = value;
        break;
      case CLK_GPOUT0_DIV:
        this.gpout0Div = value;
        break;
      case CLK_GPOUT1_CTRL:
        this.gpout1Ctrl = value;
        break;
      case CLK_GPOUT1_DIV:
        this.gpout1Div = value;
        break;
      case CLK_GPOUT2_CTRL:
        this.gpout2Ctrl = value;
        break;
      case CLK_GPOUT2_DIV:
        this.gpout2Div = value;
        break;
      case CLK_GPOUT3_CTRL:
        this.gpout3Ctrl = value;
        break;
      case CLK_GPOUT3_DIV:
        this.gpout3Div = value;
        break;
      case CLK_REF_CTRL:
        this.refCtrl = value;
        this.rpchip.updateClocks();
        break;
      case CLK_REF_DIV:
        this.refDiv = value;
        this.rpchip.updateClocks();
        break;
      case CLK_SYS_CTRL:
        this.sysCtrl = value;
        this.rpchip.updateClocks();
        break;
      case CLK_SYS_DIV:
        this.sysDiv = value;
        this.rpchip.updateClocks();
        break;
      case CLK_PERI_CTRL:
        this.periCtrl = value;
        break;
      case CLK_PERI_DIV:
        this.periDiv = value;
        break;
      case CLK_REF_SELECTED:
      case CLK_SYS_SELECTED:
      case CLK_PERI_SELECTED:
      case CLK_GPOUT0_SELECTED:
      case CLK_GPOUT1_SELECTED:
      case CLK_GPOUT2_SELECTED:
      case CLK_GPOUT3_SELECTED:
        return; // read-only status
      default:
        super.writeUint32(offset, value);
        break;
    }
  }

  transferState(s: SaveStateStream) {
    this.gpout0Ctrl = s.i32(this.gpout0Ctrl);
    this.gpout0Div = s.i32(this.gpout0Div);
    this.gpout1Ctrl = s.i32(this.gpout1Ctrl);
    this.gpout1Div = s.i32(this.gpout1Div);
    this.gpout2Ctrl = s.i32(this.gpout2Ctrl);
    this.gpout2Div = s.i32(this.gpout2Div);
    this.gpout3Ctrl = s.i32(this.gpout3Ctrl);
    this.gpout3Div = s.i32(this.gpout3Div);
    this.refCtrl = s.i32(this.refCtrl);
    this.refDiv = s.i32(this.refDiv);
    this.sysCtrl = s.i32(this.sysCtrl);
    this.sysDiv = s.i32(this.sysDiv);
    this.periCtrl = s.i32(this.periCtrl);
    this.periDiv = s.i32(this.periDiv);
    this.usbCtrl = s.i32(this.usbCtrl);
    this.usbDiv = s.i32(this.usbDiv);
    this.adcCtrl = s.i32(this.adcCtrl);
    this.adcDiv = s.i32(this.adcDiv);
    this.rtcCtrl = s.i32(this.rtcCtrl);
    this.rtcDiv = s.i32(this.rtcDiv);
  }
}
