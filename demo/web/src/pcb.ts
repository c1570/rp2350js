/**
 * Stylized RP2350 Pico (Pico 2) PCB as inline SVG. Used GPIOs are highlighted and
 * update live; the GPIO24 button is a clickable tactile button (click toggles
 * pressed/released). Narrow screens hide the PCB and show a compact rendering of
 * the button instead (registerButton()): every rendering shares one state.
 */
import { PIO_PIN_BASE, CPU_PIN_BASE } from './analyzer';

// Stylized header layout (unused pins GP0/GP1, GP10..15 and GP26..28 omitted,
// GP23 shown virtually just above GP22 — it is internal on a real Pico 2).
const LEFT = ['GND', 'GP2', 'GP3', 'GP4', 'GP5', 'GND', 'GP6', 'GP7', 'GP8', 'GP9', 'GND'];
const RIGHT = [
  'VBUS',
  'VSYS',
  'GND',
  '3V3EN',
  '3V3',
  'ADVREF',
  'AGND',
  'RUN',
  'GP23',
  'GP22',
  'GND',
  'GP21',
  'GP20',
  'GP19',
  'GP18',
  'GND',
  'GP17',
  'GP16',
];
const USED_PIO = new Set(Array.from({ length: 8 }, (_, i) => PIO_PIN_BASE + i)); // 2..9
const USED_CPU = new Set(Array.from({ length: 8 }, (_, i) => CPU_PIN_BASE + i)); // 16..23

export class PcbView {
  private readonly padEls = new Map<number, SVGCircleElement>();
  /** Every rendering of the GPIO24 button (PCB, compact) with its optional LED and hint halo. */
  private readonly buttons: {
    el: SVGGElement;
    led: SVGCircleElement | null;
    halo: SVGCircleElement | null;
  }[] = [];
  private pressed = false;
  private everClicked = false;
  /** While false, clicks are ignored (the timeline is still being prepared). */
  enabled = true;
  onButtonToggle: ((pressed: boolean) => void) | null = null;

  constructor(readonly svg: SVGSVGElement) {
    svg.innerHTML = this.render();
    for (const gp of [...USED_PIO, ...USED_CPU]) {
      this.padEls.set(gp, svg.querySelector(`#pad-${gp}`) as unknown as SVGCircleElement);
    }
    this.registerButton(svg.querySelector('#btn-gp24') as unknown as SVGGElement, {
      led: svg.querySelector('#btn-led') as unknown as SVGCircleElement,
      halo: svg.querySelector('#btn-gp24-halo') as unknown as SVGCircleElement,
    });
  }

  /** Bind another rendering of the GPIO24 button (`.btn` group) to the same toggle. */
  registerButton(
    el: SVGGElement,
    {
      led = null,
      halo = null,
    }: { led?: SVGCircleElement | null; halo?: SVGCircleElement | null } = {}
  ): void {
    this.buttons.push({ el, led, halo });
    el.classList.toggle('pressed', this.pressed);
    el.addEventListener('click', () => {
      if (this.enabled) this.setPressed(!this.pressed);
    });
  }

  /** Start the breathing hint — unless the button was already used. */
  startBlink(): void {
    if (!this.everClicked) {
      for (const { el, halo } of this.buttons) {
        el.classList.add('blink');
        halo?.classList.add('blink');
      }
    }
  }

  private setPressed(pressed: boolean): void {
    this.pressed = pressed;
    this.everClicked = true;
    for (const { el, led, halo } of this.buttons) {
      el.classList.remove('blink'); // breathed its last
      halo?.classList.remove('blink');
      el.classList.toggle('pressed', pressed);
      led?.classList.toggle('on', pressed);
    }
    this.onButtonToggle?.(pressed);
  }

  /** Update the live tint of the 16 used pads. */
  update(mask: number): void {
    for (let i = 0; i < 8; i++) {
      const pioEl = this.padEls.get(PIO_PIN_BASE + i);
      if (pioEl) pioEl.classList.toggle('hi-pio', (mask & (1 << i)) !== 0);
      const cpuEl = this.padEls.get(CPU_PIN_BASE + i);
      if (cpuEl) cpuEl.classList.toggle('hi-cpu', (mask & (1 << (8 + i))) !== 0);
    }
  }

  private render(): string {
    let defs = '';
    const top = 84; // y of first pad
    const dy = 21;
    const padRow = (column: string[], x: number, lx: number, anchor: string) => {
      column.forEach((label, i) => {
        const y = top + i * dy;
        const gpMatch = /^GP(\d+)$/.exec(label);
        if (!gpMatch) return;
        const gp = parseInt(gpMatch[1]);
        const virtual = gp === 23;
        defs += `<g>
          <circle id="pad-${gp}" class="pad${USED_PIO.has(gp) ? ' used-pio' : ''}${
          USED_CPU.has(gp) ? ' used-cpu' : ''
        }${virtual ? ' virtual' : ''}" cx="${x}" cy="${y}" r="8"/>
          <text class="lbl lbl-used" x="${lx}" y="${y + 3}" text-anchor="${anchor}">${label}${
          virtual ? '*' : ''
        }</text>
        </g>`;
      });
    };
    padRow(LEFT, 24, 38, 'start');
    padRow(RIGHT, 216, 202, 'end');

    return `<svg viewBox="0 0 240 560" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="gp24-glow-pcb">
          <stop offset="0" stop-color="#f59e0b" stop-opacity="0.95"/>
          <stop offset="0.45" stop-color="#f59e0b" stop-opacity="0.4"/>
          <stop offset="1" stop-color="#f59e0b" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect class="board" x="4" y="4" width="232" height="552" rx="14"/>
      <circle class="btn-glow" id="btn-gp24-halo" cx="65" cy="26" r="26" fill="url(#gp24-glow-pcb)"/>
      <rect class="usb" x="90" y="8" width="60" height="30" rx="4"/>
      <text class="lbl" x="120" y="52" text-anchor="middle">USB</text>
      <rect class="chip" x="85" y="322" width="70" height="70" rx="6"/>
      <circle class="chip-dot" cx="97" cy="334" r="4"/>
      <text class="lbl chip-lbl" x="120" y="352" text-anchor="middle">RP2350</text>
      <text class="lbl chip-lbl" x="120" y="366" text-anchor="middle">QFN120</text>
      <g id="btn-gp24" class="btn" tabindex="0">
        <rect class="btn-body" x="46" y="14" width="38" height="24" rx="4"/>
        <circle class="btn-cap" cx="65" cy="26" r="9"/>
        <text class="lbl" x="65" y="52" text-anchor="middle">GPIO24</text>
              </g>
      <circle id="btn-led" class="btn-led" cx="65" cy="70" r="3"/>
      ${defs}
      <text class="lbl note" x="120" y="540" text-anchor="middle">* GP23 is internal on a real Pico 2</text>
    </svg>`;
  }
}
