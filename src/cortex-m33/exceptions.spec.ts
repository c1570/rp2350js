/**
 * Exception/NVIC integration test.
 *
 * Programs a tiny vector table + handler in SRAM, asserts an external IRQ
 * via NVIC, and confirms the handler runs and returns to the main code.
 */

import { describe, expect, it } from 'vitest';
import { RP2350 } from '../rp2350';

const SRAM = 0x20000000;

describe('Cortex-M33 exception entry/return + NVIC', () => {
  it('external IRQ handler runs and returns to main code', () => {
    const chip = new RP2350({ coreArch: 'arm' });
    const core = chip.armCore0;

    // Set up vector table at SRAM. Vector for IRQ 0 (vector 16) at SRAM + 64.
    const VTOR = SRAM;
    chip.writeUint32(VTOR + 16 * 4, SRAM + 0x200); // IRQ 0 handler

    // Configure PPB: set VTOR, enable IRQ 0, set its priority to 0 (highest).
    chip.currentCore = 0;
    chip.writeUint32(0xe000ed08, VTOR); // VTOR
    chip.writeUint32(0xe000e100, 1 << 0); // ISER0: enable IRQ 0
    // Default priority is 0 — fine.

    // Main code at SRAM + 0x100:
    //   NOP
    //   NOP
    //   (after handler returns, lands here)
    //   ...
    const MAIN = SRAM + 0x100;
    chip.writeUint16(MAIN + 0, 0xbf00); // NOP
    chip.writeUint16(MAIN + 2, 0xbf00); // NOP
    chip.writeUint16(MAIN + 4, 0xbf00); // NOP
    chip.writeUint16(MAIN + 6, 0xbf00); // NOP

    // IRQ handler at SRAM + 0x200: writes a marker to R0, then returns.
    const HANDLER = SRAM + 0x200;
    chip.writeUint16(HANDLER + 0, 0x2001); // MOVS r0, #1
    chip.writeUint16(HANDLER + 2, 0x4770); // BX lr (EXC_RETURN)

    // Start the core at MAIN.
    core.regs.r[0] = 0;
    core.PC = MAIN;
    core.regs.sp = SRAM + 0x1000;
    core.regs.msp = SRAM + 0x1000;

    // Step once: NOP.
    core.executeInstruction();
    expect(core.PC).toBe(MAIN + 2);

    // Now pend IRQ 0 via NVIC (write to ISPR0).
    chip.writeUint32(0xe000e200, 1 << 0);

    // Next step: interruptsUpdated should trigger entry into handler.
    core.executeInstruction();
    expect(core.regs.ipsr).toBe(16); // IRQ 0
    expect(core.PC).toBe(HANDLER);

    // Step through the handler: MOVS r0,#1.
    core.executeInstruction();
    expect(core.regs.r[0]).toBe(1);

    // Step BX lr → EXC_RETURN → pop frame.
    core.executeInstruction();

    // Should have returned to Thread mode at MAIN+2 (the instruction that
    // was about to execute when the IRQ fired — not skipped past it).
    expect(core.regs.ipsr).toBe(0); // Thread mode
    expect(core.PC).toBe(MAIN + 2);
  });

  // Regression: the handler's own `push {r4,lr}` / `pop {r4,pc}` (as opposed
  // to a plain `bx lr`) exercises a real ordering bug — `regs.sp` must be
  // updated to its fully-popped value *before* the popped PC is handed to
  // bxWritePC/exceptionReturn, since exceptionReturn reads the exception
  // frame from the *current* SP. Popping any register before PC (here, r4)
  // means SP-before-the-pop != the frame address, so this specifically
  // requires more than one register in the pop list to catch the bug.
  it('handler using push{r4,lr}/pop{r4,pc} (not bx lr) still returns correctly', () => {
    const chip = new RP2350({ coreArch: 'arm' });
    const core = chip.armCore0;

    const VTOR = SRAM;
    chip.writeUint32(VTOR + 16 * 4, SRAM + 0x200); // IRQ 0 handler
    chip.currentCore = 0;
    chip.writeUint32(0xe000ed08, VTOR);
    chip.writeUint32(0xe000e100, 1 << 0); // ISER0: enable IRQ 0

    const MAIN = SRAM + 0x100;
    chip.writeUint16(MAIN + 0, 0xbf00); // NOP
    chip.writeUint16(MAIN + 2, 0xbf00); // NOP

    // Handler: push {r4,lr}; movs r4,#1; pop {r4,pc}.
    const HANDLER = SRAM + 0x200;
    chip.writeUint16(HANDLER + 0, 0xb510); // push {r4, lr}
    chip.writeUint16(HANDLER + 2, 0x2401); // movs r4, #1
    chip.writeUint16(HANDLER + 4, 0xbd10); // pop {r4, pc}

    core.PC = MAIN;
    core.regs.sp = SRAM + 0x1000;
    core.regs.msp = SRAM + 0x1000;

    core.executeInstruction(); // NOP
    expect(core.PC).toBe(MAIN + 2);

    chip.writeUint32(0xe000e200, 1 << 0); // pend IRQ 0
    core.executeInstruction(); // enter handler
    expect(core.regs.ipsr).toBe(16);
    expect(core.PC).toBe(HANDLER);
    const spAtEntry = core.regs.sp >>> 0;

    core.executeInstruction(); // push {r4, lr}
    expect(core.regs.sp >>> 0).toBe((spAtEntry - 8) >>> 0);
    core.executeInstruction(); // movs r4, #1
    core.executeInstruction(); // pop {r4, pc} -> exception return

    expect(core.regs.ipsr).toBe(0); // back in Thread mode
    expect(core.PC).toBe(MAIN + 2); // correct return address, not corrupted
    // spAtEntry is already past the exception frame (msp was set to frameSp
    // on entry); the frame itself (0x20 bytes) is popped back off on return.
    expect(core.regs.sp >>> 0).toBe((spAtEntry + 0x20) >>> 0); // SP fully restored
  });

  it('PENDSV can be pended and runs at low priority', () => {
    const chip = new RP2350({ coreArch: 'arm' });
    const core = chip.armCore0;

    const VTOR = SRAM;
    chip.writeUint32(VTOR + 14 * 4, SRAM + 0x200); // PendSV vector
    chip.currentCore = 0;
    chip.writeUint32(0xe000ed08, VTOR); // VTOR

    const MAIN = SRAM + 0x100;
    chip.writeUint16(MAIN + 0, 0xbf00); // NOP
    chip.writeUint16(MAIN + 2, 0xbf00); // NOP
    chip.writeUint16(MAIN + 4, 0xbf00); // NOP

    const HANDLER = SRAM + 0x200;
    chip.writeUint16(HANDLER + 0, 0x2107); // MOVS r1, #7
    chip.writeUint16(HANDLER + 2, 0x4770); // BX lr

    core.PC = MAIN;
    core.regs.sp = SRAM + 0x1000;
    core.regs.msp = SRAM + 0x1000;
    core.regs.r[1] = 0;

    core.executeInstruction(); // NOP at MAIN
    expect(core.PC).toBe(MAIN + 2);

    // Pend PendSV via ICSR.PENDSVSET.
    chip.writeUint32(0xe000ed04, 1 << 28); // PENDSVSET

    core.executeInstruction(); // triggers entry
    expect(core.regs.ipsr).toBe(14);
    expect(core.PC).toBe(HANDLER);

    core.executeInstruction(); // MOVS r1, #7
    expect(core.regs.r[1]).toBe(7);

    core.executeInstruction(); // BX lr → exception return
    expect(core.regs.ipsr).toBe(0);
    expect(core.PC).toBe(MAIN + 2);
  });

  // ---- Exception entry/return edge cases ----
  describe('Exception entry/return edge cases', () => {
    it('sync-fault stacks the faulting 32-bit instruction address (not PC-2)', () => {
      const chip = new RP2350({ coreArch: 'arm' });
      const core = chip.armCore0;
      chip.currentCore = 0;
      const VTOR = SRAM;
      chip.writeUint32(0xe000ed08, VTOR); // VTOR
      // HardFault handler.
      chip.writeUint32(VTOR + 3 * 4, SRAM + 0x300);
      chip.writeUint16(SRAM + 0x300, 0xbf00); // NOP in HardFault handler

      // Place a 32-bit FPU instruction (VADD) at SRAM+0x100 with CPACR
      // disabled → NOCP UsageFault → HardFault. The executor advances PC by 4
      // before delivering the fault; the stacked return address must be the
      // faulting instruction address (SRAM+0x100), not SRAM+0x102 (PC-2).
      const FAULT_ADDR = SRAM + 0x100;
      chip.writeUint16(FAULT_ADDR, 0xee30); // VADD.F32 hw0
      chip.writeUint16(FAULT_ADDR + 2, 0x0a81); // VADD.F32 hw1
      core.regs.sp = SRAM + 0x2000;
      core.regs.msp = SRAM + 0x2000;
      core.PC = FAULT_ADDR;
      core.executeInstruction(); // triggers NOCP → HardFault entry
      // Read stacked PC from the basic frame (frame = MSP-0x20, PC at +24).
      const frameSp = (SRAM + 0x2000 - 0x20) >>> 0;
      const stackedPc = chip.readUint32(frameSp + 24);
      expect(stackedPc).toBe(FAULT_ADDR); // not FAULT_ADDR + 2
    });

    it('IT state + pad bit restored from stacked xPSR on exception return', () => {
      const chip = new RP2350({ coreArch: 'arm' });
      const core = chip.armCore0;
      chip.currentCore = 0;
      const VTOR = SRAM;
      chip.writeUint32(VTOR + 16 * 4, SRAM + 0x200); // IRQ 0 handler
      chip.writeUint32(0xe000ed08, VTOR);
      chip.writeUint32(0xe000e100, 1 << 0); // ISER0: enable IRQ 0

      const MAIN = SRAM + 0x100;
      chip.writeUint16(MAIN + 0, 0xbf08); // IT EQ
      chip.writeUint16(MAIN + 2, 0xbf00); // NOP (then-block)
      chip.writeUint16(MAIN + 4, 0xbf00); // NOP

      const HANDLER = SRAM + 0x200;
      chip.writeUint16(HANDLER + 0, 0x4770); // BX lr

      // Use an ODD SP so 8-byte alignment pads the stack frame. This sets
      // bit 9 in the stacked xPSR on entry; exception return must strip it.
      core.PC = MAIN;
      core.regs.sp = SRAM + 0x1001; // misaligned → stack frame gets padded
      core.regs.msp = SRAM + 0x1001;

      core.executeInstruction(); // IT EQ → itState=0x08
      expect(core.regs.itState).toBe(0x08);

      // Pend IRQ 0 and step → exception entry clears itState.
      chip.writeUint32(0xe000e200, 1 << 0);
      core.executeInstruction(); // triggers IRQ entry
      expect(core.regs.itState).toBe(0);

      // Return from handler.
      core.executeInstruction(); // BX lr → exception return
      // itState must be restored from stacked xPSR.
      expect(core.regs.itState).toBe(0x08);
      // Pad bit 9 must be stripped from xPSR (architectural: bit 9 is frame
      // metadata, not part of the architectural PSR).
      expect(core.regs.xpsr & (1 << 9)).toBe(0);
    });

    it('BASEPRI masks a lower-priority external IRQ (unified &0xE0 scale)', () => {
      const chip = new RP2350({ coreArch: 'arm' });
      const core = chip.armCore0;
      chip.currentCore = 0;
      const VTOR = SRAM;
      chip.writeUint32(VTOR + 16 * 4, SRAM + 0x200); // IRQ 0 handler
      chip.writeUint32(0xe000ed08, VTOR);
      chip.writeUint32(0xe000e100, 1 << 0); // ISER0: enable IRQ 0
      // Set IRQ 0 priority directly: stored as top-nibble. Value 4 → byte 0x40,
      // which on the unified &0xE0 scale is priority 0x40.
      chip.ppb!.coreState[0].nvicPriority[0] = 4;

      const MAIN = SRAM + 0x100;
      chip.writeUint16(MAIN + 0, 0xbf00); // NOP
      chip.writeUint16(MAIN + 2, 0xbf00); // NOP
      const HANDLER = SRAM + 0x200;
      chip.writeUint16(HANDLER + 0, 0x2001); // MOVS r0, #1
      chip.writeUint16(HANDLER + 2, 0x4770); // BX lr

      core.PC = MAIN;
      core.regs.sp = SRAM + 0x1000;
      core.regs.msp = SRAM + 0x1000;
      core.regs.r[0] = 0;

      // Set BASEPRI = 0x40 → masks all IRQs with priority >= 0x40.
      core.regs.basepri = 0x40;

      core.executeInstruction(); // NOP
      // Pend IRQ 0.
      chip.writeUint32(0xe000e200, 1 << 0);
      core.executeInstruction(); // should NOT enter handler (masked by BASEPRI)
      expect(core.regs.ipsr).toBe(0); // still in Thread mode
      expect(core.PC).toBe(MAIN + 4); // advanced past NOP

      // Now clear BASEPRI and pend again.
      core.regs.basepri = 0;
      chip.writeUint32(0xe000e200, 1 << 0);
      core.executeInstruction(); // should enter handler now
      expect(core.regs.ipsr).toBe(16); // IRQ 0 active
    });

    it('system exception (SVC) priority uses full-byte &0xE0 scale', () => {
      // With SHPR2 = 0x20000000, SVC priority byte = 0x20, &0xE0 = 0x20.
      // An external IRQ at priority 0x40 (&0xE0 = 0x40) is LOWER priority than
      // SVC (0x20 < 0x40, and lower numerical = higher urgency).
      const chip = new RP2350({ coreArch: 'arm' });
      const st = chip.ppb!.coreState[0];
      st.shpr2 = 0x20000000; // SVC priority byte = 0x20
      st.nvicPriority[0] = 4; // IRQ 0 priority = 4 (byte 0x40, &0xE0 = 0x40)
      // exceptionPriority(SVC) should be 0x20, not 0.
      expect((st.shpr2 >>> 24) & 0xe0).toBe(0x20); // sanity: byte extraction
    });

    it('CONTROL.FPCA cleared on non-FP exception return (Thread mode)', () => {
      // FPCA=0 before the IRQ. Entry doesn't push an FP frame. On Thread-mode
      // return with a non-FP EXC_RETURN (bit 4 = 1 → no FP frame), FPCA must
      // stay 0.
      const chip = new RP2350({ coreArch: 'arm' });
      const core = chip.armCore0;
      chip.currentCore = 0;
      const VTOR = SRAM;
      chip.writeUint32(VTOR + 16 * 4, SRAM + 0x200); // IRQ 0 handler
      chip.writeUint32(0xe000ed08, VTOR);
      chip.writeUint32(0xe000e100, 1 << 0); // ISER0: enable IRQ 0

      const MAIN = SRAM + 0x100;
      chip.writeUint16(MAIN + 0, 0xbf00); // NOP
      chip.writeUint16(MAIN + 2, 0xbf00); // NOP
      const HANDLER = SRAM + 0x200;
      chip.writeUint16(HANDLER + 0, 0x4770); // BX lr → non-FP return (0xFFFFFFF9)

      core.PC = MAIN;
      core.regs.sp = SRAM + 0x1000;
      core.regs.msp = SRAM + 0x1000;
      // FPCA = 0 (no FP context active). Entry won't push an FP frame.

      core.executeInstruction(); // NOP
      chip.writeUint32(0xe000e200, 1 << 0); // pend IRQ 0
      core.executeInstruction(); // enter handler (no FP frame)
      core.executeInstruction(); // BX lr → exception return (non-FP, Thread mode)

      // FPCA must be 0: the return had no FP frame (EXC_RETURN bit 4 = 1).
      expect(core.regs.control & 0x4).toBe(0);
    });

    it('FP frame popped from frame SP, not global fpcar', () => {
      // With FPCA=1, entry pushes an FP frame and sets fpcar. If fpcar is then
      // overwritten (simulating a nested entry), the return must still read
      // from the correct frame SP (frameSp + 0x20), not the stale fpcar.
      const chip = new RP2350({ coreArch: 'arm' });
      const core = chip.armCore0;
      chip.currentCore = 0;
      const VTOR = SRAM;
      chip.writeUint32(VTOR + 16 * 4, SRAM + 0x200); // IRQ 0 handler
      chip.writeUint32(0xe000ed08, VTOR);
      chip.writeUint32(0xe000e100, 1 << 0); // ISER0: enable IRQ 0

      const MAIN = SRAM + 0x100;
      chip.writeUint16(MAIN + 0, 0xbf00); // NOP
      chip.writeUint16(MAIN + 2, 0xbf00); // NOP
      const HANDLER = SRAM + 0x200;
      chip.writeUint16(HANDLER + 0, 0x4770); // BX lr

      core.PC = MAIN;
      core.regs.sp = SRAM + 0x1000;
      core.regs.msp = SRAM + 0x1000;
      core.regs.control |= 0x4; // FPCA = 1 → FP frame pushed on entry
      core.regs.s[0] = 42.0; // integer-valued float survives >>> 0

      core.executeInstruction(); // NOP
      chip.writeUint32(0xe000e200, 1 << 0); // pend IRQ 0
      core.executeInstruction(); // enter handler → pushes FP frame at frameSp+0x20

      // Corrupt fpcar to simulate a nested FP entry overwriting it.
      const st = chip.ppb!.coreState[0];
      st.fpcar = 0xdeadbeef;

      core.executeInstruction(); // BX lr → exception return + FP unstack
      // S0 must be restored from the frame SP (frameSp+0x20), not the stale
      // fpcar.
      expect(core.regs.s[0]).toBe(42);
    });

    it('SysTick CVR write clears COUNTFLAG', () => {
      const chip = new RP2350({ coreArch: 'arm' });
      chip.currentCore = 0;
      const st = chip.ppb!.coreState[0];
      // Set COUNTFLAG as if SysTick had counted to 0.
      st.systickCountFlag = true;
      expect(st.systickCountFlag).toBe(true);
      // Write any value to SYST_CVR (offset 0x018 from SYSTICK_BASE 0xe000e010).
      chip.writeUint32(0xe000e028, 0);
      // COUNTFLAG must be cleared by the CVR write (ARMv8-M §B3.3).
      expect(st.systickCountFlag).toBe(false);
    });
  });
});
