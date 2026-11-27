/** Browser stub for the `uf2` package (only used by node-side firmware loaders). */
export function decodeBlock(): { flashAddress: number; payload: Uint8Array } {
  throw new Error('uf2.decodeBlock is unavailable in the browser build');
}
