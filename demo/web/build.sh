#!/bin/sh
# Builds the web demo: firmware (CMake + pico-sdk, RISC-V no_flash) and the
# browser bundle (type-checked with tsc, bundled with esbuild). Artifacts land
# in demo/web/public/.
set -e
cd "$(dirname "$0")"

PICO_SDK_PATH="${PICO_SDK_PATH:-$HOME/pico-sdk}"
PICO_TOOLCHAIN_PATH="${PICO_TOOLCHAIN_PATH:-$HOME/project/corev-openhw-gcc-ubuntu2204-20240530}"

echo "== firmware =="
cmake -S webfirmware -B webfirmware/build \
  -DPICO_SDK_PATH="$PICO_SDK_PATH" \
  -DPICO_TOOLCHAIN_PATH="$PICO_TOOLCHAIN_PATH"
cmake --build webfirmware/build -j "$(nproc 2>/dev/null || echo 2)"

mkdir -p public
cp webfirmware/build/webfirmware.hex public/
# The .dis contains objdump header lines with the build machine's absolute
# path (twice) — strip every line mentioning the .elf file.
sed -e '/\.elf:/d' webfirmware/build/webfirmware.dis > public/webfirmware.dis

echo "== browser bundle =="
# esbuild does not type-check; tsc does (demo/web/tsconfig.json covers src/ and test/).
../../node_modules/.bin/tsc -p tsconfig.json
ESBUILD=../../node_modules/.bin/esbuild
# Minified: tsc already type-checked the sources; the module-path comments
# esbuild emits otherwise would only reveal the repo layout.
"$ESBUILD" src/main.ts --bundle --minify --format=iife --target=es2020 \
  --alias:fs=./src/shims/fs-stub.ts --alias:uf2=./src/shims/uf2-stub.ts \
  --outfile=public/app.js

echo "== done: demo/web/public/ =="
