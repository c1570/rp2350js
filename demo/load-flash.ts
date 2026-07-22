import { closeSync, openSync, readSync } from 'fs';
import { IRPChip } from '../src/rpchip';

const MICROPYTHON_FS_FLASH_START = 0xa0000;
const MICROPYTHON_FS_BLOCKSIZE = 4096;
const MICROPYTHON_FS_BLOCKCOUNT = 352;

const CIRCUITPYTHON_FS_FLASH_START = 0x100000;
const CIRCUITPYTHON_FS_BLOCKSIZE = 4096;
const CIRCUITPYTHON_FS_BLOCKCOUNT = 512;

function loadFlashImage(filename: string, rp2040: IRPChip, flashStart: number, blockSize: number) {
  const file = openSync(filename, 'r');
  const buffer = new Uint8Array(blockSize);
  let flashAddress = flashStart;
  while (readSync(file, buffer) === buffer.length) {
    rp2040.flash.set(buffer, flashAddress);
    flashAddress += buffer.length;
  }
  closeSync(file);
}

export function loadMicropythonFlashImage(filename: string, rp2040: IRPChip) {
  loadFlashImage(filename, rp2040, MICROPYTHON_FS_FLASH_START, MICROPYTHON_FS_BLOCKSIZE);
}

export function loadCircuitpythonFlashImage(filename: string, rp2040: IRPChip) {
  loadFlashImage(filename, rp2040, CIRCUITPYTHON_FS_FLASH_START, CIRCUITPYTHON_FS_BLOCKSIZE);
}
