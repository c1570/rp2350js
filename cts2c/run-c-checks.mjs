#!/usr/bin/env node
// Builds and runs the C-side checks that need a transpiled emulator:
//
//   1. cts2c/helper-checks.c, as a plain -O2 binary
//   2. cts2c/helper-checks.c again, under AddressSanitizer
//   3. the parity harness's save/restore schedule (RP2350 RISC-V and ARM, RP2040),
//      under AddressSanitizer
//
// AddressSanitizer is the point of the last two. It found both of the C build's memory
// overruns so far — BOOTRAM indexing past its array, and a DMA dreq read past the end
// of dreq[] — within minutes of being pointed at the emulator. Neither is visible to a
// plain build: they just corrupt whatever happens to follow in memory.
//
// Usage:  npm run cts2c:checks                      transpile, then run everything
//         CTS2C_SKIP_BUILD=1 npm run cts2c:checks  skip the transpile (header must exist)
//
// Exits non-zero if any check fails, any process crashes, or ASan reports anything.

import { execSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'build', 'transpile');
const HEADER = join(OUT, 'rp2350js-c.h');
const CHECKS = join(ROOT, 'cts2c', 'helper-checks.c');
const PARITY = join(ROOT, 'cts2c', 'helper-cts2c-ensure-parity.c');

if (process.env.CTS2C_SKIP_BUILD === '1') {
  if (!existsSync(HEADER)) {
    console.error(`${HEADER} does not exist: run "npm run cts2c:full" first`);
    process.exit(1);
  }
  console.log('[build] skipped (CTS2C_SKIP_BUILD=1)');
} else {
  console.log('[build] transpiling...');
  execSync('npm run cts2c:full', { cwd: ROOT, stdio: 'inherit' });
}
console.log('');

const ASAN = ['-O1', '-g', '-fsanitize=address', '-fno-omit-frame-pointer'];
// The emulator never frees chip-internal allocations, and a process-lifetime chip does
// not need to: reporting those as leaks would only bury real findings.
const ASAN_ENV = { ...process.env, ASAN_OPTIONS: 'detect_leaks=0' };
const ASAN_ERROR = /ERROR: (AddressSanitizer|LeakSanitizer)/;
const ALL_PASSED = /All helper checks passed\./;
const SCHEDULE =
  /small_state step=100000 ok=1[\s\S]*state step=100000 ok=1[\s\S]*rewind step=\d+ ok=1/;

function build(source, binary, flags) {
  const result = spawnSync('gcc', [...flags, source, '-o', binary, '-lm'], { encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(`${source}: gcc exited with ${result.status}`);
    console.error((result.stderr || '').split('\n').slice(-15).join('\n'));
    process.exit(1);
  }
}

// Runs one binary and returns the lines that explain a failure, or null if it passed.
function check(label, binary, args, { asan = false, expect, detail }) {
  const t0 = Date.now();
  const result = spawnSync(binary, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: asan ? ASAN_ENV : process.env,
    maxBuffer: 256 * 1024 * 1024,
  });
  const stdout = result.stdout || '';
  const stderr = (result.stderr || '').split('\n');
  const problems = [];
  if (result.signal) problems.push(`killed by signal ${result.signal}`);
  else if (result.status !== 0) problems.push(`exited with status ${result.status}`);
  problems.push(...stdout.split('\n').filter((line) => /^FAIL /.test(line)));
  // The first ASan report in full says more than any summary of it could.
  const report = stderr.findIndex((line) => ASAN_ERROR.test(line));
  if (report >= 0) problems.push(...stderr.slice(report, report + 24));
  if (!expect.test(stdout + stderr.join('\n'))) problems.push('did not report the expected result');

  const passed = (stdout.match(/^ok /gm) || []).length;
  const summary = problems.length ? 'see below' : detail.replace('%d', String(passed));
  console.log(`${problems.length ? 'FAIL' : 'ok  '}  ${label}: ${summary} (${Date.now() - t0}ms)`);
  return problems.length ? problems.map((line) => `      ${line}`) : null;
}

build(CHECKS, join(OUT, 'helper-checks'), ['-O2', '-Wall']);
build(CHECKS, join(OUT, 'helper-checks-asan'), ASAN);
build(PARITY, join(OUT, 'rp2350-harness-asan'), ASAN);

const failures = [];
const record = (problems) => {
  if (problems) failures.push(...problems);
};

record(
  check('helper checks', join(OUT, 'helper-checks'), [], {
    expect: ALL_PASSED,
    detail: '%d checks',
  })
);
record(
  check('helper checks, AddressSanitizer', join(OUT, 'helper-checks-asan'), [], {
    asan: true,
    expect: ALL_PASSED,
    detail: '%d checks, no ASan reports',
  })
);

// A short run of each architecture's firmware: boot, a snapshot with USB/DMA/ADC work
// in flight, the rewind, and the replay. restoreAtStep must be a multiple of blockSize.
for (const [firmware, coreArch] of [
  ['demo/riscv_blink/blink_simple.hex', 'riscv'],
  ['demo/m33_blink/blink_simple.hex', 'arm'],
  ['demo/hello_serial_rp2040/hello_serial.hex', 'rp2040'],
]) {
  const args = [firmware, '400000', '100000', '0', '0', '100', coreArch, '100000'];
  record(
    check(`save/restore ${coreArch}, AddressSanitizer`, join(OUT, 'rp2350-harness-asan'), args, {
      asan: true,
      expect: SCHEDULE,
      detail: 'state taken and rewound, no ASan reports',
    })
  );
}

console.log('');
if (failures.length) {
  console.log(failures.join('\n'));
  console.log('');
  console.log(`${failures.length} problem(s): see above`);
  process.exit(1);
}
console.log('All C checks passed.');
