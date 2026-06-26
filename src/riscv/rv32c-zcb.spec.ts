import { describe, it, expect } from 'vitest';
import { decompress_rv32c_inst } from './rv32c';

// The Zcb decode paths don't touch the CPU object, so a stub is enough here.
const cpu = {} as any;
const dec = (inst: number) => decompress_rv32c_inst(cpu, inst) >>> 0;

// 32-bit RISC-V instruction field extractors
const opcode = (w: number) => w & 0x7f;
const rd = (w: number) => (w >>> 7) & 0x1f;
const funct3 = (w: number) => (w >>> 12) & 7;
const rs1 = (w: number) => (w >>> 15) & 0x1f;
const rs2 = (w: number) => (w >>> 20) & 0x1f;
const immI = (w: number) => (w >>> 20) & 0xfff;
const funct7 = (w: number) => (w >>> 25) & 0x7f;

const OP_IMM = 0x13, OP = 0x33, LOAD = 0x03, STORE = 0x23;

// Zcb is what the RP2350 boot ROM is built with, so these turn up immediately on any
// real flash binary. 0x9fe1 (c.zext.b) and 0x8c24 (c.sh) are the exact encodings that
// previously aborted boot with "Unknown/Unsupported ... instruction".
describe('RV32 Zcb compressed instruction decoding', () => {
  it('c.zext.b (0x9fe1, real bootrom) -> andi rd, rd, 0xff', () => {
    const w = dec(0x9fe1); // c.zext.b x15
    expect(opcode(w)).toBe(OP_IMM);
    expect(funct3(w)).toBe(0x7); // ANDI
    expect(immI(w)).toBe(0xff);
    expect(rd(w)).toBe(15);
    expect(rs1(w)).toBe(15);
  });

  it('c.sh (0x8c24, real bootrom) -> sh rs2, off(rs1)', () => {
    const w = dec(0x8c24);
    expect(opcode(w)).toBe(STORE);
    expect(funct3(w)).toBe(0x1); // SH
    expect(rs1(w)).toBe(8);
    expect(rs2(w)).toBe(9);
  });

  it('c.sext.b (0x9c65) -> sext.b (Zbb)', () => {
    const w = dec(0x9c65);
    expect(opcode(w)).toBe(OP_IMM);
    expect(funct3(w)).toBe(0x1);
    expect(immI(w)).toBe(0b011000000100);
  });

  it('c.zext.h (0x9c69) -> zext.h (pack rd, rd, x0)', () => {
    const w = dec(0x9c69);
    expect(opcode(w)).toBe(OP);
    expect(funct3(w)).toBe(0x4);
    expect(funct7(w)).toBe(0x04);
    expect(rs2(w)).toBe(0);
  });

  it('c.sext.h (0x9c6d) -> sext.h (Zbb)', () => {
    const w = dec(0x9c6d);
    expect(opcode(w)).toBe(OP_IMM);
    expect(funct3(w)).toBe(0x1);
    expect(immI(w)).toBe(0b011000000101);
  });

  it('c.not (0x9c75) -> xori rd, rd, -1', () => {
    const w = dec(0x9c75);
    expect(opcode(w)).toBe(OP_IMM);
    expect(funct3(w)).toBe(0x4); // XORI
    expect(immI(w)).toBe(0xfff); // -1
  });

  it('c.mul (0x9c49) -> mul rd, rd, rs2 (RV32M)', () => {
    const w = dec(0x9c49);
    expect(opcode(w)).toBe(OP);
    expect(funct3(w)).toBe(0x0);
    expect(funct7(w)).toBe(0x01); // MUL
  });

  it('c.lh (0x84c0) -> lh rd, off(rs1)', () => {
    const w = dec(0x84c0);
    expect(opcode(w)).toBe(LOAD);
    expect(funct3(w)).toBe(0x1); // LH (signed)
  });

  it('c.sb (0x8880) -> sb rs2, off(rs1)', () => {
    const w = dec(0x8880);
    expect(opcode(w)).toBe(STORE);
    expect(funct3(w)).toBe(0x0); // SB
  });
});
