/**
 * Minimal Intel HEX loader
 * Part of AVR8js
 *
 * Copyright (C) 2019, Uri Shaked
 */

export function loadHex(source: string, target: Uint8Array, baseAddress: number = 0) {
  let highAddressBytes = 0;
  for (const line of source.split('\n')) {
    if (line[0] === ':' && line.substring(7, 9) === '04') {
      highAddressBytes = parseInt(line.substring(9, 13), 16);
    }
    if (line[0] === ':' && line.substring(7, 9) === '00') {
      const bytes = parseInt(line.substring(1, 3), 16);
      const addr = ((highAddressBytes << 16) | parseInt(line.substring(3, 7), 16)) - baseAddress;
      for (let i = 0; i < bytes; i++) {
        target[addr + i] = parseInt(line.substring(9 + i * 2, 11 + i * 2), 16);
      }
    }
  }
}
