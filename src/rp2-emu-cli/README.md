# rp2_emu — RP2350 emulator CLI

`rp2_emu` is a small command-line helper that exposes the RP2350 emulator as a
background daemon. Each MCP-style tool (`read_registers`, `set_breakpoint`,
`run`, ...) becomes a CLI subcommand, so an AI agent (or a shell user) can
drive the emulator without speaking the MCP wire protocol or keeping a
long-lived Node process attached to their terminal.

The emulator state lives in one daemon process. Each CLI invocation opens the
daemon's unix socket, sends a single line-delimited JSON request, reads a
single response, prints it, and exits.

## Install / build

```bash
npm install          # also installs the `uf2` dev dependency
npm run build        # emits dist/cjs/ including rp2-emu-cli/rp2-emu.js
```

After build, the binary is wired up via `package.json`'s `bin` field:

```bash
npm link             # optional: exposes `rp2_emu` on $PATH
rp2_emu status
```

For development without a build step:

```bash
npm run bin:dev -- status       # runs via ts-node
npx ts-node src/rp2-emu-cli/rp2-emu.ts status
```

## Architecture

```
┌──────────────┐   unix socket   ┌─────────────────────────────┐
│  rp2_emu CLI │ ──────────────► │  rp2_emu daemon             │
│  (one-shot)  │                 │  holds EmulatorController    │
│              │ ◄────────────── │  serves line-delimited JSON │
└──────────────┘                 └─────────────────────────────┘
```

- **Daemon** (`src/rp2-emu-cli/daemon.ts`) — long-lived process, owns the
  `EmulatorController` instance with bootrom + firmware. Listens on a per-user
  unix socket.
- **CLI** (`src/rp2-emu-cli/rp2-emu.ts`) — short-lived. Parses argv, opens the
  socket, exchanges one JSON line, prints the result.
- **Protocol** (`src/rp2-emu-cli/protocol.ts`) — shared types + path resolution.
- **Engine** (`src/utils/emulator-controller.ts`) — the reusable
  `EmulatorController` class that implements every tool via `handleToolCall()`.
  Both this CLI (via the daemon) and the optional MCP shim
  (`src/mcp/mcp-server.ts`) consume it.

## Daemon lifecycle

```bash
rp2_emu start                                  # default bootrom (rp2350-a2)
rp2_emu start --bootrom rp2040-b1
rp2_emu start --firmware demo/riscv_blink/blink_simple.hex
rp2_emu start --firmware foo.uf2 --firmware-arch arm
rp2_emu status                                 # 0 if running, 1 if not
rp2_emu stop                                   # SIGTERM; unlinks socket + state
rp2_emu restart                                # stop + start
```

Any tool subcommand auto-starts the daemon if it isn't running. Pass
`--no-autostart` to disable this (useful in scripts where you want explicit
control).

### Socket + state file location

Per-user, in `$XDG_RUNTIME_DIR` (Linux: `/run/user/<uid>/`) or `/tmp` as a
fallback (macOS, containers without `XDG_RUNTIME_DIR`):

- Socket: `rp2-emu-<uid>.sock`
- State: `rp2-emu-<uid>.state.json` — `{pid, socketPath, startedAt, fwPath, fwArch, bootrom}`

Socket permissions are `0600` (owner-only). Stale socket/state files are
cleaned up automatically on next `start` if no live PID owns them.

## Tool subcommands

Every subcommand maps 1:1 to an `EmulatorController` tool. Integer-valued flags
accept decimal (`305419896`) or `0x`-prefixed hex (`0x12345678`). Boolean
flags accept `true`/`false` strings, or can be passed as switches
(`--keep_breakpoints` is equivalent to `--keep_breakpoints true`).

The output of each subcommand is the same JSON (or text, for `read_memory` /
`dump_pio` / `dump_gpio`) that the corresponding MCP tool would return.

### Typical firmware-debugging session

```bash
# Load a known-good blink program
rp2_emu load_firmware --path demo/riscv_blink/blink_simple.hex

# Set a breakpoint at the program's platform_entry
rp2_emu set_breakpoint --address 0x2000025c

# Run until the breakpoint fires
rp2_emu run --max_instructions 50000
# → {"halted": true, "reason": "breakpoint", "core": 0, "core0_pc": "0x2000025c", ...}

# Inspect state
rp2_emu read_registers --core 0
rp2_emu read_memory --address 0x20000200 --length 32

# Single-step a few instructions
rp2_emu single_step
rp2_emu single_step

# Reset and reload the firmware (clears breakpoints/tracepoints by default)
rp2_emu reset
```

### Subcommand reference

| Subcommand         | Required flags                | Optional flags                                    |
| ------------------ | ----------------------------- | ------------------------------------------------- |
| `get_status`       |                               |                                                   |
| `read_registers`   |                               | `--core`                                          |
| `write_register`   | `--register --value`          | `--core`                                          |
| `read_memory`      | `--address`                   | `--length`                                        |
| `write_memory`     | `--address --hex`             |                                                   |
| `single_step`      |                               | `--core`                                          |
| `run`              |                               | `--max_instructions`                              |
| `set_breakpoint`   | `--address`                   |                                                   |
| `clear_breakpoint` | `--address`                   |                                                   |
| `list_breakpoints` |                               |                                                   |
| `set_tracepoint`   | `--label --address`           |                                                   |
| `clear_tracepoint` | `--label`                     |                                                   |
| `list_tracepoints` |                               |                                                   |
| `dump_pio`         |                               | `--instance`                                      |
| `dump_gpio`        |                               |                                                   |
| `load_firmware`    | `--path`                      | `--entry_pc --use_sram --disassembly_path --arch` |
| `reset`            |                               | `--keep_breakpoints`                              |
| `convert_number`   | `--value`                     |                                                   |
| `dump_memory`      | `--region --address --length` | `--format` (ihex\|text)                           |

`rp2_emu <subcommand> --help` shows flag → MCP-arg mapping for that subcommand.

## Wire protocol

Line-delimited JSON over the unix socket. One request per connection.

```
→ {"id":1,"tool":"write_register","args":{"core":0,"register":"ra","value":"0x42"}}
← {"id":1,"ok":true,"content":[{"type":"text","text":"{\n  \"ok\": true\n}"}],"isError":false}
```

- Tool-level errors (unknown register, bad address, etc.): `ok:true` with
  `isError:true`. The error text is in `content[0].text`.
- Daemon-level errors (bad JSON, no socket): `ok:false` with an `error` field.
- The `__status` pseudo-tool returns a `DaemonStatus` snapshot (used by
  `rp2_emu status`).

## Troubleshooting

- **`rp2_emu: no response from daemon`** — daemon died. Check `rp2_emu status`
  to confirm, then `rp2_emu start`. If it crashes immediately, try
  `rp2_emu start --foreground` to see the error.
- **`daemon: failed to load firmware`** — `load_firmware` rejected the file.
  Re-run with `rp2_emu load_firmware --path ...` directly for the full error
  message.
- **Stale socket after kill -9** — `rp2_emu start` cleans these up
  automatically. To remove manually: `rm $(rp2_emu status | jq -r .socketPath)`
  (or just `rm /run/user/$UID/rp2-emu-*.sock`).
- **Windows** — not supported (unix sockets only). Use the existing
  `npx ts-node demo/mcp-server.ts` MCP server path instead.

## Tests

```bash
npx vitest run src/rp2-emu-cli/test/rp2-emu.spec.ts
```

Covers: arg parser, flag → tool-arg mapping, full daemon IPC round-trip for
~10 representative tools, type-narrowing helpers.
