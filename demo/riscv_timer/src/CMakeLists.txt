# Builds demo/riscv_timer/hello_timer.{hex,dis} for the hello_timer regression test.
#
#   cmake -S demo/riscv_timer/src -B build/riscv_timer \
#     -DPICO_SDK_PATH=<pico-sdk >= 2.1.1> -DPICO_TOOLCHAIN_PATH=<riscv gcc>
#   cmake --build build/riscv_timer
#   cp build/riscv_timer/hello_timer.{hex,dis} demo/riscv_timer/
cmake_minimum_required(VERSION 3.13)

set(PICO_PLATFORM rp2350-riscv)
set(PICO_BOARD pico2)
set(PICO_NO_PICOTOOL 1)

include(${PICO_SDK_PATH}/external/pico_sdk_import.cmake)

project(hello_timer C CXX ASM)
pico_sdk_init()

add_executable(hello_timer hello_timer.c)
target_link_libraries(hello_timer pico_stdlib)
pico_enable_stdio_uart(hello_timer 1)
pico_enable_stdio_usb(hello_timer 0)
pico_add_hex_output(hello_timer)
pico_add_dis_output(hello_timer)
