import { describe, expect, test } from 'vitest';
import { RegisterSet } from '../cpu';
import { RP2350 } from '../../rp2350';

describe('Testing RegisterSet class:', () => {
  test('Set x1 to 5', () => {
    const registerSet = new RegisterSet(32);
    registerSet.setRegister(1, 5);
    expect(registerSet.getRegister(1)).toBe(5);
  });

  test('x0 is always 0', () => {
    const registerSet = new RegisterSet(32);
    registerSet.setRegister(0, 42);
    expect(registerSet.getRegister(0)).toBe(0);
  });
});

describe('Testing step() with a raw instruction word:', () => {
  test('add x3, x1, x2  ->  0x002080b3', () => {
    const chip = new RP2350();
    const cpu = chip.core0;
    chip.core1.waiting = true;

    cpu.registerSet.setRegister(1, 3);
    cpu.registerSet.setRegister(2, 5);

    // add x3, x1, x2  =  rs2=2, rs1=1, func3=0, rd=3, opcode=0x33  ->  0x002081b3
    cpu.step(0x002081b3);

    expect(cpu.registerSet.getRegister(3)).toBe(8);
  });
});
