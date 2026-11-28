/**
 * Logic-analyzer history: one 16-bit sample per emulated PIO cycle, indexed by
 * absolute cycle number.
 *
 * Bit layout (bit = pin driven high):
 *   bits 0..7  — GP2..GP9   (PIO counter output)
 *   bits 8..15 — GP16..GP23 (core1 counter output)
 *
 * The mask is maintained event-driven by GPIO pin listeners (cheap: one call per
 * pin change); the runner calls record(cycle) once per ticked cycle. Save-state
 * restores do NOT notify listeners (transferState() restores lastValue too), so
 * the runner must call resync() after every unserialize() — otherwise the mask
 * keeps the pins' pre-restore state and every later sample is wrong.
 * Rewinds re-record cycles that are already retained — the re-derived samples
 * are written in place (they are identical), so history survives a rewind
 * untouched. The recording range is only reset by restart() (far rewinds, whose
 * neighborhood aged out of the ring) and dropped past a cycle by
 * truncateAfter() (GPIO24 button invalidates the recorded future).
 *
 * The ring holds the most recent RING_SIZE cycles; older slots may hold stale
 * values and are never read.
 */
import { RP2350 } from '../../../src/rp2350';
import { GPIOPinState } from '../../../src/gpio-pin';

export const PIO_PIN_BASE = 2;
export const CPU_PIN_BASE = 16;

const LANE_LABELS = [
  ...Array.from({ length: 8 }, (_, i) => `PIO GP${PIO_PIN_BASE + i}`),
  ...Array.from({ length: 8 }, (_, i) => `CPU GP${CPU_PIN_BASE + i}`),
];

const RING_SIZE = 1 << 15; // 32768 cycles of history

/** Cycles shown in the logic-analyzer view (current cycle centered). */
export const VIEW_WINDOW = 1000;
/** Extra speculation beyond the visible window: forward steps within this
 * slack reuse the recorded future instead of re-running the chip. */
export const COVERAGE_SLACK = VIEW_WINDOW;

export class Analyzer {
  readonly data = new Uint16Array(RING_SIZE);
  /** First cycle ever recorded (-1 = empty). */
  firstCycle = -1;
  /** Last recorded cycle (-1 = empty). */
  lastCycle = -1;
  /** Current 16-bit pin mask, kept up to date by pin listeners. */
  mask = 0;
  private chip!: RP2350; // set by attach()

  /** First cycle with a readable sample. */
  windowStart(): number {
    if (this.firstCycle < 0) return 0;
    return Math.max(this.firstCycle, this.lastCycle - RING_SIZE + 1);
  }

  /**
   * One sample per ticked PIO cycle. Cycles are contiguous except across a
   * rewind, where the replayed range overlaps already-retained cycles: those
   * are overwritten in place with identical values.
   */
  record(cycle: number): void {
    if (this.firstCycle < 0) {
      this.firstCycle = cycle;
      this.lastCycle = cycle;
    } else if (cycle === this.lastCycle + 1) {
      this.lastCycle = cycle;
    } else if (cycle > this.lastCycle + 1) {
      // Forward discontinuity (defensive): start a fresh recording.
      this.firstCycle = cycle;
      this.lastCycle = cycle;
    } else if (cycle >= this.windowStart()) {
      // Replay of a retained cycle: overwrite in place (slot is cycle-unique
      // within any RING_SIZE-wide window, so nothing newer is clobbered).
    } else {
      // Replay of an aged-out cycle: nothing to do, the slot is not readable.
      return;
    }
    this.data[cycle % RING_SIZE] = this.mask;
  }

  /** Whether samples exist for every cycle in [from, to]. */
  covers(from: number, to: number): boolean {
    return this.firstCycle >= 0 && this.windowStart() <= from && this.lastCycle >= to;
  }

  /** Sample for an absolute cycle, or undefined if not retained. */
  sampleAt(cycle: number): number | undefined {
    if (this.firstCycle < 0 || cycle < this.windowStart() || cycle > this.lastCycle) {
      return undefined;
    }
    return this.data[cycle % RING_SIZE];
  }

  /**
   * Restart the recording at an (about-to-be-replayed) position. Used by seek()
   * when the retained ring cannot cover the target's neighborhood: the replay
   * then builds up fresh coverage around the new position.
   */
  restart(): void {
    this.firstCycle = -1;
    this.lastCycle = -1;
  }

  /**
   * Drop samples past `cycle` — called when the GPIO24 button invalidates the
   * recorded future (NOT on rewind: history is preserved there).
   */
  truncateAfter(cycle: number): void {
    if (this.firstCycle < 0) return;
    if (cycle < this.firstCycle) {
      this.firstCycle = -1;
      this.lastCycle = -1;
      return;
    }
    if (cycle < this.lastCycle) {
      this.lastCycle = cycle;
    }
  }

  /** Register the GPIO listeners that maintain `mask` event-driven. */
  attach(chip: RP2350): void {
    this.chip = chip;
    for (let i = 0; i < 8; i++) {
      const pioBit = 1 << i;
      const cpuBit = 1 << (8 + i);
      chip.gpio[PIO_PIN_BASE + i].addListener((state) => {
        this.mask = state === 1 ? this.mask | pioBit : this.mask & ~pioBit;
      });
      chip.gpio[CPU_PIN_BASE + i].addListener((state) => {
        this.mask = state === 1 ? this.mask | cpuBit : this.mask & ~cpuBit;
      });
    }
  }

  /** Recompute `mask` from the pins — required after a save-state restore. */
  resync(): void {
    const chip = this.chip!;
    this.mask = 0;
    for (let i = 0; i < 8; i++) {
      if (chip.gpio[PIO_PIN_BASE + i].value === GPIOPinState.High) this.mask |= 1 << i;
      if (chip.gpio[CPU_PIN_BASE + i].value === GPIOPinState.High) this.mask |= 1 << (8 + i);
    }
  }
}

/** Geometry of the analyzer canvas: a ruler row on top, then one row per lane. */
export interface AnalyzerLayout {
  cssW: number;
  cssH: number;
  /** Height of the ruler row (also the height of one lane). */
  rulerH: number;
  leftCycle: number; // cycle at x = 0
  pxPerCycle: number;
}

/** The current cycle is always pinned at the horizontal center. */
export function analyzerLayout(
  canvas: HTMLCanvasElement,
  currentCycle: number,
  windowCycles: number
): AnalyzerLayout {
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  return {
    cssW,
    cssH,
    rulerH: cssH / (LANE_LABELS.length + 1), // +1 ruler row
    leftCycle: currentCycle - windowCycles / 2,
    pxPerCycle: cssW / windowCycles,
  };
}

/** Map a click (CSS px relative to the canvas) to its lane and cycle; null on the ruler or outside. */
export function analyzerHitTest(
  layout: AnalyzerLayout,
  x: number,
  y: number
): { lane: number; cycle: number } | null {
  if (x < 0 || x >= layout.cssW || y < layout.rulerH || y >= layout.cssH) return null;
  return {
    lane: Math.floor((y - layout.rulerH) / layout.rulerH),
    cycle: Math.floor(layout.leftCycle + x / layout.pxPerCycle),
  };
}

/**
 * Text describing a lane at a cycle, e.g.
 *   "GPIO2 is HIGH at cycle 150000. Positive edge at cycle 149990, negative edge at cycle 150010."
 * An edge is reported only if the analyzer still retains the samples around it;
 * the sentence is omitted otherwise (aged out of the ring, or beyond the
 * recorded/speculated future).
 */
export function describeSample(analyzer: Analyzer, lane: number, cycle: number): string {
  const gpio = lane < 8 ? PIO_PIN_BASE + lane : CPU_PIN_BASE + (lane - 8);
  const bit = 1 << lane;
  const sample = analyzer.sampleAt(cycle);
  if (sample === undefined) return `GPIO${gpio} has no recorded sample at cycle ${cycle}.`;
  const high = (sample & bit) !== 0;
  const level = `GPIO${gpio} is ${high ? 'HIGH' : 'LOW'} at cycle ${cycle}`;

  // An edge at cycle c is a level change between c-1 and c; the nearest ones
  // bracket the clicked cycle. The edge before has the clicked level as its
  // result, the edge after the opposite.
  const isEdge = (c: number) => {
    const before = analyzer.sampleAt(c - 1);
    const after = analyzer.sampleAt(c);
    return before !== undefined && after !== undefined && ((before ^ after) & bit) !== 0;
  };
  const edges: { cycle: number; positive: boolean }[] = [];
  for (let c = cycle; c >= analyzer.windowStart() + 1; c--) {
    if (isEdge(c)) {
      edges.push({ cycle: c, positive: high });
      break;
    }
  }
  for (let c = cycle + 1; c <= analyzer.lastCycle; c++) {
    if (isEdge(c)) {
      edges.push({ cycle: c, positive: !high });
      break;
    }
  }
  if (!edges.length) return `${level}.`;
  const notes = edges.map((e, i) => {
    const kind = e.positive ? 'Positive' : 'Negative';
    return `${i ? kind.toLowerCase() : kind} edge at cycle ${e.cycle}`;
  });
  return `${level}. ${notes.join(', ')}.`;
}

/**
 * Canvas logic-analyzer renderer: 16 lanes with the CURRENT CYCLE pinned at the
 * horizontal center (marked by a vertical bar). Recorded cycles on both sides of
 * the marker are drawn — the future dimmed; cycles without samples stay blank.
 * Zoom is fixed (px per cycle).
 */
export function drawAnalyzer(
  canvas: HTMLCanvasElement,
  analyzer: Analyzer,
  currentCycle: number,
  windowCycles: number
): void {
  const dpr = window.devicePixelRatio || 1;
  const { cssW, cssH, rulerH, leftCycle, pxPerCycle } = analyzerLayout(
    canvas,
    currentCycle,
    windowCycles
  );
  if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0b1220';
  ctx.fillRect(0, 0, cssW, cssH);

  const traceH = cssH - rulerH;
  const laneSpan = rulerH;
  const rightCycle = currentCycle + windowCycles / 2; // cycle at x = cssW
  const xOf = (cycle: number) => (cycle - leftCycle) * pxPerCycle;

  // Cycles with recorded samples in view (includes the retained "future" right
  // of the marker after a rewind — it is exactly what replay would reproduce)
  const drawFrom = Math.max(leftCycle, analyzer.windowStart());
  const drawTo = Math.min(rightCycle, analyzer.lastCycle);

  // Ruler + grid
  ctx.font = '10px ui-monospace, monospace';
  ctx.textBaseline = 'middle';
  const gridStep = niceStep(windowCycles);
  ctx.fillStyle = '#1e293b';
  const firstGrid = Math.ceil(leftCycle / gridStep) * gridStep;
  for (let c = firstGrid; c <= rightCycle; c += gridStep) {
    ctx.fillRect(xOf(c), rulerH, 1, traceH);
  }
  ctx.fillStyle = '#94a3b8';
  ctx.textAlign = 'left';
  ctx.fillText(fmtCycle(leftCycle), 4, rulerH / 2);
  ctx.textAlign = 'right';
  ctx.fillText(fmtCycle(rightCycle), cssW - 4, rulerH / 2);

  // Traces
  for (let lane = 0; lane < LANE_LABELS.length; lane++) {
    const bit = 1 << lane;
    const yTop = rulerH + lane * laneSpan + laneSpan * 0.18;
    const yBot = rulerH + lane * laneSpan + laneSpan * 0.82;
    const isPio = lane < 8;
    ctx.strokeStyle = isPio ? '#4ade80' : '#38bdf8';
    ctx.lineWidth = 1;

    // lane background stripe
    if (lane % 2 === 0) {
      ctx.fillStyle = 'rgba(148, 163, 184, 0.05)';
      ctx.fillRect(0, rulerH + lane * laneSpan, cssW, laneSpan);
    }

    // label
    ctx.fillStyle = isPio ? '#86efac' : '#7dd3fc';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(LANE_LABELS[lane], 4, (yTop + yBot) / 2);

    // Traces: solid up to the current cycle, dimmed (70%) for the retained
    // future right of the marker.
    const trace = (from: number, to: number, alpha: number) => {
      if (from > to) return;
      ctx.globalAlpha = alpha;
      let runStart = from;
      let runVal = (analyzer.sampleAt(from)! & bit) !== 0;
      let c = from + 1;
      const drawRun = (f: number, t: number, val: boolean) => {
        const x0 = xOf(f);
        const x1 = xOf(t + 1);
        if (val) {
          // High level: fill between the signal line and 0V at 60% brightness.
          ctx.globalAlpha = alpha * 0.6;
          ctx.fillStyle = ctx.strokeStyle as string;
          ctx.fillRect(x0, yTop, x1 - x0, yBot - yTop);
          ctx.globalAlpha = alpha;
        }
        ctx.beginPath();
        ctx.moveTo(x0, val ? yTop : yBot);
        ctx.lineTo(x1, val ? yTop : yBot);
        ctx.stroke();
      };
      while (c <= to) {
        const val = (analyzer.sampleAt(c)! & bit) !== 0;
        if (val !== runVal) {
          drawRun(runStart, c - 1, runVal);
          const x = xOf(c);
          ctx.beginPath();
          ctx.moveTo(x, runVal ? yTop : yBot);
          ctx.lineTo(x, val ? yTop : yBot);
          ctx.stroke();
          runStart = c;
          runVal = val;
        }
        c++;
      }
      drawRun(runStart, to, runVal);
      ctx.globalAlpha = 1;
    };
    trace(drawFrom, Math.min(drawTo, currentCycle), 1);
    trace(Math.max(drawFrom, currentCycle + 1), drawTo, 0.7);
  }

  // "now" marker: vertical bar at the current cycle (window center). The label
  // sits just right of the bar so the bar does not strike through the digits.
  const xNow = xOf(currentCycle);
  ctx.fillStyle = 'rgba(245, 158, 11, 0.18)';
  ctx.fillRect(xNow - 1, rulerH, 2, traceH);
  ctx.fillStyle = '#f59e0b';
  ctx.fillRect(xNow - 1, 0, 2, rulerH);
  ctx.textAlign = 'left';
  ctx.fillText('▶ ' + fmtCycle(currentCycle), xNow + 7, rulerH / 2);
}

function niceStep(windowCycles: number): number {
  const target = windowCycles / 8;
  const mag = Math.pow(10, Math.floor(Math.log10(target)));
  for (const m of [1, 2, 5, 10]) {
    if (m * mag >= target) return m * mag;
  }
  return 10 * mag;
}

function fmtCycle(c: number): string {
  return Math.round(c).toLocaleString('en-US').replace(/,/g, '\u202f');
}
