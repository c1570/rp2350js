// RP2350 C harness — runs a transpiled RP2350 emulator against a firmware image and
// prints the same per-block PC-trace CRC32 checksums as demo/perf-bench.ts, so the two
// runs can be bisected against each other on deviation instead of diffing full PC traces.
//
// Usage: rp2350-harness [firmware.hex] [targetCycles] [blockSize] [quietUntilStep] [dumpStart] [dumpCount] [coreArch]
//   blockSize     — steps per CRC block (default 1000000)
//   quietUntilStep — suppress pc_trace output before this step (default 0)
//   dumpStart     — if >0, dump PC + registers per step starting at this step (disables CRC mode)
//   dumpCount     — number of steps to dump (default 100)
//   coreArch      — "riscv" or "arm" (both RP2350, default "riscv") or "rp2040" (RP2040
//                   chip, Cortex-M0+). Appended as the LAST positional arg (rather than
//                   inserted earlier) so every existing call site that passes fewer args
//                   keeps today's default (riscv) behavior unchanged. For "arm" and
//                   "rp2040", the dump format still reports 32 "x" registers to match the
//                   existing side-by-side dump layout, but only x0-x15 are real (r0-r12,
//                   sp, lr, pc); x16-x31 are always 0.
//   restoreAtStep — (optional; appended last for the same reason) run a save/restore
//                   schedule on top of the trace. At this step — which must
//                   be a positive multiple of blockSize, so the blocks after the rewind
//                   line up with the first run's — serialize the chip (a `small_state`
//                   line: flash and PSRAM left out, as they are until something writes
//                   them), then leave a USB transfer, a DMA copy and an ADC conversion
//                   in flight and mark both images written, and serialize again (a
//                   `state` line with their 24 MiB). Each line carries the CRC32 of the
//                   state's bytes. Run on to the target
//                   (the first run), then unserialize and run to the target again, whose
//                   blocks print as `pc_trace phase=1 ...`. cts2c-ensure-parity.ts
//                   compares the state CRC against Node's, and the second run against
//                   the first.
#include "../build/transpile/rp2350js-c.h"
#include "inflight-work.h"
#include <stdlib.h>
#include <time.h>

static uint32_t crc32_table[256];

static void crc32_init(void) {
  for (uint32_t n = 0; n < 256; n++) {
    uint32_t c = n;
    for (int k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320u ^ (c >> 1)) : (c >> 1);
    crc32_table[n] = c;
  }
}

static uint32_t crc32_update_u32le(uint32_t crc, uint32_t value) {
  for (int i = 0; i < 4; i++) {
    uint8_t byte = (uint8_t)((value >> (i * 8)) & 0xff);
    crc = crc32_table[(crc ^ byte) & 0xff] ^ (crc >> 8);
  }
  return crc;
}

static uint32_t crc32_bytes(const uint8_t* p, size_t n) {
  uint32_t crc = 0xffffffffu;
  for (size_t i = 0; i < n; i++) crc = crc32_table[(crc ^ p[i]) & 0xff] ^ (crc >> 8);
  return crc ^ 0xffffffffu;
}

int main(int argc, char** argv) {
  const char* firmwarePath = argc > 1 ? argv[1] : "demo/riscv_blink/blink_simple.hex";
  long targetCycles = argc > 2 ? atol(argv[2]) : 50000000;
  long blockSize = argc > 3 ? atol(argv[3]) : 1000000;
  long quietUntilStep = argc > 4 ? atol(argv[4]) : 0;
  long dumpStart = argc > 5 ? atol(argv[5]) : 0;
  long dumpCount = argc > 6 ? atol(argv[6]) : 100;
  const char* coreArch = argc > 7 ? argv[7] : NULL; // NULL -> RP2350's own "riscv" default
  int isRp2040 = coreArch && strcmp(coreArch, "rp2040") == 0;
  int isArm = !isRp2040 && coreArch && strcmp(coreArch, "arm") == 0;
  long restoreAtStep = argc > 8 ? atol(argv[8]) : 0;
  if (restoreAtStep < 0 || (restoreAtStep > 0 && restoreAtStep % blockSize != 0)) {
    fprintf(stderr, "restoreAtStep must be a positive multiple of blockSize\n");
    return 2;
  }
  if (restoreAtStep > 0 && dumpStart > 0) {
    fprintf(stderr, "restoreAtStep is not available in dump mode\n");
    return 2;
  }

  crc32_init();

  // RP2040 is a distinct chip (not an RP2350 coreArch option), so it needs its own
  // options/instance/core-pointer setup rather than another branch of RP2350's.
  RP2040Options rp2040Options = { .loadFirmware = firmwarePath };
  RP2040* rp2040Mcu = isRp2040 ? RP2040_new(&rp2040Options) : NULL;
  CortexM0Core* core0m0 = isRp2040 ? rp2040Mcu->core[0] : NULL;

  RP2350Options options = { .coreArch = coreArch, .loadFirmware = firmwarePath };
  RP2350* mcu = isRp2040 ? NULL : RP2350_new(&options);

  // Exactly one of these is valid, chosen by isArm — .obj is the same underlying
  // pointer either way (mcu->core[0] is the ICpuCore fat pointer RP2350 actually
  // constructed), this just picks which concrete type to view it as.
  CPU* core0 = (isRp2040 || isArm) ? NULL : (CPU*)(mcu->core[0].obj);
  CortexM33Core* core0m33 = (!isRp2040 && isArm) ? (CortexM33Core*)(mcu->core[0].obj) : NULL;

  int dumpMode = dumpStart > 0;
  long dumpEnd = dumpStart + dumpCount;

  long steps = 0;
  uint8_t* state = NULL;
  int32_t stateSize = 0;

  clock_t t0 = clock();
  // Phase 0 is the first run. With a restoreAtStep, phase 1 rewinds to that step and
  // runs to the target again; `steps` is reset to it, so a block that starts on a
  // multiple of blockSize in one run starts on the same one in the other.
  for (int phase = 0;; phase++) {
    uint32_t blockCrc = 0xffffffff;
    long blockSteps = 0;
    long blockIndex = phase == 0 ? 0 : steps / blockSize;

    while ((isRp2040 ? RP2040_cycles_get(rp2040Mcu) : RP2350_cycles_get(mcu)) < targetCycles) {
      if (isRp2040) RP2040_step(rp2040Mcu); else RP2350_step(mcu);
      steps++;

      // CPU.pc is a plain field; CortexM33Core.PC/CortexM0Core.PC are getter-backed
      // (return regs.pc / a computed value) — no struct member to read directly for
      // the ARM/RP2040 cases, has to go through the real accessor.
      uint32_t pc = isRp2040 ? (uint32_t)CortexM0Core_PC_get(core0m0)
                  : isArm   ? (uint32_t)CortexM33Core_PC_get(core0m33)
                            : (uint32_t)core0->pc;

      if (dumpMode) {
        if (steps >= dumpStart && steps < dumpEnd) {
          fprintf(stderr, "DUMP step=%ld pc=0x%08x", steps, pc);
          if (isRp2040) {
            // RP2040 (Cortex-M0+) has only 16 real registers (r0-r12, sp, lr, pc);
            // pad the rest so the dump format matches RISC-V's 32-register layout
            // the parity script parses.
            for (int i = 0; i < 16; i++)
              fprintf(stderr, " x%d=0x%08x", i, (uint32_t)core0m0->registers[i]);
            for (int i = 16; i < 32; i++) fprintf(stderr, " x%d=0x%08x", i, 0u);
          } else if (isArm) {
            // Same padding, for Cortex-M33's r0-r12/SP/LR/PC.
            for (int i = 0; i < 16; i++)
              fprintf(stderr, " x%d=0x%08x", i, (uint32_t)core0m33->regs->r[i]);
            for (int i = 16; i < 32; i++) fprintf(stderr, " x%d=0x%08x", i, 0u);
          } else {
            for (int i = 0; i < 32; i++)
              fprintf(stderr, " x%d=0x%08x", i, (uint32_t)core0->regs[i]);
          }
          fprintf(stderr, "\n");
        }
        if (steps >= dumpEnd) break;
        continue;
      }

      if (phase == 0 && steps == restoreAtStep) {
        // First the state as firmware that never writes flash (or PSRAM) gets it: the
        // in-flight setup below marks the images written, which puts them in `state`.
        int32_t smallSize = isRp2040 ? RP2040_serializeSize(rp2040Mcu, 0) : RP2350_serializeSize(mcu, 0);
        uint8_t* smallState = calloc(1, (size_t)smallSize);
        int smallOk = isRp2040 ? RP2040_serialize(rp2040Mcu, smallState, smallSize, 0)
                               : RP2350_serialize(mcu, smallState, smallSize, 0);
        uint32_t smallWords = smallState ? ((uint32_t*)smallState)[5] : 0;
        fprintf(stderr, "small_state step=%ld ok=%d size=%d total_words=%u crc32=0x%08x\n", steps,
                smallOk, smallSize, smallWords, crc32_bytes(smallState, (8 + (size_t)smallWords) * 4));
        free(smallState);

        if (isRp2040) rp2040_start_inflight(rp2040Mcu); else rp2350_start_inflight(mcu);
        stateSize = isRp2040 ? RP2040_serializeSize(rp2040Mcu, 0) : RP2350_serializeSize(mcu, 0);
        state = calloc(1, (size_t)stateSize);
        int ok = isRp2040 ? RP2040_serialize(rp2040Mcu, state, stateSize, 0)
                         : RP2350_serialize(mcu, state, stateSize, 0);
        uint32_t totalWords = state ? ((uint32_t*)state)[5] : 0;
        // 8 = SAVE_STATE_HEADER_WORDS: the CRC covers the whole state, images included.
        fprintf(stderr, "state step=%ld ok=%d size=%d total_words=%u crc32=0x%08x\n", steps, ok,
                stateSize, totalWords, crc32_bytes(state, (8 + (size_t)totalWords) * 4));
      }

      blockCrc = crc32_update_u32le(blockCrc, pc);
      blockSteps++;
      if (blockSteps == blockSize) {
        if (steps > quietUntilStep)
          fprintf(stderr, "pc_trace %sblock=%ld steps=%ld cycles=%d crc32=0x%08x\n",
                  phase ? "phase=1 " : "", blockIndex, blockSteps,
                  (int32_t)(isRp2040 ? RP2040_cycles_get(rp2040Mcu) : RP2350_cycles_get(mcu)),
                  blockCrc ^ 0xffffffffu);
        blockIndex++;
        blockSteps = 0;
        blockCrc = 0xffffffff;
      }
    }
    if (!dumpMode && blockSteps > 0 && steps > quietUntilStep) {
      fprintf(stderr, "pc_trace %sblock=%ld steps=%ld cycles=%d crc32=0x%08x\n",
              phase ? "phase=1 " : "", blockIndex, blockSteps,
              (int32_t)(isRp2040 ? RP2040_cycles_get(rp2040Mcu) : RP2350_cycles_get(mcu)),
              blockCrc ^ 0xffffffffu);
    }

    if (phase == 0 && restoreAtStep > 0) {
      int ok = isRp2040 ? RP2040_unserialize(rp2040Mcu, state, stateSize)
                        : RP2350_unserialize(mcu, state, stateSize);
      fprintf(stderr, "rewind step=%ld ok=%d\n", steps, ok);
      if (!ok) return 3;
      steps = restoreAtStep; // the emulator is back there; number its blocks from there too
      continue;
    }
    break;
  }

  double elapsed_ms = (double)(clock() - t0) * 1000.0 / CLOCKS_PER_SEC;
  if (!dumpMode) {
    int32_t finalCycles = isRp2040 ? RP2040_cycles_get(rp2040Mcu) : RP2350_cycles_get(mcu);
    fprintf(stderr, "cycles=%d steps=%ld elapsed_ms=%.1f cycles_per_sec=%.0f\n",
            finalCycles, steps, elapsed_ms, elapsed_ms > 0 ? (finalCycles / elapsed_ms) * 1000.0 : 0.0);
  }
  return 0;
}
