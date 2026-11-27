/**
 * PIO state machine instruction disassembler (RP2350 PIO encodings, RP2040 subset).
 * Encodings mirror src/peripherals/pio.ts executeInstruction().
 *
 * Layout: [15:13] opcode, [12:8] delay/sideset, [7:0] args.
 */

export interface InsnFormat {
  /** SIDE_EN (EXECCTRL bit 12) and SIDE_COUNT [15:12]... sideset field width. */
  sideEn: boolean;
  sideCount: number;
}

const JMP_COND = ['always', '!X', 'X--', '!Y', 'Y--', 'X!=Y', 'PIN', '!OSRE'];
const IN_SRC = ['PINS', 'X', 'Y', '(null)', '(resv)', '(status)', 'ISR', 'OSR'];
const OUT_DST = ['PINS', 'X', 'Y', '(null)', 'PINDIRS', 'PUSH', 'PULL', '(exec)'];
const MOV_DST = ['PINS', 'X', 'Y', '(null)', 'EXEC', 'PC', 'ISR', 'OSR'];
const MOV_SRC = ['PINS', 'X', 'Y', '(null)', '(resv)', 'STATUS', 'ISR', 'OSR'];
const MOV_OP = ['', '~', 'bitrev', '(?)'];
const SET_DST = ['PINS', 'X', 'Y', '(resv)', 'PINDIRS', '(resv)', '(resv)', '(resv)'];

export function decodePioInsn(insn: number, fmt: InsnFormat): string {
  const op = (insn >>> 13) & 0b111;
  const delayField = (insn >>> 8) & 0x1f;
  const arg = insn & 0xff;

  // delay/sideset annotation
  const sideBits = fmt.sideEn ? Math.max(1, fmt.sideCount) : fmt.sideCount;
  let suffix = '';
  const delayMask = (1 << (5 - sideBits)) - 1;
  const delay = delayField & delayMask;
  if (fmt.sideEn && delayField & 0x10) {
    const sideVal = delayField >>> (5 - sideBits);
    suffix += ` side ${sideVal}`;
  }
  if (delay) {
    suffix += ` [${delay}]`;
  }

  switch (op) {
    case 0b000: {
      const cond = (insn >>> 5) & 0b111;
      const addr = insn & 0x1f;
      return cond === 0 ? `jmp     ${addr}` : `jmp     ${JMP_COND[cond]} ${addr}`;
    }
    case 0b001: {
      const pol = (insn >>> 7) & 1;
      const src = (insn >>> 5) & 0b11;
      const idx = insn & 0x1f;
      if (src === 0b00) return `wait    ${pol} gpio ${idx}${suffix}`;
      if (src === 0b01) return `wait    ${pol} pin ${idx}${suffix}`;
      if (src === 0b10) {
        return `wait    ${pol} irq ${idx & 0x0f}${idx & 0x10 ? ' rel' : ''}${suffix}`;
      }
      return `wait    (resv)`;
    }
    case 0b010: {
      const src = (insn >>> 5) & 0b111;
      const bits = insn & 0x1f || 32;
      return `in      ${IN_SRC[src]}, ${bits}${suffix}`;
    }
    case 0b011: {
      const dst = (insn >>> 5) & 0b111;
      const bits = insn & 0x1f || 32;
      return `out     ${OUT_DST[dst]}, ${bits}${suffix}`;
    }
    case 0b100: {
      const isPull = (arg & 0x80) !== 0;
      const cond = (arg & 0x40) !== 0 ? (isPull ? ', ifempty' : ', iffull') : '';
      const block = (arg & 0x20) !== 0 ? 'block' : 'noblock';
      return `${isPull ? 'pull' : 'push'}${cond} ${block}${suffix}`;
    }
    case 0b101: {
      const src = arg & 0b111;
      const op2 = (arg >>> 3) & 0b11;
      const dst = (arg >>> 5) & 0b111;
      const op = MOV_OP[op2] ? ` ${MOV_OP[op2]}` : '';
      return `mov     ${MOV_DST[dst]}${op}, ${MOV_SRC[src]}${suffix}`;
    }
    case 0b110: {
      const clear = (arg & 0x40) !== 0;
      const wait = (arg & 0x20) !== 0;
      const idx = arg & 0x1f;
      const mode = clear ? 'clear' : wait ? 'wait' : 'set';
      return `irq     ${mode} ${idx & 0x0f}${idx & 0x10 ? ' rel' : ''}${suffix}`;
    }
    case 0b111: {
      const dst = (arg >>> 5) & 0b111;
      const data = arg & 0x1f;
      return `set     ${SET_DST[dst]}, ${data}${suffix}`;
    }
    default:
      return `(?)`;
  }
}

/** Returns hex + decoded text lines for all 32 instruction memory slots. */
export function disassemblePioMemory(instructions: Uint32Array, fmt: InsnFormat): string[] {
  const lines: string[] = [];
  for (let i = 0; i < 32; i++) {
    const insn = instructions[i];
    lines.push(
      `${i.toString().padStart(2)}: ${insn.toString(16).padStart(4, '0')}  ${
        insn === 0 ? '— (empty)' : decodePioInsn(insn, fmt)
      }`
    );
  }
  return lines;
}
