/**
 * Browser-side firmware loading: mirrors the SRAM path of src/utils/load-firmware.ts
 * (loadHex + setupVectoredRamBoot + reset), but from fetch()-ed text instead of fs.
 */
import { RP2350 } from '../../../src/rp2350';
import { loadHex } from '../../../src/utils/load-hex';

const RAM_START_ADDRESS = 0x20000000;
const SRAM_WINDOW_SIZE = 256 * 1024; // covers typical pico-sdk SRAM images

// Vectored-reboot handshake (see src/utils/load-firmware.ts header comment).
const VECTORED_BOOT_MAGIC = 0xb007c0d3;
const NEG_MAGIC = -VECTORED_BOOT_MAGIC >>> 0; // 0x4ff83f2d
const BOOT_TYPE_RAM_IMAGE = 0x3;
const WATCHDOG_SCRATCH0 = 0x400d800c;

/**
 * Load a no_flash (SRAM) image into the chip and set up the bootrom's vectored
 * boot so the firmware starts from a clean reset, exactly as on real hardware
 * after a UF2 upload. Returns the image's load base address.
 */
export function loadSramFirmware(chip: RP2350, hexText: string): number {
  const loadBase = sramLoadBase(hexText);
  loadHex(hexText, chip.sram, RAM_START_ADDRESS);
  const w = (i: number) => WATCHDOG_SCRATCH0 + i * 4;
  chip.writeUint32(w(2), loadBase);
  chip.writeUint32(w(3), SRAM_WINDOW_SIZE);
  chip.writeUint32(w(4), VECTORED_BOOT_MAGIC);
  chip.writeUint32(w(5), (VECTORED_BOOT_MAGIC ^ NEG_MAGIC) >>> 0);
  chip.writeUint32(w(6), BOOT_TYPE_RAM_IMAGE);
  chip.writeUint32(w(7), VECTORED_BOOT_MAGIC);
  chip.reset();
  return loadBase;
}

/**
 * Lowest data address of an Intel HEX image, which must live in SRAM (a
 * no_flash build). Extended address records (type 04) tell SRAM from flash.
 */
function sramLoadBase(hex: string): number {
  let upper = 0;
  let loadBase = Infinity;
  for (const line of hex.split('\n')) {
    if (line[0] !== ':') continue;
    const recordType = line.substring(7, 9);
    if (recordType === '04') {
      upper = parseInt(line.substring(9, 13), 16);
    } else if (recordType === '00') {
      const addr = ((upper << 16) | parseInt(line.substring(3, 7), 16)) >>> 0;
      if (addr < RAM_START_ADDRESS || addr >= RAM_START_ADDRESS + SRAM_WINDOW_SIZE) {
        throw new Error(
          'firmware is not a SRAM (no_flash) image — rebuild with pico_set_binary_type no_flash'
        );
      }
      if (addr < loadBase) loadBase = addr;
    } else if (recordType === '01') {
      break;
    }
  }
  if (loadBase === Infinity) throw new Error('hex image contains no data records');
  return loadBase;
}
