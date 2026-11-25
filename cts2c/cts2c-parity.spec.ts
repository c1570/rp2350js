import { beforeAll, describe, expect, test } from 'vitest';
import { execFileSync } from 'child_process';
import { join } from 'path';

// Node-vs-C parity smoke test: runs cts2c-ensure-parity.ts for a short 5M cycles on
// each chip/architecture (blink_simple on RISC-V/ARM, hello_serial on RP2040), checking
// the CRC32 of the core0 PC trace matches block for block. It also runs the save/restore
// schedule on every chip (state bytes identical on both sides, replay after the rewind),
// and runs the C helper checks plain and under AddressSanitizer.
//
// DISABLED BY DEFAULT — it transpiles the whole emulator and invokes gcc, so it is
// far too slow and too toolchain-dependent (needs gcc and a writable build/) to run
// in the normal `npx vitest run`. Enable it explicitly:
//
//   CTS2C_PARITY=1 npx vitest run cts2c
//
// This only guards against gross regressions. The real check is the full-length run
// (400M cycles across all three demos, including riscv_pio_blink) — 5M cycles gets
// through boot and a few LED toggles, nothing more. Run that by hand before trusting
// a cts2c change:
//
//   npx tsx cts2c/cts2c-ensure-parity.ts demo/riscv_blink/blink_simple.hex 400000000 riscv
const ENABLED = process.env.CTS2C_PARITY === '1';

// `describe.skip` rather than a bare `if`, so the suite is reported as skipped instead
// of vanishing — a silently absent test looks identical to a passing one.
const describeParity = ENABLED ? describe : describe.skip;

const ROOT = join(__dirname, '..');
const CYCLES = 5_000_000;
// 5M cycles is 5 one-million-step blocks; the snapshot goes on a block boundary two
// blocks in, leaving three whose replay after unserialize() can be compared.
const RESTORE_AT = 2_000_000;
const SCRIPT = 'cts2c/cts2c-ensure-parity.ts';
const PASS_TRACE = /^PASS: all \d+ CRC32 blocks match$/m;
const PASS_SAVE_RESTORE =
  /^PASS: states 0x[0-9a-f]+ \(\d+ bytes, images left out\) and 0x[0-9a-f]+ \(\d+ bytes\) identical on Node and C; [1-9]\d* blocks after unserialize\(\) match and replay the first run on both sides$/m;

// gcc + a full transpile of src/ dominates the runtime; the comparison itself is well
// under a second per architecture.
const BUILD_TIMEOUT_MS = 240_000;
const RUN_TIMEOUT_MS = 120_000;

function runParity(
  hexFile: string,
  coreArch: 'riscv' | 'arm' | 'rp2040',
  skipBuild: boolean,
  restoreAt = 0
) {
  return execFileSync(
    'npx',
    ['tsx', SCRIPT, hexFile, String(CYCLES), coreArch, ...(restoreAt ? [String(restoreAt)] : [])],
    {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ...(skipBuild ? { CTS2C_SKIP_BUILD: '1' } : {}) },
    }
  );
}

describeParity('cts2c Node-vs-C parity (blink_simple, 5M cycles)', () => {
  // Build once here rather than letting each case rebuild identical output. Done by
  // running the RISC-V case with the build enabled, so the build commands live in one
  // place (the script) instead of being duplicated here.
  let riscvOutput = '';

  beforeAll(() => {
    riscvOutput = runParity('demo/riscv_blink/blink_simple.hex', 'riscv', false);
  }, BUILD_TIMEOUT_MS);

  test('RISC-V blink_simple matches Node', () => {
    // The script exits non-zero on divergence, so reaching here already means it
    // passed. Assert on the PASS line too: it once reported PASS while the C harness
    // was actually crashing (see the comment above runC), so a zero exit code alone is
    // not sufficient evidence.
    expect(riscvOutput).toMatch(PASS_TRACE);
  });

  test(
    'ARM blink_simple matches Node',
    () => {
      const out = runParity('demo/m33_blink/blink_simple.hex', 'arm', true);
      expect(out).toMatch(PASS_TRACE);
    },
    RUN_TIMEOUT_MS
  );

  // ── save states ──────────────────────────────────────────────────────────
  // The state Node serializes and the state C serializes must be the same bytes, and
  // after unserialize() both must replay the first run. Without this, a field that the
  // C build encodes differently (or a C-only overrun into live state, as the BOOTRAM
  // one was) only ever shows up as an unexplained divergence somewhere later.
  test(
    'RISC-V save state is the same bytes on Node and C, and replays',
    () => {
      const out = runParity('demo/riscv_blink/blink_simple.hex', 'riscv', true, RESTORE_AT);
      expect(out).toMatch(PASS_TRACE);
      expect(out).toMatch(PASS_SAVE_RESTORE);
    },
    RUN_TIMEOUT_MS
  );

  test(
    'ARM save state is the same bytes on Node and C, and replays',
    () => {
      const out = runParity('demo/m33_blink/blink_simple.hex', 'arm', true, RESTORE_AT);
      expect(out).toMatch(PASS_TRACE);
      expect(out).toMatch(PASS_SAVE_RESTORE);
    },
    RUN_TIMEOUT_MS
  );

  test(
    'RP2040 save state is the same bytes on Node and C, and replays',
    () => {
      const out = runParity(
        'demo/hello_serial_rp2040/hello_serial.hex',
        'rp2040',
        true,
        RESTORE_AT
      );
      expect(out).toMatch(PASS_TRACE);
      expect(out).toMatch(PASS_SAVE_RESTORE);
    },
    RUN_TIMEOUT_MS
  );

  // The helper checks exercise C the parity trace never reaches: hand-written bodies,
  // boundary operands, and save/restore with work in flight. AddressSanitizer is what
  // caught both C memory overruns found so far.
  test(
    'C helper checks pass, plain and under AddressSanitizer',
    () => {
      const out = execFileSync('node', ['cts2c/run-c-checks.mjs'], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: RUN_TIMEOUT_MS,
        env: { ...process.env, CTS2C_SKIP_BUILD: '1' },
      });
      expect(out.match(/^(ok|FAIL) {2}/gm)?.length).toBe(5);
      expect(out).not.toMatch(/^FAIL/m);
      expect(out).toMatch(/^All C checks passed\.$/m);
    },
    RUN_TIMEOUT_MS
  );

  // RP2040 is a distinct chip (not an RP2350 coreArch option), so it gets its own hex
  // firmware — hello_serial_rp2040/hello_serial.hex, not blink_simple.
  test(
    'RP2040 hello_serial matches Node',
    () => {
      const out = runParity('demo/hello_serial_rp2040/hello_serial.hex', 'rp2040', true);
      expect(out).toMatch(PASS_TRACE);
    },
    RUN_TIMEOUT_MS
  );
});
