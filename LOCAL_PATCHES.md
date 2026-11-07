# Local patches (not yet upstream)

Stacked on c1570/rp2350js @ 6edc84c. Upstream has issues disabled; these
are destined for PRs. Each entry: what, why, validation.

## 1. Align(PC,4) for PC-as-data-operand reads
- Files: `src/cortex-m33/execute-thumb16.ts` (2 sites: high ADD/MOV),
  `src/cortex-m33/execute-thumb32.ts` (4 sites: ADDW/SUBW/data-proc).
- Why: ARMv8-M PC reads align to 4; the emulator used raw PC, computing
  `0x20000082` instead of `0x20000080` and crashing X1's
  `_Z16init_trig_tablesv` (`addw r9, pc, #124` at 0x1002d2fa).
- Validated: micro-test stores 0x20000080; upstream suite 942 passed.

## 2. `drive_gpio` daemon tool (virtual-wire endpoint)
- Files: `src/rp2-emu-cli/rp2-emu.ts`, `src/utils/emulator-controller.ts`.
- Why: set an external input level 0/1 on a pin (GP5 TX -> GP4 RX across
  two daemon instances). Immediate; PIO/SIO see it on next sample.

## 3. VLDR.64/VSTR.64 transfer both words
- File: `src/cortex-m33/execute-fpu.ts` (VLDR/VSTR single-register handler).
- Why: handler ignored coproc==11 (double), moving only the low word.
  GCC -O3 materializes 64-bit struct constants via d-regs; the dropped
  high word zeroed PIO PINCTRL.IN_BASE in uart_rx init (RX watched GP0
  instead of GP4: FIFO filled with zeros, OTA len=0). M-profile D16 fixes
  D=0 so getSd() already equals 2*Dd: transfer s[sd] and s[sd+1].
- Validated: X1 OTA rig (256B + CRC + staging) passes; suite 942 passed.

## 4. IO_QSPI minimal model (was UnimplementedPeripheral)
- Files: new `src/peripherals/io_qspi_rp2350.ts`, registered in
  `src/rp2350.ts` at 0x40030.
- Why: unimplemented reads return 0xFFFFFFFF, so the A2 bootrom's
  flash_range_erase/program (which gate on the SD1 INOVER field) assumed
  CS was externally forced and skipped all work. Stored regs with reset
  defaults (STATUS=0, CTRL=0x1F) fix the gate; writes stick (IO CS force
  set/clear round-trips).
- Validated: bootrom erase/program now execute; suite 942 passed.

## 5. QMI direct-mode SPI flash model
- File: `src/peripherals/xip_rp2350.ts` (RPXIPQMI).
- Why: direct-TX was accept-and-discard, so flash_range_erase/program
  completed without changing chip.flash (staging readback stayed 0xFF).
  Implements: WREN/WRDI/RDSR (WIP=0, WEL tracked), SECTOR_ERASE 4K,
  PAGE_PROGRAM (NOR &= semantics, page wrap), READ/FAST_READ, RDID zeros
  (status quo), live RX FIFO + CSR status bits, CS tracking via
  ASSERT_CS0N and the IO_QSPI SS OUTOVER force. Command bytes are parsed
  as a stream (the bootrom clocks them outside CS asserts; CS edges only
  reset the parser); program auto-exits after one 256B page.
- Validated: OTA staging programs and XIP readback verifies; suite
  942 passed.
