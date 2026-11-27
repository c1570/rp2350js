# Builds webfirmware.{hex,dis,uf2}: a no_flash (RAM-resident)
# RP2350 RISC-V firmware for the snapshot/rewind web demo.
#
#   cmake -S demo/web/webfirmware -B demo/web/webfirmware/build \
#     -DPICO_SDK_PATH=$HOME/pico-sdk \
#     -DPICO_TOOLCHAIN_PATH=$HOME/project/corev-openhw-gcc-ubuntu2204-20240530
#   cmake --build demo/web/webfirmware/build
#
# The build script then copies webfirmware.{hex,dis} into demo/web/public/.
cmake_minimum_required(VERSION 3.13)

set(PICO_PLATFORM rp2350-riscv)
set(PICO_BOARD pico2)
set(PICO_NO_PICOTOOL 1)

include(${PICO_SDK_PATH}/external/pico_sdk_import.cmake)

project(webfirmware C CXX ASM)
pico_sdk_init()

add_executable(webfirmware webfirmware.c)
pico_generate_pio_header(webfirmware ${CMAKE_CURRENT_LIST_DIR}/counter.pio)
target_link_libraries(webfirmware pico_stdlib pico_multicore hardware_pio)
pico_enable_stdio_uart(webfirmware 1)
pico_enable_stdio_usb(webfirmware 0)

# Run directly from SRAM (no XIP flash image)
pico_set_binary_type(webfirmware no_flash)

pico_add_hex_output(webfirmware)
pico_add_dis_output(webfirmware)
pico_add_uf2_output(webfirmware)
