import { describe, expect, it } from 'vitest';
import { RP2350 } from '../../rp2350';

const SCRATCH = 0x20000000;
const HANDLER = 0x20020000;
const NOP = 0x00000013; // addi x0, x0, 0
const MTIP = 1 << 7;
const MSTATUS_MIE = 1 << 3;

function setup() {
  const chip = new RP2350();
  const cpu = chip.core0;
  chip.writeUint32(SCRATCH, NOP);
  cpu.pc = SCRATCH;
  cpu.next_pc = 0;
  cpu.csrs[0x305] = HANDLER; // mtvec, direct mode
  return { chip, cpu };
}

// csrrw rd, csr, rs1
const csrrw = (rd: number, csr: number, rs1: number) =>
  ((csr << 20) | (rs1 << 15) | (1 << 12) | (rd << 7) | 0x73) >>> 0;
// csrrsi rd, csr, imm
const csrrsi = (rd: number, csr: number, imm: number) =>
  ((csr << 20) | (imm << 15) | (6 << 12) | (rd << 7) | 0x73) >>> 0;

describe('Hazard3 machine timer interrupt (MIP.MTIP)', () => {
  it('traps with cause 0x80000007 when MTIE and MSTATUS.MIE are set', () => {
    const { cpu } = setup();
    cpu.csrs[0x304] = MTIP;
    cpu.csrs[0x300] = MSTATUS_MIE | (3 << 11);
    cpu.setTimerInterrupt(true);
    cpu.checkForInterrupts();
    expect(cpu.csrs[0x342]).toBe(0x80000007);
    expect(cpu.csrs[0x341]).toBe(SCRATCH);
    expect(cpu.pc).toBe(HANDLER);
  });

  it('uses the vectored offset mtvec + 4*7', () => {
    const { cpu } = setup();
    cpu.csrs[0x305] = HANDLER | 1;
    cpu.csrs[0x304] = MTIP;
    cpu.csrs[0x300] = MSTATUS_MIE | (3 << 11);
    cpu.setTimerInterrupt(true);
    cpu.checkForInterrupts();
    expect(cpu.pc).toBe(HANDLER + 0x1c);
  });

  it('does not trap while MSTATUS.MIE is clear in M-mode', () => {
    const { cpu } = setup();
    cpu.csrs[0x304] = MTIP;
    cpu.csrs[0x300] = 3 << 11;
    cpu.setTimerInterrupt(true);
    cpu.executeInstruction();
    expect(cpu.pc).toBe(SCRATCH + 4);
  });

  it('traps in U-mode even with MSTATUS.MIE clear, recording MPP=U', () => {
    const { cpu } = setup();
    cpu.privilege = 0;
    cpu.csrs[0x304] = MTIP;
    cpu.csrs[0x300] = 0;
    cpu.setTimerInterrupt(true);
    cpu.checkForInterrupts();
    expect(cpu.csrs[0x342]).toBe(0x80000007);
    expect((cpu.csrs[0x300] >>> 11) & 3).toBe(0);
    expect(cpu.privilege).toBe(3);
  });

  it('wfi wakes on MTIP & MTIE without trapping when MSTATUS.MIE is clear', () => {
    const { cpu } = setup();
    cpu.csrs[0x304] = MTIP;
    cpu.csrs[0x300] = 3 << 11;
    cpu.waiting = true;
    cpu.setTimerInterrupt(true);
    cpu.executeInstruction();
    expect(cpu.waiting).toBe(false);
  });

  it('external interrupts take priority over the timer', () => {
    const { cpu } = setup();
    cpu.csrs[0x304] = MTIP | (1 << 11);
    cpu.csrs[0x300] = MSTATUS_MIE | (3 << 11);
    cpu.setInterruptEnabled(5, true);
    cpu.setInterrupt(5, true);
    cpu.setTimerInterrupt(true);
    cpu.checkForInterrupts();
    expect(cpu.csrs[0x342]).toBe(0x8000000b);
  });
});

describe('Hazard3 MEICONTEXT timer-enable save/restore', () => {
  it('csrw meicontext (rd=x0) with MTIESAVE set restores MIE.MTIE', () => {
    const { chip, cpu } = setup();
    cpu.csrs[0x304] = 0;
    cpu.setRegisterU(5, 0b1000);
    chip.writeUint32(SCRATCH, csrrw(0, 0xbe5, 5));
    cpu.executeInstruction();
    expect(cpu.csrs[0x304] & MTIP).toBe(MTIP);
  });

  it('csrrsi meicontext, CLEARTS reports the saved enables and clears MTIE/MSIE', () => {
    const { chip, cpu } = setup();
    cpu.csrs[0x304] = MTIP | (1 << 3);
    chip.writeUint32(SCRATCH, csrrsi(6, 0xbe5, 2));
    cpu.executeInstruction();
    expect(cpu.getRegisterU(6) & 0b1100).toBe(0b1100); // MTIESAVE | MSIESAVE
    expect(cpu.csrs[0x304] & (MTIP | (1 << 3))).toBe(0);
  });
});

describe('Hazard3 MSTATUS.MPP', () => {
  it('only implements M and U: MPP reads back as 00 or 11', () => {
    const { cpu } = setup();
    cpu.setCSR(0x300, 1 << 11, 0); // MPP=01 -> U
    expect((cpu.csrs[0x300] >>> 11) & 3).toBe(0);
    cpu.setCSR(0x300, 2 << 11, 0); // MPP=10 -> M
    expect((cpu.csrs[0x300] >>> 11) & 3).toBe(3);
  });
});
