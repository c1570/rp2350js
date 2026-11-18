import { describe, expect, it } from 'vitest';
import { RP2350 } from '../rp2350';

const SSPCR0 = 0x000;
const SSPCR1 = 0x004;
const SSPDR = 0x008;
const SSPSR = 0x00c;
const SSPCPSR = 0x010;
const SSPRIS = 0x018;
const SSPICR = 0x020;

const SR_TFE = 1 << 0;
const SR_TNF = 1 << 1;
const SR_RNE = 1 << 2;
const SR_RFF = 1 << 3;
const SR_BSY = 1 << 4;

const RIS_ROR = 1 << 0;

const CR0_8BIT_MODE0 = 0x07; // DSS=8 bits, Motorola frame, CPOL=0, CPHA=0
const CR1_SSE = 1 << 1;

/* SPI0 configured the way the Pico SDK's spi_init/spi_set_format leaves it */
function createSPI() {
  const mcu = new RP2350();
  const spi = mcu.spi[0];
  spi.writeUint32(SSPCR0, CR0_8BIT_MODE0);
  spi.writeUint32(SSPCPSR, 2);
  spi.writeUint32(SSPCR1, CR1_SSE);
  return { mcu, spi };
}

describe('SPI (PL022)', () => {
  it('reports an idle, empty peripheral after setup', () => {
    const { spi } = createSPI();
    expect(spi.readUint32(SSPSR)).toBe(SR_TFE | SR_TNF);
    expect(spi.enabled).toBe(true);
    expect(spi.masterMode).toBe(true);
    expect(spi.dataBits).toBe(8);
    expect(spi.spiMode).toBe(0);
  });

  it('decodes master/slave mode from CR1 and the SPI mode from CPOL/CPHA', () => {
    const { spi } = createSPI();
    spi.writeUint32(SSPCR1, CR1_SSE | (1 << 2));
    expect(spi.masterMode).toBe(false);

    const SPO = 1 << 6;
    const SPH = 1 << 7;
    const modeFor = (bits: number) => {
      spi.writeUint32(SSPCR0, CR0_8BIT_MODE0 | bits);
      return spi.spiMode;
    };
    expect([modeFor(0), modeFor(SPH), modeFor(SPO), modeFor(SPO | SPH)]).toEqual([0, 1, 2, 3]);
  });

  it('completes a transfer through a synchronous onTransmit callback', () => {
    const { spi } = createSPI();
    const sent: number[] = [];
    spi.onTransmit = (value) => {
      sent.push(value);
      spi.completeTransmit(value ^ 0xff);
    };

    spi.writeUint32(SSPDR, 0x40);
    expect(sent).toEqual([0x40]);
    expect(spi.readUint32(SSPSR)).toBe(SR_TFE | SR_TNF | SR_RNE);
    expect(spi.readUint32(SSPDR)).toBe(0xbf);
    expect(spi.readUint32(SSPSR)).toBe(SR_TFE | SR_TNF);
  });

  it('masks transmitted data to the configured frame size', () => {
    const { spi } = createSPI();
    const sent: number[] = [];
    spi.onTransmit = (value) => {
      sent.push(value);
      spi.completeTransmit(0);
    };
    spi.writeUint32(SSPDR, 0x1a5);
    expect(sent).toEqual([0xa5]);
  });

  it('keeps BSY set and queues further bytes while a transfer is pending', () => {
    const { spi } = createSPI();
    const sent: number[] = [];
    spi.onTransmit = (value) => sent.push(value); // completed later

    spi.writeUint32(SSPDR, 1);
    expect(spi.readUint32(SSPSR) & (SR_BSY | SR_TFE)).toBe(SR_BSY | SR_TFE);

    spi.writeUint32(SSPDR, 2);
    spi.writeUint32(SSPDR, 3);
    expect(sent).toEqual([1]);
    expect(spi.readUint32(SSPSR) & (SR_BSY | SR_TFE | SR_RNE)).toBe(SR_BSY);

    spi.completeTransmit(0x11);
    expect(sent).toEqual([1, 2]);
    spi.completeTransmit(0x22);
    spi.completeTransmit(0x33);
    expect(sent).toEqual([1, 2, 3]);
    expect(spi.readUint32(SSPSR)).toBe(SR_TFE | SR_TNF | SR_RNE);
    expect([0, 1, 2].map(() => spi.readUint32(SSPDR))).toEqual([0x11, 0x22, 0x33]);
  });

  it('reports a full TX FIFO after 8 queued bytes', () => {
    const { spi } = createSPI();
    spi.onTransmit = () => undefined; // first byte stays in the shifter
    for (let i = 0; i < 9; i++) {
      spi.writeUint32(SSPDR, i);
    }
    expect(spi.readUint32(SSPSR) & (SR_TNF | SR_BSY)).toBe(SR_BSY);
  });

  it('flags a receive overrun and drops data beyond 8 bytes', () => {
    const { spi } = createSPI();
    spi.onTransmit = (value) => spi.completeTransmit(value);

    for (let i = 0; i < 10; i++) {
      spi.writeUint32(SSPDR, i);
    }
    expect(spi.readUint32(SSPSR) & (SR_RFF | SR_RNE)).toBe(SR_RFF | SR_RNE);
    expect(spi.readUint32(SSPRIS) & RIS_ROR).toBe(RIS_ROR);

    const received: number[] = [];
    while (spi.readUint32(SSPSR) & SR_RNE) {
      received.push(spi.readUint32(SSPDR));
    }
    expect(received).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    spi.writeUint32(SSPICR, RIS_ROR);
    expect(spi.readUint32(SSPRIS) & RIS_ROR).toBe(0);
  });

  it('handles the sd2iec command pattern: unread TX bytes, then flush and poll', () => {
    const { spi } = createSPI();
    const responses = [0xff, 0xff, 0x01];
    spi.onTransmit = () => spi.completeTransmit(0xff);
    // CMD0 frame, RX not drained (spi_tx_byte / spi_tx_block)
    for (const b of [0x40, 0, 0, 0, 0, 0x95]) {
      spi.writeUint32(SSPDR, b);
    }
    // spi_rx_byte: wait for !BSY, drain RX, send 0xff, wait for RNE
    spi.onTransmit = () => spi.completeTransmit(responses.shift() ?? 0xff);
    const rxByte = () => {
      while (spi.readUint32(SSPSR) & SR_BSY);
      while (spi.readUint32(SSPSR) & SR_RNE) spi.readUint32(SSPDR);
      spi.writeUint32(SSPDR, 0xff);
      while (!(spi.readUint32(SSPSR) & SR_RNE));
      return spi.readUint32(SSPDR);
    };
    expect([rxByte(), rxByte(), rxByte()]).toEqual([0xff, 0xff, 0x01]);
  });

  it('derives the SCK frequency from CPSDVSR and SCR', () => {
    const { mcu, spi } = createSPI();
    spi.writeUint32(SSPCPSR, 2);
    spi.writeUint32(SSPCR0, CR0_8BIT_MODE0 | (2 << 8));
    expect(spi.clockFrequency).toBe(mcu.clkPeri / 6);
  });
});
