/**
 * UI: transport controls + timeline slider, CPU/PIO code windows, serial window,
 * logic-analyzer canvas and the stylized PCB.
 *
 * Everything is event-driven: the timeline only moves through user actions, and
 * every action redraws what it changed (afterAction()). There is no idle frame
 * loop once the timeline is prepared.
 */
import { RP2350 } from '../../../src/rp2350';
import { WaitType } from '../../../src/peripherals/pio';
import {
  Analyzer,
  analyzerHitTest,
  analyzerLayout,
  describeSample,
  drawAnalyzer,
  VIEW_WINDOW,
} from './analyzer';
import { Disassembly, parseDisassembly } from './disasm-cpu';
import { disassemblePioMemory } from './disasm-pio';
import { PcbView } from './pcb';
import { Runner } from './runner';

/** Rough full-run length: the slider range from page load and the progress percentage. */
export const PREPARE_ESTIMATE = 20_000_000;

/** While dragging, the chip catches up at most this often (the view follows instantly). */
const SCRUB_SEEK_MS = 500;
/** Narrow-screen layout (phones): no PCB, the compact GPIO24 button next to the slider. */
const NARROW_QUERY = '(max-width: 700px)'; // keep in sync with style.css

export class UI {
  private readonly slider: HTMLInputElement;
  private readonly backBtns: HTMLButtonElement[] = [];
  private readonly fwdBtns: HTMLButtonElement[] = [];
  private readonly serialPre: HTMLPreElement;
  private readonly cpuWrap: HTMLElement;
  private readonly cpu1Wrap: HTMLElement;
  private readonly pioWrap: HTMLElement;
  private readonly cpuLines: HTMLDivElement[] = [];
  private readonly cpu1Lines: HTMLDivElement[] = [];
  private readonly cpuPcLabel: HTMLElement;
  private readonly cpu1PcLabel: HTMLElement;
  private readonly pioStateLabel: HTMLElement;
  private readonly analyzerCanvas: HTMLCanvasElement;
  private readonly pcb: PcbView;
  private readonly prepareLabel: HTMLElement;
  private readonly timelineRow: HTMLElement;
  private dis: Disassembly | null = null;
  private lastCore0Line = -1;
  private lastCore1Line = -1;
  private lastPioPc = -1;
  private pioInstrCache = new Uint32Array(32);
  /** True while the invisible initial run prepares the full timeline. */
  private preparing = false;
  /** Hint hand-off: the slider glows until first moved, then the GPIO24 button does. */
  private sliderMoved = false;
  private lastPrepareUpdate = 0;
  /** Drag state: the analyzer is centered on `scrubCycle` while the chip catches up. */
  private scrubbing = false;
  private scrubCycle: number | null = null;
  private scrubTimer: ReturnType<typeof setTimeout> | null = null;
  private lastScrubSeek = 0;
  /** Sample popover: text + copy button for the lane/cycle last clicked in the analyzer. */
  private readonly samplePopover: HTMLElement;
  private readonly samplePopoverText: HTMLElement;
  private readonly samplePopoverCopy: HTMLButtonElement;
  private sampleText = '';

  constructor(
    private readonly chip: RP2350,
    private readonly runner: Runner,
    private readonly analyzer: Analyzer
  ) {
    this.pcb = new PcbView(document.querySelector('#pcb svg') as unknown as SVGSVGElement);
    this.pcb.onButtonToggle = (pressed) => {
      this.afterAction(() => {
        this.runner.setButton(pressed);
        this.runner.invalidateFuture();
      });
    };
    this.analyzerCanvas = document.createElement('canvas');
    this.analyzerCanvas.className = 'analyzer-canvas';
    document.getElementById('analyzer-canvas-wrap')!.append(this.analyzerCanvas);

    this.timelineRow = document.getElementById('timeline-row')!;
    this.prepareLabel = document.querySelector('#prepare-label')!;
    this.pcb.registerButton(document.querySelector('#btn-gp24-compact') as unknown as SVGGElement, {
      halo: document.querySelector('#btn-gp24-compact-glow') as unknown as SVGCircleElement,
    });
    this.slider = document.createElement('input');
    this.slider.id = 'timeline';
    this.slider.type = 'range';
    this.slider.min = '0';
    this.slider.max = String(PREPARE_ESTIMATE); // full range from the very start
    this.slider.step = '1';
    this.slider.value = '0';
    this.serialPre = document.querySelector('#serial') as HTMLPreElement;
    this.cpuWrap = document.querySelector('#cpu-code')!;
    this.cpu1Wrap = document.querySelector('#cpu1-code')!;
    this.pioWrap = document.querySelector('#pio-code')!;
    this.cpuPcLabel = document.querySelector('#cpu-pc')!;
    this.cpu1PcLabel = document.querySelector('#cpu1-pc')!;
    this.pioStateLabel = document.querySelector('#pio-state')!;

    this.buildTransport();
    this.buildHelp();
    this.buildSlider();
    this.samplePopover = document.getElementById('analyzer-popover')!;
    this.samplePopoverText = document.querySelector('#analyzer-popover-text')!;
    this.samplePopoverCopy = document.querySelector('#analyzer-popover-copy') as HTMLButtonElement;
    this.buildSamplePopover();
    document.getElementById('timeline-row')!.append(this.slider);
    window.addEventListener('resize', () => this.updateViews());
  }

  // --- construction -----------------------------------------------------------

  private buildTransport(): void {
    const transport = document.getElementById('transport')!;
    const helpBtn = document.createElement('button');
    helpBtn.textContent = '? help';
    helpBtn.classList.add('help-btn', 'blink'); // breathe until first used
    helpBtn.addEventListener('click', () => {
      helpBtn.classList.remove('blink');
      document.getElementById('help-overlay')!.classList.add('open');
    });
    transport.append(helpBtn);

    // ⏪1000 ⏪10 ⏪1 ⏩1 ⏩10 ⏩1000: seek by exactly n cycles (hold to repeat).
    for (const n of [-1000, -10, -1, 1, 10, 1000]) {
      const btn = document.createElement('button');
      btn.textContent = n < 0 ? `⏪${-n}` : `⏩${n}`;
      this.attachAutoRepeat(btn, () =>
        this.afterAction(() => this.runner.seek(this.runner.cycle + n))
      );
      transport.append(btn);
      (n < 0 ? this.backBtns : this.fwdBtns).push(btn);
    }
  }

  private buildHelp(): void {
    const helpOverlay = document.getElementById('help-overlay')!;
    helpOverlay.querySelector('#help-close')!.addEventListener('click', () => {
      helpOverlay.classList.remove('open');
    });
    helpOverlay.addEventListener('click', (e) => {
      if (e.target === helpOverlay) helpOverlay.classList.remove('open');
    });
  }

  /** Click in the analyzer: describe the lane/cycle under the pointer. */
  private buildSamplePopover(): void {
    this.analyzerCanvas.addEventListener('click', (e) => {
      const { offsetX, offsetY } = e as MouseEvent;
      const hit = analyzerHitTest(
        analyzerLayout(this.analyzerCanvas, this.analyzerCenter, VIEW_WINDOW),
        offsetX,
        offsetY
      );
      if (!hit) {
        this.hideSamplePopover();
        return;
      }
      this.sampleText = describeSample(this.analyzer, hit.lane, hit.cycle);
      this.samplePopoverText.textContent = this.sampleText;
      this.samplePopover.classList.add('open');
      // Above the click (below it when that would leave the panel), inside the wrap.
      const wrap = document.getElementById('analyzer-wrap')!;
      const w = this.samplePopover.offsetWidth || 0;
      const h = this.samplePopover.offsetHeight || 0;
      const x = offsetX + this.analyzerCanvas.offsetLeft;
      const y = offsetY + this.analyzerCanvas.offsetTop;
      this.samplePopover.style.left = `${Math.max(
        4,
        Math.min(x - w / 2, wrap.clientWidth - w - 4)
      )}px`;
      this.samplePopover.style.top = `${y - h - 8 >= 4 ? y - h - 8 : y + 12}px`;
    });
    this.samplePopoverCopy.addEventListener('click', () => this.copySampleText());
    document.addEventListener('click', (e) => {
      if (e.target !== this.analyzerCanvas && !this.samplePopover.contains(e.target as Node)) {
        this.hideSamplePopover();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hideSamplePopover();
    });
  }

  private hideSamplePopover(): void {
    this.samplePopover.classList.remove('open');
  }

  private async copySampleText(): Promise<void> {
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(this.sampleText);
      } else {
        legacyCopy(this.sampleText); // non-secure context (not localhost/https)
      }
    } catch (err) {
      console.error('clipboard write failed', err);
      return;
    }
    this.samplePopoverCopy.classList.add('copied');
    this.samplePopoverCopy.title = 'Copied';
    setTimeout(() => {
      this.samplePopoverCopy.classList.remove('copied');
      this.samplePopoverCopy.title = 'Copy to clipboard';
    }, 1200);
  }

  private buildSlider(): void {
    // Drag: the view follows the thumb immediately (drawn from retained
    // samples); the chip catches up at most once per SCRUB_SEEK_MS, and
    // exactly on release (the `change` event).
    this.slider.addEventListener('input', () => {
      if (this.preparing) return;
      this.handOffHint();
      const target = this.sliderTarget();
      this.scrubbing = true;
      this.scrubCycle = target;
      this.updateViews();
      this.seekSoon(target);
    });
    this.slider.addEventListener('change', () => {
      if (this.preparing) return;
      this.handOffHint();
      this.scrubbing = false; // before the seek: refresh() syncs the thumb (e.g. clamped to the finish)
      this.scrubCycle = null;
      this.seekNow(this.sliderTarget(), performance.now()); // also cancels a pending trailing seek
    });
  }

  /**
   * Hold-to-repeat: the action fires on pointerdown and, if the button is held
   * longer than 300 ms, repeats at ~5 per second until the pointer is released.
   * The browser's follow-up `click` (detail ≥ 1) is ignored — pointerdown already
   * acted; keyboard activation (`click` with detail 0) runs the action once.
   */
  private attachAutoRepeat(btn: HTMLButtonElement, action: () => void): void {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let interval: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timeout !== null) clearTimeout(timeout);
      if (interval !== null) clearInterval(interval);
      timeout = interval = null;
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
    btn.addEventListener('pointerdown', () => {
      if (btn.disabled) return;
      action();
      timeout = setTimeout(() => {
        interval = setInterval(() => (btn.disabled ? stop() : action()), 200);
      }, 300);
      window.addEventListener('pointerup', stop);
      window.addEventListener('pointercancel', stop);
    });
    btn.addEventListener('click', (e) => {
      if (e.detail === 0) action();
    });
  }

  // --- preparation phase ------------------------------------------------------

  /** Disable every control while the invisible initial run prepares the timeline. */
  beginPrepare(): void {
    this.preparing = true;
    this.slider.disabled = true;
    this.timelineRow.classList.add('preparing');
    this.pcb.enabled = false;
    for (const b of [...this.backBtns, ...this.fwdBtns]) b.disabled = true;
    this.setPrepareNote(0);
  }

  /** Progress note, updated at most once per second. */
  prepareProgress(cycle: number): void {
    const now = performance.now();
    if (now - this.lastPrepareUpdate < 1000) return;
    this.lastPrepareUpdate = now;
    this.setPrepareNote(cycle);
  }

  /** On narrow screens the note doubles as a hint that the demo is best viewed on desktop. */
  private setPrepareNote(cycle: number): void {
    const pct = Math.min(99, Math.floor((cycle / PREPARE_ESTIMATE) * 100));
    this.prepareLabel.textContent = window.matchMedia(NARROW_QUERY).matches
      ? `Better viewed on desktop... ${pct}%`
      : `preparing timeline… ${pct}%`;
  }

  /** The timeline is ready: enable the controls, show the rewound state, hint the GPIO24 button. */
  endPrepare(): void {
    this.preparing = false;
    this.slider.disabled = false;
    this.timelineRow.classList.remove('preparing');
    this.pcb.enabled = true;
    this.prepareLabel.textContent = '';
    this.slider.classList.add('blink'); // first hint: the timeline; GPIO24 follows once it was moved
    this.refresh();
    this.updateViews();
  }

  // --- data wiring ------------------------------------------------------------

  setDisassembly(text: string): void {
    this.dis = parseDisassembly(text);
    for (const wrap of [this.cpuWrap, this.cpu1Wrap]) wrap.textContent = '';
    this.cpuLines.length = 0;
    this.cpu1Lines.length = 0;
    for (const line of this.dis.lines) {
      const el0 = document.createElement('div');
      el0.className = 'code-line';
      el0.textContent = line || ' ';
      this.cpuWrap.append(el0);
      this.cpuLines.push(el0);
      const el1 = document.createElement('div');
      el1.className = 'code-line';
      el1.textContent = line || ' ';
      this.cpu1Wrap.append(el1);
      this.cpu1Lines.push(el1);
    }
  }

  /** Re-decode the PIO instruction memory when it changes (the firmware loads it at runtime). */
  private updatePioListing(): void {
    const pio = this.chip.pio[0];
    const instr = pio.instructions;
    if (instr.every((v, i) => v === this.pioInstrCache[i])) return;
    this.pioInstrCache.set(instr);

    const sm = pio.machines[0];
    const listing = disassemblePioMemory(instr, {
      sideEn: !!(sm.execCtrl & (1 << 12)),
      sideCount: (sm.execCtrl >>> 8) & 0xf,
    });
    this.pioWrap.textContent = '';
    for (const line of listing) {
      const el = document.createElement('div');
      el.className = 'code-line';
      el.textContent = line;
      this.pioWrap.append(el);
    }
  }

  private scrollToCenter(wrap: HTMLElement, el: HTMLElement): void {
    // Keep the current instruction pinned at the vertical middle of the window.
    wrap.scrollTop = el.offsetTop - (wrap.clientHeight - el.clientHeight) / 2;
  }

  /** Toggle the highlight of one code window to the line of `pc`; returns the new line. */
  private highlightCore(
    dis: Disassembly,
    pc: number,
    lines: HTMLDivElement[],
    wrap: HTMLElement,
    className: string,
    lastLine: number
  ): number {
    const line = dis.lineIndexForPc(pc);
    for (let i = 0; i < lines.length; i++) {
      lines[i].classList.toggle(className, i === line);
    }
    if (line >= 0 && line !== lastLine) this.scrollToCenter(wrap, lines[line]);
    return line;
  }

  // --- user actions -----------------------------------------------------------

  /** Run a timeline-moving action, then redraw the controls and the views. */
  private afterAction(action: () => void): void {
    action();
    this.refresh();
    this.updateViews();
  }

  /** Slider position as a seek target (the timeline ends at the finish cycle). */
  private sliderTarget(): number {
    const target = parseInt(this.slider.value, 10);
    return this.runner.finishedCycle !== null
      ? Math.min(target, this.runner.finishedCycle)
      : target;
  }

  /** The slider was moved: its glow gives way to the GPIO24 button's. */
  private handOffHint(): void {
    if (this.sliderMoved) return;
    this.sliderMoved = true;
    this.slider.classList.remove('blink');
    this.pcb.startBlink();
  }

  /** Chip catch-up while dragging: at most once per SCRUB_SEEK_MS, exactly on release. */
  private seekSoon(target: number): void {
    const now = performance.now();
    if (now - this.lastScrubSeek >= SCRUB_SEEK_MS) {
      this.seekNow(target, now);
      return;
    }
    if (this.scrubTimer !== null) clearTimeout(this.scrubTimer);
    this.scrubTimer = setTimeout(
      () => this.seekNow(target, performance.now()),
      SCRUB_SEEK_MS - (now - this.lastScrubSeek)
    );
  }

  private seekNow(target: number, now: number): void {
    if (this.scrubTimer !== null) {
      clearTimeout(this.scrubTimer);
      this.scrubTimer = null;
    }
    this.lastScrubSeek = now;
    this.afterAction(() => this.runner.seek(target));
  }

  // --- drawing ----------------------------------------------------------------

  /** Enable/disable the controls and sync the slider (the thumb is the user's while dragging). */
  refresh(): void {
    if (this.preparing) return;
    const r = this.runner;
    const atEnd = r.finishedCycle !== null && r.cycle >= r.finishedCycle;
    for (const b of this.backBtns) b.disabled = r.cycle <= 0;
    // Forward always works (it plays n cycles); only at the end of a finished
    // timeline is there nothing left.
    for (const b of this.fwdBtns) b.disabled = atEnd;
    this.slider.max = String(Math.max(PREPARE_ESTIMATE, r.finishedCycle ?? 0));
    if (!this.scrubbing) this.slider.value = String(r.cycle);
  }

  /** While scrubbing, the analyzer is centered on the drag position (drawn from
   * retained samples — no chip involvement); everything else reflects the chip's
   * last seeked state. */
  private get analyzerCenter(): number {
    return this.scrubCycle ?? this.runner.cycle;
  }

  updateViews(): void {
    const chip = this.chip;

    this.updatePioListing();

    // CPU code windows: highlight each core's live PC and keep it centered
    if (this.dis) {
      const pc0 = chip.core[0].PC >>> 0;
      const pc1 = chip.core[1].PC >>> 0;
      this.lastCore0Line = this.highlightCore(
        this.dis,
        pc0,
        this.cpuLines,
        this.cpuWrap,
        'hl-core0',
        this.lastCore0Line
      );
      this.lastCore1Line = this.highlightCore(
        this.dis,
        pc1,
        this.cpu1Lines,
        this.cpu1Wrap,
        'hl-core1',
        this.lastCore1Line
      );
      this.cpuPcLabel.textContent = pcLabel(pc0, chip.core[0].cycles);
      this.cpu1PcLabel.textContent = pcLabel(pc1, chip.core[1].cycles);
    }

    // PIO window
    const sm = chip.pio[0].machines[0];
    const rows = this.pioWrap.children;
    for (let i = 0; i < rows.length; i++) {
      (rows[i] as HTMLElement).classList.toggle('hl-core0', i === sm.pc);
    }
    const pcRowEl = rows[sm.pc] as HTMLElement | undefined;
    if (pcRowEl && sm.pc !== this.lastPioPc) {
      this.scrollToCenter(this.pioWrap, pcRowEl);
      this.lastPioPc = sm.pc;
    }
    // While the [7] hold delay counts down, show it as running-N.
    const state = !sm.enabled
      ? 'disabled'
      : sm.waiting
      ? `stalled (${WaitType[sm.waitType]})`
      : sm.remainingDelay > 0
      ? `running-${sm.remainingDelay}`
      : 'running';
    const hex32 = (v: number) => (v >>> 0).toString(16).padStart(8, '0'); // restored registers come back signed
    // Y and ISR omitted: the countdown program never touches them.
    this.pioStateLabel.textContent =
      `PIO0 SM0 pc=${sm.pc} ${state}  X=0x${hex32(sm.x)}  ` +
      `OSR=0x${hex32(sm.outputShiftReg)}+${sm.outputShiftCount}  ` +
      `FIFO rx=${sm.rxFIFO.itemCount}/8 tx=${sm.txFIFO.itemCount}/8  out=0x${hex32(
        sm.outPinValues
      )}  sm_cycles=${sm.cycles.toLocaleString('en-US')}  clkdiv=${(sm.clockDiv / 256).toFixed(0)}`;

    // Logic analyzer + PCB pads
    drawAnalyzer(this.analyzerCanvas, this.analyzer, this.analyzerCenter, VIEW_WINDOW);
    this.pcb.update(this.analyzer.mask);

    // Serial
    this.serialPre.textContent = this.runner.serialText;
    this.serialPre.scrollTop = this.serialPre.scrollHeight;
  }
}

function pcLabel(pc: number, cycles: number): string {
  return `PC=0x${pc.toString(16).padStart(8, '0')} cycles=${cycles.toLocaleString('en-US')}`;
}

/** Clipboard via a hidden textarea, for contexts without the async Clipboard API. */
function legacyCopy(text: string): void {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.append(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}
