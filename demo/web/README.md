# rp2350js web demo — snapshot / rewind / cycle-accurate stepping

An in-browser RP2350 (RISC-V) emulation with **cycle-accurate rewind**: the whole
firmware run is recorded up front (~20M cycles), then you scrub the timeline, step
cycle-by-cycle, rewind and replay, and watch the PIO and CPU state follow.

Web demo of rp2350js and time rewind feature: <https://c1570.github.io/rp2350js/>

## Layout

```
demo/web/
├── build.sh              firmware (CMake + pico-sdk) + tsc type-check + esbuild bundle (minified)
├── publish-gh-pages.sh   public/ → root of the orphan `gh-pages` branch (GitHub Pages)
├── server.mjs            tiny static file server (no deps)
├── tsconfig.json         type-check config for src/ and test/ (run by build.sh)
├── .gitignore            the build artifacts in public/
├── public/               served: index.html, style.css (sources) + build.sh output (app.js,
│                         webfirmware.{hex,dis} — git-ignored, run build.sh first)
├── src/                  browser app sources (vanilla TypeScript)
│   ├── main.ts           entry point: boots chip, wires UI, drives the initial run
│   ├── firmware.ts       browser-safe SRAM firmware loader (vectored boot)
│   ├── runner.ts         stepping model, snapshots, serial log, seek/rewind
│   ├── snapshots.ts      sorted snapshot store (~870 KB each, dedup, no eviction)
│   ├── analyzer.ts       16-lane per-cycle logic-analyzer ring + canvas view, click →
│                         lane/cycle hit test and sample description (level, nearest edges)
│   ├── disasm-cpu.ts     .dis (objdump) parser; PC → listing line, <main> lookup
│   ├── disasm-pio.ts     PIO instruction disassembler (all 8 instruction classes)
│   ├── pcb.ts            stylized Pico 2 SVG with live pads + clickable GPIO24 button
│   ├── shims/            browser stubs for the node modules src/rp2350.ts imports (fs, uf2)
│   └── ui.ts             transport controls, timeline slider, code windows, serial view,
│                         sample popover, help popup
├── test/
│   ├── runner-test.ts    headless runner machinery test (rewind, determinism, store)
│   └── browser-stub-test.ts  full-app smoke test with a DOM stub
└── webfirmware/          the RP2350 firmware (see below)
```

## Firmware (`webfirmware/`)

RP2350 RISC-V, **no_flash** (runs from SRAM), built with the pico-sdk:

- **core0**: edge-detects GPIO24 and pushes a 0 into PIO0's TX FIFO on every
  button toggle (countdown reload); prints a banner, 10 periodic status lines
  and an end sentinel over UART0 (115200).
- **PIO0 SM0** (`counter.pio`): a 5-instruction countdown — `pull noblock`
  reloads the OSR from the FIFO (or from x when empty), `out pins, 8 [7]`
  shows the low 8 bits on **GPIO2..9**, `jmp x-- start` decrements; every
  toggle restarts the countdown from the top of the 8-bit range.
- **core1**: increments its own counter while **GPIO24** (button, pull-up,
  pressed = low) is released, decrements while pressed; outputs the lowest 8
  bits onto **GPIO16..23** via `gpio_put_masked()`.
- Serial output finishes with `### END OF OUTPUT ###` — the web demo stops the
  emulation exactly when that last byte has left the UART; the timeline runs
  from boot (cycle 0) to that cycle (~20 M cycles ≈ 133 ms @ 150 MHz). On load
  the demo runs this far invisibly (progress shown), then rewinds to the cycle
  at which core0 enters `main()` — that is where the demo starts.

## Run it

```sh
./build.sh          # firmware (CMake + pico-sdk); tsc type-check + esbuild bundle
node server.mjs 8080
# open http://localhost:8080/
```

Or from the repository root: `npm run demo:web:build`, `npm run demo:web:serve`,
`npm run demo:web:test`.

`build.sh` uses `~/pico-sdk` and the corev toolchain from
`~/project/corev-openhw-gcc-ubuntu2204-20240530` (override via `PICO_SDK_PATH`
/ `PICO_TOOLCHAIN_PATH`).

## Publish (GitHub Pages)

`./publish-gh-pages.sh` after `./build.sh` writes `public/` as the root of the
orphan `gh-pages` branch (plumbing only — your checkout and index are not
touched; the git-ignored build artifacts are included). Push it with
`git push origin gh-pages`; the repository's Pages settings deploy from that
branch's root.

## How the rewind works

- **Stepping order** (ntc-run style): each step runs one core0 CPU instruction
  (`stepCores()`, core1 catching up internally), then ticks the PIO **one cycle
  at a time**, recording a logic-analyzer sample per cycle.
- **Seek(T)**: unserialize the nearest snapshot at/before T, truncate the serial
  log to its recorded length, then replay forward — the final CPU instruction is
  split so the **PIO stops at exactly cycle T** (leftover ticks are kept as
  `residual` and consumed first on the next step; snapshots store it). Rewinds
  always work this way; forward jumps do too when they exceed one snapshot
  interval and the initial run left a snapshot beyond the current position
  (the whole timeline was recorded), so even a jump from the start to 18M cycles
  is a ~100k-cycle replay rather than seconds of emulation. Short forward hops
  just run the chip.
- **Snapshots**: full chip serialize (~870 KB, flash/PSRAM omitted — never
  written by the RAM-resident firmware), one every 100k cycles during the
  initial run (~200 for the full run) plus one per seek target (a new snapshot
  replaces existing ones within 500 cycles, so stepping does not accumulate
  them). There is no capacity eviction — snapshots are only dropped when the
  GPIO24 button invalidates the recorded future. Rewind+replay is deterministic:
  it reproduces byte-identical serial output and byte-identical chip state
  (verified in `test/runner-test.ts`), and a rewind replays at most one
  snapshot interval (~100k cycles, ~10 ms) instead of from cycle 0.
- **Initial run**: the whole timeline is played once on load (a few seconds of pure
  emulation) in 12 ms chunks driven by a `MessageChannel` task loop rather than
  `requestAnimationFrame` — full duty cycle regardless of display refresh, and
  it keeps running in a background tab. Afterwards the chip only moves through
  user actions; the UI redraws per action, there is no idle frame loop.
- **GPIO24 button** (click on the PCB toggles pressed/released): toggling it
  invalidates the recorded future — snapshots, logic-analyzer samples and the
  finish marker past that point are dropped, and the near future is re-recorded.
- **⏪/⏩ buttons** seek by exactly 1/10/1000 cycles (hold to repeat); ⏩ simply
  runs the chip forward, recorded future or not, and stops at the finish cycle
  once the output is complete. The finish cycle itself is a hard stop: the
  timeline never runs past it, not even mid-instruction.
- **Analyzer coverage**: after every seek the runner speculatively runs 2000
  cycles ahead (chip state rolled back, trace kept) so the analyzer always
  shows past *and* future around the marker. Clicking a lane pops up the
  GPIO's level at that cycle plus the nearest edges on both sides (omitted
  when outside the retained history), with a copy-to-clipboard button.

## Notes

- The PIO state window shows PIO0 SM0's registers, FIFOs and the decoded
  instruction memory with the live PC marker; the CPU window shows the
  objdump-generated `.dis` listing with core0 (green) and core1 (blue) PC
  markers.
- GP23 is internal on a real Pico 2 (not on the header) — the PCB shows it as a
  virtual pad. GP2..9 and GP16..22 are real header pins. The drawing omits pins
  the demo does not use (GP0/GP1, GP10..15, GP26..28).
- Narrow screens (≤ 700 px): the PCB is hidden, a compact GPIO24 button sits left
  of the slider (same state as the PCB's), and the progress note reads
  "Better viewed on desktop... NN%" instead of "preparing timeline… NN%".

## Tests

```sh
npx ts-node --transpile-only demo/web/test/runner-test.ts        # rewind/determinism, snapshot store
npx ts-node --transpile-only demo/web/test/browser-stub-test.ts  # full-app smoke test (DOM stub)
npx ts-node --transpile-only demo/web/webfirmware/boot-test.ts   # firmware boot check
npx tsc -p demo/web/tsconfig.json                               # type-check src/ and test/
```

Both suites read the firmware from `public/` — build first.
