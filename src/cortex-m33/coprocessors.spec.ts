import { describe, expect, it } from 'vitest';
import { RP2350 } from '../rp2350';

const SRAM = 0x20000000;

function setup() {
  const chip = new RP2350({ coreArch: 'arm' });
  const core = chip.armCore0;
  chip.currentCore = 0;
  chip.writeUint32(0xe000ed08, SRAM);
  // Enable CP0/4/5/7 (GPIOC/DCP/RCP) and CP10/11 (FPU). 2 bits each.
  chip.writeUint32(0xe000ed88, 0x00ffcf03);
  return { chip, core };
}

function put32(chip: RP2350, addr: number, hw0: number, hw1: number) {
  chip.writeUint16(addr, hw0);
  chip.writeUint16(addr + 2, hw1);
}

describe('Cortex-M33 CP0 GPIOC', () => {
  it('bulk write (MCR _put) sets GPIO OUT', () => {
    const { chip, core } = setup();
    core.regs.r[0] = 0x12345678;
    put32(chip, SRAM, 0xee00, 0x0010); // mcr p0, 0, r0, c0, c0, 0
    core.PC = SRAM;
    core.executeInstruction();
    expect(chip.readUint32(0xd0000010)).toBe(0x12345678 & 0x3fffffff);
  });

  it('bulk read (MRC _get) reads GPIO OUT', () => {
    const { chip, core } = setup();
    chip.writeUint32(0xd0000010, 0xdeadbeef);
    put32(chip, SRAM, 0xee10, 0x0010); // mrc p0, 0, r0, c0, c0, 0
    core.PC = SRAM;
    core.executeInstruction();
    expect(core.regs.r[0]).toBe(0xdeadbeef & 0x3fffffff);
  });

  it('bulk read GPIO IN via GPIOC', () => {
    const { chip, core } = setup();
    // GPIO IN reads the raw GPIO input register from SIO.
    // The SIO GPIO IN at offset 0x4 reflects GPIO pin input values.
    // We can test it indirectly: write to GPIO OUT, then read OUT back.
    chip.sio.writeUint32(0x010, 0xcafe, 0);
    put32(chip, SRAM, 0xee10, 0x0010); // mrc p0, 0, r0, c0, c0, 0 (OUT get)
    core.PC = SRAM;
    core.executeInstruction();
    expect(core.regs.r[0]).toBe(0xcafe);
  });
});

describe('Cortex-M33 CP4/5 DCP', () => {
  it('MCR/MRC transfers load/store DCP halves', () => {
    const { chip, core } = setup();
    // MCR p4, 0, r0, c0, c0, 0 → hw0=0xee00, hw1=0x0410
    core.regs.r[0] = 0x40000000;
    put32(chip, SRAM, 0xee00, 0x0410);
    core.PC = SRAM;
    core.executeInstruction();
    // Read back via MRC.
    core.regs.r[0] = 0;
    put32(chip, SRAM + 4, 0xee10, 0x0410);
    core.PC = SRAM + 4;
    core.executeInstruction();
    expect(core.regs.r[0]).toBe(0x40000000);
  });

  it('CDP dadd: d[0] = d[1] + d[2]', () => {
    const { chip, core } = setup();
    const st = chip.ppb!.coreState[0];
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    // Load 1.5 into slot 1 (CRn=1), 2.5 into slot 2 (CRm=2).
    view.setFloat64(0, 1.5, true);
    st.dcpHalves[2] = view.getUint32(0, true);
    st.dcpHalves[3] = view.getUint32(4, true);
    view.setFloat64(0, 2.5, true);
    st.dcpHalves[4] = view.getUint32(0, true);
    st.dcpHalves[5] = view.getUint32(4, true);
    // cdp p4, 0, c0, c1, c2, 0 (dadd): CRd=0, CRn=1, CRm=2.
    // hw0 = 0xee00 | (opc1=0<<4) | CRn=1 = 0xee01.
    // hw1 = (CRd=0<<12) | (coproc=4<<8) | (opc2=0<<5) | 0 | CRm=2 = 0x0402.
    put32(chip, SRAM, 0xee01, 0x0402);
    core.PC = SRAM;
    core.executeInstruction();
    view.setUint32(0, st.dcpHalves[0], true);
    view.setUint32(4, st.dcpHalves[1], true);
    expect(view.getFloat64(0, true)).toBeCloseTo(4.0, 10);
  });

  it('dcpstat_get returns status', () => {
    const { chip, core } = setup();
    const st = chip.ppb!.coreState[0];
    st.dcpStatus = 5;
    // cdp p4, 3, c0, c0, c0, 0 (dcpstat_get)
    // hw0 = 0xee30, hw1 = 0x0400
    put32(chip, SRAM, 0xee30, 0x0400);
    core.PC = SRAM;
    core.executeInstruction();
    expect(st.dcpHalves[0]).toBe(5);
  });
});

describe('Cortex-M33 CP7 RCP', () => {
  it('rcp_canary_get returns salt XOR DEADBEEF when salt is valid', () => {
    const { chip, core } = setup();
    const st = chip.ppb!.coreState[0];
    st.rcpSalt = 0x12345678;
    st.rcpSaltValid = true;
    put32(chip, SRAM, 0xee10, 0x0730); // mrc p7, 0, r0, c0, c0, 1
    core.PC = SRAM;
    core.executeInstruction();
    expect(core.regs.r[0]).toBe((0x12345678 ^ 0xdeadbeef) >>> 0);
  });

  it('rcp_canary_check passes when value matches', () => {
    const { chip, core } = setup();
    const st = chip.ppb!.coreState[0];
    st.rcpSalt = 0xaabbccdd;
    st.rcpSaltValid = true;
    core.regs.r[0] = (0xaabbccdd ^ 0xdeadbeef) >>> 0;
    put32(chip, SRAM, 0xee00, 0x0730); // mcr p7, 0, r0, c0, c0, 1
    core.PC = SRAM;
    core.executeInstruction();
    expect(core.pendingFault).toBe(null);
  });

  it('rcp_canary_check triggers NMI when value mismatches', () => {
    const { chip, core } = setup();
    chip.writeUint32(SRAM + 2 * 4, SRAM + 0x200);
    chip.writeUint16(SRAM + 0x200, 0xbf00);
    const st = chip.ppb!.coreState[0];
    st.rcpSalt = 0xaabbccdd;
    st.rcpSaltValid = true;
    core.regs.r[0] = 0;
    core.regs.msp = SRAM + 0x2000;
    core.regs.sp = SRAM + 0x2000;
    put32(chip, SRAM, 0xee00, 0x0730); // mcr p7 canary_check
    core.PC = SRAM;
    core.executeInstruction();
    expect(core.regs.ipsr).toBe(2); // NMI
  });

  it('rcp_count_init sets counter', () => {
    const { chip, core } = setup();
    const st = chip.ppb!.coreState[0];
    put32(chip, SRAM, 0xee84, 0x0712); // mcr p7, 4, r0, c4, c2, 0
    core.PC = SRAM;
    core.executeInstruction();
    expect(st.rcpCount).toBe(0x42);
  });

  it('rcp_btrue triggers NMI when value != 1', () => {
    const { chip, core } = setup();
    chip.writeUint32(SRAM + 2 * 4, SRAM + 0x200);
    chip.writeUint16(SRAM + 0x200, 0xbf00);
    core.regs.r[0] = 0;
    core.regs.msp = SRAM + 0x2000;
    core.regs.sp = SRAM + 0x2000;
    put32(chip, SRAM, 0xee40, 0x0710); // mcr p7, 2, r0, c0, c0, 0
    core.PC = SRAM;
    core.executeInstruction();
    expect(core.regs.ipsr).toBe(2); // NMI
  });

  it('rcp_panic triggers NMI', () => {
    const { chip, core } = setup();
    chip.writeUint32(SRAM + 2 * 4, SRAM + 0x200);
    chip.writeUint16(SRAM + 0x200, 0xbf00);
    core.regs.msp = SRAM + 0x2000;
    core.regs.sp = SRAM + 0x2000;
    put32(chip, SRAM, 0xee00, 0x0720); // cdp p7, 0, c0, c0, c0, 1
    core.PC = SRAM;
    core.executeInstruction();
    expect(core.regs.ipsr).toBe(2); // NMI
  });

  it('rcp_iequal passes when values match', () => {
    const { chip, core } = setup();
    core.regs.r[0] = 42;
    core.regs.r[1] = 42;
    put32(chip, SRAM, 0xec51, 0x0770); // mrrc p7, 7, r0, r1, c0
    core.PC = SRAM;
    core.executeInstruction();
    expect(core.pendingFault).toBe(null);
  });

  it('rcp_salt_core0 sets salt', () => {
    const { chip, core } = setup();
    const st = chip.ppb!.coreState[0];
    core.regs.r[0] = 0xcafef00d;
    put32(chip, SRAM, 0xec41, 0x0780); // mcrr p7, 8, r0, r1, c0
    core.PC = SRAM;
    core.executeInstruction();
    expect(st.rcpSalt).toBe(0xcafef00d);
    expect(st.rcpSaltValid).toBe(true);
  });
});

// ---- Coprocessor edge cases ----

/** Write an f64 into DCP slot `idx` via the shared state halves. */
function setDcpDouble(st: { dcpHalves: Uint32Array }, idx: number, val: number) {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setFloat64(0, val, true);
  st.dcpHalves[idx * 2] = view.getUint32(0, true);
  st.dcpHalves[idx * 2 + 1] = view.getUint32(4, true);
}

/** Read an f64 from DCP slot `idx`. */
function getDcpDouble(st: { dcpHalves: Uint32Array }, idx: number): number {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, st.dcpHalves[idx * 2], true);
  view.setUint32(4, st.dcpHalves[idx * 2 + 1], true);
  return view.getFloat64(0, true);
}

describe('Cortex-M33 coprocessor edge cases', () => {
  it('CP0 per-bit GPIO put (op2=4) preserves other pins', () => {
    const { chip, core } = setup();
    // Pre-set GPIO OUT to 0xFF.
    chip.writeUint32(0xd0000010, 0xff);
    // Per-bit put pin 3 = 1: CRn=0,CRm=3 → pin=3, op2=4, Rt=1 (set).
    // MCR p0, 0, r0, c0, c3, 4: hw1=(0<<12)|(0<<8)|(4<<5)|(1<<4)|3 = 0x93.
    core.regs.r[0] = 1;
    put32(chip, SRAM, 0xee00, 0x0093);
    core.PC = SRAM;
    core.executeInstruction();
    // Must be 0xFF (unchanged) | (1<<3) = 0xFF, NOT 0x08 (bulk write bug).
    expect(chip.readUint32(0xd0000010)).toBe(0xff);
  });

  it('CP0 per-bit GPIO put pin=1 clears only that pin', () => {
    const { chip, core } = setup();
    chip.writeUint32(0xd0000010, 0xff);
    // Per-bit put pin 1 = 0: CRn=0,CRm=1 → pin=1, op2=4, Rt=0 (clear).
    // hw1 = (4<<5)|(1<<4)|1 = 0x91.
    put32(chip, SRAM, 0xee00, 0x0091);
    core.regs.r[0] = 0;
    core.PC = SRAM;
    core.executeInstruction();
    expect(chip.readUint32(0xd0000010)).toBe(0xfd); // only pin 1 cleared
  });

  it('DCP d2i saturates for out-of-range positive (3e9 → 0x7FFFFFFF)', () => {
    const { chip, core } = setup();
    const st = chip.ppb!.coreState[0];
    setDcpDouble(st, 1, 3e9);
    // cdp p4, 2, c0, c1, c0, 2 (d2i): opc1=2,opc2=2 → hw1=(2<<5)|4<<8=0x0440.
    put32(chip, SRAM, 0xee21, 0x0440);
    core.PC = SRAM;
    core.executeInstruction();
    expect(st.dcpHalves[0]).toBe(0x7fffffff);
  });

  it('DCP d2u saturates for out-of-range (5e9 → 0xFFFFFFFF)', () => {
    const { chip, core } = setup();
    const st = chip.ppb!.coreState[0];
    setDcpDouble(st, 1, 5e9);
    // cdp p4, 2, c0, c1, c0, 3 (d2u): opc1=2,opc2=3.
    put32(chip, SRAM, 0xee21, 0x0460); // hw1 = (3<<5)|0|coproc=4<<8 = 0x0460
    core.PC = SRAM;
    core.executeInstruction();
    expect(st.dcpHalves[0]).toBe(0xffffffff >>> 0);
  });

  it('DCP d2i saturates for negative out-of-range (-3e9 → 0x80000000)', () => {
    const { chip, core } = setup();
    const st = chip.ppb!.coreState[0];
    setDcpDouble(st, 1, -3e9);
    put32(chip, SRAM, 0xee21, 0x0440); // d2i (opc2=2)
    core.PC = SRAM;
    core.executeInstruction();
    expect(st.dcpHalves[0]).toBe(0x80000000 >>> 0);
  });

  it('DCP division 1.0/0.0 = +Infinity (not NaN)', () => {
    const { chip, core } = setup();
    const st = chip.ppb!.coreState[0];
    setDcpDouble(st, 1, 1.0);
    setDcpDouble(st, 2, 0.0);
    // cdp p4, 0, c0, c1, c2, 3 (ddiv): opc1=0,opc2=3, CRd=0,CRn=1,CRm=2.
    put32(chip, SRAM, 0xee01, 0x0462); // hw1 = (3<<5)|2|4<<8 = 0x0462
    core.PC = SRAM;
    core.executeInstruction();
    expect(getDcpDouble(st, 0)).toBe(Infinity);
  });

  it('DCP division -1.0/0.0 = -Infinity', () => {
    const { chip, core } = setup();
    const st = chip.ppb!.coreState[0];
    setDcpDouble(st, 1, -1.0);
    setDcpDouble(st, 2, 0.0);
    put32(chip, SRAM, 0xee01, 0x0462); // ddiv
    core.PC = SRAM;
    core.executeInstruction();
    expect(getDcpDouble(st, 0)).toBe(-Infinity);
  });

  it('DCP division 0.0/0.0 = NaN', () => {
    const { chip, core } = setup();
    const st = chip.ppb!.coreState[0];
    setDcpDouble(st, 1, 0.0);
    setDcpDouble(st, 2, 0.0);
    put32(chip, SRAM, 0xee01, 0x0462); // ddiv
    core.PC = SRAM;
    core.executeInstruction();
    expect(isNaN(getDcpDouble(st, 0))).toBe(true);
  });

  it('DCP status flags NaN correctly (NaN bit, not infinity bit)', () => {
    const { chip, core } = setup();
    const st = chip.ppb!.coreState[0];
    setDcpDouble(st, 1, NaN);
    setDcpDouble(st, 2, 1.0);
    // dadd: opc1=0,opc2=0 → NaN + 1.0 = NaN.
    put32(chip, SRAM, 0xee01, 0x0402); // cdp p4, 0, c0, c1, c2, 0
    core.PC = SRAM;
    core.executeInstruction();
    // Status: bit 3 (NaN) set, bit 2 (infinity) clear.
    expect(st.dcpStatus & 8).not.toBe(0); // NaN
    expect(st.dcpStatus & 4).toBe(0); // NOT infinity
  });

  it('DCP status flags +Infinity as infinity (not NaN)', () => {
    const { chip, core } = setup();
    const st = chip.ppb!.coreState[0];
    setDcpDouble(st, 1, Infinity);
    setDcpDouble(st, 2, 1.0);
    // dadd: Infinity + 1.0 = Infinity.
    put32(chip, SRAM, 0xee01, 0x0402);
    core.PC = SRAM;
    core.executeInstruction();
    expect(st.dcpStatus & 4).not.toBe(0); // infinity
    expect(st.dcpStatus & 8).toBe(0); // NOT NaN
  });

  it('DCP status flags -0.0 as negative+zero', () => {
    const { chip, core } = setup();
    const st = chip.ppb!.coreState[0];
    // i2d from a -0.0 pattern: store -0.0 f64, then i2d gives 0.0.
    // Instead test dmul: -0.0 * 1.0 = -0.0.
    setDcpDouble(st, 1, -0.0);
    setDcpDouble(st, 2, 1.0);
    // dmul: opc1=0,opc2=2.
    put32(chip, SRAM, 0xee01, 0x0442); // cdp p4, 0, c0, c1, c2, 2
    core.PC = SRAM;
    core.executeInstruction();
    // -0.0: zero bit (1) + negative bit (2).
    expect(st.dcpStatus & 1).not.toBe(0); // zero
    expect(st.dcpStatus & 2).not.toBe(0); // negative
  });

  it('DCP d2i conversion updates the status register', () => {
    const { chip, core } = setup();
    const st = chip.ppb!.coreState[0];
    st.dcpStatus = 0xff; // stale
    setDcpDouble(st, 1, 42.0);
    put32(chip, SRAM, 0xee21, 0x0440); // d2i (opc2=2)
    core.PC = SRAM;
    core.executeInstruction();
    // 42.0 is positive and non-zero: only bit 1 (zero) clear, no neg/inf/nan.
    expect(st.dcpStatus).toBe(0);
  });

  it('DCP i2d conversion updates the status register', () => {
    const { chip, core } = setup();
    const st = chip.ppb!.coreState[0];
    st.dcpStatus = 0xff;
    st.dcpHalves[2] = -5; // i32 = -5 in slot 1 half A
    put32(chip, SRAM, 0xee21, 0x0400); // opc1=2,opc2=0 (i2d), CRn=1
    // Wait — i2d reads half A of CRn. hw0 = 0xee20 | opc1=2<<4 | CRn=1 = 0xee21.
    // hw1 = (Rd=0<<12) | (coproc=4<<8) | (opc2=0<<5) | CRm=0 = 0x0400.
    core.PC = SRAM;
    core.executeInstruction();
    // -5.0: negative bit (2), not zero, not inf/nan.
    expect(st.dcpStatus).toBe(2);
  });

  it('rcp_canary_status sets N=1 when salt valid, clears NZCV nibble', () => {
    const { chip, core } = setup();
    const st = chip.ppb!.coreState[0];
    st.rcpSaltValid = true;
    // Pre-set APSR NZCV to all-ones to verify the nibble is cleared.
    core.regs.xpsr = (core.regs.xpsr & 0x0fffffff) | 0xf0000000;
    // rcp_canary_status: mrc p7, 1, pc, c0, c0, 0. Rt=15, opc1=1, opc2=0.
    // hw0=0xee10|(1<<5)=0xee30, hw1=(15<<12)|(7<<8)|(0<<5)|(1<<4)|0=0xf710.
    put32(chip, SRAM, 0xee30, 0xf710);
    core.PC = SRAM;
    core.executeInstruction();
    // N must be SET (salt valid), Z/C/V cleared.
    expect(core.regs.xpsr & 0x80000000).not.toBe(0); // N=1
    expect(core.regs.xpsr & 0x70000000).toBe(0); // Z/C/V clear
  });

  it('rcp_canary_status sets N=0 when salt invalid', () => {
    const { chip, core } = setup();
    const st = chip.ppb!.coreState[0];
    st.rcpSaltValid = false;
    core.regs.xpsr = (core.regs.xpsr & 0x0fffffff) | 0xf0000000;
    put32(chip, SRAM, 0xee30, 0xf710);
    core.PC = SRAM;
    core.executeInstruction();
    expect(core.regs.xpsr & 0xf0000000).toBe(0); // N/Z/C/V all clear
  });

  it('DCP op with CPACR disabled triggers NOCP UsageFault', () => {
    const chip = new RP2350({ coreArch: 'arm' });
    const core = chip.armCore0;
    chip.currentCore = 0;
    chip.writeUint32(0xe000ed08, SRAM); // VTOR
    chip.writeUint32(SRAM + 3 * 4, SRAM + 0x300); // HardFault vector
    chip.writeUint16(SRAM + 0x300, 0xbf00); // NOP in handler
    // Enable ONLY CP10/11, NOT CP4/5 (DCP). CPACR = 0x00ff0000.
    chip.writeUint32(0xe000ed88, 0x00ff0000);
    core.regs.msp = SRAM + 0x2000;
    core.regs.sp = SRAM + 0x2000;
    // CDP p4 (DCP): cdp p4, 0, c0, c0, c0, 0.
    put32(chip, SRAM, 0xee00, 0x0400);
    core.PC = SRAM;
    core.executeInstruction();
    expect(core.regs.ipsr).toBe(3); // HardFault (escalated from UsageFault)
    expect(chip.readUint32(0xe000ed28) & (1 << 21)).not.toBe(0); // NOCP
  });

  it('MRRC2 (L=1) from CP7 is a NOP — does not trigger rcp_iequal', () => {
    const { chip, core } = setup();
    chip.writeUint32(SRAM + 2 * 4, SRAM + 0x200); // NMI vector
    chip.writeUint16(SRAM + 0x200, 0xbf00);
    core.regs.r[0] = 42;
    core.regs.r[1] = 99; // mismatch → would NMI if iequal ran
    core.regs.msp = SRAM + 0x2000;
    core.regs.sp = SRAM + 0x2000;
    // MRRC p7, 7, r0, r1, c0 (L=1): hw0 = 0xEC00 | Rt2 | (L<<4), Rt2=r1=1 →
    // 0xec11. hw1 = (opc1<<4) | (coproc<<8): rcp_iequal opc1=7, coproc=7 →
    // 0x0770.
    put32(chip, SRAM, 0xec11, 0x0770); // mrrc p7, 7, r0, r1, c0 (L=1)
    core.PC = SRAM;
    core.executeInstruction();
    // Must NOT enter NMI: L=1 (MRRC2) is a NOP.
    expect(core.regs.ipsr).toBe(0); // still Thread mode
  });

  it('MCRR (L=0) from CP7 DOES run rcp_iequal', () => {
    const { chip, core } = setup();
    chip.writeUint32(SRAM + 2 * 4, SRAM + 0x200);
    chip.writeUint16(SRAM + 0x200, 0xbf00);
    core.regs.r[0] = 42;
    core.regs.r[1] = 99; // mismatch → NMI
    core.regs.msp = SRAM + 0x2000;
    core.regs.sp = SRAM + 0x2000;
    // MCRR p7, 7: L=0. hw0=0xec01 (no L bit). hw1=0x0770.
    put32(chip, SRAM, 0xec01, 0x0770); // mcrr p7, 7, r0, r1, c0 (L=0)
    core.PC = SRAM;
    core.executeInstruction();
    expect(core.regs.ipsr).toBe(2); // NMI (iequal mismatch)
  });

  it('T2 (0xFE/0xFF) coprocessor prefix: GPIOC bulk write via MCR2', () => {
    // The T2/unconditional encoding uses hw0 prefix 0xFE instead of 0xEE.
    // Same encoding otherwise: MCR2 p0, 0, r0, c0, c0, 0 → hw0=0xfe00, hw1=0x0010.
    const { chip, core } = setup();
    core.regs.r[0] = 0x12345678;
    put32(chip, SRAM, 0xfe00, 0x0010);
    core.PC = SRAM;
    core.executeInstruction();
    expect(chip.readUint32(0xd0000010)).toBe(0x12345678 & 0x3fffffff);
  });

  it('T2 coprocessor prefix: DCP MCR2 transfer', () => {
    // MCR2 p4, 0, r0, c0, c0, 0 → hw0=0xfe00, hw1=0x0410.
    const { chip, core } = setup();
    core.regs.r[0] = 0xdeadbeef;
    put32(chip, SRAM, 0xfe00, 0x0410);
    core.PC = SRAM;
    core.executeInstruction();
    // Read back via MRC2 (0xfe10).
    core.regs.r[0] = 0;
    put32(chip, SRAM + 4, 0xfe10, 0x0410);
    core.PC = SRAM + 4;
    core.executeInstruction();
    expect(core.regs.r[0]).toBe(0xdeadbeef);
  });

  it('T2 coprocessor prefix: RCP rcp_canary_get via MRC2', () => {
    const { chip, core } = setup();
    const st = chip.ppb!.coreState[0];
    st.rcpSalt = 0xcafef00d;
    st.rcpSaltValid = true;
    // MRC2 p7, 0, r0, c0, c0, 1 → hw0=0xfe10, hw1=0x0730.
    put32(chip, SRAM, 0xfe10, 0x0730);
    core.PC = SRAM;
    core.executeInstruction();
    expect(core.regs.r[0]).toBe((0xcafef00d ^ 0xdeadbeef) >>> 0);
  });

  it('T2 MCRR2 prefix (0xFC): rcp_salt_core0', () => {
    // MCRR2 p7, 8: hw0=0xfc01, hw1=0x0780.
    const { chip, core } = setup();
    const st = chip.ppb!.coreState[0];
    core.regs.r[0] = 0xabcdeffe;
    put32(chip, SRAM, 0xfc01, 0x0780);
    core.PC = SRAM;
    core.executeInstruction();
    expect(st.rcpSalt).toBe(0xabcdeffe);
    expect(st.rcpSaltValid).toBe(true);
  });

  it('RCP salts start invalid for both cores', () => {
    const { chip } = setup();
    expect(chip.ppb!.coreState[0].rcpSaltValid).toBe(false);
    expect(chip.ppb!.coreState[1].rcpSaltValid).toBe(false);
  });

  it('rcp_salt_core1 (CRm=1) on core 0 writes core 1 salt, not core 0', () => {
    // Per datasheet §3.6.3.1 core 0's coprocessor port provisions both cores'
    // salts; CRm selects the *target* core. mcrr p7,8,r0,r1,c1 →
    // hw0=0xec01 (Rt2=r1, L=0), hw1=0x0781 (Rt=r0, coproc=7, opc1=8, CRm=1).
    const { chip, core } = setup();
    const st0 = chip.ppb!.coreState[0];
    const st1 = chip.ppb!.coreState[1];
    core.regs.r[0] = 0xfeedface;
    put32(chip, SRAM, 0xec01, 0x0781);
    core.PC = SRAM;
    core.executeInstruction();
    expect(st1.rcpSalt).toBe(0xfeedface);
    expect(st1.rcpSaltValid).toBe(true);
    expect(st0.rcpSaltValid).toBe(false);
  });

  it('writing an already-valid salt triggers an RCP fault (NMI)', () => {
    const { chip, core } = setup();
    chip.writeUint32(SRAM + 2 * 4, SRAM + 0x200); // NMI vector
    chip.writeUint16(SRAM + 0x200, 0xbf00); // NOP handler
    core.regs.msp = SRAM + 0x2000;
    core.regs.sp = SRAM + 0x2000;
    // Core 1 salt already valid (e.g. previously provisioned by core 0).
    chip.ppb!.coreState[1].rcpSaltValid = true;
    core.regs.r[0] = 0x12345678;
    put32(chip, SRAM, 0xec01, 0x0781); // mcrr p7,8,r0,r1,c1
    core.PC = SRAM;
    core.executeInstruction();
    expect(core.regs.ipsr).toBe(2); // NMI
    // The already-valid salt must not be overwritten.
    expect(chip.ppb!.coreState[1].rcpSalt).toBe(0);
  });

  describe('MRC with Rt=15 (apsr_nzcv) writes flags, not PC', () => {
    // Per ARMv8-M, an MRC whose destination is r15 transfers result[31:28]
    // to the N/Z/C/V flags and leaves PC unchanged. Regression for the crash
    // where the SDK's double routines did `mrc2 p4, ..., apsr_nzcv, ...` and
    // the value was written straight to PC, jumping to address 0.
    it('DCP mrc2 p4, #0, apsr_nzcv, c0, c0, #1 updates NZCV from DCP half', () => {
      // hw0=0xfe10 (T2, L=1 → MRC2), hw1=0xf430 (Rt=15, coproc=4, opc2=1, CRm=0).
      // → halfIdx = (0&7)*2 + (1&1) = 1.
      const { chip, core } = setup();
      chip.ppb!.coreState[0].dcpHalves[1] = 0xf0000000; // N=Z=C=V all set
      put32(chip, SRAM, 0xfe10, 0xf430);
      core.PC = SRAM;
      core.executeInstruction();
      // PC advanced past the 32-bit insn normally; NOT set to the result (0).
      expect(core.regs.pc).toBe((SRAM + 4) >>> 0);
      expect(core.regs.N).toBe(true);
      expect(core.regs.Z).toBe(true);
      expect(core.regs.C).toBe(true);
      expect(core.regs.V).toBe(true);
    });

    it('GPIOC bulk read into apsr_nzcv sets flags from the GPIO word', () => {
      // mrc p0, 0, apsr_nzcv, c0, c0: bulk OUT read. hw0=0xee10, hw1=0xf010
      // (Rt=15 at bits[15:12]). Seed GPIO OUT to 0x20000000; the GPIOC mask
      // (0x3fffffff) keeps bit29, which lands in APSR bit29 = C flag.
      const { chip, core } = setup();
      chip.sio.writeUint32(0x010, 0x20000000, 0);
      put32(chip, SRAM, 0xee10, 0xf010);
      core.PC = SRAM;
      core.executeInstruction();
      expect(core.regs.pc).toBe((SRAM + 4) >>> 0);
      expect(core.regs.C).toBe(true);
      expect(core.regs.N).toBe(false);
    });
  });
});
