/**
 * Copyright (c) 2020 Raspberry Pi (Trading) Ltd.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * pico-examples hello_timer with shorter times (20 ms alarm, 50 ms repeats,
 * 500 ms sleeps), so the whole program runs in about 2.5 s of simulated time.
 */

#include <stdio.h>
#include "pico/stdlib.h"

volatile bool timer_fired = false;

int64_t alarm_callback(alarm_id_t id, __unused void *user_data) {
    printf("Timer %d fired!\n", (int) id);
    timer_fired = true;
    // Can return a value here in us to fire in the future
    return 0;
}

bool repeating_timer_callback(__unused struct repeating_timer *t) {
    printf("Repeat at %lld\n", time_us_64());
    return true;
}

int main() {
    stdio_init_all();
    printf("Hello Timer!\n");

    // Call alarm_callback in 20 ms
    add_alarm_in_ms(20, alarm_callback, NULL, false);

    // Wait for alarm callback to set timer_fired
    while (!timer_fired) {
        tight_loop_contents();
    }

    // Create a repeating timer that calls repeating_timer_callback.
    // If the delay is > 0 then this is the delay between the previous callback ending and the next starting.
    // If the delay is negative (see below) then the next call to the callback will be exactly 50ms after the
    // start of the call to the last callback
    struct repeating_timer timer;
    add_repeating_timer_ms(50, repeating_timer_callback, NULL, &timer);
    sleep_ms(500);
    bool cancelled = cancel_repeating_timer(&timer);
    printf("cancelled... %d\n", cancelled);
    sleep_ms(500);

    // Negative delay so means we will call repeating_timer_callback, and call it again
    // 50ms later regardless of how long the callback took to execute
    add_repeating_timer_ms(-50, repeating_timer_callback, NULL, &timer);
    sleep_ms(500);
    cancelled = cancel_repeating_timer(&timer);
    printf("cancelled... %d\n", cancelled);
    sleep_ms(500);
    printf("Done\n");
    return 0;
}
