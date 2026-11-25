// Work left in flight at a snapshot point, so a save state holds more than registers:
// a USB endpoint transfer, a DMA copy and an ADC conversion, each waiting on a clock
// alarm. Shared by the two C harnesses (helper-checks.c and the parity harness) and
// mirrored by startInflight() in cts2c-ensure-parity.ts — keep them in step, since a
// poke one side lacks shows up as a Node-vs-C state CRC mismatch.
//
// Ends with flash (and, on the RP2350, PSRAM) marked written: a state carries an image
// only once something has written it, and without this the comparison would leave the
// images out. The two chips mark flash written differently: the RP2350 through the hook
// its QMI flash model reports to, the RP2040 through an ordinary store into the flash
// window (every flash write of its funnels through writeUint32).
//
// Include after the generated header, which has no include guard of its own.
#pragma once

// Source and destination of the DMA copy, clear of the firmware and its stack in either
// chip's SRAM: the RP2350 has 520 KiB, the RP2040 only 264 KiB (stack at its top), so a
// pair that suits the first lands outside memory on the second.
#define INFLIGHT_SRC 0x20060000u
#define INFLIGHT_DST 0x20061000u
#define INFLIGHT_SRC_RP2040 0x20030000u
#define INFLIGHT_DST_RP2040 0x20038000u

// Channel 0's CTRL_TRIG: enable, increment both addresses, 16-bit data, permanent
// request. RP2350: TREQ_SEL is bits 17..22, INCR_WRITE bit 6. RP2040: bits 15..20, bit 5.
#define INFLIGHT_CTRL_RP2350 (1u | (1u << 6) | (1u << 4) | (0x3fu << 17) | (2u << 2))
#define INFLIGHT_CTRL_RP2040 (1u | (1u << 5) | (1u << 4) | (0x3fu << 15) | (2u << 2))

// One body for both chips; W is the chip's writeUint32, SRC/DST its SRAM pair.
#define RP_INFLIGHT_WORK(chip, W, CTRL, ADC_BASE, SRC, DST)                      \
  for (int i = 0; i < 4; i++) (chip)->usbDPRAM[0x40 + i] = (uint8_t)(0xa0 + i); \
  W(chip, 0x50100008u, 0x40); /* USB EP1 IN control: buffer at 0x40 */           \
  W(chip, 0x50100088u, (int32_t)(4u | (1u << 10))); /* EP1 IN: 4 bytes, available */ \
  W(chip, SRC, (int32_t)0x11u); /* DMA ch0 READ_ADDR */                          \
  W(chip, SRC + 4, (int32_t)0x2233u);                                            \
  W(chip, SRC + 8, (int32_t)0x445566u);                                          \
  W(chip, SRC + 12, (int32_t)0x778899aau);                                       \
  W(chip, 0x50000000u, (int32_t)SRC); /* READ_ADDR */                            \
  W(chip, 0x50000004u, (int32_t)DST); /* WRITE_ADDR */                           \
  W(chip, 0x50000008u, 4); /* TRANS_COUNT */                                     \
  W(chip, 0x5000000cu, (int32_t)(CTRL));                                         \
  (chip)->adc->channelValues[2] = 0x9ab;                                         \
  W(chip, ADC_BASE, (int32_t)(1u | (1u << 2) | (2u << 12))); /* ADC: enable, start one, channel 2 */

static void rp2350_start_inflight(RP2350* mcu) {
  mcu->flash[0x110000] = 0x5a;
  RP2350_invalidateFlashDecode(mcu, 0x100, 4);
  RP2350_writeUint32(mcu, 0x15000000u, 0x1234); // an ordinary store into PSRAM
  RP_INFLIGHT_WORK(mcu, RP2350_writeUint32, INFLIGHT_CTRL_RP2350, 0x400a0000u, INFLIGHT_SRC, INFLIGHT_DST);
}

static void rp2040_start_inflight(RP2040* mcu) {
  RP2040_writeUint32(mcu, 0x10150000u, (int32_t)0x5a5a5a5au); // 0x150000 bytes into flash
  RP_INFLIGHT_WORK(mcu, RP2040_writeUint32, INFLIGHT_CTRL_RP2040, 0x4004c000u, INFLIGHT_SRC_RP2040,
                   INFLIGHT_DST_RP2040);
}
