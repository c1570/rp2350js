# RP2040 / RP2350 Hardware/SDK Internals

## PIO (Programmable I/O)

- Each PIO instance has **4 state machines** sharing a single 32-instruction memory. All SMs execute from the same program.
- PIO has only **9 instructions** (JMP, WAIT, IN, OUT, PUSH, PULL, MOV, IRQ, SET) — there is no ADD, SUB, or any arithmetic. Use the CPU for math.
- **FIFO join** (`FJOIN_RX` / `FJOIN_TX`): a state machine can sacrifice its TX FIFO to double the RX FIFO (to 8 words) or vice versa. One FIFO can even become size 0, making the SM purely shift-register driven via `PULL`/`PUSH` from registers.
- **Autopush / Autopull**: when enabled, the IN instruction automatically pushes to RX FIFO once the shift count reaches the threshold, and OUT automatically pulls from TX FIFO. The autopull happens _before_ the OUT executes its destination write — if the FIFO is empty, the SM stalls.
- **Shift direction** is independently configurable for input and output shift registers (`IN_SHIFTDIR`, `OUT_SHIFTDIR`). Default is MSB-first (shift left); setting the bit reverses to LSB-first (shift right).
- The **output shift counter** starts at 32 (full) after reset; the **input shift counter** starts at 0 (empty). `MOV OSR, x` resets the output counter to 0 (considered "full"), `MOV ISR, x` resets the input counter to 0 (considered "empty").
- **Wrap** is free (zero cycles). When `PC == wrapTop`, the next PC becomes `wrapBottom` instead of `PC+1`. This is configured in `EXECCTRL`, not by a special instruction.
- **Sideset** pins share bits with the delay field. If `SIDE_EN` is set, the MSB of the delay/sideset field acts as an enable — only 4 bits of delay are available when sideset is active, and sideset can be 1-4 pins. Without `SIDE_EN`, all sideset pins are used every cycle but only 0-3 delay bits remain.
- **Clock divisor** has a fractional part (8-bit fraction, 16-bit integer). A divisor of 1 means full speed; the fractional part accumulates and occasionally inserts an extra wait cycle.
- `OUT EXEC` executes the shifted-out value as a PIO instruction. The delay field on the EXEC'd instruction is ignored but EXEC itself still costs 1 cycle.
- **`PULL NOBLOCK` on empty FIFO**: has the same effect as `MOV OSR, X`.
- **RP2350 only**: **IN_COUNT** (SHIFTCTRL bits 4:0) masks input pins to only the low N bits — unused high bits of `IN PINS` / `MOV x, PINS` / `WAIT PIN` read as zero. RP2040 always reads all 32 bits.

## PIO IRQ

- Each PIO instance has **8 IRQ flags** (bits 0-7). These are local to the PIO instance — they are NOT global across PIOs.
- The **raw interrupt** (`INTR`) fed to the CPU interrupt controller combines: IRQ flags (bits 8-11) plus per-SM FIFO status bits (TX-not-full bits 4-7, RX-not-empty bits 0-3). So `IRQ` instruction flags and FIFO flags share the same interrupt path.
- `IRQ wait` sets the flag then stalls the SM until some other agent (CPU or another SM) clears that flag. This is an inter-SM or SM-to-CPU synchronization primitive.
- `WAIT IRQ` with polarity=1 clears the IRQ flag upon matching — it's a consume-on-read semantic.
- **RP2350** supports setting/waiting on IRQ bits from the "previous" and "next" PIO in `IRQ`/`WAIT`.

## PIO Pin Mapping

- Each SM has independently configurable base pins for: `OUT`, `SET`, `SIDESET`, and `IN`.
- RP2040 PIO can access **GPIO 0-29** (30 pins). RP2350B PIO can access **GPIO 0-47** (48 pins).
- RP2350B adds `GPIOBASE` to offset the entire PIO pin space, allowing different PIO instances to control non-overlapping pin ranges.

## RP2350B PIO GPIOBASE Usage

- `sm_config_set_*_pins()` functions take **absolute** GPIO numbers (0-47). The SDK internally converts them to PIO-relative values during `pio_sm_init`. You do not need to subtract gpio_base yourself.
- A PIO with gpio_base=16 can only address GPIO16-47. A PIO with gpio_base=0 can only address GPIO0-31. Assigning pin numbers outside the PIO's range fails validation in `pio_sm_init`.
- To start SMs across multiple PIOs in sync, use `pio_enable_sm_multi_mask_in_sync(pio, mask_prev, mask, mask_next)`. The masks are **relative to the passed `pio`**: `mask_prev` = SMs on the previous-numbered PIO, `mask` = SMs on the passed PIO, `mask_next` = SMs on the next-numbered PIO. PIOs wrap circularly (on RP2350: 0→1→2→0).
- `pio_claim_free_sm_and_add_program_for_gpio_range()` is a convenience that auto-selects a PIO based on the requested GPIO range; however, when using `pio_enable_sm_multi_mask_in_sync` or `WAIT`/`IRQ` with the `prev`/`next` keywords, this is problematic. Use hardcoded assignments instead.
- For hardcoded assignments (e.g., PIO0=gpio_base 0, PIO1=gpio_base 16), use `pio_set_gpio_base(pio1, 16)` before **any** `pio_claim_unused_sm` / `pio_add_program` / `pio_sm_init` calls (e.g., at start of `main()`), then (when initializing SM programs) `pio_claim_unused_sm` + `pio_add_program` + `*_program_init` manually instead.

### Instruction pin numbers with gpio_base

PIO instructions only have 5 bits for pin indices (0-31). On RP2350, three mechanisms translate absolute GPIO numbers to PIO-relative values:

- **WAIT GPIO**: pioasm stores the absolute GPIO number's bits[4:0] in the instruction. `pio_add_program` XORs bit 4 with `gpio_base` (i.e. flips it when gpio_base=16). Hardware then adds gpio_base at execution time. Always use absolute GPIO numbers in `.pio` source — the toolchain handles translation.
- **JMP PIN**: Uses `execctrl.JMP_PIN` register. `sm_config_set_jmp_pin` takes absolute GPIO; `pio_sm_set_config` converts via the `pinhi` mechanism at config time. No instruction patching needed; per-SM configurable JMP PIN is a design feature.
- **WAIT PIN / IN / OUT / SET / SIDESET**: Assembler syntax is relative to PINCTRL base registers (`in_base`, `out_base`, etc.) which get set by `sm_config_set_*_pins` which takes absolute GPIO. No patching needed as relative indexing is by design here (enables sharing the same program in multiple SMs).

### Program loading and JMP patching

- `pio_add_program` places the program at a free offset in the 32-instruction memory (or at `.origin` if specified). It adds that offset to the address field of every JMP instruction so branches target the correct location. No other instructions are patched (except WAIT GPIO with gpio_base, above). Wrap target/wrap addresses passed to `sm_config_set_wrap` must also include the offset (handled automatically in pico-sdk by pioasm/`pio_sm_config *_program_get_default_config` mechanism).

## General

- **GPIO function select** determines which peripheral (PIO0, PIO1, PIO2, PWM, SIO, SPI, etc.) drives a pin's **output**. **Input** is independent. E.g., any GPIO can be sampled by PIO without calling `pio_gpio_init`, as long as the pad's input-enable bit is set.
