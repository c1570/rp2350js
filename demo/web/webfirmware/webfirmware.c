/**
 * webfirmware — concurrent PIO + core1 counter demo firmware for the rp2350js
 * snapshot/rewind web demo.
 *
 *  core0: edge-detects the GPIO24 button and pushes 0 into the PIO TX FIFO on
 *         every toggle (reload request); prints a banner plus periodic status
 *         lines over UART0.
 *  PIO0 SM0: countdown program — displays the 8-bit counter on GPIO 2..9,
 *         decrementing every ~12 SM cycles; a FIFO word reloads it (0 = restart
 *         from the top of the 8-bit range).
 *  core1: keeps its own counter, increments it while the GPIO24 button is
 *         released, decrements while pressed; outputs the lowest 8 bits on
 *         GPIO 16..23 via gpio_put_masked().
 *
 * Built as a no_flash (run-from-RAM) image; the emulator boots it via the
 * bootrom's vectored SRAM boot.
 */

#include <stdio.h>
#include "pico/stdlib.h"
#include "hardware/pio.h"
#include "hardware/gpio.h"
#include "pico/multicore.h"

#include "counter.pio.h"

#define PIO_PINS_BASE 2 // GPIO 2..9: PIO countdown bit 0..7
#define CPU_PINS_BASE 16 // GPIO 16..23: core1 counter bit 0..7
#define BTN_GPIO 24 // button to GND, internal pull-up; pressed = low

#define CPU_PINS_MASK (0xffu << CPU_PINS_BASE)
#define PRINT_PERIOD 300000 // core0 loop iterations between status lines
#define STATUS_LINES 10 // number of periodic status lines before the end sentinel

// The web demo stops the emulation when the last byte of the sentinel line has
// been shifted out of UART0; the timeline runs from boot to exactly that cycle.
#define END_SENTINEL "### END OF OUTPUT ###"

static volatile uint32_t cpu_counter = 0; // written by core1, printed by core0
static uint32_t reload_count = 0;

static void core1_main(void) {
    gpio_init(BTN_GPIO);
    gpio_set_dir(BTN_GPIO, GPIO_IN);
    gpio_pull_up(BTN_GPIO);

    gpio_init_mask(CPU_PINS_MASK);
    gpio_set_dir_out_masked(CPU_PINS_MASK);

    while (true) {
        if (gpio_get(BTN_GPIO)) {
            cpu_counter++;
        } else {
            cpu_counter--;
        }
        gpio_put_masked(CPU_PINS_MASK, (cpu_counter & 0xffu) << CPU_PINS_BASE);
    }
}

int main(void) {
    stdio_init_all();

    printf("\n");
    printf("=============================================\n");
    printf(" rp2350js demo firmware (no_flash, RISC-V)\n");
    printf(" PIO0 SM0: countdown -> GPIO 2..9 (out pins)\n");
    printf(" core1   : counter -> GPIO 16..23 (gpio_put)\n");
    printf(" GPIO24  : toggle = reload, reverses the core1 counter\n");
    printf("=============================================\n");

    // PIO countdown output
    PIO pio = pio0;
    const uint sm = 0;
    const uint offset = pio_add_program(pio, &countdown_program);
    countdown_program_init(pio, sm, offset, PIO_PINS_BASE);
    printf("countdown program loaded at offset %u on PIO0 SM%u\n", offset, sm);

    // core1 counter output
    multicore_launch_core1(core1_main);

    // Button edge detection: push 0 (a countdown reload) on every toggle.
    bool last_btn = true;
    gpio_init(BTN_GPIO);
    gpio_set_dir(BTN_GPIO, GPIO_IN);
    gpio_pull_up(BTN_GPIO);

    uint32_t ticks = 0;
    uint32_t lines = 0;
    while (true) {
        const bool btn = gpio_get(BTN_GPIO);
        if (btn != last_btn) {
            last_btn = btn;
            pio->txf[sm] = 0; // reload the countdown
            reload_count++;
        }
        if (++ticks >= PRINT_PERIOD) {
            ticks = 0;
            if (lines < STATUS_LINES) {
                lines++;
                printf("status %lu/%u: cpu_counter=0x%08lx button=%s reloads=%lu\n",
                       (unsigned long)lines, STATUS_LINES, (unsigned long)cpu_counter,
                       gpio_get(BTN_GPIO) ? "up" : "PRESSED", (unsigned long)reload_count);
            } else if (lines == STATUS_LINES) {
                lines++; // print the sentinel exactly once, then stay silent
                printf("%s\n", END_SENTINEL);
            }
        }
    }
}
