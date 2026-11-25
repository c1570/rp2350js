# cts2c — (Constrained) TypeScript to C transpiler for rp2350js

https://github.com/c1570/rp2350js/tree/main/cts2c

Transpiles the emulator core in `src/` to a single C file.
The C version achieves 2-4x the speed of the Node/TS version.

    cts2c.js                     the transpiler
    transpile-check.mjs          transpile all of src/, compile with gcc, summarize
    cts2c-ensure-parity.ts       Node-vs-C CRC32 parity, with divergence bisection
    cts2c-parity.spec.ts         opt-in vitest smoke test wrapping the above
    helper-cts2c-ensure-parity.c C harness the parity check drives
    helper-checks.c              standalone checks: hand-written C bodies
                                 (bit-punning, checkTraceMagic* callbacks),
                                 boundary-value add/sub/mul/div opcodes on all
                                 three cores (uint-vs-int trap regression tests),
                                 a full USB CDC enumeration + serial data drive
                                 on both chip flavors, timer alarms with
                                 deltas past INT32_MAX ns, and save states
                                 (stream primitives, in-flight USB/DMA/ADC work,
                                 replay after unserialize on both RP2350 cores)
    run-c-checks.mjs             builds and runs helper-checks.c, plain and under
                                 AddressSanitizer, plus the parity harness's save/restore
                                 schedule under AddressSanitizer (npm run cts2c:checks)
    inflight-work.h              the USB/DMA/ADC work both C harnesses leave in
                                 flight at a snapshot point, plus marking
                                 flash and PSRAM written so a state carries them

`demo/emulator-run.c` is a C port of `demo/emulator-run.ts` showing how to drive the
generated emulator: UART output, GPIO listeners, stepping.

## Verifying a change

    npm run cts2c:full                              # transpiles + gcc; expect 0 errors
    npm run cts2c:checks                            # helper checks + ASan; see below
    CTS2C_PARITY=1 npx vitest run cts2c             # 5M-cycle parity, both arches,
                                                   # save/restore, helper checks + ASan

    # more thorough check, takes minutes
    npx tsx cts2c/cts2c-ensure-parity.ts demo/riscv_blink/blink_simple.hex 400000000 riscv
    npx tsx cts2c/cts2c-ensure-parity.ts demo/riscv_pio_blink/pio_blink.hex 400000000 riscv
    npx tsx cts2c/cts2c-ensure-parity.ts demo/m33_blink/blink_simple.hex 400000000 arm
    npx tsx cts2c/cts2c-ensure-parity.ts demo/hello_serial_rp2040/hello_serial.hex 400000000 rp2040

    # the same, plus a save/restore at step 2000000: the state must be the same bytes
    # on Node and C, and replay the first run on both sides
    npx tsx cts2c/cts2c-ensure-parity.ts demo/riscv_blink/blink_simple.hex 400000000 riscv 2000000
    npx tsx cts2c/cts2c-ensure-parity.ts demo/m33_blink/blink_simple.hex 400000000 arm 2000000
    npx tsx cts2c/cts2c-ensure-parity.ts demo/hello_serial_rp2040/hello_serial.hex 400000000 rp2040 2000000

## Save states

`helper-checks.c` and the parity harness's `restoreAtStep` schedule cover the C side of
save states (see `IRPChip.serialize()` / `unserialize()` in `src/rpchip.ts`); the JS side
is held to its own, stricter test in `src/savestate-coverage.spec.ts`.

The parity schedule is the one check that compares the *bytes* Node and C produce for the
same state. It is what caught the C build's BOOTRAM overrun: the stray writes landed in a
core's CSR array, so the two sides disagreed about one word of a 25 MB state. (The
schedule's setup marks flash and PSRAM as written, because a state otherwise leaves
both out until something writes them; so the 24 MiB of images are compared too.)

Run the helper checks under AddressSanitizer (`npm run cts2c:checks` does) after touching
anything that indexes an array in the C build. Two C-only overruns — BOOTRAM, and a DMA
`dreq` read at 0x3f — went unnoticed by every other check here.

## Scope

RP2350 (RISC-V and ARM cores) and RP2040 are both supported and covered by the CI parity
check above. RP2040 support relies on `monomorphize-chip-classes.mjs` to specialize
ChipType-generic peripheral classes per chip, since cts2c's class monomorphization otherwise
always resolves `ChipType` to RP2350.
