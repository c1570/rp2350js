/**
 * Full-app smoke test with a minimal DOM stub: boots demo/web/src/main.ts's flow
 * (invisible initial run, rewind to <main>), then exercises the UI — help popup,
 * step buttons (click, hold-to-repeat, keyboard), slider scrubbing, the GPIO24
 * button — and verifies the controls, windows and serial output react correctly.
 *
 * Run: npx ts-node --transpile-only demo/web/test/browser-stub-test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { Disassembly, findSymbolAddr, parseDisassembly } from '../src/disasm-cpu';
import { PREPARE_ESTIMATE } from '../src/ui';

// --- DOM stub -----------------------------------------------------------------
class StubElement {
  children: StubElement[] = [];
  listeners: Record<string, ((e?: unknown) => void)[]> = {};
  _text = '';
  _html = '';
  scrollTop = 0;
  scrollHeight = 100;
  clientHeight = 200;
  clientWidth = 800;
  offsetTop = 0;
  value = '';
  max = '1';
  disabled = false;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  classSet = new Set<string>();
  _qsel: Map<string, StubElement> | null = null;

  get classList() {
    const set = this.classSet;
    return {
      toggle: (cls: string, force?: boolean) => {
        const on = force === undefined ? !set.has(cls) : force;
        if (on) set.add(cls);
        else set.delete(cls);
        return on;
      },
      add: (...cls: string[]) => cls.forEach((c) => set.add(c)),
      remove: (...cls: string[]) => cls.forEach((c) => set.delete(c)),
    };
  }
  get textContent() {
    return this._text;
  }
  set textContent(v: string) {
    this._text = v;
    this.children = [];
  }
  get innerHTML() {
    return this._html;
  }
  set innerHTML(v: string) {
    this._html = v;
  }
  append(...kids: StubElement[]) {
    this.children.push(...kids);
  }
  addEventListener(type: string, fn: (e?: unknown) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  /** Dispatch a synthetic event; `props` become fields of the event object. */
  fire(type: string, props: Record<string, unknown> = {}) {
    const ev = { preventDefault: () => undefined, ...props };
    for (const fn of this.listeners[type] ?? []) fn(ev);
  }
  querySelector(sel: string): StubElement {
    // Cache per (element, selector) so repeated lookups return the same stub.
    this._qsel ??= new Map();
    let el = this._qsel.get(sel);
    if (!el) {
      el = new StubElement();
      this._qsel.set(sel, el);
    }
    return el;
  }
  setPointerCapture() {
    /* stub */
  }
  contains(_other: StubElement | null): boolean {
    return false; // the real DOM: true for self and descendants
  }
  getContext() {
    // 2D context stub: assigned properties (fillStyle, ...) are stored and read
    // back; everything else is a no-op method.
    const props: Record<string | symbol, unknown> = {};
    return new Proxy(props, {
      get: (target, prop) => (prop in target ? target[prop] : () => undefined),
      set: (target, prop, value) => {
        target[prop] = value;
        return true;
      },
    });
  }
}

const registry = new Map<string, StubElement>();
// Ids that exist in the served HTML or are created dynamically (slider, PCB SVG
// internals built from innerHTML strings). Anything else is a bug: the real
// browser would hand `querySelector` a null — fail loudly instead of masking it.
const htmlIds = new Set(
  [
    ...fs
      .readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8')
      .matchAll(/id="([^"]+)"/g),
  ].map((m) => `#${m[1]}`)
);
const dynamicIds = new Set(['#timeline', '#pcb svg', '#btn-gp24', '#btn-led', '#btn-gp24-halo']);
function bySelector(sel: string): StubElement {
  let el = registry.get(sel);
  if (!el) {
    if (!htmlIds.has(sel) && !dynamicIds.has(sel) && !/^#pad-\d+$/.test(sel)) {
      throw new Error(`stub test: unknown selector '${sel}' (not in index.html or dynamic set)`);
    }
    el = new StubElement();
    registry.set(sel, el);
  }
  return el;
}

const g = globalThis as unknown as Record<string, unknown>;
g.document = {
  getElementById: (id: string) => bySelector(`#${id}`),
  querySelector: (sel: string) => bySelector(sel),
  createElement: (_tag: string) => new StubElement(),
  addEventListener: (_type: string, _fn: (e?: unknown) => void) => {
    /* recorded nowhere: the test fires events on elements only */
  },
};
let clipboardText = '';
Object.defineProperty(g, 'navigator', {
  value: { clipboard: { writeText: async (text: string) => void (clipboardText = text) } },
  configurable: true,
  writable: true,
});
const t0 = Date.now();
g.performance = { now: () => Date.now() - t0 }; // real time: budgets in runFor() trip normally
const windowListeners: Record<string, ((e?: unknown) => void)[]> = {};
let narrowScreen = true; // what window.matchMedia reports for the narrow-screen query
g.window = {
  devicePixelRatio: 1,
  matchMedia: (_query: string) => ({ matches: narrowScreen }),
  addEventListener: (type: string, fn: (e?: unknown) => void) => {
    (windowListeners[type] ??= []).push(fn);
  },
  removeEventListener: (type: string, fn: (e?: unknown) => void) => {
    const list = windowListeners[type] ?? [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  },
};
// MessageChannel stub (main.ts's prep work loop): posted messages queue the
// receiving port's onmessage like a browser task; runTasks() drains the queue.
const taskQueue: (() => void)[] = [];
class StubPort {
  onmessage: ((e: unknown) => void) | null = null;
  peer!: StubPort;
  postMessage() {
    taskQueue.push(() => this.peer.onmessage?.({ data: null }));
  }
}
g.MessageChannel = class {
  port1 = new StubPort();
  port2 = new StubPort();
  constructor() {
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
};
const publicDir = path.join(__dirname, '..', 'public');
g.fetch = async (url: string) => {
  const file = path.join(publicDir, String(url).replace(/^\/+/, ''));
  return { ok: fs.existsSync(file), text: async () => fs.readFileSync(file, 'utf-8') };
};
g.console = console;

// --- run the app ---------------------------------------------------------------
let failures = 0;
const check = (cond: boolean, what: string) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${what}`);
  if (!cond) failures++;
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../src/main');

/** Run up to n queued tasks (one work chunk each, like one browser task). */
function runTasks(n: number): void {
  for (let i = 0; i < n && taskQueue.length > 0; i++) {
    taskQueue.shift()!();
  }
}

const transport = () => bySelector('#transport');
const button = (i: number) => transport().children[i];
// created with createElement('input') — only reachable as the timeline row's child
const slider = () => bySelector('#timeline-row').children[0];
const serial = () => bySelector('#serial').textContent as string;
const pcOf = (label: string) => /PC=0x([0-9a-f]+)/.exec(bySelector(label).textContent)?.[1];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await sleep(0); // let boot() fetch and construct the UI

  check(!bySelector('#app').textContent.includes('boot failed'), 'boot succeeded');
  check(
    bySelector('#cpu-code').children.length > 100,
    `CPU listing rendered (${bySelector('#cpu-code').children.length} lines)`
  );
  check(transport().children.length === 7, 'transport: help + 6 step buttons (no play)');

  const helpBtn = button(0);
  check(helpBtn.classSet.has('blink'), 'help button breathes on initial load');
  helpBtn.fire('click', { detail: 1 });
  check(bySelector('#help-overlay').classSet.has('open'), 'help button opens the popup');
  bySelector('#help-overlay').querySelector('#help-close').fire('click', { detail: 1 });
  check(!bySelector('#help-overlay').classSet.has('open'), 'help close button hides the popup');
  check(!helpBtn.classSet.has('blink'), 'help button stops breathing after being pressed');

  // while the timeline is prepared the controls are disabled and the GPIO24
  // button ignores clicks; the progress note reads differently on narrow screens
  const btn = bySelector('#pcb svg').querySelector('#btn-gp24');
  const btnCompact = bySelector('#btn-gp24-compact');
  const prepareLabel = () => bySelector('#prepare-label').textContent as string;
  runTasks(3); // boot() ran with narrowScreen = true: the note must say so from the start
  check(slider().disabled && button(1).disabled, 'controls disabled while preparing');
  check(
    /^Better viewed on desktop\.\.\. \d+%$/.test(prepareLabel()),
    `narrow screens: desktop hint as the progress note (${prepareLabel()})`
  );
  check(
    bySelector('#timeline-row').classSet.has('preparing'),
    'timeline row flagged while preparing (hides the compact button)'
  );
  btn.fire('click', { detail: 1 });
  check(!btn.classSet.has('pressed'), 'GPIO24 click ignored while preparing');
  narrowScreen = false;
  await sleep(1100); // the note updates at most once per second
  runTasks(1);
  check(
    /^preparing timeline… \d+%$/.test(prepareLabel()),
    `desktop: normal progress note (${prepareLabel()})`
  );

  // the invisible initial run prepares the whole timeline, then rewinds to
  // the cycle at which core0 enters <main>
  runTasks(2000);
  check(!slider().disabled && !button(1).disabled, 'controls enabled once prepared');
  check(slider().max === String(PREPARE_ESTIMATE), 'slider shows the full range from the start');
  const startCycle = Number(slider().value);
  check(
    startCycle > 100_000 && startCycle < 1_000_000,
    `rewound to the <main> anchor (slider: ${startCycle})`
  );
  check(startCycle < Number(slider().max), 'slider sits at the anchor, not the end');

  // the anchor is exactly <main>: compute its address from the .dis annotations
  const disText = fs.readFileSync(path.join(publicDir, 'webfirmware.dis'), 'utf-8');
  const mainAddr = findSymbolAddr(disText, 'main');
  const readyPc = pcOf('#cpu-pc');
  check(
    readyPc !== undefined && readyPc === mainAddr?.toString(16),
    `rewind anchor PC is <main> (pc=${readyPc}, main=0x${mainAddr?.toString(16)})`
  );

  // GPIO24 breathing starts once the timeline is ready; serial is truncated at the anchor
  check(
    slider().classSet.has('blink') &&
      !btn.classSet.has('blink') &&
      !btnCompact.classSet.has('blink'),
    'initially the slider glows and the GPIO24 button does not'
  );
  check(!bySelector('#timeline-row').classSet.has('preparing'), 'timeline row no longer flagged');
  check(!serial().includes('END OF OUTPUT'), 'serial log is truncated at the anchor');
  check(!serial().includes('button=PRESSED'), 'ignored GPIO24 click left the run untouched');

  // step buttons (children: help, ⏪1000, ⏪10, ⏪1, ⏩1, ⏩10, ⏩1000) — a mouse
  // click is pointerdown (+ pointerup, click); the action fires on pointerdown
  const mouseClick = (b: StubElement) => {
    b.fire('pointerdown', { pointerId: 1 });
    windowListeners.pointerup?.forEach((fn) => fn({}));
    b.fire('click', { detail: 1 }); // the browser's follow-up click: ignored
  };
  mouseClick(button(1)); // ⏪1000
  check(
    slider().value === String(startCycle - 1000),
    `back 1000 cycles (slider: ${slider().value})`
  );
  mouseClick(button(4)); // ⏩1
  check(slider().value === String(startCycle - 999), `forward 1 cycle (slider: ${slider().value})`);
  button(5).fire('click', { detail: 0 }); // keyboard activation (Enter/Space) acts once
  check(
    slider().value === String(startCycle - 989),
    `keyboard step +10 (slider: ${slider().value})`
  );

  // scrub: 'input' updates the view without moving the chip state; 'change'
  // (release) performs the exact seek
  slider().value = '1200000';
  slider().fire('input');
  check(slider().value === '1200000', `scrub input keeps the thumb (slider: ${slider().value})`);
  check(
    !slider().classSet.has('blink') &&
      btn.classSet.has('blink') &&
      bySelector('#pcb svg').querySelector('#btn-gp24-halo').classSet.has('blink') &&
      btnCompact.classSet.has('blink') &&
      bySelector('#btn-gp24-compact-glow').classSet.has('blink'),
    'once the slider has been moved, the GPIO24 button glows instead (both renderings, halos too)'
  );
  slider().value = '1100000';
  slider().fire('change');
  check(slider().value === '1100000', `scrub release seeks exactly (slider: ${slider().value})`);

  // CPU highlights must track the live PCs (dis binary-search regression)
  const dis: Disassembly = parseDisassembly(disText);
  for (const [codeSel, pcLabel, hl, core] of [
    ['#cpu-code', '#cpu-pc', 'hl-core0', 'core0'],
    ['#cpu1-code', '#cpu1-pc', 'hl-core1', 'core1'],
  ] as const) {
    const pc = pcOf(pcLabel);
    const hlEls = bySelector(codeSel).children.filter((el) => el.classSet.has(hl));
    check(
      hlEls.length === 1 && pc !== undefined && hlEls[0].textContent.trim().startsWith(pc + ':'),
      `${core} highlight at live PC (pc=${pc}, line="${hlEls[0]?.textContent.slice(0, 24).trim()}")`
    );
    check(
      pc !== undefined && dis.lineIndexForPc(parseInt(pc, 16)) >= 0,
      `${core} PC maps to a listing line`
    );
  }

  check(
    bySelector('#pio-state').textContent.includes('sm_cycles='),
    'PIO state line includes live sm_cycles counter'
  );

  // click a lane in the analyzer: a popover describes the GPIO at that cycle
  // (canvas stub: 800x200; one lane = 200/17 px below the ruler row)
  const canvas = bySelector('#analyzer-canvas-wrap').children[0];
  const laneY = (lane: number) => (200 / 17) * (lane + 1.5);
  const popover = bySelector('#analyzer-popover');
  const popoverText = () => bySelector('#analyzer-popover-text').textContent as string;
  const gp2High = bySelector('#pcb svg').querySelector('#pad-2').classSet.has('hi-pio');
  canvas.fire('click', { offsetX: 400, offsetY: laneY(0), detail: 1 }); // GPIO2, current cycle
  const text = popoverText();
  check(
    popover.classSet.has('open') &&
      new RegExp(`^GPIO2 is ${gp2High ? 'HIGH' : 'LOW'} at cycle 1100000\\. `).test(text),
    `analyzer click describes the clicked lane/cycle, level matches the live pad (${text})`
  );
  const edgeCycles = [...text.matchAll(/edge at cycle (\d+)/g)].map((m) => Number(m[1]));
  check(
    edgeCycles.length >= 2 && edgeCycles.every((c) => Math.abs(c - 1_100_000) <= 100),
    `nearest edges bracket the cycle (${text})`
  );
  canvas.fire('click', { offsetX: 100, offsetY: laneY(7), detail: 1 }); // GPIO9, 125 cycles (100px / 0.8px) left of center
  check(
    /^GPIO9 is (HIGH|LOW) at cycle 1099625\./.test(popoverText()),
    `lane 7 is GPIO9, x maps to the cycle (${popoverText()})`
  );
  canvas.fire('click', { offsetX: 100, offsetY: laneY(8), detail: 1 }); // first core1 lane
  check(popoverText().startsWith('GPIO16 is '), `lane 8 is GPIO16 (${popoverText()})`);

  bySelector('#analyzer-popover-copy').fire('click', { detail: 1 });
  await sleep(0);
  check(
    clipboardText === popoverText() && bySelector('#analyzer-popover-copy').classSet.has('copied'),
    'copy button copies the popover text'
  );
  canvas.fire('click', { offsetX: 400, offsetY: 2, detail: 1 }); // ruler row: no lane
  check(!popover.classSet.has('open'), 'clicking the ruler closes the popover');
  canvas.fire('click', { offsetX: 400, offsetY: laneY(0), detail: 1 });
  check(popover.classSet.has('open'), 'clicking a lane reopens it');

  // seek to the end of the slider: the seek clamps to the finish cycle, where
  // the full serial output exists
  slider().value = slider().max;
  slider().fire('change');
  const finishCycle = slider().value;
  check(
    /^\d+$/.test(finishCycle) &&
      Number(finishCycle) > 5_000_000 &&
      Number(finishCycle) < PREPARE_ESTIMATE,
    `seek past the end lands on the finish cycle (${finishCycle})`
  );
  check(serial().includes('END OF OUTPUT'), 'serial at the end contains the sentinel');
  check(serial().includes('status 10/10'), 'all 10 status lines printed');

  // forward at the very end of a finished timeline has nothing left to do
  mouseClick(button(6)); // ⏩1000 at the finish
  check(
    slider().value === finishCycle,
    `forward at the end stays at the finish (slider: ${slider().value})`
  );

  // drag the slider to an early position (change event = seek)
  slider().value = '1000000';
  slider().fire('change');
  check(slider().value === '1000000', `slider seek to 1M (slider: ${slider().value})`);

  // toggle GPIO24 here (via the compact button): the recorded future is dropped,
  // and both renderings of the button show the same state
  btnCompact.fire('click', { detail: 1 });
  check(
    btn.classSet.has('pressed') &&
      btnCompact.classSet.has('pressed') &&
      !btn.classSet.has('blink') &&
      !btnCompact.classSet.has('blink') &&
      !bySelector('#pcb svg').querySelector('#btn-gp24-halo').classSet.has('blink') &&
      !bySelector('#btn-gp24-compact-glow').classSet.has('blink'),
    'GPIO24 press registered on both renderings (glow off)'
  );

  // forward without a recorded future extends time (plays n cycles, stops)
  mouseClick(button(6)); // ⏩1000 beyond the old frontier
  check(
    slider().value === '1001000',
    `forward extends beyond the invalidated future (slider: ${slider().value})`
  );

  // hold-to-repeat: pointerdown fires once, holding >300ms repeats (~5/s),
  // and the follow-up click is ignored so nothing double-fires
  slider().value = '1000000';
  slider().fire('change');
  const holdBefore = Number(slider().value);
  const fwd1 = button(4); // ⏩1
  fwd1.fire('pointerdown', { pointerId: 1 });
  await sleep(550); // down + ~2 repeats
  windowListeners.pointerup?.forEach((fn) => fn({}));
  await sleep(250); // released: no further repeats
  fwd1.fire('click', { detail: 1 });
  const holdDelta = Number(slider().value) - holdBefore;
  check(holdDelta >= 2 && holdDelta <= 5, `hold-to-repeat advanced (delta: ${holdDelta})`);

  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
