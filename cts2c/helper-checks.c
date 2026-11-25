// Standalone correctness checks for C function helpers cts2c.js emits in
// place of transpiled TS (see its FunctionDeclaration name-override blocks):
//
//  - floatToBits/bitsToFloat/isSignNegative/readDouble/writeDouble's bit-punning
//    bodies, exercised with non-trivial (non-integer-valued) float/double values —
//    deliberately NOT covered by any of the reference demos' CRC32 parity tests,
//    which is exactly how the pre-fix bug (wrong C parameter/return types causing
//    numeric, not bit-for-bit, conversion) went undetected.
//  - checkTraceMagic/checkTraceMagicM33/checkTraceMagicM0's allocation-free trace
//    hook bodies: write the 0xabcd/0xffff marker + tag into (virtual) chip memory,
//    call the hook, and verify the chip's onTrace callback fires exactly once with
//    the right core number, PC and tag string.
//  - the transpiled cores' add/sub/mul/div opcodes, run as hand-assembled
//    instructions on each core (RISC-V, Cortex-M33, Cortex-M0+) with boundary
//    operands — the cases where a uint-vs-int mixup in the generated C silently
//    changes the result (see the section comment near the end for details).
//  - save states: stateF64Lo/Hi/From and stateF32ToBits/FromBits (hand-written
//    bit-punning bodies again), the SaveStateStream primitives against a raw
//    buffer, and whole-chip serialize/unserialize with USB, DMA, ADC and timer
//    work in flight, on both core architectures.
//
// Exits non-zero and prints a diagnostic on the first mismatch.
#include "../build/transpile/rp2350js-c.h"
#include "inflight-work.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int failures = 0;

static void checkU32(const char* label, uint32_t got, uint32_t want) {
  if (got != want) {
    fprintf(stderr, "FAIL %s: got 0x%08x, want 0x%08x\n", label, got, want);
    failures++;
  } else {
    printf("ok   %s: 0x%08x\n", label, got);
  }
}

static void checkF32(const char* label, float got, float want) {
  uint32_t gotBits, wantBits;
  memcpy(&gotBits, &got, sizeof(gotBits));
  memcpy(&wantBits, &want, sizeof(wantBits));
  if (gotBits != wantBits) {
    fprintf(stderr, "FAIL %s: got %.9g (0x%08x), want %.9g (0x%08x)\n", label, got, gotBits, want, wantBits);
    failures++;
  } else {
    printf("ok   %s: %.9g\n", label, got);
  }
}

static void checkF64(const char* label, double got, double want) {
  uint64_t gotBits, wantBits;
  memcpy(&gotBits, &got, sizeof(gotBits));
  memcpy(&wantBits, &want, sizeof(wantBits));
  if (gotBits != wantBits) {
    fprintf(stderr, "FAIL %s: got %.17g (0x%016llx), want %.17g (0x%016llx)\n", label, got, (unsigned long long)gotBits, want, (unsigned long long)wantBits);
    failures++;
  } else {
    printf("ok   %s: %.17g\n", label, got);
  }
}

static void checkBool(const char* label, bool got, bool want) {
  if (got != want) {
    fprintf(stderr, "FAIL %s: got %d, want %d\n", label, got, want);
    failures++;
  } else {
    printf("ok   %s: %d\n", label, got);
  }
}

static void checkI32(const char* label, int32_t got, int32_t want) {
  if (got != want) {
    fprintf(stderr, "FAIL %s: got %d, want %d\n", label, got, want);
    failures++;
  } else {
    printf("ok   %s: %d\n", label, got);
  }
}

static void checkI64(const char* label, int64_t got, int64_t want) {
  if (got != want) {
    fprintf(stderr, "FAIL %s: got %lld, want %lld\n", label, (long long)got, (long long)want);
    failures++;
  } else {
    printf("ok   %s: %lld\n", label, (long long)got);
  }
}

static void checkStr(const char* label, const char* got, const char* want) {
  if (strcmp(got, want) != 0) {
    fprintf(stderr, "FAIL %s: got \"%s\", want \"%s\"\n", label, got, want);
    failures++;
  } else {
    printf("ok   %s: \"%s\"\n", label, got);
  }
}

// ─── add/sub/mul/div opcode checks (uint-vs-int traps) ───────────────────

// R-type with rs1=x1, rs2=x2, rd=x5.
static uint32_t rv_r(uint32_t funct3, uint32_t funct7) {
  return 0x33u | (5u << 7) | (funct3 << 12) | (1u << 15) | (2u << 20) | (funct7 << 25);
}

static uint32_t rv_alu(RP2350* mcu, CPU* cpu, uint32_t insn, uint32_t a, uint32_t b) {
  const uint32_t base = 0x20040000;
  cpu->regs[1] = (int32_t)a;
  cpu->regs[2] = (int32_t)b;
  cpu->regs[5] = 0;
  RP2350_writeUint32(mcu, base, insn);
  cpu->pc = (int32_t)base;
  cpu->next_pc = (int32_t)(base + 4);
  CPU_executeInstruction(cpu);
  return (uint32_t)cpu->regs[5];
}

// Executes a Thumb instruction (w1, plus w2 for 32-bit encodings; pass 0 for
// 16-bit ones) with r1=a, r2=b, r5 preloaded with b (MULS needs rd==rm) and
// returns r5; *hiOut (optional) receives r6 for SMULL/UMULL results.
static uint32_t m33_exec(
    RP2350* mcu, CortexM33Core* core, uint16_t w1, uint16_t w2, uint32_t a, uint32_t b, uint32_t* hiOut) {
  const uint32_t base = 0x20040000;
  core->regs->r[1] = a;
  core->regs->r[2] = b;
  core->regs->r[5] = b;
  core->regs->r[6] = 0;
  RP2350_writeUint16(mcu, base, w1);
  if (w2) RP2350_writeUint16(mcu, base + 2, w2);
  core->regs->r[15] = base;
  CortexM33Core_executeInstruction(core);
  if (hiOut) *hiOut = core->regs->r[6];
  return core->regs->r[5];
}

static uint32_t m0_exec(RP2040* mcu, CortexM0Core* core, uint16_t insn, uint32_t a, uint32_t b) {
  const uint32_t base = 0x20040000;
  core->registers[1] = a;
  core->registers[2] = b;
  core->registers[5] = b;
  RP2040_writeUint16(mcu, base, insn);
  core->registers[15] = base;
  CortexM0Core_executeInstruction(core);
  return core->registers[5];
}

// ─── checkTraceMagic* callback tests ─────────────────────────────────────

static int trace_calls = 0;
static int32_t trace_core;
static int32_t trace_pc;
static char trace_tag[128];
static void* trace_ctx_seen;

static void on_trace(void* ctx, int32_t coreNumber, int32_t pc, const char* tag) {
  (void)ctx;
  trace_calls++;
  trace_ctx_seen = ctx;
  trace_core = coreNumber;
  trace_pc = pc;
  snprintf(trace_tag, sizeof trace_tag, "%s", tag);
}

static void trace_reset(void) {
  trace_calls = 0;
  trace_ctx_seen = NULL;
  trace_core = -1;
  trace_pc = -1;
  trace_tag[0] = '\0';
}

static void rp2350_write_tag(RP2350* mcu, uint32_t addr, const char* tag) {
  size_t n = strlen(tag);
  for (size_t i = 0; i < n; i++) RP2350_writeUint8(mcu, addr + (uint32_t)i, (uint32_t)(uint8_t)tag[i]);
  RP2350_writeUint8(mcu, addr + (uint32_t)n, 0); // NUL terminator
}

static void rp2040_write_tag(RP2040* mcu, uint32_t addr, const char* tag) {
  size_t n = strlen(tag);
  for (size_t i = 0; i < n; i++) RP2040_writeUint8(mcu, addr + (uint32_t)i, (uint32_t)(uint8_t)tag[i]);
  RP2040_writeUint8(mcu, addr + (uint32_t)n, 0); // NUL terminator
}

// ─── USB CDC enumeration + data tests ────────────────────────────────────
// Drives RPUSBController + USBCDC the way a pico-sdk-style device responds:
// clear the bus reset, service SETUP packets by arming EP0 buffers, feed the
// config descriptor, then push serial data both directions. Runs on both chip
// flavors so the monomorphized USBCDC__RP2040 interrupt routing is covered.
// Exercised: the alarm buffer pool + lengths, the cdcSetControlLineState
// defaults (DTR|RTS, interface 0), extractEndpointNumbers (packed),
// sendSetupPacket's copy loop, deliverOutData → endpointReadDone → finishRead,
// and onSerialData with lengths.

#define USB_DPRAM_BASE 0x50100000u
#define USB_CTRL_BASE 0x50110000u
#define USB_MAIN_CTRL 0x40u
#define USB_SIE_STATUS 0x50u
#define USB_SIE_BUS_RESET (1u << 19)
#define USB_SIE_SETUP_REC (1u << 17)
#define USB_EP0_IN_BC 0x80u
#define USB_EP0_OUT_BC 0x84u
#define USB_BUF_CTRL_AVAILABLE (1u << 10)
#define USB_BUF_CTRL_FULL (1u << 15)

static uint8_t cdc_serial_captured[256];
static int32_t cdc_serial_captured_len;
static int32_t cdc_connected_count;

static void cdc_on_serial(void* ctx, uint8_t* buffer, int32_t length) {
  (void)ctx;
  for (int32_t i = 0; i < length && cdc_serial_captured_len < (int32_t)sizeof cdc_serial_captured; i++) {
    cdc_serial_captured[cdc_serial_captured_len++] = buffer[i];
  }
}

static void cdc_on_connected(void* ctx) {
  (void)ctx;
  cdc_connected_count++;
}

// pico-sdk-style CDC config descriptor (84 bytes, from cdc.spec.ts).
static const uint8_t CFG_DESC_9[9] = {9, 2, 84, 0, 3, 1, 0, 128, 125};
static const uint8_t CFG_DESC[84] = {
  9, 2, 84, 0, 3, 1, 0, 128, 125, 8, 11, 0, 2, 2, 2, 0, 0, 9, 4, 0,
  0, 1, 2, 2, 0, 4, 5, 36, 0, 32, 1, 5, 36, 1, 0, 1, 4, 36, 2, 2,
  5, 36, 6, 0, 1, 7, 5, 129, 3, 8, 0, 16, 9, 4, 1, 0, 2, 10, 0, 0, 0,
  7, 5, 2, 2, 64, 0, 0, 7, 5, 130, 2, 64, 0, 0, 9, 4, 2, 0, 0, 255, 0, 1, 5,
};

typedef struct {
  void* chip;
  SimulationClock* clock;
  void (*write32)(void* chip, uint32_t addr, uint32_t v);
  void (*write8)(void* chip, uint32_t addr, uint32_t v);
  uint32_t (*read32)(void* chip, uint32_t addr);
  uint32_t (*read8)(void* chip, uint32_t addr);
  void (*tick)(SimulationClock* clock, double nanos);
} UsbOps;

// Firmware-side service of one pending SETUP packet: read it from DPRAM,
// clear SETUP_REC, hand the 8 raw bytes back.
static void usb_service_setup(const UsbOps* io, uint8_t out[8]) {
  for (int i = 0; i < 8; i++) out[i] = (uint8_t)io->read8(io->chip, USB_DPRAM_BASE + i);
  io->write32(io->chip, USB_CTRL_BASE + USB_SIE_STATUS, USB_SIE_SETUP_REC);
}

static void usb_arm_ep0_in(const UsbOps* io, const uint8_t* data, int len) {
  for (int i = 0; i < len; i++) io->write8(io->chip, USB_DPRAM_BASE + 0x100 + i, data[i]);
  io->write32(io->chip, USB_DPRAM_BASE + USB_EP0_IN_BC, (uint32_t)len | USB_BUF_CTRL_AVAILABLE);
  io->tick(io->clock, 20000); // > writeDelayMicroseconds (10us) default
}

static void usb_cdc_drive(const UsbOps* io, void (*send_byte)(void*, int32_t), void* cdc) {
  void* chip = io->chip;
  uint8_t setup[8];

  // Enable the controller; CDC schedules the 10ms bus reset; firmware clears
  // it, which triggers the first SETUP (SET_ADDRESS).
  io->write32(chip, USB_CTRL_BASE + USB_MAIN_CTRL, 1);
  io->tick(io->clock, 20e6);
  io->write32(chip, USB_CTRL_BASE + USB_SIE_STATUS, USB_SIE_BUS_RESET);

  usb_service_setup(io, setup);
  checkBool("cdc set-address request", setup[1] == 5, true);
  usb_arm_ep0_in(io, NULL, 0); // status stage → CDC requests the 9-byte config descriptor

  usb_service_setup(io, setup);
  checkBool("cdc get-desc 9 request", setup[1] == 6 && setup[3] == 2 && setup[6] == 9, true);
  usb_arm_ep0_in(io, CFG_DESC_9, 9);

  usb_service_setup(io, setup);
  checkBool("cdc get-desc 84 request", setup[1] == 6 && setup[6] == 84, true);
  usb_arm_ep0_in(io, CFG_DESC, 64);      // first packet
  usb_arm_ep0_in(io, CFG_DESC + 64, 20); // rest → enumeration completes

  usb_service_setup(io, setup);
  checkBool("cdc set-configuration request", setup[1] == 9, true);
  usb_arm_ep0_in(io, NULL, 0); // ack → CDC sends SET_CONTROL_LINE_STATE with DEFAULTS

  usb_service_setup(io, setup);
  checkBool("cdc class request 0x22", setup[1] == 0x22, true);
  // The value/index defaults: DTR|RTS = 3, interface 0.
  checkU32("cdc dtr|rts default", setup[2], 3);
  checkU32("cdc interface default", setup[4], 0);
  checkI32("cdc onDeviceConnected fired", cdc_connected_count, 1);

  // Device → host serial: arm EP2 IN ("hello") → onSerialData(buffer, 5).
  static const uint8_t hello[5] = {'h', 'e', 'l', 'l', 'o'};
  io->write32(chip, USB_DPRAM_BASE + 0x10, 0x180); // EP2 IN control: buffer offset
  for (int i = 0; i < 5; i++) io->write8(chip, USB_DPRAM_BASE + 0x180 + i, hello[i]);
  io->write32(chip, USB_DPRAM_BASE + USB_EP0_IN_BC + 2 * 8, 5 | USB_BUF_CTRL_AVAILABLE);
  io->tick(io->clock, 20000);
  checkI32("cdc onSerialData length", cdc_serial_captured_len, 5);
  checkBool("cdc onSerialData bytes", memcmp(cdc_serial_captured, hello, 5) == 0, true);

  // Host → device serial: queue bytes, then arm EP2 OUT (64-byte request) →
  // deliverOutData → finishRead lands exactly 3 bytes in the EP2 OUT buffer.
  io->write32(chip, USB_DPRAM_BASE + 0x14, 0x200); // EP2 OUT control: buffer offset
  send_byte(cdc, 'a');
  send_byte(cdc, 'b');
  send_byte(cdc, 'c');
  io->write32(chip, USB_DPRAM_BASE + USB_EP0_OUT_BC + 2 * 8, 64 | USB_BUF_CTRL_AVAILABLE);
  io->tick(io->clock, 20000);
  checkU32("cdc out byte 0", io->read8(chip, USB_DPRAM_BASE + 0x200), 'a');
  checkU32("cdc out byte 1", io->read8(chip, USB_DPRAM_BASE + 0x201), 'b');
  checkU32("cdc out byte 2", io->read8(chip, USB_DPRAM_BASE + 0x202), 'c');
  checkBool("cdc out full bit",
            (io->read32(chip, USB_DPRAM_BASE + USB_EP0_OUT_BC + 2 * 8) & USB_BUF_CTRL_FULL) != 0,
            true);
  checkI32("cdc no extra serial data", cdc_serial_captured_len, 5);

  // extractEndpointNumbers: invalid descriptors stay silent (packed not-found).
  uint8_t bad[2] = {0, 0};
  checkU32("cdc extract invalid descriptors", extractEndpointNumbers(bad, 2), 0xffffu);
}

static void check_usb_cdc_rp2350(void) {
  RP2350Options options = {.coreArch = "arm", .loadFirmware = NULL};
  RP2350* mcu = RP2350_new(&options);
  USBCDC* cdc = USBCDC_new(mcu->usbCtrl);
  cdc->onSerialData_fn = cdc_on_serial;
  cdc->onSerialData_ctx = NULL;
  cdc->onDeviceConnected_fn = cdc_on_connected;
  cdc->onDeviceConnected_ctx = NULL;

  cdc_serial_captured_len = 0;
  cdc_connected_count = 0;
  UsbOps io = {
    .chip = mcu,
    .clock = mcu->clock,
    .write32 = (void (*)(void*, uint32_t, uint32_t))RP2350_writeUint32,
    .write8 = (void (*)(void*, uint32_t, uint32_t))RP2350_writeUint8,
    .read32 = (uint32_t(*)(void*, uint32_t))RP2350_readUint32,
    .read8 = (uint32_t(*)(void*, uint32_t))RP2350_readUint8,
    .tick = SimulationClock_tick,
  };
  usb_cdc_drive(&io, (void (*)(void*, int32_t))USBCDC_sendSerialByte, cdc);
}

static void check_usb_cdc_rp2040(void) {
  RP2040Options options = {.loadFirmware = NULL};
  RP2040* mcu = RP2040_new(&options);
  USBCDC__RP2040* cdc = USBCDC__RP2040_new(mcu->usbCtrl);
  cdc->onSerialData_fn = cdc_on_serial;
  cdc->onSerialData_ctx = NULL;
  cdc->onDeviceConnected_fn = cdc_on_connected;
  cdc->onDeviceConnected_ctx = NULL;

  cdc_serial_captured_len = 0;
  cdc_connected_count = 0;
  UsbOps io = {
    .chip = mcu,
    .clock = mcu->clock,
    .write32 = (void (*)(void*, uint32_t, uint32_t))RP2040_writeUint32,
    .write8 = (void (*)(void*, uint32_t, uint32_t))RP2040_writeUint8,
    .read32 = (uint32_t(*)(void*, uint32_t))RP2040_readUint32,
    .read8 = (uint32_t(*)(void*, uint32_t))RP2040_readUint8,
    .tick = SimulationClock_tick,
  };
  usb_cdc_drive(&io, (void (*)(void*, int32_t))USBCDC__RP2040_sendSerialByte, cdc);
}

// ─── Timer alarm scheduling (uint-vs-int overflow) ───────────────────────
// A 2.5 s alarm has a 2.5e9 ns delta — past INT32_MAX. The generated C used to
// compute it as int32*int32 (`1000.0` transpiled as `1000`), overflowing so the
// alarm fired immediately; a `double deltaMicros` local plus the preserved
// float literal fixes it. This test fails if either regresses.
static void check_timer_alarm_overflow(void) {
  RP2350Options options = {.coreArch = "arm", .loadFirmware = NULL};
  RP2350* mcu = RP2350_new(&options);
  const uint32_t timer = 0x400b0000u; // TIMER0 base; ALARM0 at +0x10, INTR at +0x3c
  RP2350_writeUint32(mcu, timer + 0x10, 2500000); // target 2.5e6 µs ahead of the zeroed clock
  SimulationClock_tick(mcu->clock, 2.4e9);
  checkU32("timer >2.1s alarm not fired early", RP2350_readUint32(mcu, timer + 0x3c) & 1u, 0);
  SimulationClock_tick(mcu->clock, 0.2e9);
  checkU32("timer >2.1s alarm fired", RP2350_readUint32(mcu, timer + 0x3c) & 1u, 1);
}

// ─── mtimecmp halves must be unsigned ────────────────────────────────────
// cts2c used to infer number[] as int32_t[], so 0xffffffff (and any low word
// with bit 31 set) became negative; mtime >= mtimecmp then looked already
// true, leaving MTIP asserted as a permanent interrupt storm. FULLSPEED hits
// bit 31 in ~14 s at 150 MHz instead of ~36 min at 1 MHz.
static void check_mtimecmp_unsigned(void) {
  RP2350Options options = {.coreArch = "riscv", .loadFirmware = NULL};
  RP2350* mcu = RP2350_new(&options);
  checkF64("mtimecmp reset is 0xffffffff", RP2350SIO_mtimecmpValue(mcu->sio, 0), 4294967295.0);
  RP2350_writeUint32(mcu, 0xd00001bc, 1); // MTIMECMPH
  RP2350_writeUint32(mcu, 0xd00001b8, 0x80000000u); // MTIMECMP
  checkF64("mtimecmp keeps bit 31", RP2350SIO_mtimecmpValue(mcu->sio, 0), 6442450944.0);
}

// ─── save states ────────────────────────────────────────────────────────

// The save-state stream's primitives, against a raw buffer.
static void check_state_stream(void) {
  uint8_t buf[64];
  memset(buf, 0xa5, sizeof buf);
  SaveStateStream* out = SaveStateStream_new(true, false);
  SaveStateStream_attach(out, buf, sizeof buf);
  SaveStateStream_u32(out, (int32_t)0xdeadbeefu);
  SaveStateStream_i32(out, -12345);
  SaveStateStream_f64(out, 1.5e300);
  const float floats[3] = {0.0f, -0.0f, 3.14159f};
  SaveStateStream_f32array(out, (float*)floats, 3);
  const uint8_t bytes[5] = {1, 2, 3, 4, 5};
  SaveStateStream_u8array(out, (uint8_t*)bytes, 5);
  checkBool("stream stays ok in bounds", out->ok, true);
  const int32_t words = out->pos;
  checkI32("stream word count", words, 1 + 1 + 2 + 3 + 2);
  checkU32("stream u8array zero-pads to a word",
           (uint32_t)buf[words * 4 - 1] << 16 | (uint32_t)buf[words * 4 - 2] << 8 | buf[words * 4 - 3], 0);
  SaveStateStream_skip(out, 1000);
  checkBool("stream skip past the end clears ok", out->ok, false);

  SaveStateStream* in = SaveStateStream_new(false, false);
  SaveStateStream_attach(in, buf, words * 4);
  checkU32("stream u32 round trip", (uint32_t)SaveStateStream_u32(in, 0), 0xdeadbeefu);
  checkI32("stream i32 round trip", SaveStateStream_i32(in, 0), -12345);
  checkF64("stream f64 round trip", SaveStateStream_f64(in, 0.0), 1.5e300);
  float back[3] = {1.0f, 1.0f, 1.0f};
  SaveStateStream_f32array(in, back, 3);
  checkU32("stream f32array keeps the bits of -0.0", (uint32_t)floatToBits(back[1]), 0x80000000u);
  checkF32("stream f32array round trip", back[2], 3.14159f);
  uint8_t backBytes[5] = {0};
  SaveStateStream_u8array(in, backBytes, 5);
  checkBool("stream u8array round trip", memcmp(backBytes, bytes, 5) == 0, true);
  checkI32("stream reads exactly what was written", in->pos, words);
  checkI32("stream read past the end keeps its argument", SaveStateStream_i32(in, 77), 77);
  checkBool("stream read past the end clears ok", in->ok, false);

  // Measuring (for serializeSize) advances pos like a real write and stores nothing.
  SaveStateStream* measuring = SaveStateStream_new(true, true);
  SaveStateStream_u32(measuring, 1);
  SaveStateStream_f64(measuring, 2.0);
  SaveStateStream_skip(measuring, 3);
  checkI32("stream measuring advances like a real write", measuring->pos, 1 + 2 + 3);
  checkBool("stream measuring never runs out of room", measuring->ok, true);
}

static int host_alarm_fires = 0;
static void host_alarm_fire(void* self) {
  (void)self;
  host_alarm_fires++;
}
static const AlarmCallbackVTable host_alarm_vtable = {.fire = host_alarm_fire};

static int usb_writes = 0;
static uint8_t usb_last[4] = {0};
static void on_endpoint_write(void* ctx, int32_t endpoint, uint8_t* buffer, int32_t length) {
  (void)ctx;
  if (endpoint == 1 && length == 4) {
    memcpy(usb_last, buffer, 4);
    usb_writes++;
  }
}

// Leaves a USB endpoint transfer, a DMA copy, an ADC conversion and a timer alarm
// half done, so the snapshot has work in flight as well as plain registers.
static void start_inflight(RP2350* mcu) {
  rp2350_start_inflight(mcu);
  RP2350_writeUint32(mcu, 0x400b0010u, 5000); // TIMER0 ALARM0: 5 ms from now
}

// RISC-V RP2350: registers round-trip, in-flight work completes again after a
// restore, the clock rewinds, and execution continues as if never interrupted.
static void check_save_state_rp2350(void) {
  RP2350Options options = {.coreArch = "riscv", .loadFirmware = NULL};
  RP2350* mcu = RP2350_new(&options);
  mcu->usbCtrl->onEndpointWrite_fn = on_endpoint_write;
  mcu->usbCtrl->onEndpointWrite_ctx = NULL;
  const int32_t idleSize = RP2350_serializeSize(mcu, 0);

  // Plain registers, far from their reset values.
  RP2350_writeUint32(mcu, 0x40070024u, 65);          // UART0 IBRD
  RP2350_writeUint32(mcu, 0x400d8010u, 0xdeadbeefu); // WATCHDOG SCRATCH1
  RP2350_writeUint32(mcu, 0x50200048u, 0x6001u);     // PIO0 INSTR_MEM0
  RP2350_writeUint32(mcu, 0xd0000060u, 100);         // SIO UDIVIDEND
  RP2350_writeUint32(mcu, 0xd0000064u, 7);           // SIO UDIVISOR
  start_inflight(mcu);

  // An upper bound: pending work, even a pending host alarm, must not move it.
  host_alarm_fires = 0;
  IAlarm host = SimulationClock_createAlarm(
      mcu->clock, (AlarmCallback){.obj = NULL, .vtable = &host_alarm_vtable});
  checkI32("host alarm is unregistered", ((ClockAlarm*)host.obj)->id, -1);
  IAlarm_schedule(host, 3.0);
  const int32_t size = RP2350_serializeSize(mcu, 0);
  checkI32("serializeSize ignores pending work", size, idleSize);

  uint8_t* state = calloc(1, size);
  checkBool("rv serialize", RP2350_serialize(mcu, state, size, 0), true);
  const uint32_t totalWords = ((uint32_t*)state)[5];
  checkU32("state magic", ((uint32_t*)state)[0], 0x52505353u);
  checkBool("state fits in serializeSize()", 6 + (int64_t)totalWords <= size / 4, true);
  // Let everything finish, then overwrite the registers: the state must bring
  // both the old values and the half-done work back.
  SimulationClock_tick(mcu->clock, 10e6); // nanoseconds
  checkI32("host alarm fired once", host_alarm_fires, 1);
  checkI32("USB buffer delivered once before the restore", usb_writes, 1);
  checkU32("DMA copied before the restore", RP2350_readUint32(mcu, INFLIGHT_DST + 12), 0x778899aau);
  checkU32("ADC converted before the restore", RP2350_readUint32(mcu, 0x400a0004u), 0x9abu);
  RP2350_writeUint32(mcu, 0x40070024u, 1);
  RP2350_writeUint32(mcu, 0x400d8010u, 0);
  RP2350_writeUint32(mcu, 0x50200048u, 0);
  for (int i = 0; i < 4; i++) RP2350_writeUint32(mcu, INFLIGHT_DST + 4 * i, 0);
  RP2350_writeUint32(mcu, 0x50000008u, 99);
  mcu->adc->channelValues[2] = 0x123;
  IAlarm_schedule(host, 3.0); // pending again, but not part of the state

  checkBool("rv unserialize", RP2350_unserialize(mcu, state, size), true);
  checkU32("UART IBRD restored", RP2350_readUint32(mcu, 0x40070024u), 65);
  checkU32("WATCHDOG SCRATCH1 restored", RP2350_readUint32(mcu, 0x400d8010u), 0xdeadbeefu);
  checkU32("PIO instruction restored", mcu->pio[0]->instructions[0], 0x6001u);
  checkU32("SIO divider restored (100 / 7)", RP2350_readUint32(mcu, 0xd0000070u), 14);
  checkF64("clock rewound to the snapshot", SimulationClock_getNanos(mcu->clock), 0.0);
  checkBool("pending host alarm cancelled, not restored", ((ClockAlarm*)host.obj)->scheduled, false);

  SimulationClock_tick(mcu->clock, 4e6);
  checkI32("USB buffer delivered again after the restore", usb_writes, 2);
  checkBool("...with the same bytes", memcmp(usb_last, "\xa0\xa1\xa2\xa3", 4) == 0, true);
  checkU32("DMA copy repeated after the restore", RP2350_readUint32(mcu, INFLIGHT_DST + 12), 0x778899aau);
  checkI32("DMA count restored before the transfer", RP2350_readUint32(mcu, 0x50000008u), 0);
  checkU32("ADC converted the captured input after the restore", RP2350_readUint32(mcu, 0x400a0004u), 0x9abu);
  checkU32("TIMER0 alarm still armed 4 ms in", RP2350_readUint32(mcu, 0x400b0020u) & 1u, 1u);
  checkU32("TIMER0 alarm not fired early", RP2350_readUint32(mcu, 0x400b003cu) & 1u, 0u);
  SimulationClock_tick(mcu->clock, 2e6);
  checkU32("TIMER0 alarm fired after the restore", RP2350_readUint32(mcu, 0x400b003cu) & 1u, 1u);
  checkI32("cancelled host alarm does not fire again", host_alarm_fires, 1);
  free(state);

  // A serialize that fails leaves its buffer unusable (see IRPChip.serialize). That
  // is the one rejection unserialize detects only after applying the body, so it goes
  // last, with a scratch buffer of its own.
  uint8_t* scratch = calloc(1, size);
  checkBool("serialize into a scratch buffer", RP2350_serialize(mcu, scratch, size, 0), true);
  const int32_t oneShort = (6 + (int32_t)((uint32_t*)scratch)[5]) * 4 - 1;
  checkBool("serialize refuses a short buffer", RP2350_serialize(mcu, scratch, oneShort, 0), false);
  checkBool("unserialize rejects what a failed serialize left behind",
            RP2350_unserialize(mcu, scratch, size), false);
  free(scratch);

  // Continuing after a restore must reproduce the uninterrupted run. A loop in
  // SRAM (addi x5,x5,1 ; jal x0,-4) keeps the core busy without any firmware.
  const uint32_t code = 0x20040000u;
  RP2350_writeUint32(mcu, code, 0x00128293u);
  RP2350_writeUint32(mcu, code + 4, 0xffdff06fu); // jal x0, -4
  CPU* cpu = RP2350_riscvCore0_get(mcu);
  cpu->pc = (int32_t)code;
  cpu->next_pc = (int32_t)(code + 4);
  cpu->regs[5] = 0;
  for (int i = 0; i < 10; i++) CPU_executeInstruction(cpu);
  checkI32("rv loop ran to the snapshot", cpu->regs[5], 5);
  const int32_t loopSize = RP2350_serializeSize(mcu, 0);
  uint8_t* loopState = calloc(1, loopSize);
  checkBool("rv loop serialize", RP2350_serialize(mcu, loopState, loopSize, 0), true);
  const int32_t pcAtSnapshot = cpu->pc;
  for (int i = 0; i < 20; i++) CPU_executeInstruction(cpu);
  checkI32("rv loop uninterrupted", cpu->regs[5], 15);
  const int32_t pcAfter = cpu->pc;
  const int64_t cyclesAfter = cpu->cycles;

  checkBool("rv loop unserialize", RP2350_unserialize(mcu, loopState, loopSize), true);
  checkI32("rv loop rewound", cpu->regs[5], 5);
  checkI32("rv pc rewound", cpu->pc, pcAtSnapshot);
  for (int i = 0; i < 20; i++) CPU_executeInstruction(cpu);
  checkI32("rv loop replays", cpu->regs[5], 15);
  checkI32("rv pc replays", cpu->pc, pcAfter);
  checkI64("rv cycles replay", cpu->cycles, cyclesAfter);
  free(loopState);
}

// ARM RP2350: float registers by raw bits, the pending-fault sentinel, and
// continuing after a restore.
static void check_save_state_arm(void) {
  RP2350Options options = {.coreArch = "arm", .loadFirmware = NULL};
  RP2350* mcu = RP2350_new(&options);
  CortexM33Core* core = RP2350_armCore0_get(mcu);
  checkI32("pendingFault resets to NO_PENDING_FAULT", core->pendingFault, NO_PENDING_FAULT);

  // Signed zero, both infinities, a NaN, the smallest subnormal, the largest finite, pi.
  const uint32_t bits[8] = {0, 0x80000000u, 0x7f800000u, 0xff800000u,
                            0x7fc00000u, 0x00000001u, 0x7f7fffffu, 0x40490fdbu};
  for (int i = 0; i < 8; i++) memcpy(&core->regs->s[i], &bits[i], 4);

  // A stack in SRAM and a `b .` to execute: the fault is delivered after an
  // instruction, and the exception frame needs somewhere to go.
  const uint32_t code = 0x20040100u;
  RP2350_writeUint16(mcu, code, 0xE7FEu); // b .
  core->regs->r[13] = 0x20041000u;
  core->regs->msp = 0x20041000u;
  core->regs->control = 0; // SPSEL = 0: stack on MSP
  core->regs->r[15] = code;

  core->pendingFault = Fault_UsageFault;
  const int32_t size = RP2350_serializeSize(mcu, 0);
  uint8_t* state = calloc(1, size);
  checkBool("arm serialize", RP2350_serialize(mcu, state, size, 0), true);
  core->pendingFault = NO_PENDING_FAULT; // the scramble
  for (int i = 0; i < 8; i++) core->regs->s[i] = 1.0f;
  checkBool("arm unserialize", RP2350_unserialize(mcu, state, size), true);
  checkI32("a pending UsageFault survives a restore", core->pendingFault, Fault_UsageFault);
  for (int i = 0; i < 8; i++) {
    uint32_t got;
    memcpy(&got, &core->regs->s[i], 4);
    char label[64];
    snprintf(label, sizeof label, "S%d restored bit-exactly", i);
    checkU32(label, got, bits[i]);
  }

  // `pendingFault` used to hold null for "none", which is 0 in C — the same value
  // as Fault.UsageFault — so the generated code silently dropped the fault.
  CortexM33Core_executeInstruction(core);
  checkI32("pending UsageFault is delivered", core->pendingFault, NO_PENDING_FAULT);
  checkU32("...escalated to HardFault, which is not enabled", core->regs->xpsr & 0x1ffu, 3u);
  free(state);

  // Thumb loop: adds r5,#1 ; b code
  RP2350_writeUint16(mcu, code, 0x3501u); // adds r5, #1
  RP2350_writeUint16(mcu, code + 2, 0xE7FDu); // b code
  core->regs->r[5] = 0;
  core->regs->r[15] = code;
  core->regs->xpsr = 0x01000000u; // Thread mode, Thumb
  core->currentMode = 0;
  for (int i = 0; i < 10; i++) CortexM33Core_executeInstruction(core);
  checkI32("m33 loop ran to the snapshot", (int32_t)core->regs->r[5], 5);
  const int32_t loopSize = RP2350_serializeSize(mcu, 0);
  uint8_t* loopState = calloc(1, loopSize);
  checkBool("m33 loop serialize", RP2350_serialize(mcu, loopState, loopSize, 0), true);
  const uint32_t pcAtSnapshot = core->regs->r[15];
  for (int i = 0; i < 20; i++) CortexM33Core_executeInstruction(core);
  checkI32("m33 loop uninterrupted", (int32_t)core->regs->r[5], 15);
  const uint32_t pcAfter = core->regs->r[15];
  const int64_t cyclesAfter = core->cycles;

  checkBool("m33 loop unserialize", RP2350_unserialize(mcu, loopState, loopSize), true);
  checkI32("m33 loop rewound", (int32_t)core->regs->r[5], 5);
  checkU32("m33 pc rewound", core->regs->r[15], pcAtSnapshot);
  for (int i = 0; i < 20; i++) CortexM33Core_executeInstruction(core);
  checkI32("m33 loop replays", (int32_t)core->regs->r[5], 15);
  checkU32("m33 pc replays", core->regs->r[15], pcAfter);
  checkI64("m33 cycles replay", core->cycles, cyclesAfter);
  free(loopState);
}

#define PSRAM_WINDOW 0x15000000u // cached PSRAM: XIP chip select 1
#define OMIT_BOTH (SAVE_STATE_OMIT_FLASH | SAVE_STATE_OMIT_PSRAM)
#define ALL_IMAGES \
  (SAVE_STATE_FLAG_FLASH | SAVE_STATE_FLAG_FLASH_WRITTEN | SAVE_STATE_FLAG_PSRAM | \
   SAVE_STATE_FLAG_PSRAM_WRITTEN)

// Flash and PSRAM are left out of a state until something writes them, and are part of
// every state from then on, unless omitted on request.
static void check_save_state_images(void) {
  RP2350Options options = {.coreArch = "riscv", .loadFirmware = NULL};
  RP2350* mcu = RP2350_new(&options);
  const int32_t full = RP2350_serializeSize(mcu, 0);
  const int32_t small = RP2350_serializeSize(mcu, OMIT_BOTH);

  // The plain bound covers both images even before anything has written them, so it
  // never grows later.
  checkI32("unwritten images: the plain bound covers exactly the two images", full - small, 24 * 1024 * 1024);
  checkBool("unwritten images: the bound without them is under 1 MiB", small < 1024 * 1024, true);
  uint8_t* tiny = calloc(1, small);
  checkBool("unwritten images: serialize() fits the small bound", RP2350_serialize(mcu, tiny, small, 0), true);
  const uint32_t* words = (const uint32_t*)tiny;
  checkU32("unwritten images: header flags", words[2], 0);
  checkU32("unwritten images: header flash changes", words[6], 0);
  checkU32("unwritten images: header PSRAM changes", words[7], 0);
  const int32_t plainBytes = (8 + (int32_t)words[5]) * 4;
  checkBool("unwritten images: the state itself is under 1 MiB", plainBytes < 1024 * 1024, true);
  checkBool("unwritten images: unserialize()", RP2350_unserialize(mcu, tiny, small), true);

  // An ordinary store into PSRAM puts it in every state from here on.
  RP2350_writeUint32(mcu, PSRAM_WINDOW, 0x1234);
  uint8_t* state = calloc(1, full);
  checkBool("PSRAM written: serialize()", RP2350_serialize(mcu, state, full, 0), true);
  words = (const uint32_t*)state;
  checkU32("PSRAM written: header flags", words[2], SAVE_STATE_FLAG_PSRAM | SAVE_STATE_FLAG_PSRAM_WRITTEN);
  checkU32("PSRAM written: header PSRAM changes", words[7], 1);
  checkI32("PSRAM written: the state grew by the image", (8 + (int32_t)words[5]) * 4 - plainBytes,
           8 * 1024 * 1024);
  RP2350* fresh = RP2350_new(&options);
  checkU32("fresh chip: PSRAM starts zeroed", RP2350_readUint32(fresh, PSRAM_WINDOW), 0);
  checkBool("PSRAM written: unserialize() onto a fresh chip", RP2350_unserialize(fresh, state, full), true);
  checkU32("PSRAM written: the image came back", RP2350_readUint32(fresh, PSRAM_WINDOW), 0x1234);

  // Omitted on request, with PSRAM written: accepted while nothing writes it again.
  RP2350_writeUint32(mcu, PSRAM_WINDOW + 4, 0x5678);
  checkBool("PSRAM omitted on request: serialize()", RP2350_serialize(mcu, tiny, small, SAVE_STATE_OMIT_PSRAM), true);
  words = (const uint32_t*)tiny;
  checkU32("PSRAM omitted on request: header flags", words[2], SAVE_STATE_FLAG_PSRAM_WRITTEN);
  checkU32("PSRAM omitted on request: header PSRAM changes", words[7], 2);
  RP2350_writeUint32(mcu, 0x20000100u, 7); // something else changes; PSRAM does not
  checkBool("PSRAM omitted, unchanged since: unserialize()", RP2350_unserialize(mcu, tiny, small), true);
  checkU32("PSRAM omitted: left exactly as it is", RP2350_readUint32(mcu, PSRAM_WINDOW + 4), 0x5678);
  RP2350_writeUint32(mcu, PSRAM_WINDOW + 8, 1); // PSRAM written again since the snapshot
  checkBool("PSRAM omitted, written again since: refused", RP2350_unserialize(mcu, tiny, small), false);

  // Flash: the QMI flash model reports an erase or program through invalidateFlashDecode.
  mcu->flash[0x110000] = 0x5a;
  RP2350_invalidateFlashDecode(mcu, 0x100, 4);
  checkBool("flash written: serialize()", RP2350_serialize(mcu, state, full, 0), true);
  words = (const uint32_t*)state;
  checkU32("flash written: header flags", words[2], ALL_IMAGES);
  checkU32("flash written: header flash changes", words[6], 1);
  RP2350* fresh2 = RP2350_new(&options);
  checkU32("fresh chip: flash is erased there", fresh2->flash[0x110000], 0xff);
  checkBool("flash written: unserialize() onto a fresh chip", RP2350_unserialize(fresh2, state, full), true);
  checkU32("flash written: the image came back", fresh2->flash[0x110000], 0x5a);
  checkU32("flash written: PSRAM came back too", RP2350_readUint32(fresh2, PSRAM_WINDOW + 4), 0x5678);
  // The restored chip knows the images are written: its own state carries them.
  uint8_t* again = calloc(1, full);
  RP2350_serialize(fresh2, again, full, 0);
  checkU32("restored chip: its next state carries both images", ((const uint32_t*)again)[2], ALL_IMAGES);
  free(again);
  free(state);
  free(tiny);
}

// RP2040: flash left out until written, registers round-trip, in-flight work completes
// again, the RTC keeps its time, and the Cortex-M0+ continues after a restore.
static void check_save_state_rp2040(void) {
  RP2040Options options = {.loadFirmware = NULL};
  RP2040* mcu = RP2040_new(&options);
  mcu->usbCtrl->onEndpointWrite_fn = on_endpoint_write;
  mcu->usbCtrl->onEndpointWrite_ctx = NULL;
  const uint32_t* words = NULL;
#define RP2040_RTC 0x4005c000u
#define RP2040_TIMER 0x40054000u // interrupt registers at +0x34 (0x3c on the RP2350)
#define RP2040_ADC 0x4004c000u
  const uint32_t rtcDate = (2024u << 12) | (6u << 8) | 15u;
  const uint32_t rtcTime = (6u << 24) | (13u << 16) | (40u << 8) | 59u;

  // The RTC's wall clock used to be stubbed out in this build (cts2c had no Date); it
  // is plain arithmetic now, so the C build can tell the time too.
  RP2040_writeUint32(mcu, RP2040_RTC + 0x04, (int32_t)rtcDate);
  RP2040_writeUint32(mcu, RP2040_RTC + 0x08, (int32_t)rtcTime);
  RP2040_writeUint32(mcu, RP2040_RTC + 0x0c, 0x10); // LOAD
  RP2040_writeUint32(mcu, RP2040_RTC + 0x0c, 0x01); // ENABLE
  checkU32("rp2040 RTC reads back the loaded date", RP2040_readUint32(mcu, RP2040_RTC + 0x18), rtcDate);
  checkU32("rp2040 RTC reads back the loaded time", RP2040_readUint32(mcu, RP2040_RTC + 0x1c), rtcTime);

  // Plain registers, far from their reset values.
  RP2040_writeUint32(mcu, 0x40034024u, 65);          // UART0 IBRD
  RP2040_writeUint32(mcu, 0x40058010u, 0xdeadbeefu); // WATCHDOG SCRATCH1
  RP2040_writeUint32(mcu, 0x50200048u, 0x6001u);     // PIO0 INSTR_MEM0
  RP2040_writeUint32(mcu, 0xd0000060u, 100);         // SIO UDIVIDEND
  RP2040_writeUint32(mcu, 0xd0000064u, 7);           // SIO UDIVISOR
  RP2040_writeUint32(mcu, RP2040_TIMER + 0x10, 5000); // ALARM0: 5 ms from now

  // In-flight USB, DMA and ADC work, without the flash write the harness variant adds.
  usb_writes = 0;
  RP_INFLIGHT_WORK(mcu, RP2040_writeUint32, INFLIGHT_CTRL_RP2040, RP2040_ADC, INFLIGHT_SRC_RP2040,
                   INFLIGHT_DST_RP2040);

  const int32_t full = RP2040_serializeSize(mcu, 0);
  const int32_t small = RP2040_serializeSize(mcu, SAVE_STATE_OMIT_FLASH);
  checkI32("rp2040: the plain bound covers exactly the flash image", full - small, 16 * 1024 * 1024);
  checkBool("rp2040: the bound without flash is under 1 MiB", small < 1024 * 1024, true);
  uint8_t* state = calloc(1, full);
  checkBool("rp2040 serialize", RP2040_serialize(mcu, state, full, 0), true);
  words = (const uint32_t*)state;
  checkU32("rp2040 state magic", words[0], 0x52505353u);
  checkU32("rp2040 header: chip id", words[3], 0);
  checkU32("rp2040 header: flash unwritten, so left out", words[2], 0);
  checkU32("rp2040 header: flash change count", words[6], 0);
  checkU32("rp2040 header: PSRAM change count (there is no PSRAM)", words[7], 0);
  const int32_t plainBytes = (8 + (int32_t)words[5]) * 4;
  checkBool("rp2040 unwritten flash: the state fits the small bound", plainBytes <= small, true);

  // Let everything finish, then scramble: the state must bring both the old values and
  // the half-done work back.
  SimulationClock_tick(mcu->clock, 10e6); // nanoseconds
  checkI32("rp2040 USB buffer delivered once before the restore", usb_writes, 1);
  checkU32("rp2040 DMA copied before the restore", RP2040_readUint32(mcu, INFLIGHT_DST_RP2040 + 12), 0x778899aau);
  checkU32("rp2040 ADC converted before the restore", RP2040_readUint32(mcu, RP2040_ADC + 4), 0x9abu);
  RP2040_writeUint32(mcu, 0x40034024u, 1);
  RP2040_writeUint32(mcu, 0x40058010u, 0);
  RP2040_writeUint32(mcu, 0x50200048u, 0);
  for (int i = 0; i < 4; i++) RP2040_writeUint32(mcu, INFLIGHT_DST_RP2040 + 4 * i, 0);
  RP2040_writeUint32(mcu, 0x50000008u, 99);
  mcu->adc->channelValues[2] = 0x123;
  RP2040_writeUint32(mcu, RP2040_RTC + 0x04, (2000 << 12) | (1 << 8) | 1); // another date
  RP2040_writeUint32(mcu, RP2040_RTC + 0x08, 0);
  RP2040_writeUint32(mcu, RP2040_RTC + 0x0c, 0x10);
  RP2040_writeUint32(mcu, RP2040_RTC + 0x0c, 0x01);
  checkU32("rp2040 RTC moved to the other date", RP2040_readUint32(mcu, RP2040_RTC + 0x18), (2000u << 12) | (1u << 8) | 1u);

  checkBool("rp2040 unserialize", RP2040_unserialize(mcu, state, full), true);
  checkU32("rp2040 UART IBRD restored", RP2040_readUint32(mcu, 0x40034024u), 65);
  checkU32("rp2040 WATCHDOG SCRATCH1 restored", RP2040_readUint32(mcu, 0x40058010u), 0xdeadbeefu);
  checkU32("rp2040 PIO instruction restored", mcu->pio[0]->instructions[0], 0x6001u);
  checkU32("rp2040 SIO divider restored (100 / 7)", RP2040_readUint32(mcu, 0xd0000070u), 14);
  checkU32("rp2040 RTC date restored", RP2040_readUint32(mcu, RP2040_RTC + 0x18), rtcDate);
  checkU32("rp2040 RTC time restored", RP2040_readUint32(mcu, RP2040_RTC + 0x1c), rtcTime);
  checkF64("rp2040 clock rewound to the snapshot", SimulationClock_getNanos(mcu->clock), 0.0);

  SimulationClock_tick(mcu->clock, 4e6);
  checkI32("rp2040 USB buffer delivered again after the restore", usb_writes, 2);
  checkBool("...with the same bytes", memcmp(usb_last, "\xa0\xa1\xa2\xa3", 4) == 0, true);
  checkU32("rp2040 DMA copy repeated after the restore", RP2040_readUint32(mcu, INFLIGHT_DST_RP2040 + 12), 0x778899aau);
  checkU32("rp2040 ADC converted the captured input after the restore", RP2040_readUint32(mcu, RP2040_ADC + 4), 0x9abu);
  checkU32("rp2040 TIMER alarm still armed 4 ms in", RP2040_readUint32(mcu, RP2040_TIMER + 0x20) & 1u, 1u);
  checkU32("rp2040 TIMER alarm not fired early", RP2040_readUint32(mcu, RP2040_TIMER + 0x34) & 1u, 0u);
  SimulationClock_tick(mcu->clock, 2e6);
  checkU32("rp2040 TIMER alarm fired after the restore", RP2040_readUint32(mcu, RP2040_TIMER + 0x34) & 1u, 1u);
  // The wall clock runs on from the restored baseline, as if nothing had happened.
  SimulationClock_tick(mcu->clock, 1.5e9);
  checkU32("rp2040 RTC kept time across the restore", RP2040_readUint32(mcu, RP2040_RTC + 0x1c),
           (6u << 24) | (13u << 16) | (41u << 8) | 0u);
  free(state);

  // Flash: an ordinary store into the flash window puts the image in every state. Two
  // states from the same instant, so that only the flash write tells them apart (each
  // queued clock alarm costs a word, and alarms come and go).
  uint8_t* before = calloc(1, full);
  RP2040_serialize(mcu, before, full, 0);
  checkU32("rp2040 flash still unwritten at this point", ((const uint32_t*)before)[2], 0);
  const int32_t beforeBytes = (8 + (int32_t)((const uint32_t*)before)[5]) * 4;
  free(before);
  RP2040_writeUint32(mcu, 0x10150000u, (int32_t)0x5a5a5a5au);
  uint8_t* withFlash = calloc(1, full);
  checkBool("rp2040 flash written: serialize", RP2040_serialize(mcu, withFlash, full, 0), true);
  words = (const uint32_t*)withFlash;
  checkU32("rp2040 flash written: header flags", words[2], SAVE_STATE_FLAG_FLASH | SAVE_STATE_FLAG_FLASH_WRITTEN);
  checkU32("rp2040 flash written: header flash change count", words[6], 1);
  checkI32("rp2040 flash written: the state grew by the image",
           (8 + (int32_t)words[5]) * 4 - beforeBytes, 16 * 1024 * 1024);
  RP2040* fresh = RP2040_new(&options);
  checkU32("rp2040 fresh chip: flash is erased there", RP2040_readUint32(fresh, 0x10150000u), 0xffffffffu);
  checkBool("rp2040 flash written: unserialize() onto a fresh chip", RP2040_unserialize(fresh, withFlash, full), true);
  checkU32("rp2040 flash written: the image came back", RP2040_readUint32(fresh, 0x10150000u), 0x5a5a5a5au);
  checkU32("rp2040 flash written: the RTC came back too", RP2040_readUint32(fresh, RP2040_RTC + 0x18), rtcDate);
  // The restored chip knows the image is written: its own next state carries it.
  uint8_t* again = calloc(1, full);
  RP2040_serialize(fresh, again, full, 0);
  checkU32("rp2040 restored chip: its next state carries the image",
           ((const uint32_t*)again)[2], SAVE_STATE_FLAG_FLASH | SAVE_STATE_FLAG_FLASH_WRITTEN);
  free(again);

  // Omitted on request once written: accepted while nothing writes it again.
  uint8_t* omitted = calloc(1, small);
  checkBool("rp2040 flash omitted on request: serialize", RP2040_serialize(mcu, omitted, small, SAVE_STATE_OMIT_FLASH), true);
  checkU32("rp2040 flash omitted on request: header flags", ((const uint32_t*)omitted)[2], SAVE_STATE_FLAG_FLASH_WRITTEN);
  checkU32("rp2040 flash omitted on request: header flash change count", ((const uint32_t*)omitted)[6], 1);
  checkBool("rp2040 flash omitted, unchanged since: unserialize()", RP2040_unserialize(mcu, omitted, small), true);
  RP2040_writeUint32(mcu, 0x10150004u, 1u); // written again since the snapshot
  checkBool("rp2040 flash omitted, written again since: refused", RP2040_unserialize(mcu, omitted, small), false);
  free(omitted);
  free(withFlash);

  // Continuing after a restore must reproduce the uninterrupted run. A loop in SRAM
  // (adds r5,#1 ; b) keeps the core busy without any firmware.
  const uint32_t code = 0x20040100u;
  RP2040_writeUint16(mcu, code, 0x3501u);       // adds r5, #1
  RP2040_writeUint16(mcu, code + 2, 0xE7FDu);  // b code
  CortexM0Core* core = mcu->core[0];
  core->registers[5] = 0;
  core->registers[15] = code;
  for (int i = 0; i < 10; i++) CortexM0Core_executeInstruction(core);
  checkI32("m0 loop ran to the snapshot", (int32_t)core->registers[5], 5);
  const int32_t loopSize = RP2040_serializeSize(mcu, 0);
  uint8_t* loopState = calloc(1, loopSize);
  checkBool("m0 loop serialize", RP2040_serialize(mcu, loopState, loopSize, 0), true);
  const uint32_t pcAtSnapshot = core->registers[15];
  for (int i = 0; i < 20; i++) CortexM0Core_executeInstruction(core);
  checkI32("m0 loop uninterrupted", (int32_t)core->registers[5], 15);
  const uint32_t pcAfter = core->registers[15];
  const int64_t cyclesAfter = core->cycles;

  checkBool("m0 loop unserialize", RP2040_unserialize(mcu, loopState, loopSize), true);
  checkI32("m0 loop rewound", (int32_t)core->registers[5], 5);
  checkU32("m0 pc rewound", core->registers[15], pcAtSnapshot);
  for (int i = 0; i < 20; i++) CortexM0Core_executeInstruction(core);
  checkI32("m0 loop replays", (int32_t)core->registers[5], 15);
  checkU32("m0 pc replays", core->registers[15], pcAfter);
  checkI64("m0 cycles replay", core->cycles, cyclesAfter);
  free(loopState);
#undef RP2040_RTC
#undef RP2040_TIMER
#undef RP2040_ADC
}

int main(void) {
  // cts2c stubs abort() the process; buffered stdout would lose everything up to there.
  setvbuf(stdout, NULL, _IONBF, 0);

  // floatToBits/bitsToFloat: 3.14159f's real IEEE-754 bits are 0x40490FD0 — NOT the
  // bit pattern for 3.0f (0x40400000), which is what the pre-fix
  // truncate-to-int32-then-reconvert bug would have silently produced instead.
  float pi_f = 3.14159f;
  uint32_t pi_bits = 0x40490FD0u;
  checkU32("floatToBits(3.14159f)", (uint32_t)floatToBits(pi_f), pi_bits);
  checkF32("bitsToFloat(0x40490FD0)", bitsToFloat((int32_t)pi_bits), pi_f);

  // Negative fractional value.
  float neg_f = -2.5f;
  uint32_t neg_bits = 0xC0200000u;
  checkU32("floatToBits(-2.5f)", (uint32_t)floatToBits(neg_f), neg_bits);
  checkF32("bitsToFloat(0xC0200000)", bitsToFloat((int32_t)neg_bits), neg_f);

  // isSignNegative: real double bit-sign check, not a truncated-then-reconverted value.
  checkBool("isSignNegative(3.14159)", isSignNegative(3.14159), false);
  checkBool("isSignNegative(-3.14159)", isSignNegative(-3.14159), true);
  checkBool("isSignNegative(-0.0)", isSignNegative(-0.0), true);
  checkBool("isSignNegative(0.0)", isSignNegative(0.0), false);

  // readDouble/writeDouble: round-trip a genuinely fractional double through the
  // "halves" storage DCP registers actually use.
  M33CoreState st;
  uint32_t halves[16] = {0};
  st.dcpHalves = halves;
  double pi = 3.14159265358979;
  writeDouble(&st, 2, pi);
  checkF64("readDouble(writeDouble(pi))", readDouble(&st, 2), pi);

  double negVal = -123456.789;
  writeDouble(&st, 5, negVal);
  checkF64("readDouble(writeDouble(-123456.789))", readDouble(&st, 5), negVal);

  // f64ToI32Sat/f64ToU32Sat (DCP d2i/d2u): a plain `number` param truncates to
  // int32_t at the call boundary, discarding the fractional part BEFORE the
  // function's own truncate-toward-zero logic ever runs — 42.9 truncated to 42
  // (int32_t) first, then to 42 again, silently matching by coincidence; the real
  // bug shows on a value whose int32-truncated bit pattern differs from its
  // correct double-truncated one, e.g. anything requiring the saturation checks
  // to see the ORIGINAL fractional value, or simply a large fractional value.
  checkI32("f64ToI32Sat(42.9)", f64ToI32Sat(42.9), 42);
  checkI32("f64ToI32Sat(-42.9)", f64ToI32Sat(-42.9), -42);
  checkI32("f64ToI32Sat(3000000000.5)", f64ToI32Sat(3000000000.5), 0x7fffffff);
  checkU32("f64ToU32Sat(42.9)", (uint32_t)f64ToU32Sat(42.9), 42u);
  checkU32("f64ToU32Sat(5000000000.5)", (uint32_t)f64ToU32Sat(5000000000.5), 0xffffffffu);

  // stateF64Lo/Hi/From and stateF32ToBits/FromBits: the save-state stream's own
  // bit-reinterpretation bodies. 0.1 has no finite binary representation, so a
  // numeric conversion would not round-trip its bits (0x3FB999999999999A).
  checkU32("stateF64Lo(0.1)", (uint32_t)stateF64Lo(0.1), 0x9999999Au);
  checkU32("stateF64Hi(0.1)", (uint32_t)stateF64Hi(0.1), 0x3FB99999u);
  checkF64("stateF64From(lo, hi) of 0.1", stateF64From((int32_t)0x9999999Au, (int32_t)0x3FB99999u), 0.1);
  checkU32("stateF64Hi(-0.0)", (uint32_t)stateF64Hi(-0.0), 0x80000000u);
  checkU32("stateF32ToBits(3.14159f)", (uint32_t)stateF32ToBits(3.14159f), 0x40490FD0u);
  checkF32("stateF32FromBits(0x40490FD0)", stateF32FromBits((int32_t)0x40490FD0u), 3.14159f);

  // ─── checkTraceMagic (RISC-V) ──────────────────────────────────────────
  // The `j` over the marker is 4 bytes, so the marker sits at the link address
  // itself (0xabcd at +0, 0xffff at +2) and the tag at +4. The hook reports the
  // cpu's CURRENT pc/mhartid — not the marker address.
  {
    RP2350Options options = {.coreArch = "riscv", .loadFirmware = NULL};
    RP2350* mcu = RP2350_new(&options);
    mcu->onTrace_fn = on_trace;
    mcu->onTrace_ctx = (void*)0x1234;
    CPU* cpu = RP2350_riscvCore1_get(mcu); // core 1 proves the number is forwarded
    const uint32_t base = 0x20000000;
    RP2350_writeUint16(mcu, base, 0xabcd);
    RP2350_writeUint16(mcu, base + 2, 0xffff);
    rp2350_write_tag(mcu, base + 4, "riscv trace");
    cpu->pc = 0x20000123; // distinctive: the callback must see THIS, not `base`

    trace_reset();
    checkTraceMagic(cpu, base);
    checkI32("trace riscv fired once", trace_calls, 1);
    checkI32("trace riscv core number", trace_core, 1);
    checkI32("trace riscv pc", trace_pc, 0x20000123);
    checkStr("trace riscv tag", trace_tag, "riscv trace");
    checkBool("trace riscv ctx passthrough", trace_ctx_seen == (void*)0x1234, true);

    // Half a marker (0xffff missing) must stay silent.
    trace_reset();
    RP2350_writeUint16(mcu, base + 2, 0x0000);
    checkTraceMagic(cpu, base);
    checkI32("trace riscv no fire on bad marker", trace_calls, 0);
  }

  // ─── checkTraceMagicM33 (Cortex-M33) ───────────────────────────────────
  // Thumb `b` is 2 bytes, so the marker sits at opcodePC+2/+4 and the tag at
  // +6. The hook reports (coreIndex, opcodePC).
  {
    RP2350Options options = {.coreArch = "arm", .loadFirmware = NULL};
    RP2350* mcu = RP2350_new(&options);
    mcu->onTrace_fn = on_trace;
    CortexM33Core* core = RP2350_armCore1_get(mcu);
    const uint32_t base = 0x20000100;
    RP2350_writeUint16(mcu, base + 2, 0xabcd);
    RP2350_writeUint16(mcu, base + 4, 0xffff);
    rp2350_write_tag(mcu, base + 6, "m33 trace");

    trace_reset();
    checkTraceMagicM33(core, base);
    checkI32("trace m33 fired once", trace_calls, 1);
    checkI32("trace m33 core number", trace_core, 1);
    checkI32("trace m33 pc", trace_pc, (int32_t)base);
    checkStr("trace m33 tag", trace_tag, "m33 trace");

    // Empty tag (NUL right after the marker) fires with "".
    trace_reset();
    RP2350_writeUint8(mcu, base + 6, 0);
    checkTraceMagicM33(core, base);
    checkI32("trace m33 empty tag fired", trace_calls, 1);
    checkStr("trace m33 empty tag", trace_tag, "");

    // A 70-char tag is capped at 63 chars by the 64-byte stack buffer (the C
    // body's documented divergence from the unbounded TS string building).
    trace_reset();
    char longTag[71];
    memset(longTag, 'A', sizeof longTag - 1);
    longTag[sizeof longTag - 1] = '\0';
    rp2350_write_tag(mcu, base + 6, longTag);
    char wantTag[64];
    memset(wantTag, 'A', sizeof wantTag - 1);
    wantTag[sizeof wantTag - 1] = '\0';
    checkTraceMagicM33(core, base);
    checkStr("trace m33 long tag truncated to 63", trace_tag, wantTag);

    // No marker at all must stay silent.
    trace_reset();
    RP2350_writeUint16(mcu, base + 2, 0x1234);
    checkTraceMagicM33(core, base);
    checkI32("trace m33 no fire on bad marker", trace_calls, 0);
  }

  // ─── checkTraceMagicM0 (Cortex-M0+, RP2040) ────────────────────────────
  // Same +2/+4/+6 marker layout as M33, but reads go through the M0 core's
  // own helpers and the hook reports (coreNumber, current PC).
  {
    RP2040Options options = {.loadFirmware = NULL};
    RP2040* mcu = RP2040_new(&options);
    mcu->onTrace_fn = on_trace;
    CortexM0Core* core = RP2040_core0_get(mcu);
    const uint32_t base = 0x20000000;
    RP2040_writeUint16(mcu, base + 2, 0xabcd);
    RP2040_writeUint16(mcu, base + 4, 0xffff);
    rp2040_write_tag(mcu, base + 6, "m0 trace");
    int32_t pcBefore = CortexM0Core_PC_get(core);

    trace_reset();
    checkTraceMagicM0(core, base);
    checkI32("trace m0 fired once", trace_calls, 1);
    checkI32("trace m0 core number", trace_core, 0);
    checkI32("trace m0 pc", trace_pc, pcBefore);
    checkStr("trace m0 tag", trace_tag, "m0 trace");

    // No marker must stay silent.
    trace_reset();
    RP2040_writeUint16(mcu, base + 2, 0x0000);
    checkTraceMagicM0(core, base);
    checkI32("trace m0 no fire on bad marker", trace_calls, 0);
  }

  // ─── RISC-V add/sub/mul/div (RV32IM opcodes) ───────────────────────────
  {
    RP2350Options options = {.coreArch = "riscv", .loadFirmware = NULL};
    RP2350* mcu = RP2350_new(&options);
    CPU* cpu = RP2350_riscvCore0_get(mcu);

    // ADD: wrap at the signed/unsigned top.
    checkU32("rv add 0x7fffffff+1", rv_alu(mcu, cpu, rv_r(0, 0x00), 0x7fffffff, 1), 0x80000000u);
    checkU32("rv add 0xffffffff+0xffffffff", rv_alu(mcu, cpu, rv_r(0, 0x00), 0xffffffff, 0xffffffff), 0xfffffffeu);
    // SUB: borrow across zero and out of INT_MIN.
    checkU32("rv sub 0-1", rv_alu(mcu, cpu, rv_r(0, 0x20), 0, 1), 0xffffffffu);
    checkU32("rv sub 0x80000000-1", rv_alu(mcu, cpu, rv_r(0, 0x20), 0x80000000, 1), 0x7fffffffu);
    // MUL: low 32 bits only.
    checkU32("rv mul 0x10001*0x10001", rv_alu(mcu, cpu, rv_r(0, 0x01), 0x00010001, 0x00010001), 0x00020001u);
    checkU32("rv mul -1*-1", rv_alu(mcu, cpu, rv_r(0, 0x01), 0xffffffff, 0xffffffff), 1);
    checkU32("rv mul 0x80000000*2", rv_alu(mcu, cpu, rv_r(0, 0x01), 0x80000000, 2), 0);
    // MULH/MULHU/MULHSU: THE signed-vs-unsigned discriminator.
    checkU32("rv mulh INT_MIN*INT_MIN", rv_alu(mcu, cpu, rv_r(1, 0x01), 0x80000000, 0x80000000), 0x40000000u);
    checkU32("rv mulh INT_MIN*INT_MAX", rv_alu(mcu, cpu, rv_r(1, 0x01), 0x80000000, 0x7fffffff), 0xc0000000u);
    checkU32("rv mulhu 0xffffffff*0xffffffff", rv_alu(mcu, cpu, rv_r(3, 0x01), 0xffffffff, 0xffffffff), 0xfffffffeu);
    checkU32("rv mulhsu -1*0xffffffff", rv_alu(mcu, cpu, rv_r(2, 0x01), 0xffffffff, 0xffffffff), 0xffffffffu);
    // DIV: truncate toward zero, remainder takes the dividend's sign.
    checkU32("rv div -7/2", rv_alu(mcu, cpu, rv_r(4, 0x01), (uint32_t)-7, 2), 0xfffffffcu + 1); // -3
    checkU32("rv div INT_MIN/-1", rv_alu(mcu, cpu, rv_r(4, 0x01), 0x80000000, 0xffffffff), 0x80000000u);
    checkU32("rv div 7/-2", rv_alu(mcu, cpu, rv_r(4, 0x01), 7, 0xfffffffe), 0xfffffffcu + 1); // -3
    checkU32("rv divu 0xffffffff/0x10", rv_alu(mcu, cpu, rv_r(5, 0x01), 0xffffffff, 0x10), 0x0fffffffu);
    // RISC-V div-by-zero is NOT a trap: quotient all-ones, remainder = dividend.
    checkU32("rv div 5/0", rv_alu(mcu, cpu, rv_r(4, 0x01), 5, 0), 0xffffffffu);
    checkU32("rv divu 5/0", rv_alu(mcu, cpu, rv_r(5, 0x01), 5, 0), 0xffffffffu);
    checkU32("rv rem -7%2", rv_alu(mcu, cpu, rv_r(6, 0x01), (uint32_t)-7, 2), 0xffffffffu); // -1
    checkU32("rv rem 7%-2", rv_alu(mcu, cpu, rv_r(6, 0x01), 7, 0xfffffffe), 1);
    checkU32("rv rem INT_MIN%-1", rv_alu(mcu, cpu, rv_r(6, 0x01), 0x80000000, 0xffffffff), 0);
    checkU32("rv remu 0xffffffff%0x10", rv_alu(mcu, cpu, rv_r(7, 0x01), 0xffffffff, 0x10), 0xfu);
    checkU32("rv rem 5%0", rv_alu(mcu, cpu, rv_r(6, 0x01), 5, 0), 5);
    checkU32("rv remu 5%0", rv_alu(mcu, cpu, rv_r(7, 0x01), 5, 0), 5);
  }

  // ─── Cortex-M33 add/sub/mul/div (Thumb-16 + Thumb-32) ──────────────────
  // ADDS r5,r1,r2 / SUBS r5,r1,r2 / MULS r5,r1,r5 (rd==rm) / SDIV|UDIV r5,r1,r2 /
  // SMULL|UMULL r5,r6,r1,r2.
  {
    RP2350Options options = {.coreArch = "arm", .loadFirmware = NULL};
    RP2350* mcu = RP2350_new(&options);
    CortexM33Core* core = RP2350_armCore0_get(mcu);
    const uint16_t ADDS = 0x188d, SUBS = 0x1a8d, MULS = 0x434d; // rm=r2/r5, rn=r1, rd=r5
    const uint16_t SDIV_W1 = 0xfb91, UDIV_W1 = 0xfbb1, DIV_W2 = 0xf5f2; // r5 = r1 op r2
    const uint16_t SMULL_W1 = 0xfb81, UMULL_W1 = 0xfba1, MULL_W2 = 0x5602; // r5=lo, r6=hi
    uint32_t hi;

    checkU32("m33 adds 0x7fffffff+1", m33_exec(mcu, core, ADDS, 0, 0x7fffffff, 1, NULL), 0x80000000u);
    checkBool("m33 adds 0x7fffffff+1 N", M33Registers_N_get(core->regs), true);
    checkBool("m33 adds 0x7fffffff+1 V", M33Registers_V_get(core->regs), true);
    checkBool("m33 adds 0x7fffffff+1 C", M33Registers_C_get(core->regs), false);
    checkU32("m33 adds 0xffffffff+1", m33_exec(mcu, core, ADDS, 0, 0xffffffff, 1, NULL), 0);
    checkBool("m33 adds 0xffffffff+1 Z", M33Registers_Z_get(core->regs), true);
    checkBool("m33 adds 0xffffffff+1 C", M33Registers_C_get(core->regs), true); // carry, not signed ovf
    checkBool("m33 adds 0xffffffff+1 V", M33Registers_V_get(core->regs), false);
    checkU32("m33 subs 0-1", m33_exec(mcu, core, SUBS, 0, 0, 1, NULL), 0xffffffffu);
    checkBool("m33 subs 0-1 N", M33Registers_N_get(core->regs), true);
    checkBool("m33 subs 0-1 C", M33Registers_C_get(core->regs), false); // borrow
    checkU32("m33 subs 0x80000000-1", m33_exec(mcu, core, SUBS, 0, 0x80000000, 1, NULL), 0x7fffffffu);
    checkBool("m33 subs 0x80000000-1 V", M33Registers_V_get(core->regs), true);
    checkBool("m33 subs 0x80000000-1 C", M33Registers_C_get(core->regs), true); // no borrow unsigned

    checkU32("m33 muls 0x10001*0x10001", m33_exec(mcu, core, MULS, 0, 0x00010001, 0x00010001, NULL), 0x00020001u);
    checkU32("m33 muls -1*-1", m33_exec(mcu, core, MULS, 0, 0xffffffff, 0xffffffff, NULL), 1);
    checkU32("m33 smull INT_MIN*INT_MIN lo", m33_exec(mcu, core, SMULL_W1, MULL_W2, 0x80000000, 0x80000000, &hi), 0);
    checkU32("m33 smull INT_MIN*INT_MIN hi", hi, 0x40000000u);
    checkU32("m33 smull -1*1 lo", m33_exec(mcu, core, SMULL_W1, MULL_W2, 0xffffffff, 1, &hi), 0xffffffffu);
    checkU32("m33 smull -1*1 hi", hi, 0xffffffffu);
    checkU32("m33 umull 0xffffffff*0xffffffff lo", m33_exec(mcu, core, UMULL_W1, MULL_W2, 0xffffffff, 0xffffffff, &hi), 1);
    checkU32("m33 umull 0xffffffff*0xffffffff hi", hi, 0xfffffffeu);

    checkU32("m33 sdiv -7/2", m33_exec(mcu, core, SDIV_W1, DIV_W2, (uint32_t)-7, 2, NULL), (uint32_t)-3);
    checkU32("m33 sdiv INT_MIN/-1", m33_exec(mcu, core, SDIV_W1, DIV_W2, 0x80000000, 0xffffffff, NULL), 0x80000000u);
    checkU32("m33 sdiv 5/0", m33_exec(mcu, core, SDIV_W1, DIV_W2, 5, 0, NULL), 0); // untrapped: 0
    checkU32("m33 udiv 0xffffffff/0x10", m33_exec(mcu, core, UDIV_W1, DIV_W2, 0xffffffff, 0x10, NULL), 0x0fffffffu);
    checkU32("m33 udiv 5/0", m33_exec(mcu, core, UDIV_W1, DIV_W2, 5, 0, NULL), 0); // untrapped: 0
  }

  // ─── Cortex-M0+ add/sub/mul (Thumb-16; no div on this core) ────────────
  {
    RP2040Options options = {.loadFirmware = NULL};
    RP2040* mcu = RP2040_new(&options);
    CortexM0Core* core = RP2040_core0_get(mcu);
    const uint16_t ADDS = 0x188d, SUBS = 0x1a8d, MULS = 0x434d; // rm=r2/r5, rn=r1, rd=r5

    checkU32("m0 adds 0x7fffffff+1", m0_exec(mcu, core, ADDS, 0x7fffffff, 1), 0x80000000u);
    checkBool("m0 adds 0x7fffffff+1 N", core->N, true);
    checkBool("m0 adds 0x7fffffff+1 C", core->C, false);
    checkU32("m0 adds 0xffffffff+1", m0_exec(mcu, core, ADDS, 0xffffffff, 1), 0);
    checkBool("m0 adds 0xffffffff+1 Z", core->Z, true);
    checkBool("m0 adds 0xffffffff+1 C", core->C, true);
    checkU32("m0 subs 0-1", m0_exec(mcu, core, SUBS, 0, 1), 0xffffffffu);
    checkBool("m0 subs 0-1 N", core->N, true);
    checkBool("m0 subs 0-1 C", core->C, false); // borrow
    checkU32("m0 subs 0x80000000-1", m0_exec(mcu, core, SUBS, 0x80000000, 1), 0x7fffffffu);
    checkBool("m0 subs 0x80000000-1 C", core->C, true);
    checkU32("m0 muls 0x10001*0x10001", m0_exec(mcu, core, MULS, 0x00010001, 0x00010001), 0x00020001u);
    checkU32("m0 muls -1*-1", m0_exec(mcu, core, MULS, 0xffffffff, 0xffffffff), 1);
  }

  // ─── USB CDC enumeration + data (both chip flavors) ────────────────────
  check_usb_cdc_rp2350();
  check_usb_cdc_rp2040();

  // ─── Timer alarm scheduling past INT32_MAX ns ──────────────────────────
  check_timer_alarm_overflow();
  check_mtimecmp_unsigned();

  // ─── save states ──────────────────────────────────────────────────────
  check_state_stream();
  check_save_state_rp2350();
  check_save_state_arm();
  check_save_state_images();
  check_save_state_rp2040();

  if (failures > 0) {
    fprintf(stderr, "\n%d check(s) FAILED\n", failures);
    return 1;
  }
  printf("\nAll helper checks passed.\n");
  return 0;
}
