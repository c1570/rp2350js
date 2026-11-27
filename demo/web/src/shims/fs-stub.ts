/**
 * Browser stubs for the `fs` module. The RP2350 class transitively imports
 * src/utils/load-firmware.ts (for the node CLI path); we never call its fs-backed
 * helpers in the browser — demo/web/src/firmware.ts re-implements the load flow
 * with fetch()-ed text instead. These stubs only need to exist so the bundle links.
 */
export function existsSync(_path: string): boolean {
  return false;
}

export function readFileSync(_path: string, _options?: string): string {
  throw new Error('fs.readFileSync is unavailable in the browser build');
}
