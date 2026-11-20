import { baseCss, bgIds, CanvasBg, type BgHost } from "./bg-base.js";
import { rng } from "./bg-model.js";
import { oceanPalette, oceanParams, type Rgb } from "./model.js";

export { markSurfaces } from "./bg-surfaces.js";

/**
 * Ocean background: a drifting field of letters on the shared full-app canvas (`CanvasBg`), with click ripples and
 * a pointer glow. Adapted from the user-supplied ocean.js.
 *
 * Ocean draws incrementally: only cells whose band or letter changed are repainted, so the base never clears the
 * canvas before a frame. Everything with a lifetime (canvas, loop, listeners, resize, theme, pause, quality) is the
 * base class's job; this file only lays out the grid and draws it.
 *
 * - Ink colors come from the app's `--foreground`, the glow from the artwork accent (or the app's `--primary`).
 * - Letters come from a hash of the cell, so a resize keeps every letter where it was (the old code re-rolled the
 *   whole grid on every resize event). Shimmer swaps letters only while time advances.
 * - Ripple and glow times are simulation time: a still or frozen frame repaints the same picture (the old code
 *   jumped the pattern to t = 4 s for every still frame).
 */

const CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const CELL_H = 16;
const FONT = 11;
const GAP = 3;
const FONT_CSS = `500 ${FONT}px "IBM Plex Mono", ui-monospace, Consolas, monospace`;
const TAU = Math.PI * 2;
/** Fallback glow color when the accent cannot be resolved. */
const ACCENT_FALLBACK: Rgb = [249, 115, 22];

export const OCEAN_CANVAS_ID = bgIds("ocean").root;
export const OCEAN_ATTR = bgIds("ocean").attr;
export const OCEAN_STYLE_ID = bgIds("ocean").style;
export const OCEAN_CLEAR_ATTR = bgIds("ocean").clear;
/** The shared background CSS for Ocean's ids (see `baseCss`). */
export const OCEAN_CSS = baseCss("ocean");

interface Ripple {
  x: number;
  y: number;
  /** Start, in real seconds of loop time. */
  t: number;
  a: number;
  shape: (u: number, v: number, k: Ripple) => number;
  n: number;
  cos: number;
  sin: number;
  sx: number;
  sy: number;
  front: number;
  fade: number;
  reach: number;
  extent: number;
}

const polygon = (u: number, v: number, n: number): number => {
  const seg = TAU / n;
  const a = ((Math.atan2(v, u) % seg) + seg) % seg - seg / 2;
  return (Math.hypot(u, v) * Math.cos(seg / 2)) / Math.cos(a);
};
const SHAPES: Array<Ripple["shape"]> = [
  (u, v) => Math.hypot(u, v),
  (u, v) => (Math.abs(u) + Math.abs(v)) * 0.78,
  (u, v) => Math.max(Math.abs(u), Math.abs(v)),
  (u, v, k) => polygon(u, v, k.n),
  (u, v, k) => Math.hypot(u, v) / (1 + 0.32 * Math.cos(k.n * Math.atan2(v, u))),
  (u, v, k) => Math.hypot(u, v) / (1 + 0.14 * Math.sin(k.n * Math.atan2(v, u))),
];
const SHAPE_RADIUS = (idx: number, n: number): number => [1, 1 / 0.78, Math.SQRT2, 1 / Math.cos(Math.PI / n), 1.32, 1.14][idx]!;

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Stable letter for a cell (integer hash), so the grid is the same after every resize. */
export const cellLetter = (c: number, r: number): number => {
  let h = Math.imul(c + 1, 0x27d4eb2d) ^ Math.imul(r + 1, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) % CHARS.length;
};

export class Ocean extends CanvasBg {
  protected override readonly incremental = true;
  protected override readonly usesDensityGovernor = false;

  #ink: string[] = [];
  #glow: string[] = [];
  #cols = 0;
  #rows = 0;
  #cellW = 9;
  #grid = new Uint8Array(0);
  #painted = new Uint8Array(0);
  #letters = new Uint8Array(0);
  #dirty = new Uint16Array(0);
  #advances: number[] = [];
  #ripples: Ripple[] = [];
  #pAmp = 0;
  /** Real seconds the loop has advanced (ripple ages), independent of the speed setting. */
  #clock = 0;
  #noise = new Uint8Array(512);
  #rand = rng(0x0cea);

  constructor(host: BgHost) {
    super("ocean", host);
    const p = [...Array(256).keys()];
    for (let i = 255; i > 0; i--) {
      const j = (this.#rand() * (i + 1)) | 0;
      [p[i], p[j]] = [p[j]!, p[i]!];
    }
    for (let i = 0; i < 512; i++) this.#noise[i] = p[i & 255]!;
  }

  /** Grid size (for tests and the perf notes). */
  get grid(): { cols: number; rows: number } {
    return { cols: this.#cols, rows: this.#rows };
  }

  get ripples(): number {
    return this.#ripples.length;
  }

  protected override teardown(): void {
    this.#ripples = [];
    this.#pAmp = 0;
    this.#cols = 0;
    this.#rows = 0;
    this.#grid = new Uint8Array(0);
    this.#painted = new Uint8Array(0);
    this.#letters = new Uint8Array(0);
  }

  protected override paletteChanged(fg: Rgb): void {
    const { ink, glow } = oceanPalette(fg, this.accent ?? ACCENT_FALLBACK, this.params.alpha);
    this.#ink = ink;
    this.#glow = glow;
    // Every cell is repainted with the new colors.
    this.#painted.fill(255);
    this.#clearTarget();
  }

  #clearTarget(): void {
    // In CSS px under the current transform; the extra cell covers the rounded-up backing store.
    this.target?.clearRect(0, 0, this.w + this.#cellW, this.h + CELL_H);
  }

  protected override layout(w: number, h: number): void {
    const ctx = this.target;
    if (!ctx) return;
    ctx.font = FONT_CSS;
    ctx.textBaseline = "top";
    if ("letterSpacing" in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${GAP}px`;
    this.#cellW = ctx.measureText("0123456789").width / 10 || 9;
    const cols = Math.ceil(w / this.#cellW) + 1;
    const rows = Math.ceil(h / CELL_H) + 1;
    if (cols !== this.#cols || rows !== this.#rows) {
      const old = this.#grid;
      const oldCols = this.#cols;
      const oldRows = this.#rows;
      const grid = new Uint8Array(cols * rows);
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) grid[r * cols + c] = c < oldCols && r < oldRows ? old[r * oldCols + c]! : cellLetter(c, r);
      this.#grid = grid;
      this.#letters = new Uint8Array(cols * rows);
      this.#cols = cols;
      this.#rows = rows;
      this.#dirty = new Uint16Array(cols);
      this.#painted = new Uint8Array(cols * rows);
    }
    this.#advances = Array.from({ length: cols + 1 }, (_, c) => ctx.measureText(" ".repeat(c)).width || c * this.#cellW);
    // The canvas was just resized (cleared): every cell is repainted.
    this.#painted.fill(255);
  }

  protected override pointerMoved(): void {
    this.#pAmp = Math.min(1, this.#pAmp + 0.05);
  }

  protected override pointerDown(x: number, y: number): void {
    // A ripple only means something while the water moves (a frozen or still layer would show a stray ring).
    if (!this.cfg.ripples || !this.looping) return;
    const rot = this.#rand() * TAU;
    const stretch = this.#rand() < 0.4 ? 1 + this.#rand() * 0.9 : 1;
    const idx = (this.#rand() * SHAPES.length) | 0;
    const n = 3 + ((this.#rand() * 5) | 0);
    this.#ripples.push({
      x,
      y,
      t: this.#clock,
      a: 1,
      shape: SHAPES[idx]!,
      n,
      cos: Math.cos(rot),
      sin: Math.sin(rot),
      sx: stretch,
      sy: 1 / Math.sqrt(stretch),
      front: 0,
      fade: 1,
      reach: 0,
      extent: SHAPE_RADIUS(idx, n) * Math.max(stretch, 1 / Math.sqrt(stretch)),
    });
    if (this.#ripples.length > 8) this.#ripples.shift();
  }

  protected override step(dt: number): void {
    const speed = this.params.speed;
    if (speed > 0) this.#clock += dt / speed;
    this.#pAmp *= 0.965;
  }

  #vnoise(x: number, y: number): number {
    const P = this.#noise;
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const X = xi & 255;
    const Y = yi & 255;
    const a = P[P[X]! + Y]!;
    const b = P[P[X + 1]! + Y]!;
    const c = P[P[X]! + Y + 1]!;
    const d = P[P[X + 1]! + Y + 1]!;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    return ((a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v) / 255;
  }

  #fbm(x: number, y: number): number {
    return this.#vnoise(x, y) * 0.55 + this.#vnoise(x * 2.1 + 7.3, y * 2.1 - 3.1) * 0.3 + this.#vnoise(x * 4.3 - 1.7, y * 4.3 + 9.2) * 0.15;
  }

  protected override draw(ctx: CanvasRenderingContext2D): boolean {
    if (this.#ink.length === 0 || this.#cols === 0) return false;
    const op = oceanParams({ intensity: 60, speed: 50 * this.params.speed });
    const cols = this.#cols;
    const rows = this.#rows;
    const grid = this.#grid;
    const painted = this.#painted;
    const letters = this.#letters;
    const dpr = this.scale;
    const INK = this.#ink;
    const GLOW = this.#glow;
    const now = this.#clock;
    for (let i = this.#ripples.length - 1; i >= 0; i--) {
      const rp = this.#ripples[i]!;
      const age = now - rp.t;
      if (age > 3.4) {
        this.#ripples.splice(i, 1);
        continue;
      }
      rp.front = age * op.rippleSpeed;
      rp.fade = Math.max(0, 1 - age / 3.2) * rp.a;
      rp.reach = (rp.front + 30) * rp.extent + 1;
    }
    if (this.advancing && op.shimmer > 0) {
      const perFrame = op.shimmer * (30 / Math.max(1, this.params.maxFps));
      for (let k = (grid.length * perFrame) | 0; k > 0; k--) grid[(this.#rand() * grid.length) | 0] = (this.#rand() * CHARS.length) | 0;
    }
    // `time` is already scaled by the speed; 0.035 is Ocean's drift per second at the default speed.
    const drift = this.time * 0.035;
    const glowOn = this.#pAmp > 0.01;
    let drew = false;
    for (let r = 0; r < rows; r++) {
      const cy = r * CELL_H;
      let changed = 0;
      for (let c = 0; c < cols; c++) {
        const cx = c * this.#cellW;
        const i = r * cols + c;
        const n = this.#fbm(cx * 0.0056 + drift, cy * 0.0074 - drift * 0.6);
        let lit = smooth(0.48, 0.78, n);
        let glow = 0;
        for (const rp of this.#ripples) {
          if (!rp.fade) continue;
          const dx = cx - rp.x;
          const dy = cy - rp.y;
          if (Math.abs(dx) > rp.reach || Math.abs(dy) > rp.reach) continue;
          const u = (dx * rp.cos + dy * rp.sin) / rp.sx;
          const v = (dy * rp.cos - dx * rp.sin) / rp.sy;
          const off = rp.shape(u, v, rp) - rp.front;
          if (off > 30 || off < -90) continue;
          glow += Math.exp(-(off * off) / 700) * rp.fade;
        }
        if (glowOn) {
          const d = Math.hypot(cx - this.px, cy - this.py);
          if (d < 130) lit += (1 - d / 130) * 0.5 * this.#pAmp;
        }
        let band: number;
        if (glow > 0.3) band = INK.length + (glow > 0.7 ? 1 : 0);
        else {
          lit += glow;
          band = lit < 0.06 ? 255 : Math.min(INK.length - 1, (lit * INK.length) | 0);
        }
        if (painted[i] === band && (band === 255 || letters[i] === grid[i])) continue;
        painted[i] = band;
        letters[i] = grid[i]!;
        this.#dirty[changed++] = c;
      }
      if (!changed) continue;
      drew = true;
      const top = Math.floor(cy * dpr);
      const height = (Math.floor((cy + CELL_H) * dpr) - top) / dpr;
      if (changed > cols / 8) {
        ctx.clearRect(0, top / dpr, this.w + this.#cellW, height);
        for (let band = 0; band < INK.length + GLOW.length; band++) {
          let text = "";
          for (let c = 0; c < cols; c++) {
            const i = r * cols + c;
            text += painted[i] === band ? CHARS[letters[i]!] : " ";
          }
          text = text.trimEnd();
          if (!text) continue;
          ctx.fillStyle = band < INK.length ? INK[band]! : GLOW[band - INK.length]!;
          ctx.fillText(text, 0, cy);
        }
        continue;
      }
      for (let k = 0; k < changed; k++) {
        const c = this.#dirty[k]!;
        const i = r * cols + c;
        const band = painted[i]!;
        const left = Math.floor(this.#advances[c]! * dpr);
        ctx.clearRect(left / dpr, top / dpr, (Math.floor(this.#advances[c + 1]! * dpr) - left) / dpr, height);
        if (band !== 255) {
          ctx.fillStyle = band < INK.length ? INK[band]! : GLOW[band - INK.length]!;
          ctx.fillText(CHARS[grid[i]!]!, this.#advances[c]!, cy);
        }
      }
    }
    return drew;
  }
}
