// Bundled RP2040 / RP2350 bootrom images.
//
// Each is a flat Uint32Array of the bootrom's address space, suitable for
// passing to RP2350.loadBootrom() or as the optional `bootrom` argument to
// EmulatorController (or the RP2350McpServer shim that wraps it).

export { bootromB1 } from './bootrom-rp2040-b1';
export { bootrom_rp2350_A2 } from './bootrom-rp2350-a2';
