import * as fs from 'fs';
import * as path from 'path';
import { randomFillSync } from 'node:crypto';
import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';
import { RP2040 } from './rp2040';
import { RP2350 } from './rp2350';
import { bootrom_rp2350_A2 } from './bootroms';
import { loadHex } from './utils/load-hex';
import { ConsoleLogger, LogLevel } from './utils/logging';
import { SERIALIZATION_QUIRK_INCOMPLETE } from './utils/save-state';

// Save-state coverage. Two independent checks:
//
//  1. Static: every class with instance fields defines transferState(), or is listed
//     with a reason as exempt or pending. A pending bucket must be empty before its chip
//     may stop reporting SERIALIZATION_QUIRK_INCOMPLETE.
//  2. Dynamic: capture every field reachable from the chip, serialize, overwrite all of
//     it with random values, unserialize, and require the graph to match the capture.
//     This needs reflection, so it is JS-only; the transferState() code it exercises is
//     the same the C build runs.

/* ------------------------------------------------------------------ */
/* Static inventory                                                    */
/* ------------------------------------------------------------------ */

const SKIP_DIR = new Set(['gdb', 'mcp', 'rp2-emu-cli', 'bootroms', 'test']);
const SKIP_FILE = /\.spec\.ts$|simulator\.ts|emulator-controller\.ts|pio-gpio-dump\.ts/;

interface ClassInfo {
  name: string;
  where: string;
  fields: Map<string, boolean>;
  mutatedOutsideCtor: Set<string>;
  hasTransferState: boolean;
}

function memberName(node: any): string | null {
  const key = node.key;
  if (!key) {
    return null;
  }
  if (key.type === 'Identifier') {
    return key.name;
  }
  return key.type === 'PrivateName' ? `#${key.id.name}` : String(key.value);
}

function thisMember(expr: any): string | null {
  while (
    expr &&
    /^(TSNonNullExpression|TSAsExpression|TSTypeAssertion|TypeCastExpression)$/.test(expr.type)
  ) {
    expr = expr.expression;
  }
  return expr?.type === 'MemberExpression' &&
    !expr.computed &&
    expr.object.type === 'ThisExpression'
    ? expr.property.name
    : null;
}

function thisAssignment(node: any): string | null {
  if (node.type === 'AssignmentExpression') {
    return thisMember(node.left);
  }
  return node.type === 'UpdateExpression' ? thisMember(node.argument) : null;
}

function walk(node: any, visit: (n: any) => void) {
  if (!node || typeof node !== 'object') {
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      walk(item, visit);
    }
    return;
  }
  if (typeof node.type !== 'string') {
    return;
  }
  visit(node);
  // A nested class has its own `this`; its assignments are not ours.
  if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
    return;
  }
  for (const key of Object.keys(node)) {
    if (
      !/^(loc|leadingComments|trailingComments|innerComments|extra|range|errors|tokens)$/.test(key)
    ) {
      walk(node[key], visit);
    }
  }
}

function analyzeClass(cls: any, file: string): ClassInfo {
  const info: ClassInfo = {
    name: cls.id?.name ?? '<anonymous>',
    where: `${path.relative(process.cwd(), file)}:${cls.loc.start.line}`,
    fields: new Map(),
    mutatedOutsideCtor: new Set(),
    hasTransferState: false,
  };
  for (const member of cls.body.body) {
    if (/^Class(Property|PrivateProperty|AccessorProperty)$/.test(member.type)) {
      const name = memberName(member);
      // `locked`: TypeScript itself guarantees no assignment outside the constructor.
      const locked = member.accessibility === 'private' || !!member.readonly;
      if (name && !member.static) {
        info.fields.set(name, locked);
      }
    }
    if (/^(ClassMethod|ClassPrivateMethod|TSDeclareMethod)$/.test(member.type)) {
      if (member.kind === 'constructor') {
        for (const param of member.params) {
          if (param.type === 'TSParameterProperty') {
            const name = param.parameter.left?.name ?? param.parameter.name;
            if (name) {
              info.fields.set(name, param.accessibility === 'private' || !!param.readonly);
            }
          }
        }
        walk(member.body, (n) => {
          const name = thisAssignment(n);
          if (name && !info.fields.has(name)) {
            info.fields.set(name, false);
          }
        });
        continue;
      }
      if (member.kind === 'method' && memberName(member) === 'transferState') {
        info.hasTransferState = true;
      }
    }
    walk(member, (n) => {
      const name = thisAssignment(n);
      if (name) {
        info.mutatedOutsideCtor.add(name);
      }
    });
  }
  for (const name of info.mutatedOutsideCtor) {
    if (info.fields.has(name)) {
      info.fields.set(name, false);
    }
  }
  return info;
}

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIR.has(entry.name)) {
        yield* sourceFiles(full);
      }
    } else if (entry.name.endsWith('.ts') && !SKIP_FILE.test(entry.name)) {
      yield full;
    }
  }
}

function scanClasses(): Map<string, ClassInfo> {
  const result = new Map<string, ClassInfo>();
  for (const file of sourceFiles(__dirname)) {
    const ast = parse(fs.readFileSync(file, 'utf8'), {
      sourceType: 'module',
      plugins: ['typescript'],
    });
    for (const statement of ast.program.body) {
      const cls = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
      if (cls?.type === 'ClassDeclaration') {
        const info = analyzeClass(cls, file);
        result.set(info.name, info);
      }
    }
  }
  return result;
}

const CLASSES = scanClasses();

const EXEMPT: Record<string, string> = {
  // Saved by SimulationClock.transferState() through the alarm registry.
  ClockAlarm: 'alarm state is saved by its clock',
  RP2350OTPData: 'read-only window onto RP2350OTP.fuse',
  InterpolatorConfig: 'scratch, re-decoded from ctrl before every use',
  // Its only mutable field, rawWriteValue, is set and consumed within one MMIO write.
  BasePeripheral: 'no state of its own',
  USBCDC: 'consumer-owned, lives outside the chip',
  ConsoleLogger: 'host-side logger',
  SaveStateStream: 'the serializer itself',
  // Wiring only: they hold nothing but references to their owner.
  ADCSampleAlarm: 'wiring only',
  ADCMultiShotAlarm: 'wiring only',
  MtimecmpAlarmCallback: 'wiring only',
  SystickAlarmCallback: 'wiring only',
  PWMChannelAAlarmCallback: 'wiring only',
  PWMChannelBAlarmCallback: 'wiring only',
  PWMChannelBottomAlarmCallback: 'wiring only',
  Timer32PeriodicAlarmUpdateListener: 'wiring only',
};

// Classes still awaiting transferState(), per chip flavour. Each bucket must be empty
// before that flavour stops reporting SERIALIZATION_QUIRK_INCOMPLETE.
const PENDING = {
  rp2350Riscv: [],
  rp2350Arm: [],
  rp2040: [],
};

/* ------------------------------------------------------------------ */
/* Dynamic: perturb, restore, compare                                  */
/* ------------------------------------------------------------------ */

type Kind = 'number' | 'boolean' | 'bytes' | 'other';

interface Leaf {
  path: string;
  kind: Kind;
  value: any;
  parent: any;
  // Field within the owning (non-array) object; array elements read like `reg[3]`.
  key: string;
  // The property to read or write on `parent`: an index for array elements.
  prop: string;
  // Bytes that count for a typed array; -1 for all of it.
  limit: number;
  // `Class.field` with array indices dropped, for grouping a report.
  group: string;
  owners: string[];
}

interface Hashed {
  size: number;
  h1: number;
  h2: number;
}

type Captured = number | boolean | string | null | undefined | Hashed | Uint8Array;

interface Snapshot {
  leaves: Leaf[];
  values: Map<string, Captured>;
  paths: Map<string, Leaf>;
  aliases: string[];
  pendingComponents: string[];
  pendingClasses: string[];
}

interface Difference {
  path: string;
  group: string;
  before: Captured;
  after?: Captured;
  extra?: boolean;
}

// Not state: configuration the caller loaded, decode caches (dropped on restore and
// checked by their own test), and host-side objects or scratch re-derived before use.
const SKIP_PATHS = new Set([
  'chip.bootrom',
  'chip.sramDecode',
  'chip.flashDecode',
  'chip.psramDecode',
]);
const SKIP_CLASSES = new Set(['ConsoleLogger', 'InterpolatorConfig']);

// Deliberately not saved. Each entry carries its reason.
const CONSTANT_FIELDS: Record<string, string[]> = {
  // Set and consumed within a single MMIO write.
  BasePeripheral: ['rawWriteValue'],
  // Registry size and alarm identity: fixed by construction, and read by unserialize().
  SimulationClock: ['alarmCount', 'sealed'],
  ClockAlarm: ['id'],
  // A host-side timer handle from the old run() API that nothing sets any more.
  RPPIO: ['runTimer'],
  // Recomputed from reg[] by every PLL write; only used in a log line.
  RP2350PLL: ['foutpostdiv'],
};

// Construction wiring kept in plain objects, which the class rule cannot see.
const CONSTANT_PATHS = [
  /^chip\.(uart|spi)\[\d+\]\.dreq\.(rx|tx)$/,
  // Written by resolveIrqTarget() immediately before every read.
  /\.machines\[\d\]\.irqTargetScratch\.irqBit$/,
  // Out-parameters of the FPU and Thumb-32 helpers, refilled before every use.
  /\.core\[\d\]\.(otherCore\.)?(fpResultScratch|immCarryScratch|mul64Scratch)\./,
];

// Only part of these arrays is meaningful. Each entry returns the bytes that count,
// given the owning object and the element's index; 0 means none.
const BYTE_LIMIT: Record<string, (holder: any, index: number) => number> = {
  // USBEndpointAlarm's pool slots are scratch beyond their queued length.
  'USBEndpointAlarm.buffers': (alarm, index) =>
    index < alarm.bufferCount ? alarm.lengths[index] : 0,
};

// Saved through a narrower slot than the JS field: the restored value must equal the
// normalised captured one.
const NORMALIZE: Record<string, (v: number) => number> = {
  // The JS divider keeps a fractional quotient; the C build truncates to int32_t.
  'RPSIOCore.divQuotient': Math.trunc,
  'RPSIOCore.divRemainder': Math.trunc,
};

// Plain number fields whose live JS value can sit above 2^31 in either number form:
// the code writes them with a bitwise op (signed) in some places and with `>>> 0` or a
// typed-array read (unsigned) in others, so it cannot depend on their sign, and every
// use is a bitwise op, a typed-array store or a plain read-back. Only these may come
// back from a restore in the other form; anything else has to restore to the very same
// JS number. The stack pointers are written unsigned at reset and signed by MSR; the
// bootram and the MPU/SAU region registers hold whatever form the CPU stored.
// CortexM0Core.interruptPriorities starts from the unsigned 0xffffffff; the NVIC
// priority registers then rewrite it with `&=`/`|=`, which give signed results.
const BIT_PATTERN_FIELDS = new Set([
  'M33Registers.msp',
  'M33Registers.psp',
  'RPBootRAM.bootram',
  'CortexM0Core.interruptPriorities',
]);
const BIT_PATTERN_PATHS = [/\.(mpuRegions|sauRegions)\[\d\]\.(rbar|rlar)$/];

const DECODE_CACHES = ['sramDecode', 'flashDecode', 'psramDecode'];

const COPY_LIMIT = 4096;

function className(value: any): string {
  return value?.constructor?.name ?? '';
}

function isObject(value: any): boolean {
  return value !== null && typeof value === 'object' && !ArrayBuffer.isView(value);
}

function ownersOf(obj: any): string[] {
  const names: string[] = [];
  for (let proto = Object.getPrototypeOf(obj); proto; proto = Object.getPrototypeOf(proto)) {
    names.push(proto.constructor?.name ?? '');
  }
  return names;
}

function isConstant(leaf: Leaf): boolean {
  if (leaf.kind !== 'number' && leaf.kind !== 'boolean') {
    return false;
  }
  if (CONSTANT_PATHS.some((pattern) => pattern.test(leaf.path))) {
    return true;
  }
  for (const owner of leaf.owners) {
    if (CONSTANT_FIELDS[owner]?.includes(leaf.key)) {
      return true;
    }
    // private/readonly and never reassigned outside the constructor: fixed for life.
    if (CLASSES.get(owner)?.fields.get(leaf.key)) {
      return true;
    }
  }
  return false;
}

// The chip's direct children (through arrays and the address map) are component roots.
// Anything else reachable from one without passing through another belongs to it.
function componentRoots(chip: any): Map<unknown, string> {
  const roots = new Map<unknown, string>([[chip, 'chip']]);
  for (const key of Object.keys(chip)) {
    const value = chip[key];
    if (!isObject(value)) {
      continue;
    }
    roots.set(value, `chip.${key}`);
    if (Array.isArray(value) || className(value) === 'Object') {
      for (const inner of Object.keys(value)) {
        if (isObject(value[inner])) {
          roots.set(value[inner], `chip.${key}[${inner}]`);
        }
      }
    }
  }
  return roots;
}

// While a peripheral is pending, its whole interior is left alone, including helpers
// such as its timers and alarms that the clock's registry also points at.
function pendingInteriors(chip: any, pending: Set<string>) {
  const roots = componentRoots(chip);
  const excluded = new Set<unknown>();
  const reached: string[] = [];
  for (const [root, at] of roots) {
    if (root === chip || !pending.has(className(root))) {
      continue;
    }
    reached.push(at);
    const stack: unknown[] = [root];
    while (stack.length) {
      const current = stack.pop();
      if (current === undefined || excluded.has(current)) {
        continue;
      }
      excluded.add(current);
      for (const key of Object.keys(current as Record<string, unknown>)) {
        const value = (current as Record<string, unknown>)[key];
        if (isObject(value) && !roots.has(value)) {
          stack.push(value);
        }
      }
    }
  }
  return { excluded, reached: reached.sort() };
}

// Flash and PSRAM are not part of a state until something has written them, and a
// restore then leaves them as found. While unwritten, their bytes, and the change
// counts that guard a state which leaves them out, are the precondition of a restore
// rather than something it reproduces, so they are neither captured nor scrambled.
const IMAGE_FIELDS: Record<string, 'flash' | 'psram'> = {
  flash: 'flash',
  flash16: 'flash',
  flash32: 'flash',
  flashChanges: 'flash',
  psram: 'psram',
  psram16: 'psram',
  psram32: 'psram',
  psramChanges: 'psram',
};

function snapshot(chip: any, pending: Set<string>): Snapshot {
  const { excluded, reached } = pendingInteriors(chip, pending);
  const leftOutOfState = (owners: string[], key: string) => {
    if (owners[0] !== 'RP2350' && owners[0] !== 'RP2040') return false;
    const image = IMAGE_FIELDS[key];
    if (!image) return false;
    return image === 'flash' ? !chip.flashWritten : !chip.psramWritten;
  };
  const leaves: Leaf[] = [];
  const aliases: string[] = [];
  const seen = new Map<unknown, string>();
  const skipped = new Set<string>();
  // `field` is the key this object was reached under, relative to its non-array owner.
  const visit = (obj: any, at: string, owners: string[], field: string, holder: any) => {
    seen.set(obj, at);
    const array = Array.isArray(obj);
    const keys: string[] = array
      ? Array.from({ length: obj.length }, (_, i) => String(i))
      : Object.keys(obj);
    for (const key of keys) {
      // A hole in a sparse array: unserialize() may fill it with a default.
      if (array && !(key in obj)) {
        continue;
      }
      const value = obj[key];
      const name = className(value);
      const childKey = array ? `${field}[${key}]` : key;
      const path = array ? `${at}[${key}]` : `${at}.${key}`;
      if (typeof value === 'function' || SKIP_PATHS.has(path) || SKIP_CLASSES.has(name)) {
        continue;
      }
      if (isObject(value) && (excluded.has(value) || pending.has(name))) {
        if (pending.has(name)) {
          skipped.add(name);
        }
        continue;
      }
      if (ArrayBuffer.isView(value)) {
        // DataView fields are plain windows onto arrays saved under another name.
        if (!(value instanceof DataView)) {
          const limit = BYTE_LIMIT[`${owners[0]}.${field}`]?.(holder, Number(key)) ?? -1;
          if (limit !== 0 && !leftOutOfState(owners, key)) {
            leaves.push({
              path,
              kind: 'bytes',
              value,
              parent: obj,
              key: childKey,
              prop: key,
              group: `${owners[0]}.${field || key}`,
              owners,
              limit,
            });
          }
        }
        continue;
      }
      if (!isObject(value) && !leftOutOfState(owners, childKey)) {
        const kind: Kind =
          typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'other';
        const leaf: Leaf = {
          path,
          kind,
          value,
          parent: obj,
          key: childKey,
          prop: key,
          group: `${owners[0]}.${field || key}`,
          owners,
          limit: -1,
        };
        if (kind === 'other' || !isConstant(leaf)) {
          leaves.push(leaf);
        }
        continue;
      }
      if (value instanceof Map || value instanceof Set || value instanceof WeakMap) {
        throw new Error(`unsupported state container at ${path}`);
      }
      if (seen.has(value)) {
        aliases.push(`${path} = ${seen.get(value)}`);
        continue;
      }
      // An array belongs to the object it was reached from; keep that object's
      // class and the field name so leaves under it can be attributed and limited.
      visit(
        value,
        path,
        Array.isArray(value) ? owners : ownersOf(value),
        Array.isArray(value) ? key : '',
        Array.isArray(value) ? obj : value
      );
    }
  };
  visit(chip, 'chip', ownersOf(chip), '', chip);
  const paths = new Map<string, Leaf>();
  const values = new Map<string, Captured>();
  for (const leaf of leaves) {
    paths.set(leaf.path, leaf);
    values.set(
      leaf.path,
      leaf.kind === 'bytes' ? captureBytes(leaf.value, leaf.limit) : (leaf.value as Captured)
    );
  }
  return {
    leaves,
    values,
    paths,
    aliases: aliases.slice().sort(),
    pendingComponents: reached,
    pendingClasses: [...skipped].sort(),
  };
}

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function captureBytes(view: ArrayBufferView, limit: number): Captured {
  const bytes = limit < 0 ? bytesOf(view) : bytesOf(view).subarray(0, limit);
  if (bytes.byteLength <= COPY_LIMIT) {
    return bytes.slice();
  }
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < bytes.length; i++) {
    h1 = Math.imul(h1 ^ bytes[i], 0x01000193) >>> 0;
    h2 = (Math.imul(h2, 31) + bytes[i] + i) >>> 0;
  }
  return { size: bytes.byteLength, h1, h2 };
}

function perturb(leaves: Leaf[]) {
  for (const leaf of leaves) {
    switch (leaf.kind) {
      case 'number':
        leaf.parent[leaf.prop] =
          Number.isInteger(leaf.value) && Math.abs(leaf.value) < 0x80000000
            ? (Math.random() * 0x100000000) | 0
            : Math.random() * 0x100000000 + Math.random();
        break;
      case 'boolean':
        leaf.parent[leaf.prop] = !leaf.value;
        break;
      case 'bytes':
        randomFillSync(
          leaf.limit < 0 ? bytesOf(leaf.value) : bytesOf(leaf.value).subarray(0, leaf.limit)
        );
        break;
      default:
        break;
    }
  }
}

function show(value: Captured): string {
  if (value instanceof Uint8Array) {
    return `bytes[${value.byteLength}]`;
  }
  return value instanceof Object
    ? `bytes[${value.size}] #${value.h1.toString(16)}${value.h2.toString(16)}`
    : String(value);
}

function isHashed(value: Captured): value is Hashed {
  return typeof value === 'object' && value !== null;
}

function sameValue(before: Captured, after: Captured, leaf: Leaf | undefined): boolean {
  if (before instanceof Uint8Array || after instanceof Uint8Array) {
    return (
      before instanceof Uint8Array &&
      after instanceof Uint8Array &&
      before.length === after.length &&
      before.every((byte, i) => byte === after[i])
    );
  }
  if (isHashed(before) || isHashed(after)) {
    return (
      isHashed(before) &&
      isHashed(after) &&
      before.size === after.size &&
      before.h1 === after.h1 &&
      before.h2 === after.h2
    );
  }
  if (typeof before === 'number' && typeof after === 'number') {
    const normalize = leaf && NORMALIZE[`${leaf.owners[0]}.${leaf.key}`];
    if (normalize && after === normalize(before)) {
      return true;
    }
    // Plain number fields come back in their int32 form (see SaveStateStream.i32);
    // that is only acceptable for the fields listed as bit patterns.
    return (
      Object.is(before, after) ||
      (Number.isInteger(before) &&
        Number.isInteger(after) &&
        before >>> 0 === after >>> 0 &&
        !!leaf &&
        (BIT_PATTERN_FIELDS.has(leaf.group) || BIT_PATTERN_PATHS.some((p) => p.test(leaf.path))))
    );
  }
  return Object.is(before, after);
}

function diff(before: Snapshot, after: Snapshot): Difference[] {
  const result: Difference[] = [];
  for (const [at, value] of before.values) {
    const restored = after.values.get(at);
    if (restored === undefined || !sameValue(value, restored, before.paths.get(at))) {
      const leaf = before.paths.get(at) as Leaf;
      result.push({
        path: at,
        group: leaf.group,
        before: value,
        after: restored,
      });
    }
  }
  for (const [at, value] of after.values) {
    // Array elements are exempt: they may be holes that unserialize() filled in.
    if (!before.values.has(at) && !Array.isArray(after.paths.get(at)?.parent)) {
      const leaf = after.paths.get(at) as Leaf;
      result.push({ path: at, group: leaf.group, before: value, extra: true });
    }
  }
  return result;
}

// One line per class and field, with an example, so a failure reads as a to-do list.
function summarize(differences: Difference[]): string[] {
  const groups = new Map<string, { count: number; example: string }>();
  for (const d of differences) {
    const group = groups.get(d.group) ?? { count: 0, example: '' };
    group.count++;
    if (!group.example) {
      const after = d.extra
        ? 'appeared after restore'
        : d.after === undefined
        ? 'missing'
        : show(d.after);
      group.example = `${d.path}: ${show(d.before)} -> ${after}`;
    }
    groups.set(d.group, group);
  }
  return [...groups]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([key, group]) => `${key} x${group.count}, e.g. ${group.example}`);
}

function allZero(view: ArrayBufferView): boolean {
  const bytes = bytesOf(view);
  const chunk = 1 << 20;
  for (let at = 0; at < bytes.length; at += chunk) {
    if (!bytes.subarray(at, at + chunk).every((byte) => byte === 0)) {
      return false;
    }
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Flavours                                                            */
/* ------------------------------------------------------------------ */

interface Flavour {
  name: string;
  build: () => any;
  chip: () => { getSerializationQuirks(): number };
}

// Everything still awaiting transferState(), across all chips: none of it counts as
// checked state on any flavour until its own phase lands.
const ANY_PENDING = new Set([...PENDING.rp2350Riscv, ...PENDING.rp2350Arm, ...PENDING.rp2040]);

function blinkChip(): RP2350 {
  const chip = new RP2350();
  chip.logger = new ConsoleLogger(LogLevel.Error, true);
  chip.loadBootrom(bootrom_rp2350_A2);
  loadHex(fs.readFileSync('./demo/riscv_blink/blink_simple.hex', 'utf-8'), chip.sram, 0x20000000);
  chip.core0.pc = chip.core1.pc = 0x20000220;
  for (let i = 0; i < 100000; i++) {
    chip.step();
  }
  chip.sio.writeUint32(0x60, 100, 0);
  chip.sio.writeUint32(0x64, 7, 0);
  chip.sio.writeUint32(0x1b8, 500000, 0);
  chip.writeUint32(0x400b0000 + 0x10, chip.readUint32(0x400b0000 + 0x0c) + 5000);
  chip.writeUint32(0x40070000 + 0x24, 65);
  chip.writeUint32(0x400d8000 + 0x10, 0xdeadbeef);
  chip.gpio[7].setInputValue(true);
  chip.uart[0].feedByte(0x55);
  return chip;
}

function armBlinkChip(): RP2350 {
  const chip = new RP2350({ coreArch: 'arm' });
  chip.logger = new ConsoleLogger(LogLevel.Error, true);
  chip.loadFirmware('demo/m33_blink/blink_simple.hex');
  for (let i = 0; i < 100000; i++) {
    chip.step();
  }
  return chip;
}

function rp2040Chip(): RP2040 {
  const chip = new RP2040({ loadFirmware: 'demo/hello_serial_rp2040/hello_serial.hex' });
  chip.logger = new ConsoleLogger(LogLevel.Error, true);
  for (let i = 0; i < 100000; i++) {
    chip.step();
  }
  chip.sio.writeUint32(0x60, 100, 0);
  chip.sio.writeUint32(0x64, 7, 0);
  chip.writeUint32(0x40054000 + 0x10, chip.readUint32(0x40054000 + 0x0c) + 5000); // TIMER ALARM0
  chip.writeUint32(0x40034000 + 0x24, 65);
  chip.writeUint32(0x40058000 + 0x10, 0xdeadbeef); // WATCHDOG SCRATCH1
  chip.gpio[7].setInputValue(true);
  chip.uart[0].feedByte(0x55);
  return chip;
}

// Once written, flash and PSRAM are part of the state and get the full treatment. The
// two chips mark flash written differently: the RP2350 through the hook its QMI flash
// model reports to, the RP2040 through an ordinary store into the flash window.
function withWrittenImages(buildChip: () => RP2350 | RP2040) {
  return () => {
    const chip = buildChip();
    if (chip instanceof RP2350) {
      chip.writeUint32(0x15000000, 0x1234); // an ordinary store into PSRAM
      chip.invalidateFlashDecode(0x100, 4);
    } else {
      chip.writeUint32(0x10150000, 0x5a5a5a5a); // 0x150000 bytes into the flash image
    }
    return chip;
  };
}

const FLAVOURS: Flavour[] = [
  {
    name: 'RP2350 (RISC-V), flash and PSRAM unwritten',
    build: blinkChip,
    chip: () => new RP2350(),
  },
  {
    name: 'RP2350 (ARM), flash and PSRAM unwritten',
    build: armBlinkChip,
    chip: () => new RP2350({ coreArch: 'arm' }),
  },
  {
    name: 'RP2350 (RISC-V), flash and PSRAM written',
    build: withWrittenImages(blinkChip),
    chip: () => new RP2350(),
  },
  {
    name: 'RP2350 (ARM), flash and PSRAM written',
    build: withWrittenImages(armBlinkChip),
    chip: () => new RP2350({ coreArch: 'arm' }),
  },
  { name: 'RP2040, flash unwritten', build: rp2040Chip, chip: () => new RP2040() },
  { name: 'RP2040, flash written', build: withWrittenImages(rp2040Chip), chip: () => new RP2040() },
];

describe('save state coverage (static)', () => {
  const classes = CLASSES;
  const stateful = [...classes.values()].filter((c) => c.fields.size > 0);

  it('finds the emulator classes', () => {
    expect(classes.get('RP2350')?.hasTransferState).toBe(true);
    expect(classes.get('FIFO')?.fields.get('capacity')).toBe(true);
    expect(classes.get('RP2350')?.fields.get('isArmCore')).toBe(true);
    expect(classes.get('RP2350')?.fields.get('currentCore')).toBe(false);
    expect(classes.get('SimulationClock')?.fields.get('nanosCounter')).toBe(false);
  });

  it('classifies every class that holds state', () => {
    const listed = new Map<string, string>();
    const add = (name: string, label: string) => {
      expect(listed.has(name), `${name} is listed twice`).toBe(false);
      listed.set(name, label);
    };
    for (const name of Object.keys(EXEMPT)) {
      add(name, 'exempt');
    }
    for (const [bucket, names] of Object.entries(PENDING)) {
      for (const name of names) {
        add(name, `pending (${bucket})`);
      }
    }
    const problems: string[] = [];
    for (const info of stateful) {
      const covered = info.hasTransferState;
      const label = listed.get(info.name);
      if (covered && label) {
        problems.push(
          `${info.name} (${info.where}) has transferState() but is still listed: ${label}`
        );
      }
      if (!covered && !label) {
        problems.push(
          `${info.name} (${info.where}) has ${info.fields.size} field(s) but no transferState(), ` +
            'and is neither exempt nor pending'
        );
      }
    }
    for (const name of listed.keys()) {
      if (!stateful.some((c) => c.name === name)) {
        problems.push(`${name} is listed but holds no state`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('keeps every pending bucket empty once its chip is complete', () => {
    const complete = (chip: { getSerializationQuirks(): number }) =>
      (chip.getSerializationQuirks() & SERIALIZATION_QUIRK_INCOMPLETE) === 0;
    if (complete(new RP2350())) {
      expect(PENDING.rp2350Riscv, 'RP2350 (RISC-V) reports complete').toEqual([]);
    }
    if (complete(new RP2350({ coreArch: 'arm' }))) {
      expect(PENDING.rp2350Arm, 'RP2350 (ARM) reports complete').toEqual([]);
    }
    if (complete(new RP2040())) {
      expect(PENDING.rp2040, 'RP2040 reports complete').toEqual([]);
    }
  });
});

describe.each(FLAVOURS)('save state coverage: $name', ({ build, chip }) => {
  const isComplete = () => (chip().getSerializationQuirks() & SERIALIZATION_QUIRK_INCOMPLETE) === 0;

  it('does not report completeness while work is pending', () => {
    if (!isComplete()) {
      const { pendingComponents, pendingClasses } = snapshot(build(), ANY_PENDING);
      expect(pendingComponents.length + pendingClasses.length).toBeGreaterThan(0);
    }
  });

  it('serialize() and serializeSize() leave the chip untouched', () => {
    const mcu = build();
    const before = snapshot(mcu, ANY_PENDING);
    mcu.serializeSize();
    const data = new Uint8Array(mcu.serializeSize());
    expect(mcu.serialize(data, data.length)).toBe(true);
    expect(summarize(diff(before, snapshot(mcu, ANY_PENDING)))).toEqual([]);
  });

  it('unserialize() restores every mutable field', () => {
    const mcu = build();
    const before = snapshot(mcu, ANY_PENDING);
    // Nothing may be set aside as pending once the chip claims to be complete.
    if (isComplete()) {
      expect(before.pendingComponents).toEqual([]);
      expect(before.pendingClasses).toEqual([]);
    }
    const data = new Uint8Array(mcu.serializeSize());
    expect(mcu.serialize(data, data.length)).toBe(true);
    perturb(before.leaves);
    // Guard against a vacuous run: nearly every scalar must actually have changed.
    const scalars = before.leaves.filter((l) => l.kind === 'number' || l.kind === 'boolean').length;
    expect(diff(before, snapshot(mcu, ANY_PENDING)).length).toBeGreaterThan(scalars * 0.9);
    expect(mcu.unserialize(data, data.length)).toBe(true);
    const after = snapshot(mcu, ANY_PENDING);
    expect(summarize(diff(before, after))).toEqual([]);
    expect(after.aliases).toEqual(before.aliases);
  });

  it('drops only the decode caches of memory the state rewrote', () => {
    const mcu = build();
    if (mcu instanceof RP2040) return; // no fetch-decode caches: nothing to drop
    const data = new Uint8Array(mcu.serializeSize());
    expect(mcu.serialize(data, data.length)).toBe(true);
    for (const name of DECODE_CACHES) {
      randomFillSync(mcu[name]);
    }
    expect(mcu.unserialize(data, data.length)).toBe(true);
    if (mcu instanceof RP2040) return; // no fetch-decode caches
    // SRAM is always in the state.
    expect(allZero(mcu.sramDecode)).toBe(true);
    // A cache is keyed on memory content, so it is still valid for an image the state
    // left out, and stale for one it rewrote.
    expect(allZero(mcu.flashDecode)).toBe(mcu.flashWritten);
    expect(allZero(mcu.psramDecode)).toBe(mcu.psramWritten);
  });
});
