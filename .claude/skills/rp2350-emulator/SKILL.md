---
name: rp2350-emulator
description: Drive the in-repo RP2040/RP2350 emulator (RISC-V Hazard3 + ARM Cortex-M33) via the rp2_emu CLI — load firmware, set breakpoints, single-step, inspect registers/memory/PIO/GPIO. Use for any task touching RP2040/RP2350 firmware, boot flow, PIO programs, GPIO, or RISC-V/ARM code that runs in this emulator.
license: MIT
compatibility: opencode
---

# RP2350 emulator skill

This repo (`rp2350js` — published as the npm package `rp2350js`,
source at `github.com/c1570/rp2350js`) ships a JavaScript emulator for the
Raspberry Pi RP2040 and RP2350 microcontrollers, including:

- RISC-V Hazard3 machine-mode cores (both RP2350 cores)
- ARM Cortex-M33 cores (basic RP2350 support)
- PIO (Programmable I/O), GPIO, DMA, bootrom, XIP flash, USB
- A `rp2_emu` CLI that exposes the emulator state through 20+ MCP-style tool
  subcommands, backed by a long-lived background daemon

Load this skill whenever the user is working on RP2040/RP2350 firmware, boot
flow, PIO programs, GPIO behaviour, or any code that targets this emulator.

## When to load me

- "Load this firmware / .hex / .uf2 and step through it"
- "Why does my RP2350 PIO program hang?"
- "Set a breakpoint at <address> and run"
- "What's in register a0 after <event>?"
- "Dump GPIO state"
- Tasks involving the `src/` emulator code itself, `demo/*.ts` runners, or the
  existing `SKILL_RP2.md` hardware internals

Do **not** load for: generic Node/TypeScript questions unrelated to the
emulator, or tasks about real hardware (this is a simulator).

## How to drive the emulator

The `rp2_emu` binary is the entry point. After `npm run build`, it lives at
`./dist/cjs/rp2-emu-cli/rp2-emu.js` and is wired through these `package.json`
scripts:

- `npm run bin -- <subcommand>` — runs the built JS (e.g. `npm run bin -- status`).
- `npm run bin:dev -- <subcommand>` — runs from source via ts-node (no build step).
- `npx ts-node src/rp2-emu-cli/rp2-emu.ts <subcommand>` — equivalent direct invocation.
- `node dist/cjs/rp2-emu-cli/rp2-emu.js <subcommand>` — direct invocation of the built file.
- `npm link` then `rp2_emu <subcommand>` — installs it onto `$PATH`.

The daemon holds all emulator state; one process per work session. Auto-start
happens on first tool call.

### Standard debugging workflow

```bash
# 1. Load firmware (auto-detects SRAM vs flash, picks up adjacent .dis file)
rp2_emu load_firmware --path demo/riscv_blink/blink_simple.hex

# 2. (Optional) Read entry state
rp2_emu get_status
rp2_emu read_registers --core 0

# 3. Set a breakpoint and run
rp2_emu set_breakpoint --address 0x2000025c
rp2_emu run --max_instructions 50000
# → {"halted": true, "reason": "breakpoint", "core0_pc": "0x2000025c", ...}

# 4. Inspect and step
rp2_emu read_registers
rp2_emu read_memory --address 0x20000200 --length 32
rp2_emu single_step

# 5. Reset (clears breakpoints unless --keep_breakpoints) and try again
rp2_emu reset

# 6. Stop the daemon when done
rp2_emu stop
```

### Other useful subcommands

- `dump_pio [--instance 0|1|2]` — PIO state machine registers (pc, x, y, ISR,
  OSR, FIFO depths). Indispensable for debugging PIO programs.
- `dump_gpio` — all 48 GPIO pins: function select, in/out/oe values, pullups.
- `set_tracepoint --label <name> --address <addr>` — fire-and-record marker at
  a `jal` instruction; doesn't halt. Use to track function entries/loop
  iterations. `list_tracepoints` shows recorded hits.
- `dump_memory --region flash|sram --address <offset> --length <n>` — dumps to
  a temp file (default Intel HEX, reloadable via `load_firmware`).
- `convert_number --value 0x12345678` — hex↔decimal parity helper.

Integer flags accept decimal or `0x`-prefixed hex. Run `rp2_emu <subcommand>
--help` for per-subcommand flag → MCP-arg mapping. Full reference in
`src/rp2-emu-cli/README.md`.

## Tool surface

Every `rp2_emu <tool>` subcommand maps 1:1 to a tool exposed by
`EmulatorController` (in `src/utils/emulator-controller.ts`). The same input
conventions and the same output shape apply across both transports (this CLI
and the optional MCP shim in `src/mcp/mcp-server.ts`). The full tool list:

`get_status` · `read_registers` · `write_register` · `read_memory` ·
`write_memory` · `single_step` · `run` · `set_breakpoint` · `clear_breakpoint`
· `list_breakpoints` · `set_tracepoint` · `clear_tracepoint` ·
`list_tracepoints` · `dump_pio` · `dump_gpio` · `load_firmware` · `reset` ·
`convert_number` · `dump_memory`

## State model & lifecycle

- **One daemon per user.** Holds bootrom + firmware + breakpoints/tracepoints
  - emulator chip state. Lives at `$XDG_RUNTIME_DIR/rp2-emu-<uid>.sock`.
- **Auto-start.** Any tool subcommand starts the daemon if missing. Pass
  `--no-autostart` to disable.
- **Explicit control:** `rp2_emu start [--bootrom <spec>] [--firmware <path>]`,
  `rp2_emu stop`, `rp2_emu status`, `rp2_emu restart`.
- **Default bootrom:** `rp2350-a2` (the bundled RP2350 bootrom). Alternatives:
  `--bootrom rp2040-b1`, `--bootrom none`, or `--bootrom <path-to-.bin>`.

## Cross-references

- `SKILL_RP2.md` (repo root) — RP2040/RP2350 hardware & pico-SDK internals
  (PIO instruction set, IRQ routing, GPIOBASE, autopush/autopull, etc.). Read
  this when you need to understand **what the emulator is emulating**.
- `src/rp2-emu-cli/README.md` — full CLI reference, wire protocol, troubleshooting.
- `src/utils/emulator-controller.ts` — the reusable engine that implements
  every tool via `handleToolCall()`. The 20 tool descriptions in
  `TOOL_DESCRIPTIONS` (exported from the same file) are the single source of
  truth consumed by both the CLI's `--help` text and the MCP shim's schema.
- `src/utils/test/emulator-controller.spec.ts` — example calls for every tool
  (these double as authoritative documentation of each tool's input shape).
- `demo/` — example firmware (`riscv_blink/`, `riscv_pio_blink/`,
  `riscv_timer/`) you can load with `load_firmware` for smoke tests.

## Notes & limitations

- ARM/Cortex-M33 support is **basic** (no secure/insecure mode). For RISC-V
  firmware, pass `--arch riscv` (default) to `load_firmware`; for ARM, pass
  `--arch arm`.
- The emulator does not implement everything (see README "Missing" section):
  no exceptions, no full timer interrupts, no PWM/RTC/TRNG/etc. If a firmware
  hangs because it's waiting on an unimplemented peripheral, that's expected.
- Windows is **not** supported by `rp2_emu` (unix sockets only). Windows users
  should run the MCP server directly: `npx ts-node demo/mcp-server.ts`.
