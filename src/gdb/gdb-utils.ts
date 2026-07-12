export function encodeHexByte(value: number) {
  return (value >> 4).toString(16) + (value & 0xf).toString(16);
}

export function encodeHexBuf(buf: Uint8Array) {
  return Array.from(buf).map(encodeHexByte).join('');
}

export function encodeHexUint32BE(value: number) {
  return encodeHexBuf(
    new Uint8Array([(value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff])
  );
}

export function encodeHexUint32(value: number) {
  const buf = new Uint32Array([value]);
  return encodeHexBuf(new Uint8Array(buf.buffer));
}

export function decodeHexBuf(encoded: string) {
  const result = new Uint8Array(encoded.length / 2);
  for (let i = 0; i < result.length; i++) {
    result[i] = parseInt(encoded.substring(i * 2, i * 2 + 2), 16);
  }
  return result;
}

export function decodeHexUint32Array(encoded: string) {
  return new Uint32Array(decodeHexBuf(encoded).buffer);
}

export function decodeHexUint32(encoded: string) {
  return decodeHexUint32Array(encoded)[0];
}

// Unescape GDB binary data: '}' is the escape char, next byte XOR'd with 0x20.
// Used by the X (binary memory write) packet.
export function unescapeBinary(escaped: string): Uint8Array {
  const result: number[] = [];
  for (let i = 0; i < escaped.length; i++) {
    const c = escaped.charCodeAt(i);
    if (c === 0x7d && i + 1 < escaped.length) {
      result.push(escaped.charCodeAt(++i) ^ 0x20);
    } else {
      result.push(c);
    }
  }
  return new Uint8Array(result);
}

export function gdbChecksum(text: string) {
  const value =
    text
      .split('')
      .map((c) => c.charCodeAt(0))
      .reduce((a, b) => a + b, 0) & 0xff;
  return encodeHexByte(value);
}

export function gdbMessage(value: string) {
  return `$${value}#${gdbChecksum(value)}`;
}
