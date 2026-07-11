import { IRPChip } from '../rpchip';
import { executeRv32c } from './rv32c';

const opcode = (i: number) => i & 0x7f;
const rd = (i: number) => (i >>> 7) & 0x1f;
const func3 = (i: number) => (i >>> 12) & 0x7;
const rs1 = (i: number) => (i >>> 15) & 0x1f;
const rs2 = (i: number) => (i >>> 20) & 0x1f;
const func7 = (i: number) => (i >>> 25) & 0x7f;
const shamt = (i: number) => (i >>> 20) & 0x1f; // same bits as rs2 in shift-imm encodings

const imm_i = (i: number) => i >> 20; // I-type, signed
const immU_i = (i: number) => (i >>> 20) & 0xfff; // I-type, raw 12-bit
const imm_s = (i: number) => ((i >> 25) << 5) | ((i >>> 7) & 0x1f); // S-type, signed
const imm_b = (i: number) =>
  ((i >> 31) << 12) |
  (((i >>> 7) & 1) << 11) |
  (((i >>> 25) & 0x3f) << 5) |
  (((i >>> 8) & 0xf) << 1); // B-type, signed
const imm_u = (i: number) => i & 0xfffff000; // U-type (bits[31:12] in place)
const imm_j = (i: number) =>
  ((i >> 31) << 20) |
  (((i >>> 12) & 0xff) << 12) |
  (((i >>> 20) & 1) << 11) |
  (((i >>> 21) & 0x3ff) << 1); // J-type, signed

enum ExecutionMode {
  Mode_Machine,
  Mode_User,
}

class EICAND {
  constructor(readonly irq_number: number, readonly priority: number) {}
}

export class CPU {
  public waiting = false;
  public eventRegistered = false;

  registerSet: RegisterSet = new RegisterSet(32);
  csrs = new Array<number>(0x1000);
  pc = 0;
  next_pc = 0;
  stopped = false; //TODO
  cycles = 0;
  currentMode: ExecutionMode = ExecutionMode.Mode_Machine;

  interruptsUpdated = false;
  meiea = new Array<number>(512);
  meipa = new Array<number>(512);
  meifa = new Array<number>(512);
  meipra = new Array<number>(512);
  meicand = new Array<EICAND>();

  did_just_jump = false;

  // LR/SC reservation: -1 = no active reservation, otherwise the 16-byte
  // granule-aligned reservation address. lr.w sets it; sc.w checks it;
  // lr.w or AMO on the other hart to the same granule invalidates it.
  lr_addr = -1;
  otherCpu!: CPU;

  invalidateLrReservation(addr: number) {
    if (this.lr_addr === (addr & ~0xf)) this.lr_addr = -1;
  }

  // h3.unblock (SEV): wake the other hart if it's sleeping, otherwise flag a pending event.
  fireSEV() {
    if (this.otherCpu.waiting) {
      this.otherCpu.waiting = false;
    } else {
      this.otherCpu.eventRegistered = true;
    }
  }

  constructor(readonly chip: IRPChip, readonly coreLabel: string, readonly mhartid: number) {
    this.reset();
  }

  get PC() {
    return this.pc;
  }

  get logger() {
    return this.chip.logger;
  }

  reset() {
    // TODO
    this.meiea.fill(0);
    this.meipa.fill(0);
    this.meifa.fill(0);
    this.meipra.fill(0);
    this.meicand = new Array<EICAND>();
    this.interruptsUpdated = false;

    this.csrs.fill(0);
    this.csrs[0x300] = 3 << 11;
    this.csrs[0x301] = 0b01000000100100000001000100000101;
    this.csrs[0x305] = 0x00001fff00;
    this.csrs[0x320] = 0x101;
    //TODO 0x3a1 - 0x7b0
    this.csrs[0xbe4] = (1 << 31) >>> 0; // meinext: noirq
    this.csrs[0xbe5] = 1 << 15; // meicontext: noirq=1
    this.csrs[0xf11] = (0x9 << 7) | 0x13;
    this.csrs[0xf12] = 0x1b;
    this.csrs[0xf13] = 0x86fc4e3f;
  }

  inst_length = 0;

  private fetchInstruction(): number {
    const inst = this.chip.readUint16(this.pc);
    if ((inst & 3) != 3) {
      if (inst == 0) {
        throw Error(`Illegal 16 bit instruction 0 at 0x${this.pc.toString(16)}`);
      }
      // RV32C: execute the decompressed instruction inline and return a
      // sentinel; step() will skip dispatch and only run the PC-update logic.
      executeRv32c(this, inst);
      this.inst_length = 2;
      return 0;
    }
    // 32-bit instruction: fetch the remaining two bytes
    const full = (inst | (this.chip.readUint16(this.pc + 2) << 16)) >>> 0;
    if (this.did_just_jump && this.pc & 3) this.cycles++; // jumped to non 32 bit aligned instr
    this.inst_length = 4;
    return full;
  }

  printDisassembly() {
    let pc = this.pc;
    if (this.chip.disassembly) {
      const search = (this.pc.toString(16) + ':').replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
      const re = new RegExp(search + '(.*)');
      const res = re.exec(this.chip.disassembly);
      const dis = res == null ? '?' : res[1];
      this.logger.info(this.coreLabel, `PC 0x${this.pc.toString(16)} - ${dis}`);
    } else {
      this.logger.info(this.coreLabel, `PC 0x${this.pc.toString(16)}`);
    }
  }

  executeInstruction() {
    this.checkForInterrupts();
    if (this.waiting) {
      this.cycles++;
      return;
    }
    const instruction = this.fetchInstruction();
    try {
      this.step(instruction);
    } catch (e) {
      this.printDisassembly();
      throw e;
    }
    this.cycles++;
  }

  step(instruction: number) {
    // 0 = sentinel from fetchInstruction() meaning the compressed instruction
    // was already executed inline by executeRv32c(); skip dispatch but still
    // run the PC-update logic below.
    if (instruction !== 0) {
      // Cascaded switch on opcode (bits[6:0]); each case dispatches to a
      // per-opcode executor that pre-extracts the relevant fields once.
      switch (instruction & 0x7f) {
        case 0x03:
          executeLoad(instruction, this);
          break; // LOAD
        case 0x0f:
          executeMiscMem(instruction, this);
          break; // MISC-MEM
        case 0x13:
          executeOpImm(instruction, this);
          break; // OP-IMM
        case 0x17:
          executeAuipc(instruction, this);
          break; // AUIPC
        case 0x23:
          executeStore(instruction, this);
          break; // STORE
        case 0x2f:
          executeAmo(instruction, this);
          break; // AMO
        case 0x33:
          executeOp(instruction, this);
          break; // OP
        case 0x37:
          executeLui(instruction, this);
          break; // LUI
        case 0x63:
          executeBranch(instruction, this);
          break; // BRANCH
        case 0x67:
          executeJalr(instruction, this);
          break; // JALR
        case 0x6f:
          executeJal(instruction, this);
          break; // JAL
        case 0x73:
          executeSystem(instruction, this);
          break; // SYSTEM
        case 0x0b:
          executeCustom0(instruction, this);
          break; // CUSTOM0
        default:
          throw Error(
            `Invalid instruction: 0x${instruction.toString(16)} at 0x${this.pc.toString(
              16
            )}, opcode 0x${(instruction & 0x7f).toString(16)}`
          );
      }
    } // end if (instruction !== 0)

    if (this.next_pc != 0) {
      this.pc = this.next_pc;
      this.next_pc = 0;
      this.did_just_jump = true;
    } else {
      this.pc += this.inst_length;
      this.did_just_jump = false;
    }
  }

  setInterruptEnabled(irq: number, value: boolean) {
    if (value && !this.meiea[irq] && this.meipa[irq]) {
      // interrupt was pending and just has been enabled, put into meicand
      this.meiea[irq] = 1;
      this.meipa[irq] = 0;
      this.setInterrupt(irq, true);
    } else if (!value && this.meiea[irq] && this.meipa[irq]) {
      // interrupt is pending and just has been disabled, remove from meicand
      this.setInterrupt(irq, false);
      this.meipa[irq] = 1;
    }
    this.meiea[irq] = +value;
  }

  setInterrupt(irq: number, value: boolean) {
    //this.logger.warn(this.coreLabel, `New interrupt: ${irq} = ${value}`);
    if (value && !this.meipa[irq]) {
      this.meipa[irq] = 1; // Spec: meipa = irq_r | meifa, unconditional on meiea
      if (this.meiea[irq]) {
        // Only add to candidate list if the IRQ is enabled
        this.meicand.push(new EICAND(irq, this.meipra[irq]));
        this.meicand.sort(
          (a, b) => ((b.priority - a.priority) << 9) + (a.irq_number - b.irq_number)
        );
        this.updateMEINEXT();
        this.interruptsUpdated = true;
      }
    } else if (!value && this.meipa[irq]) {
      this.meipa[irq] = 0;
      this.meicand = this.meicand.filter((icand) => icand.irq_number != irq);
      this.updateMEINEXT();
    }
  }

  updateMEINEXT() {
    // updates MEINEXT and MIE.MEIP
    const meicontext_ppreempt = (this.csrs[0xbe5] >>> 24) & 0b1111;
    if (this.meicand.length > 0 && this.meicand[0].priority >= meicontext_ppreempt) {
      // note that we're looking at *PP*REEMPT here - interrupts with equal or higher priority than that ARE visible in MEINEXT
      // but might still NOT trigger a trap in case their priority is lower than *P*REEMPT.
      this.csrs[0xbe4] = this.meicand[0].irq_number << 2;
      this.csrs[0x344] |= 1 << 11;
    } else {
      this.csrs[0xbe4] = (1 << 31) >>> 0;
      this.csrs[0x344] &= ~(1 << 11);
    }
  }

  updateMEICONTEXT_update() {
    // called on MEINEXT.UPDATE write
    let meicontext = this.csrs[0xbe5];
    const meinext = this.csrs[0xbe4] >>> 0;
    const noirq = meinext >> 31;
    // clear NOIRQ, IRQ, and PREEMPT
    meicontext &= ~((0b1 << 15) | (0x1ff << 4) | (0x1f << 16));
    // update NOIRQ
    meicontext |= noirq << 15;
    // update IRQ and PREEMPT
    if (!noirq) {
      const current_irq = (meinext >>> 2) & 511;
      meicontext |= current_irq << 4;
      // Spec: preempt_level_next = 1 + priority (for IRQ_PRIORITY_BITS=4)
      meicontext |= (this.meipra[current_irq] + 1) << 16;
    } else {
      meicontext |= 16 << 16; // no preemption when noirq
    }
    this.csrs[0xbe5] = meicontext;
  }

  updateMEICONTEXT_priority_save() {
    // called on priority save (external interrupt trap)
    let meicontext = this.csrs[0xbe5];
    // clear PPPREEMPT, PPREEMPT, PREEMPT, MTIESAVE, MSIESAVE, CLEARTS
    meicontext &= 0b1111111111110001;
    // update PPREEMPT from old PREEMPT
    meicontext |= ((this.csrs[0xbe5] >>> 16) & 0b1111) << 24;
    // update PPPREEMPT from old PPREEMPT
    meicontext |= ((this.csrs[0xbe5] >>> 24) & 0b1111) << 28;
    // update PREEMPT
    const meinext = this.csrs[0xbe4] >>> 0;
    if (!(meinext >> 31)) {
      // Valid IRQ: preempt = 1 + priority (IRQ_PRIORITY_BITS=4)
      const current_irq = (meinext >>> 2) & 511;
      meicontext |= (this.meipra[current_irq] + 1) << 16;
    } else {
      meicontext |= 16 << 16;
    }
    meicontext |= 1; // set MEICONTEXT.MRETEIRQ
    this.csrs[0xbe5] = meicontext;
  }

  updateMEICONTEXT_priority_restore() {
    // called on potential priority restore (mret)
    let meicontext = this.csrs[0xbe5];
    if (!(meicontext & 1)) return; // only proceed if MRETEIRQ is set
    // clear PPP/PP/PREEMPT/MRETEIRQ
    meicontext &= 0b111111111111110;
    // set PPREEMPT from old PPPREEMPT
    meicontext |= (this.csrs[0xbe5] >>> 28) << 24;
    // set PREEMPT from old PPREEMPT
    meicontext |= ((this.csrs[0xbe5] >>> 24) & 0b1111) << 16;
    this.csrs[0xbe5] = meicontext;
  }

  checkForInterrupts() {
    if (!this.interruptsUpdated) return;
    this.interruptsUpdated = false;
    if (this.csrs[0x304] & 0b100000000000) {
      // if MIE.MEIE is set... TODO consider software and timer interrupts as well
      const meinext = this.csrs[0xbe4] >>> 0;
      const meinext_noirq = meinext >> 31;
      const meinext_irq_number = (meinext >>> 2) & 511;
      const meinext_irq_prio = this.meipra[meinext_irq_number];
      const meicontext_preempt = (this.csrs[0xbe5] >>> 16) & 0b11111;
      if (!meinext_noirq && meinext_irq_prio >= meicontext_preempt) {
        // ...and the interrupt visible in MEINEXT has at least PREEMPT priority...
        if (this.csrs[0x300] & 0b1000) {
          // ...and MSTATUS.MIE is set...
          this.updateMEICONTEXT_priority_save(); // this gets called ONLY on external interrupt trap
          this.trapEntry(((1 << 31) | 11) >>> 0); //TODO hardwired cause MEIP = external interrupt
        }
        this.waiting = false; // "wfi ignores the global interrupt enable, MSTATUS.MIE"
      }
    }
  }

  trapEntry(mcause: number, fromStep: boolean = false) {
    //this.logger.info(this.coreLabel, `Entering trap handler, mcause 0x${mcause.toString(16)}`);
    if (mcause != ((1 << 31) | 11) >>> 0) this.csrs[0xbe5] &= ~1; // clear MIECONTEXT.MRETEIRQ on any trap that's not an external interrupt
    this.setCSR(0x341, this.pc, 0); // Save the address of the interrupted or excepting instruction to MEPC
    // 2. Set the MSB of MCAUSE to indicate the cause is an interrupt, or clear it to indicate an exception
    // 3. Write the detailed trap cause to the LSBs of the MCAUSE register
    this.setCSR(0x342, mcause, 0);
    // TODO 4. Save the current privilege level to MSTATUS.MPP
    // TODO 5. Set the privilege to M-mode (note Hazard3 does not implement S-mode)
    // 6. Save the current value of MSTATUS.MIE to MSTATUS.MPIE
    let mstatus = this.getCSR(0x300, 0);
    mstatus &= ~0b10000000;
    mstatus |= (mstatus << 4) & 0b10000000;
    // 7. Disable interrupts by clearing MSTATUS.MIE
    mstatus &= ~(1 << 3);
    this.setCSR(0x300, mstatus, 0);
    // 8. Jump to the correct offset from MTVEC depending on the trap cause.
    // For synchronous exceptions (ecall/ebreak during step), set next_pc so the
    // post-step PC-update logic redirects without adding inst_length. For
    // asynchronous interrupts (checkForInterrupts before fetch), set pc directly.
    // Trap target: (mtvec & ~3) | (vector_sel << 2), where vector_sel is 0 for
    // exceptions and direct-mode interrupts (hazard3_csr.v, mtvec wire).
    const mtvec = this.getCSR(0x305, 0);
    let target: number;
    if (mcause >> 31 && mtvec & 1) {
      target = (mtvec & ~0b11) | ((mcause & 0b1111) << 2); // vectored interrupt
    } else {
      target = mtvec & ~0b11; // exception or direct-mode interrupt
    }
    if (fromStep) {
      this.next_pc = target;
    } else {
      this.pc = target;
      this.next_pc = 0;
    }
    this.cycles += 2;
  }

  // Hazard3 branch predictor
  private btb: number = -1;
  public h3_branch_cycles(taken: boolean) {
    const from_pc = this.pc;
    const to_pc = this.next_pc;
    const jumped_back = to_pc < from_pc;
    if (from_pc === this.btb) {
      if (taken && jumped_back) return; // predictor hit
      // known branch mispredicted
      this.btb = -1;
      this.cycles++;
      return;
    }
    if (taken) {
      this.cycles++;
      if (jumped_back) this.btb = from_pc; // new backwards branch
    }
  }

  setCSR(csr: number, value: number, raw_write: number) {
    // raw_write: instruction raw write value, used for Xh3irq interrupt array indices
    value >>>= 0;
    raw_write >>>= 0;
    switch (csr) {
      case 0x300: // MSTATUS
        if (value & ~this.csrs[csr] & 0b1000) this.interruptsUpdated = true; // MSTATUS.MIE has been set
      case 0x305: // MTVEC
        this.csrs[csr] = value;
        return;
      case 0x304: // MIE
        if (value & ~this.csrs[csr]) this.interruptsUpdated = true; // any bit in MIE has been set
        this.csrs[csr] = value;
        return;
      case 0x301:
      case 0x30a:
      case 0x310:
      case 0x31a:
      case 0x323:
      case 0x324:
      case 0x325:
      case 0x326:
      case 0x327:
      case 0x328:
      case 0x329:
      case 0x32a:
      case 0x32b:
      case 0x32c:
      case 0x32d:
      case 0x32e:
      case 0x32f:
      case 0x330:
      case 0x331:
      case 0x332:
      case 0x333:
      case 0x334:
      case 0x335:
      case 0x336:
      case 0x337:
      case 0x338:
      case 0x339:
      case 0x33a:
      case 0x33b:
      case 0x33c:
      case 0x33d:
      case 0x33e:
      case 0x33f:
      case 0x343:
      case 0x3b8:
      case 0x3b9:
      case 0x3ba:
      case 0x3bb:
      case 0x3bc:
      case 0x3bd:
      case 0x3be:
      case 0x3bf:
        return;
      case 0x340:
      case 0x341:
      case 0x342:
        this.csrs[csr] = value;
        return;
      //TODO
      case 0xbe0: {
        // MEIEA
        let state = value >>> 16;
        for (let irq = (raw_write & 0b11111) * 16; irq < (raw_write & 0b11111) * 16 + 16; irq++) {
          this.setInterruptEnabled(irq, !!(state & 1));
          state >>= 1;
        }
        return;
      }
      case 0xbe1:
        return; // MEIPA
      case 0xbe2: {
        // MEIFA
        let state = value >>> 16;
        for (let irq = (raw_write & 0b11111) * 16; irq < (raw_write & 0b11111) * 16 + 16; irq++) {
          const forced = state & 1;
          this.meifa[irq] = forced;
          if (forced) this.setInterrupt(irq, true);
          else if (irq >= 46) this.setInterrupt(irq, false);
          state >>= 1;
        }
        return;
      }
      case 0xbe3: {
        // MEIPRA
        let state = value >>> 16;
        for (let irq = (raw_write & 0b11111) * 4; irq < (raw_write & 0b11111) * 4 + 4; irq++) {
          this.meipra[irq] = state & 0b1111;
          if (this.meipa[irq]) {
            this.setInterrupt(irq, false);
            this.setInterrupt(irq, true);
          }
          state >>= 4;
        }
        return;
      }
      case 0xbe4: {
        // MEINEXT
        if (value & 1) {
          // MEINEXT.UPDATE set
          this.updateMEICONTEXT_update();
          this.updateMEINEXT();
          this.interruptsUpdated = true;
        }
        return;
      }
      case 0xbe5: // MEICONTEXT - note MTIESAVE/MSIESAVE/CLEARTS writes are a side effect of getCTS here
        this.csrs[csr] = value;
        this.updateMEINEXT();
        this.interruptsUpdated = true;
        return;
      //TODO
      case 0xc00:
      case 0xc02:
      case 0xc80:
      case 0xc82:
      case 0xf11:
      case 0xf12:
      case 0xf13:
      case 0xf14:
        return;
    }
    this.logger.info(
      this.coreLabel,
      `Unknown CSR set: 0x${value.toString(16)} => 0x${csr.toString(16)}`
    );
    this.csrs[csr] = value;
  }

  getCSR(csr: number, raw_write: number): number {
    raw_write >>>= 0;
    // raw_write: instruction raw write value, used for Xh3irq interrupt array indices
    // MSLEEP 0xbf0
    switch (csr) {
      case 0xf14:
        return this.mhartid;
      case 0x300: // MSTATUS
      case 0x301:
      case 0x302:
      case 0x303:
      case 0x304: // MIE
      case 0x305: // MTVEC
      case 0x340: // MSCRATCH
      case 0x341:
      case 0x342:
      case 0x343:
      case 0x344:
      case 0xbf0:
        return this.csrs[csr];
      case 0xbe0:
        return (
          (this.meiea
            .slice((raw_write & 0b11111) * 16, (raw_write & 0b11111) * 16 + 16)
            .reduceRight((acc, val) => (acc << 1) | val, 0) <<
            16) >>>
          0
        );
      case 0xbe1:
        return (
          (this.meipa
            .slice((raw_write & 0b11111) * 16, (raw_write & 0b11111) * 16 + 16)
            .reduceRight((acc, val) => (acc << 1) | val, 0) <<
            16) >>>
          0
        );
      case 0xbe2:
        return (
          (this.meifa
            .slice((raw_write & 0b11111) * 16, (raw_write & 0b11111) * 16 + 16)
            .reduceRight((acc, val) => (acc << 1) | val, 0) <<
            16) >>>
          0
        );
      case 0xbe3:
        return (
          (this.meipra
            .slice((raw_write & 0b11111) * 4, (raw_write & 0b11111) * 4 + 4)
            .reduceRight((acc, val) => (acc << 4) | val, 0) <<
            16) >>>
          0
        );
      case 0xbe4:
        const meinext = this.csrs[csr] >>> 0;
        if (!(meinext >> 31)) {
          // reading MEINEXT clears MEIFA bits
          const irq = (meinext >> 2) & 511;
          const old_forced = this.meifa[irq];
          this.meifa[irq] = 0;
          if (irq >= 46 && old_forced) this.setInterrupt(irq, false); // for soft irqs, removing MEIFA will deassert the irq
          //TODO deassert lower irqs as well?
        }
        return meinext;
      case 0xbe5:
        let meicontext = this.csrs[0xbe5];
        if (raw_write & 0b0010) {
          // write to CLEARTS
          meicontext &= ~0b1110;
          meicontext |= ((this.csrs[0x304] >>> 7) & 1) << 3; // MTIE
          meicontext |= ((this.csrs[0x304] >>> 3) & 1) << 2; // MSIE
          this.csrs[0x304] &= ~0b10001000; // clear MIE.MTIE and MSIE
        } else {
          if (raw_write & 0b1000) this.csrs[0x304] |= 1 << 7; // write to MTIESAVE: set MIE.MTIE
          if (raw_write & 0b0100) this.csrs[0x304] |= 1 << 3; // write to MSIESAVE: set MIE.MSIE
        }
        return meicontext;
    }
    this.logger.info(this.coreLabel, `Unknown CSR get: 0x${csr.toString(16)}`);
    return this.csrs[csr];
  }
}

function signExtend8(value: number) {
  return (value << 24) >> 24;
}

function signExtend16(value: number) {
  return (value << 16) >> 16;
}

export class RegisterSet {
  private regs: Int32Array;

  constructor(numRegisters: number) {
    this.regs = new Int32Array(numRegisters);
  }

  getRegister(index: number): number {
    return index === 0 ? 0 : this.regs[index];
  }

  getRegisterU(index: number): number {
    return index === 0 ? 0 : this.regs[index] >>> 0;
  }

  setRegister(index: number, value: number): void {
    // setRegister and setRegisterU are identical: Int32Array stores apply
    // ToInt32, which preserves all 32 bits regardless of signedness.
    if (index !== 0) this.regs[index] = value;
  }

  setRegisterU(index: number, value: number): void {
    if (index !== 0) this.regs[index] = value;
  }
}

// LOAD (0x03) - I-type
function executeLoad(inst: number, cpu: CPU) {
  const r = rd(inst),
    s1 = rs1(inst),
    im = imm_i(inst);
  const addr = cpu.registerSet.getRegisterU(s1) + im;
  switch (func3(inst)) {
    case 0x0:
      cpu.registerSet.setRegister(r, signExtend8(cpu.chip.readUint8(addr)));
      break; // lb
    case 0x1:
      cpu.registerSet.setRegister(r, signExtend16(cpu.chip.readUint16(addr)));
      break; // lh
    case 0x2:
      cpu.registerSet.setRegisterU(r, cpu.chip.readUint32(addr));
      break; // lw
    case 0x4:
      cpu.registerSet.setRegister(r, cpu.chip.readUint8(addr));
      break; // lbu
    case 0x5:
      cpu.registerSet.setRegister(r, cpu.chip.readUint16(addr));
      break; // lhu
    default:
      throw Error(`Invalid LOAD func3 ${func3(inst)}`);
  }
}

// MISC-MEM (0x0f) - fence / fence.i are no-ops here
function executeMiscMem(inst: number, cpu: CPU) {
  // intentionally empty
}

// OP-IMM (0x13) - I-type; func3=1 and func3=5 carry sub-encodings via func7
// and Zbb unary-op selectors (immU).
function executeOpImm(inst: number, cpu: CPU) {
  const r = rd(inst),
    s1 = rs1(inst);
  const rs = cpu.registerSet;
  switch (func3(inst)) {
    case 0x0: // addi
      rs.setRegisterU(r, (rs.getRegisterU(s1) + imm_i(inst)) >>> 0);
      break;
    case 0x1: {
      // slli / bseti / bclri / binvi / clz / ctz / cpop / sext.b / sext.h
      const sh = shamt(inst),
        f7 = func7(inst),
        imu = immU_i(inst);
      if (f7 === 0x00) rs.setRegisterU(r, rs.getRegisterU(s1) << sh); // slli
      else if (f7 === 0x14) rs.setRegister(r, rs.getRegister(s1) | (1 << sh)); // bseti (Zbs)
      else if (f7 === 0x24) rs.setRegister(r, rs.getRegister(s1) & ~(1 << sh)); // bclri
      else if (f7 === 0x34) rs.setRegister(r, rs.getRegister(s1) ^ (1 << sh)); // binvi
      else if (imu === 0b011000000001) {
        // ctz (Zbb)
        const t = rs.getRegister(s1) >>> 0;
        rs.setRegister(r, t === 0 ? 32 : 31 - Math.clz32(t & -t));
      } else if (imu === 0b011000000010) {
        // cpop (Zbb)
        let t = rs.getRegister(s1) >>> 0;
        t = t - ((t >> 1) & 0x55555555);
        t = (t & 0x33333333) + ((t >> 2) & 0x33333333);
        rs.setRegister(r, (((t + (t >> 4)) & 0xf0f0f0f) * 0x1010101) >> 24);
      } else if (imu === 0b011000000101) {
        // sext.h (Zbb)
        rs.setRegister(r, signExtend16(rs.getRegisterU(s1) & 0xffff));
      } else if (imu === 0b011000000100) {
        // sext.b (Zbb)
        rs.setRegister(r, signExtend8(rs.getRegisterU(s1) & 0xff));
      } else if (
        (inst & 0b11111111111100000111000001111111) ===
        0b01100000000000000001000000010011
      ) {
        rs.setRegister(r, Math.clz32(rs.getRegisterU(s1))); // clz (Zbb)
      } else if (imu === 0b000010001111) {
        // zip (Zbkb) — interleave: even bits from high half, odd bits from low half
        const u = rs.getRegisterU(s1);
        let result = 0;
        for (let i = 0; i < 16; i++) {
          result |= ((u >>> (16 + i)) & 1) << (2 * i); // even positions
          result |= ((u >>> i) & 1) << (2 * i + 1); // odd positions
        }
        rs.setRegisterU(r, result >>> 0);
      } else throw Error(`Unknown OP-IMM func3=1, func7: 0x${f7.toString(16)}`);
      break;
    }
    case 0x2:
      rs.setRegister(r, rs.getRegister(s1) < imm_i(inst) ? 1 : 0);
      break; // slti
    case 0x3:
      rs.setRegister(r, rs.getRegisterU(s1) < immU_i(inst) ? 1 : 0);
      break; // sltiu
    case 0x4:
      rs.setRegister(r, rs.getRegister(s1) ^ imm_i(inst));
      break; // xori
    case 0x5: {
      // srli / srai / bexti / rori / rev8 / orc.b / brev8
      const sh = shamt(inst),
        f7 = func7(inst),
        imu = immU_i(inst),
        v = rs.getRegister(s1);
      if (f7 === 0x00) rs.setRegister(r, v >>> sh); // srli
      else if (f7 === 0x20) rs.setRegister(r, v >> sh); // srai
      else if (f7 === 0x24) rs.setRegister(r, (v >>> sh) & 1); // bexti (Zbs)
      else if (f7 === 0x30) {
        // rori (Zbb)
        const u = rs.getRegisterU(s1);
        rs.setRegister(r, ((u << (32 - sh)) >>> 0) | (u >>> sh));
      } else if (imu === 0x698) {
        // rev8 (Zbb)
        rs.setRegisterU(
          r,
          ((v >>> 24) |
            ((v >>> 8) & 0xff00) |
            ((v << 8) & 0xff0000) |
            (((v & 0xff) << 24) >>> 0)) >>>
            0
        );
      } else if (imu === 0x687) {
        // brev8 (Zbkb) — reverse bits within each byte
        const u = rs.getRegisterU(s1);
        let result = 0;
        for (let i = 0; i < 32; i += 8) {
          let by = (u >>> i) & 0xff;
          by = ((by & 0xf0) >> 4) | ((by & 0x0f) << 4);
          by = ((by & 0xcc) >> 2) | ((by & 0x33) << 2);
          by = ((by & 0xaa) >> 1) | ((by & 0x55) << 1);
          result |= by << i;
        }
        rs.setRegisterU(r, result >>> 0);
      } else if (imu === 0x287) {
        // orc.b (Zbb) — broadcast bit 7 of each byte across all 8 bits
        const u = rs.getRegisterU(s1);
        let result = 0;
        for (let i = 0; i < 32; i += 8) {
          if (u & (0x80 << i)) result |= 0xff << i;
        }
        rs.setRegisterU(r, result >>> 0);
      } else if (imu === 0b000010001111) {
        // unzip (Zbkb) — deinterleave: odd bits to low half, even bits to high half
        const u = rs.getRegisterU(s1);
        let result = 0;
        for (let i = 0; i < 16; i++) {
          result |= ((u >>> (2 * i + 1)) & 1) << i; // odd positions -> low half
          result |= ((u >>> (2 * i)) & 1) << (16 + i); // even positions -> high half
        }
        rs.setRegisterU(r, result >>> 0);
      } else throw Error(`Unknown OP-IMM func3=5, func7: 0x${f7.toString(16)}`);
      break;
    }
    case 0x6:
      rs.setRegister(r, rs.getRegister(s1) | imm_i(inst));
      break; // ori
    case 0x7:
      rs.setRegister(r, rs.getRegister(s1) & imm_i(inst));
      break; // andi
    default:
      throw Error(`Invalid OP-IMM func3 ${func3(inst)}`);
  }
}

// STORE (0x23) - S-type
function executeStore(inst: number, cpu: CPU) {
  const s1 = rs1(inst),
    s2 = rs2(inst);
  const addr = cpu.registerSet.getRegister(s1) + imm_s(inst);
  const v = cpu.registerSet.getRegister(s2);
  switch (func3(inst)) {
    case 0x0:
      cpu.chip.writeUint8(addr, v & 0xff);
      break; // sb
    case 0x1:
      cpu.chip.writeUint16(addr, v & 0xffff);
      break; // sh
    case 0x2:
      cpu.chip.writeUint32(addr, v);
      break; // sw
    default:
      throw Error(`Invalid STORE func3 ${func3(inst)}`);
  }
}

// AMO/LR/SC (0x2f) - R-type; func3=0x2. funct5 (bits[31:27]) selects the
// operation; aq/rl bits (26:25) are no-ops in the emulator.
function executeAmo(inst: number, cpu: CPU) {
  if (func3(inst) !== 0x2) throw Error(`Invalid AMO func3 ${func3(inst)}`);
  const funct5 = (inst >>> 27) & 0x1f;
  const r = rd(inst),
    s1 = rs1(inst),
    s2 = rs2(inst);
  const rs = cpu.registerSet,
    chip = cpu.chip;
  const addr = rs.getRegisterU(s1);

  // lr.w: load + set reservation (no write)
  if (funct5 === 0x02) {
    rs.setRegisterU(r, chip.readUint32(addr));
    cpu.lr_addr = addr & ~0xf;
    cpu.otherCpu.invalidateLrReservation(addr);
    cpu.cycles += 3;
    return;
  }

  // sc.w: conditional store; rd=0 on success, rd=1 on failure
  if (funct5 === 0x03) {
    if (cpu.lr_addr === (addr & ~0xf)) {
      chip.writeUint32(addr, rs.getRegisterU(s2));
      rs.setRegisterU(r, 0);
    } else {
      rs.setRegisterU(r, 1);
    }
    cpu.lr_addr = -1;
    cpu.cycles += 3;
    return;
  }

  const v = rs.getRegisterU(s2);
  const mem = chip.readUint32(addr);
  rs.setRegisterU(r, mem);
  // AMO store + invalidate other hart's reservation
  const store = (val: number) => {
    chip.writeUint32(addr, val);
    cpu.otherCpu.invalidateLrReservation(addr);
  };
  switch (funct5) {
    case 0x00:
      store((mem + v) >>> 0);
      break; // amoadd.w
    case 0x01:
      store(v);
      break; // amoswap.w
    case 0x04:
      store(mem ^ v);
      break; // amoxor.w
    case 0x08:
      store(mem | v);
      break; // amoor.w
    case 0x0c:
      store(mem & v);
      break; // amoand.w
    case 0x10: {
      const ms = mem | 0,
        vs = v | 0;
      store(ms < vs ? mem : v);
      break; // amomin.w (signed)
    }
    case 0x14: {
      const ms = mem | 0,
        vs = v | 0;
      store(ms > vs ? mem : v);
      break; // amomax.w (signed)
    }
    case 0x18:
      store(mem < v ? mem : v);
      break; // amominu.w (unsigned)
    case 0x1c:
      store(mem > v ? mem : v);
      break; // amomaxu.w (unsigned)
    default:
      throw Error(`Unknown AMO funct5: 0x${funct5.toString(16)}`);
  }
  cpu.cycles += 3;
}

// OP (0x33) - R-type; sub-dispatched by func7 within func3
function executeOp(inst: number, cpu: CPU) {
  const r = rd(inst),
    s1 = rs1(inst),
    s2 = rs2(inst);
  const rs = cpu.registerSet;
  switch (func3(inst)) {
    case 0x0: {
      const a = rs.getRegister(s1),
        b = rs.getRegister(s2),
        f7 = func7(inst);
      if (f7 === 0x00) rs.setRegister(r, a + b); // add
      else if (f7 === 0x20) rs.setRegister(r, a - b); // sub
      else if (f7 === 0x01) rs.setRegister(r, Math.imul(a, b)); // mul (RV32M)
      else throw Error(`Unknown OP func3=0, func7: 0x${f7.toString(16)}`);
      break;
    }
    case 0x1: {
      const a = rs.getRegister(s1),
        b = rs.getRegisterU(s2),
        f7 = func7(inst);
      if (f7 === 0x00) rs.setRegister(r, a << b); // sll
      else if (f7 === 0x01)
        rs.setRegisterU(r, ((a * rs.getRegister(s2)) / 0x100000000) >>> 0); // mulh
      else if (f7 === 0x14) rs.setRegister(r, a | (1 << (b & 31))); // bset (Zbs)
      else if (f7 === 0x24) rs.setRegister(r, a & ~(1 << (b & 31))); // bclr (Zbs)
      else if (f7 === 0x30) {
        // rol (Zbb)
        const sh = b & 31;
        rs.setRegister(r, ((a << sh) | (a >>> (32 - sh))) >>> 0);
      } else if (f7 === 0x34) rs.setRegister(r, a ^ (1 << (b & 31))); // binv (Zbs)
      else throw Error(`Unknown OP func3=1, func7: 0x${f7.toString(16)}`);
      break;
    }
    case 0x2: {
      const f7 = func7(inst);
      if (f7 === 0x00) {
        // slt - but special-case h3.block / h3.unblock (Xh3power) for slt x0,x0,x0|1
        if (r === 0 && s1 === 0) {
          if (s2 === 0) {
            // h3.block
            if (!cpu.eventRegistered) {
              cpu.waiting = true;
              return;
            }
            cpu.eventRegistered = false;
            return;
          } else if (s2 === 1) {
            // h3.unblock
            cpu.fireSEV();
            return;
          }
        }
        rs.setRegister(r, rs.getRegister(s1) < rs.getRegister(s2) ? 1 : 0);
      } else if (f7 === 0x01) {
        // mulhsu (RV32M): signed * unsigned, return high 32 bits
        const a = rs.getRegister(s1); // signed
        const b = rs.getRegisterU(s2); // unsigned
        const negate = a < 0;
        let hi = Math.floor(((a >>> 0) * b) / 0x100000000);
        if (negate) hi = (hi - b) >>> 0;
        rs.setRegisterU(r, hi);
      } else if (f7 === 0x10) {
        // sh1add (Zbb)
        rs.setRegister(r, ((rs.getRegister(s1) << 1) + rs.getRegister(s2)) & 0xffffffff);
      } else throw Error(`Unknown OP func3=2, func7: 0x${f7.toString(16)}`);
      break;
    }
    case 0x3: {
      const a = rs.getRegisterU(s1),
        b = rs.getRegisterU(s2),
        f7 = func7(inst);
      if (f7 === 0x00) rs.setRegister(r, a < b ? 1 : 0); // sltu
      else if (f7 === 0x01) rs.setRegister(r, ((a * b) / 0x100000000) >>> 0); // mulhu
      else throw Error(`Unknown OP func3=3, func7: 0x${f7.toString(16)}`);
      break;
    }
    case 0x4: {
      const a = rs.getRegister(s1),
        b = rs.getRegister(s2),
        f7 = func7(inst);
      if (f7 === 0x00) rs.setRegister(r, a ^ b); // xor
      else if (f7 === 0x01) {
        // div (RV32M)
        if (b === 0) rs.setRegisterU(r, 0xffffffff);
        else if (a >>> 0 === 0x80000000 && b >>> 0 === 0xffffffff) rs.setRegisterU(r, 0x80000000);
        else rs.setRegister(r, (a / b) | 0);
        cpu.cycles += 17;
      } else if (f7 === 0x10) rs.setRegister(r, ((a << 2) + b) & 0xffffffff); // sh2add (Zbb)
      else if (f7 === 0x04) rs.setRegister(r, (a & 0xffff) | ((b & 0xffff) << 16)); // pack (Zbkb)
      else if (f7 === 0x05) rs.setRegister(r, a < b ? a : b); // min (Zbb)
      else if (f7 === 0x20) rs.setRegister(r, ~a ^ b); // xnor (Zbb)
      else throw Error(`Unknown OP func3=4, func7: 0x${f7.toString(16)}`);
      break;
    }
    case 0x5: {
      const a = rs.getRegister(s1),
        b = rs.getRegister(s2),
        f7 = func7(inst);
      if (f7 === 0x00) rs.setRegister(r, a >>> b); // srl
      else if (f7 === 0x05) {
        // minu (Zbb)
        const u1 = a >>> 0,
          u2 = b >>> 0;
        rs.setRegister(r, u1 < u2 ? u1 : u2);
      } else if (f7 === 0x20) rs.setRegister(r, a >> b); // sra
      else if (f7 === 0x24) rs.setRegister(r, (a >>> (b & 31)) & 1); // bext (Zbs)
      else if (f7 === 0x30) {
        // ror (Zbb)
        const sh = b & 31;
        const u = rs.getRegisterU(s1);
        rs.setRegister(r, ((u << (32 - sh)) >>> 0) | (u >>> sh));
      } else if (f7 === 0x01) {
        // divu (RV32M)
        if (b === 0) rs.setRegisterU(r, 0xffffffff);
        else rs.setRegister(r, ((a >>> 0) / (b >>> 0)) >>> 0);
        cpu.cycles += 17;
      } else throw Error(`Unknown OP func3=5, func7: 0x${f7.toString(16)}`);
      break;
    }
    case 0x6: {
      const a = rs.getRegister(s1),
        b = rs.getRegister(s2),
        f7 = func7(inst);
      if (f7 === 0x00) rs.setRegister(r, a | b); // or
      else if (f7 === 0x01) {
        rs.setRegister(r, b === 0 ? a : a % b);
        cpu.cycles += 17;
      } // rem (RV32M)
      else if (f7 === 0x05) rs.setRegister(r, a > b ? a : b); // max (Zbb)
      else if (f7 === 0x20) rs.setRegister(r, a | ~b); // orn (Zbb)
      else if (f7 === 0x10) rs.setRegister(r, ((a << 3) + b) & 0xffffffff); // sh3add (Zbb)
      else throw Error(`Unknown OP func3=6, func7: 0x${f7.toString(16)}`);
      break;
    }
    case 0x7: {
      const a = rs.getRegister(s1),
        b = rs.getRegister(s2),
        f7 = func7(inst);
      if (f7 === 0x00) rs.setRegister(r, a & b); // and
      else if (f7 === 0x20) rs.setRegister(r, a & ~b); // andn (Zbb)
      else if (f7 === 0x04) rs.setRegister(r, (a & 0xff) | ((b & 0xff) << 8)); // packh (Zbkb)
      else if (f7 === 0x05) rs.setRegisterU(r, (a >>> 0 > b >>> 0 ? a : b) >>> 0); // maxu (Zbb)
      else if (f7 === 0x01) {
        rs.setRegisterU(r, (b === 0 ? a : (a >>> 0) % (b >>> 0)) >>> 0);
        cpu.cycles += 17;
      } // remu (RV32M)
      else throw Error(`Unknown OP func3=7, func7: 0x${f7.toString(16)}`);
      break;
    }
    default:
      throw Error(`Invalid OP func3 ${func3(inst)}`);
  }
}

// BRANCH (0x63) - B-type; signed (blt/bge) vs unsigned (bltu/bgeu) by func3
function executeBranch(inst: number, cpu: CPU) {
  const s1 = rs1(inst),
    s2 = rs2(inst),
    im = imm_b(inst);
  const rs = cpu.registerSet;
  let taken = false;
  switch (func3(inst)) {
    case 0x0:
      taken = rs.getRegister(s1) === rs.getRegister(s2);
      break; // beq
    case 0x1:
      taken = rs.getRegister(s1) !== rs.getRegister(s2);
      break; // bne
    case 0x4:
      taken = rs.getRegister(s1) < rs.getRegister(s2);
      break; // blt
    case 0x5:
      taken = rs.getRegister(s1) >= rs.getRegister(s2);
      break; // bge
    case 0x6:
      taken = rs.getRegisterU(s1) < rs.getRegisterU(s2);
      break; // bltu
    case 0x7:
      taken = rs.getRegisterU(s1) >= rs.getRegisterU(s2);
      break; // bgeu
    default:
      throw Error(`Invalid BRANCH func3 ${func3(inst)}`);
  }
  if (taken) cpu.next_pc = cpu.pc + im;
  cpu.h3_branch_cycles(taken);
}

// JALR (0x67) - I-type; only func3=0 defined
function executeJalr(inst: number, cpu: CPU) {
  if (func3(inst) !== 0) throw Error(`Invalid JALR func3 ${func3(inst)}`);
  // Read rs1 before writing rd - they may be the same register (e.g. jalr ra, ra, imm).
  const target = cpu.registerSet.getRegister(rs1(inst)) + imm_i(inst);
  cpu.registerSet.setRegister(rd(inst), cpu.pc + cpu.inst_length);
  cpu.next_pc = target;
  cpu.cycles++;
}

// LUI (0x37) - U-type. Top 20 bits of the immediate land directly in rd.
function executeLui(inst: number, cpu: CPU) {
  cpu.registerSet.setRegisterU(rd(inst), imm_u(inst));
}

// AUIPC (0x17) - U-type. rd = pc + upper-immediate.
function executeAuipc(inst: number, cpu: CPU) {
  cpu.registerSet.setRegister(rd(inst), imm_u(inst) + cpu.pc);
}

// JAL (0x6f) - J-type. Link register gets pc+inst_length, then jump.
function executeJal(inst: number, cpu: CPU) {
  cpu.registerSet.setRegister(rd(inst), cpu.pc + cpu.inst_length);

  // Profiler trace magic: a 0xabcd/0xffff marker at the return-address slot
  // signals that a NUL-terminated trace-tag string follows; onTrace consumes it.
  const magicStart = cpu.pc + cpu.inst_length;
  if (
    cpu.chip.readUint16(magicStart) === 0xabcd &&
    cpu.chip.readUint16(magicStart + 2) === 0xffff
  ) {
    let profTag = '';
    for (let i = magicStart + 4; ; i++) {
      const ch = cpu.chip.readUint8(i);
      if (ch === 0) break;
      profTag += String.fromCharCode(ch);
    }
    cpu.chip.onTrace(cpu.mhartid, cpu.pc, profTag);
  }

  cpu.next_pc = cpu.pc + imm_j(inst);
  cpu.cycles++;
}

// SYSTEM (0x73) - CSR ops + mret/ecall/ebreak
function executeSystem(inst: number, cpu: CPU) {
  const rs = cpu.registerSet;
  switch (func3(inst)) {
    case 0x0: {
      // mret / ecall / ebreak - dispatched by the full 32-bit word
      switch (inst >>> 0) {
        case 0x30200073: {
          // mret
          let mstatus = cpu.getCSR(0x300, 0);
          mstatus &= ~(3 << 11); // MSTATUS.MPP <- 0 (U-mode)
          mstatus &= ~0b1000;
          mstatus |= (mstatus >>> 4) & 0b1000; // MIE <- MPIE
          mstatus |= 1 << 7; // MPIE <- 1
          cpu.setCSR(0x300, mstatus, 0);
          cpu.next_pc = cpu.getCSR(0x341, 0); // jump to MEPC
          cpu.cycles++;
          cpu.updateMEICONTEXT_priority_restore(); // Xh3irq
          cpu.interruptsUpdated = true;
          break;
        }
        case 0x73:
          cpu.trapEntry(0xb, true);
          break; // ecall (M-mode)
        case 0x100073:
          cpu.trapEntry(3, true);
          break; // ebreak
        case 0x10500073:
          cpu.waiting = true;
          break; // wfi
        default:
          throw Error(`Unknown SYSTEM instruction 0x${(inst >>> 0).toString(16)}`);
      }
      break;
    }
    case 0x1: {
      // csrrw
      const csr = immU_i(inst),
        r = rd(inst),
        s1 = rs1(inst);
      const newVal = rs.getRegister(s1);
      if (r !== 0) rs.setRegister(r, cpu.getCSR(csr, newVal));
      cpu.setCSR(csr, newVal, newVal);
      break;
    }
    case 0x2: {
      // csrrs
      const csr = immU_i(inst),
        r = rd(inst),
        s1 = rs1(inst);
      const orVal = rs.getRegister(s1);
      const old = cpu.getCSR(csr, orVal);
      if (s1 !== 0) cpu.setCSR(csr, old | orVal, orVal);
      rs.setRegister(r, old);
      break;
    }
    case 0x3: {
      // csrrc
      const csr = immU_i(inst),
        r = rd(inst),
        s1 = rs1(inst);
      const notVal = rs.getRegister(s1);
      const old = cpu.getCSR(csr, notVal);
      if (notVal !== 0) cpu.setCSR(csr, old & ~notVal, notVal);
      rs.setRegister(r, old);
      break;
    }
    case 0x5: {
      // csrwi - rs1 field holds the 5-bit immediate
      const csr = immU_i(inst),
        r = rd(inst),
        imm5 = rs1(inst);
      if (r !== 0) rs.setRegister(r, cpu.getCSR(csr, imm5));
      cpu.setCSR(csr, imm5, imm5);
      break;
    }
    case 0x6: {
      // csrrsi
      const csr = immU_i(inst),
        r = rd(inst),
        imm5 = rs1(inst);
      const old = cpu.getCSR(csr, imm5);
      if (imm5 !== 0) cpu.setCSR(csr, old | imm5, imm5);
      rs.setRegister(r, old);
      break;
    }
    case 0x7: {
      // csrrci
      const csr = immU_i(inst),
        r = rd(inst),
        imm5 = rs1(inst);
      const old = cpu.getCSR(csr, imm5);
      if (imm5 !== 0) cpu.setCSR(csr, old & ~imm5, imm5);
      rs.setRegister(r, old);
      break;
    }
    default:
      throw Error(`Invalid SYSTEM func3 ${func3(inst)}`);
  }
}

// CUSTOM0 (Hazard3 bit-field extract with mask) - non-standard c_ident match.
function executeCustom0(inst: number, cpu: CPU) {
  const c_ident = inst & 0b11100010000000000111000001111111;
  const size = (inst >>> 26) & 0b111;
  if (c_ident === 0b00000000000000000000000000001011) {
    // h3.bextm - shift amount from rs2 register
    const sh = cpu.registerSet.getRegisterU(rs2(inst));
    let v = cpu.registerSet.getRegisterU(rs1(inst)) >>> sh;
    cpu.registerSet.setRegisterU(rd(inst), v & ((2 << size) - 1));
  } else if (c_ident === 0b00000000000000000100000000001011) {
    // h3.bextmi - shift amount is the immediate rs2 field
    let v = cpu.registerSet.getRegisterU(rs1(inst)) >>> rs2(inst);
    cpu.registerSet.setRegisterU(rd(inst), v & ((2 << size) - 1));
  } else {
    throw Error(`Invalid CUSTOM0 instruction 0x${inst.toString(16)}`);
  }
}
