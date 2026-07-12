/**
 * GDB Server for RP2350 RISC-V (Hazard3 dual-core).
 *
 * Implements the GDB Remote Serial Protocol for RV32IMAC. Exposes both cores
 * as GDB threads (thread 1 = core0, thread 2 = core1). Software breakpoints
 * are implemented via PC checking in the execute loop.
 */

import { RP2350 } from '../rp2350';
import { CPU } from '../riscv/cpu';
import { GDBServer } from './gdb-server';
import {
  decodeHexBuf,
  decodeHexUint32,
  encodeHexBuf,
  encodeHexByte,
  encodeHexUint32,
  gdbMessage,
  unescapeBinary,
} from './gdb-utils';

/* string value: riscv32-unknown-elf */
const lldbTriple = '726973637633322d756e6b6e6f776e2d656666';

// CSR addresses for the target.xml CSR feature
const CSR_MAP: [string, number][] = [
  ['mstatus', 0x300],
  ['mie', 0x304],
  ['mtvec', 0x305],
  ['mepc', 0x341],
  ['mcause', 0x342],
  ['mip', 0x344],
  ['mhartid', 0xf14],
];

const NUM_GPRS = 32;
const REG_PC = 32;
const REG_CSR_BASE = 33;
const NUM_REGS = REG_CSR_BASE + CSR_MAP.length; // 40

const targetXML = `<?xml version="1.0"?>
<!DOCTYPE target SYSTEM "gdb-target.dtd">
<target version="1.0">
<architecture>riscv</architecture>
<feature name="org.gnu.gdb.riscv.cpu">
<reg name="zero" bitsize="32" regnum="0" save-restore="yes" type="int" group="general"/>
<reg name="ra" bitsize="32" regnum="1" save-restore="yes" type="int" group="general"/>
<reg name="sp" bitsize="32" regnum="2" save-restore="yes" type="data_ptr" group="general"/>
<reg name="gp" bitsize="32" regnum="3" save-restore="yes" type="int" group="general"/>
<reg name="tp" bitsize="32" regnum="4" save-restore="yes" type="int" group="general"/>
<reg name="t0" bitsize="32" regnum="5" save-restore="yes" type="int" group="general"/>
<reg name="t1" bitsize="32" regnum="6" save-restore="yes" type="int" group="general"/>
<reg name="t2" bitsize="32" regnum="7" save-restore="yes" type="int" group="general"/>
<reg name="s0" bitsize="32" regnum="8" save-restore="yes" type="int" group="general"/>
<reg name="s1" bitsize="32" regnum="9" save-restore="yes" type="int" group="general"/>
<reg name="a0" bitsize="32" regnum="10" save-restore="yes" type="int" group="general"/>
<reg name="a1" bitsize="32" regnum="11" save-restore="yes" type="int" group="general"/>
<reg name="a2" bitsize="32" regnum="12" save-restore="yes" type="int" group="general"/>
<reg name="a3" bitsize="32" regnum="13" save-restore="yes" type="int" group="general"/>
<reg name="a4" bitsize="32" regnum="14" save-restore="yes" type="int" group="general"/>
<reg name="a5" bitsize="32" regnum="15" save-restore="yes" type="int" group="general"/>
<reg name="a6" bitsize="32" regnum="16" save-restore="yes" type="int" group="general"/>
<reg name="a7" bitsize="32" regnum="17" save-restore="yes" type="int" group="general"/>
<reg name="s2" bitsize="32" regnum="18" save-restore="yes" type="int" group="general"/>
<reg name="s3" bitsize="32" regnum="19" save-restore="yes" type="int" group="general"/>
<reg name="s4" bitsize="32" regnum="20" save-restore="yes" type="int" group="general"/>
<reg name="s5" bitsize="32" regnum="21" save-restore="yes" type="int" group="general"/>
<reg name="s6" bitsize="32" regnum="22" save-restore="yes" type="int" group="general"/>
<reg name="s7" bitsize="32" regnum="23" save-restore="yes" type="int" group="general"/>
<reg name="s8" bitsize="32" regnum="24" save-restore="yes" type="int" group="general"/>
<reg name="s9" bitsize="32" regnum="25" save-restore="yes" type="int" group="general"/>
<reg name="s10" bitsize="32" regnum="26" save-restore="yes" type="int" group="general"/>
<reg name="s11" bitsize="32" regnum="27" save-restore="yes" type="int" group="general"/>
<reg name="t3" bitsize="32" regnum="28" save-restore="yes" type="int" group="general"/>
<reg name="t4" bitsize="32" regnum="29" save-restore="yes" type="int" group="general"/>
<reg name="t5" bitsize="32" regnum="30" save-restore="yes" type="int" group="general"/>
<reg name="t6" bitsize="32" regnum="31" save-restore="yes" type="int" group="general"/>
<reg name="pc" bitsize="32" regnum="32" save-restore="yes" type="code_ptr" group="general"/>
</feature>
<feature name="org.gnu.gdb.riscv.csr">
<reg name="mstatus" bitsize="32" regnum="33" save-restore="yes" type="int" group="csr"/>
<reg name="mie" bitsize="32" regnum="34" save-restore="yes" type="int" group="csr"/>
<reg name="mtvec" bitsize="32" regnum="35" save-restore="yes" type="int" group="csr"/>
<reg name="mepc" bitsize="32" regnum="36" save-restore="yes" type="int" group="csr"/>
<reg name="mcause" bitsize="32" regnum="37" save-restore="yes" type="int" group="csr"/>
<reg name="mip" bitsize="32" regnum="38" save-restore="yes" type="int" group="csr"/>
<reg name="mhartid" bitsize="32" regnum="39" save-restore="yes" type="int" group="csr"/>
</feature>
</target>`;

export class RISCVGDBServer extends GDBServer {
  private executeTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private currentThread = 1; // 1 = core0, 2 = core1
  private haltedCore = 0;

  // Breakpoint addresses, shared across both cores
  private breakpoints = new Set<number>();

  constructor(readonly chip: RP2350) {
    super();
    this.onInterrupt = () => this.stop();
  }

  private get cpu(): CPU {
    return this.currentThread === 1 ? this.chip.core0 : this.chip.core1;
  }

  executing = false;

  // When set, only this core (0 or 1) is stepped during execute(). When -1,
  // both cores are stepped (via chip.step()). This supports vCont;c:N which
  // continues only the specified thread.
  private singleCore: number = -1;

  execute() {
    this.stopped = false;
    this.executing = true;
    const run = () => {
      if (this.stopped) return;
      for (let i = 0; i < 100000 && !this.stopped; i++) {
        if (this.singleCore >= 0) {
          // Step only the specified core. Only core0 advances wall-clock
          // time for peripherals.
          const cpu = this.singleCore === 0 ? this.chip.core0 : this.chip.core1;
          this.chip.isCore0Running = this.singleCore === 0;
          const elapsed = cpu.executeInstruction();
          if (this.singleCore === 0) this.chip.stepThings(elapsed);
          if (this.checkBreakpoints()) return;
        } else {
          if (this.stepLowestCycleCore()) return;
        }
      }
      if (!this.stopped) {
        this.executeTimer = setTimeout(run, 0);
      }
    };
    run();
  }

  stop() {
    this.stopped = true;
    this.executing = false;
    if (this.executeTimer != null) {
      clearTimeout(this.executeTimer);
      this.executeTimer = null;
    }
  }

  // Step whichever core has fewer cycles, then advance peripherals by the
  // core0 cycle delta only (core1 is catching up, not advancing wall-clock).
  private stepLowestCycleCore(): boolean {
    const step0 = this.chip.core0.cycles <= this.chip.core1.cycles;
    const cpu = step0 ? this.chip.core0 : this.chip.core1;
    this.chip.isCore0Running = step0;
    const elapsed = cpu.executeInstruction();
    if (step0) this.chip.stepThings(elapsed);
    return this.hitBreakpoint(cpu) ? this.halt(step0 ? 0 : 1) : false;
  }

  // A parked (WFI) core isn't executing, so its PC sitting on a breakpoint
  // address must not count as a hit (it would spuriously halt the session).
  private hitBreakpoint(cpu: CPU): boolean {
    return !cpu.waiting && this.breakpoints.has(cpu.pc);
  }

  private halt(core: number): boolean {
    this.haltedCore = core;
    this.stopped = true;
    this.executing = false;
    this.singleCore = -1;
    this.notifyBreakpoint(core + 1);
    return true;
  }

  // Breakpoint check for the single-core continue path (vCont;c:N). The
  // both-cores path checks breakpoints itself, per instruction, in stepBothCores.
  private checkBreakpoints(): boolean {
    const cpu = this.singleCore === 0 ? this.chip.core0 : this.chip.core1;
    if (this.hitBreakpoint(cpu)) {
      return this.halt(this.singleCore);
    }
    return false;
  }

  private readRegister(index: number): number {
    if (index < NUM_GPRS) return this.cpu.registerSet.getRegisterU(index);
    if (index === REG_PC) return this.cpu.pc;
    const csrIdx = index - REG_CSR_BASE;
    if (csrIdx >= 0 && csrIdx < CSR_MAP.length) {
      return this.cpu.getCSR(CSR_MAP[csrIdx][1], 0) >>> 0;
    }
    return 0;
  }

  private writeRegister(index: number, value: number) {
    if (index < NUM_GPRS) {
      this.cpu.registerSet.setRegisterU(index, value);
    } else if (index === REG_PC) {
      this.cpu.pc = value;
    } else {
      const csrIdx = index - REG_CSR_BASE;
      if (csrIdx >= 0 && csrIdx < CSR_MAP.length) {
        this.cpu.setCSR(CSR_MAP[csrIdx][1], value, 0);
      }
    }
  }

  processGDBMessage(cmd: string): string | void {
    switch (cmd[0]) {
      case '?':
        return gdbMessage(`T05thread:${this.haltedCore + 1};`);

      case 'T': {
        // Thread alive query: T<thread-id>
        const tid = parseInt(cmd.substring(1));
        if (tid === 1 || tid === 2) return gdbMessage('OK');
        return gdbMessage('E01');
      }

      case 'H': {
        // Select thread for subsequent operations.
        // Hg<thread> = general ops, Hc<thread> = continue ops.
        // Thread 0 or -1 means "any thread".
        const threadId = parseInt(cmd.substring(2));
        if (threadId === 0 || threadId === -1 || threadId === 1 || threadId === 2) {
          if (threadId >= 1) this.currentThread = threadId;
          return gdbMessage('OK');
        }
        return gdbMessage('E01');
      }

      case 'q':
        if (cmd.startsWith('qSupported:')) {
          return gdbMessage('PacketSize=4000;vContSupported+;qXfer:features:read+');
        }
        if (cmd === 'qAttached') {
          return gdbMessage('1');
        }
        if (cmd.startsWith('qXfer:features:read:target.xml')) {
          return gdbMessage('l' + targetXML);
        }
        if (cmd === 'qHostInfo') {
          return gdbMessage(`triple:${lldbTriple};endian:little;ptrsize:4;`);
        }
        if (cmd === 'qProcessInfo') {
          return gdbMessage('pid:1;endian:little;ptrsize:4;');
        }
        if (cmd === 'qfThreadInfo') {
          return gdbMessage('m1,2');
        }
        if (cmd === 'qsThreadInfo') {
          return gdbMessage('l');
        }
        if (cmd === 'qC') {
          return gdbMessage('QC1');
        }
        if (cmd.startsWith('qThreadStopInfo')) {
          const tid = parseInt(cmd.substring(15));
          // Both threads are stopped; report the halted core's signal
          return gdbMessage(`T05thread:${tid};`);
        }
        if (cmd.startsWith('qRcmd,')) {
          return this.handleMonitor(cmd.substring(6));
        }
        // qThreadExtraInfo, qP: return empty (not supported)
        return gdbMessage('');

      case 'v':
        if (cmd === 'vCont?') {
          return gdbMessage('vCont;c;C;s;S');
        }
        if (cmd.startsWith('vCont;')) {
          const actions = cmd.substring(6).split(';');
          // Collect continue and step actions. GDB may send multiple actions
          // (e.g. vCont;c:1;c:2) to resume different threads.
          let continueTids: number[] = [];
          let stepTid = 0;
          for (const action of actions) {
            const colonIdx = action.indexOf(':');
            const tid = colonIdx >= 0 ? parseInt(action.substring(colonIdx + 1)) : 0;
            if (action[0] === 'c') {
              continueTids.push(tid);
            } else if (action[0] === 's') {
              stepTid = tid >= 1 ? tid : this.currentThread;
            }
          }

          // Step takes priority (returns a synchronous stop reply)
          if (stepTid > 0) {
            const stepCpu = stepTid === 1 ? this.chip.core0 : this.chip.core1;
            this.chip.isCore0Running = stepTid === 1;
            stepCpu.executeInstruction();
            this.haltedCore = stepTid - 1;
            return gdbMessage(`T05thread:${stepTid};`);
          }

          // Determine which cores to continue. Both tids present (or tid=0
          // meaning "all") → run both; a single tid → run that core only.
          if (continueTids.length > 0) {
            const allThreads = continueTids.some((t) => t === 0);
            const hasCore0 = allThreads || continueTids.includes(1);
            const hasCore1 = allThreads || continueTids.includes(2);
            if (hasCore0 && hasCore1) {
              this.singleCore = -1;
            } else if (hasCore0) {
              this.currentThread = 1;
              if (this.chip.core0.waiting) {
                this.haltedCore = 0;
                setTimeout(() => this.notifyBreakpoint(1), 0);
                return;
              }
              this.singleCore = 0;
            } else {
              this.currentThread = 2;
              if (this.chip.core1.waiting) {
                this.haltedCore = 1;
                setTimeout(() => this.notifyBreakpoint(2), 0);
                return;
              }
              this.singleCore = 1;
            }
            if (!this.executing) this.execute();
            return;
          }
          return gdbMessage('');
        }
        if (cmd.startsWith('vKill')) {
          this.stop();
          return gdbMessage('OK');
        }
        return gdbMessage('');

      case 'c':
        if (!this.executing) this.execute();
        return gdbMessage('OK');

      case 'g': {
        // Read all registers
        let result = '';
        for (let i = 0; i < NUM_REGS; i++) {
          result += encodeHexUint32(this.readRegister(i));
        }
        return gdbMessage(result);
      }

      case 'G': {
        // Write all registers (hex bytes in target/LE order)
        const hexData = cmd.substring(1);
        for (let i = 0; i < NUM_REGS; i++) {
          const hexVal = hexData.substring(i * 8, i * 8 + 8);
          if (hexVal.length === 8) {
            this.writeRegister(i, decodeHexUint32(hexVal));
          }
        }
        return gdbMessage('OK');
      }

      case 'p': {
        const index = parseInt(cmd.substring(1), 16);
        return gdbMessage(encodeHexUint32(this.readRegister(index)));
      }

      case 'P': {
        const params = cmd.substring(1).split('=');
        const index = parseInt(params[0], 16);
        const value = decodeHexUint32(params[1]);
        this.writeRegister(index, value);
        return gdbMessage('OK');
      }

      case 'm': {
        // Read memory
        const params = cmd.substring(1).split(',');
        const address = parseInt(params[0], 16);
        const length = parseInt(params[1], 16);
        let result = '';
        for (let i = 0; i < length; i++) {
          try {
            result += encodeHexByte(this.chip.readUint8(address + i));
          } catch {
            result += 'ff'; // unreadable memory
          }
        }
        return gdbMessage(result);
      }

      case 'M': {
        // Write memory
        const params = cmd.substring(1).split(/[,:]/);
        const address = parseInt(params[0], 16);
        const length = parseInt(params[1], 16);
        const data = decodeHexBuf(params[2].substring(0, length * 2));
        for (let i = 0; i < data.length; i++) {
          this.chip.writeUint8(address + i, data[i]);
        }
        return gdbMessage('OK');
      }

      case 'X': {
        // Binary memory write: X<addr>,<length>:<escaped-binary>
        const colonIdx = cmd.indexOf(':');
        const header = cmd.substring(1, colonIdx).split(',');
        const address = parseInt(header[0], 16);
        const data = unescapeBinary(cmd.substring(colonIdx + 1));
        for (let i = 0; i < data.length; i++) {
          this.chip.writeUint8(address + i, data[i]);
        }
        return gdbMessage('OK');
      }

      case 'Z': {
        // Set breakpoint: Z0/Z1,addr,kind
        const params = cmd.substring(1).split(',');
        const type = params[0];
        const address = parseInt(params[1], 16);
        if (type === '0' || type === '1') {
          this.breakpoints.add(address);
          return gdbMessage('OK');
        }
        return gdbMessage('');
      }

      case 'z': {
        // Clear breakpoint: z0/z1,addr,kind
        const params = cmd.substring(1).split(',');
        const type = params[0];
        const address = parseInt(params[1], 16);
        if (type === '0' || type === '1') {
          this.breakpoints.delete(address);
          return gdbMessage('OK');
        }
        return gdbMessage('');
      }

      case 'D':
        // Detach
        this.stop();
        return gdbMessage('OK');
    }

    this.warn(`Unhandled GDB packet: ${cmd}`);
    return gdbMessage('');
  }

  private handleMonitor(hexCmd: string): string {
    const cmd = Buffer.from(decodeHexBuf(hexCmd)).toString('ascii').trim();
    const parts = cmd.split(/\s+/);
    const sub = parts[0];

    // GDB expects console output as a separate $O<hex>#cs packet, followed
    // by the final $OK#cs reply. We concatenate both packets in one return.
    const monitorReply = (msg: string) =>
      gdbMessage('O' + encodeHexBuf(new TextEncoder().encode(msg))) + gdbMessage('OK');

    if (sub === 'pio') {
      return this.dumpPio(parts[1] ? parseInt(parts[1]) : -1);
    }
    if (sub === 'gpio') {
      return this.dumpGpio();
    }
    if (sub === 'help' || sub === '') {
      return monitorReply(
        'Available monitor commands:\n  pio [n]  - dump PIO state (all or instance n)\n  gpio     - dump GPIO pin state'
      );
    }
    return monitorReply(
      `Unknown monitor command: ${cmd}\nType "monitor help" for available commands`
    );
  }

  private dumpPio(instance: number): string {
    const pios = this.chip.pio;
    const lines: string[] = [];
    const indices = instance >= 0 && instance < pios.length ? [instance] : pios.map((_, i) => i);

    for (const i of indices) {
      const pio = pios[i];
      lines.push(`=== PIO${i} ===`);
      for (let sm = 0; sm < pio.machines.length; sm++) {
        const m = pio.machines[sm];
        const isrBits = m.inputShiftCount;
        const osrBits = m.outputShiftCount;
        lines.push(
          `  SM${sm}: pc=${m.pc} x=0x${(m.x >>> 0).toString(16)} y=0x${(m.y >>> 0).toString(16)}` +
            ` enabled=${m.enabled ? 1 : 0} waiting=${m.waiting ? 1 : 0}` +
            ` tx=${m.txFIFO.itemCount}/${m.txFIFO.size} rx=${m.rxFIFO.itemCount}/${m.rxFIFO.size}` +
            ` instr=0x${(pio.instructions[m.pc] >>> 0).toString(16).padStart(8, '0')}`
        );
        lines.push(
          `    ISR=0x${(m.inputShiftReg >>> 0).toString(16).padStart(8, '0')} (${(
            m.inputShiftReg >>> 0
          )
            .toString(2)
            .padStart(32, '0')}) ${isrBits}/${m.pushThreshold} bits` +
            (m.shiftCtrl & (1 << 16) ? ' autopush' : '') +
            (m.shiftCtrl & (1 << 18) ? ' →' : ' ←')
        );
        lines.push(
          `    OSR=0x${(m.outputShiftReg >>> 0).toString(16).padStart(8, '0')} (${(
            m.outputShiftReg >>> 0
          )
            .toString(2)
            .padStart(32, '0')}) ${osrBits}/${m.pullThreshold} bits` +
            (m.shiftCtrl & (1 << 17) ? ' autopull' : '') +
            (m.shiftCtrl & (1 << 19) ? ' →' : ' ←')
        );
      }
    }
    return (
      gdbMessage('O' + encodeHexBuf(new TextEncoder().encode(lines.join('\n') + '\n'))) +
      gdbMessage('OK')
    );
  }

  private dumpGpio(): string {
    const pins = this.chip.gpio;
    const n = pins.length;
    const funcNames = ['SPI', 'UART', 'I2C', 'XIP', 'PWM', 'SIO', 'PIO0', 'PIO1', 'PIO2', 'CLK', 'USB'];
    const funcName = (f: number) => funcNames[f] ?? `FUNC${f}`;

    const lines: string[] = [`=== GPIO (${n} pins) ===`];
    for (let i = 0; i < n; i++) {
      const p = pins[i];
      const fn = p.functionSelect;
      lines.push(
        `  GP${i.toString().padStart(2)} ${funcName(fn).padEnd(5)}` +
          ` in=${p.inputValue ? 1 : 0} out=${p.outputValue ? 1 : 0} oe=${p.outputEnable ? 1 : 0}` +
          ` irq=${p.irqValue ? 1 : 0} pu=${p.pullupEnabled ? 1 : 0} pd=${p.pulldownEnabled ? 1 : 0}`
      );
    }
    // Summary: input values as a 48-bit (or 30-bit) binary string
    let inBits = '';
    let outBits = '';
    for (let i = 0; i < n; i++) {
      inBits = (pins[i].inputValue ? '1' : '0') + inBits;
      outBits = (pins[i].outputValue ? '1' : '0') + outBits;
    }
    lines.push(`  inputs:  ${inBits}`);
    lines.push(`  outputs: ${outBits}`);
    return (
      gdbMessage('O' + encodeHexBuf(new TextEncoder().encode(lines.join('\n') + '\n'))) +
      gdbMessage('OK')
    );
  }
}
