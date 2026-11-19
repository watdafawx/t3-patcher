import { CanvasBg } from "./bg-base.js";
import { rgbaString, rng, smoothstep } from "./bg-model.js";

/**
 * "Antigravity" background: a field of tiny round-capped dashes. A soft ring follows the pointer (or
 * wanders on its own when the pointer is idle); dashes near the ring grow, get pulled slightly toward
 * it and point away from its center, while a slow flow field keeps the rest of the field alive as dust.
 * Colors drift across a three-stop gradient.
 *
 * Idea only: the technique of the Google Antigravity website hero (a GPU particle field with a
 * pointer-following ring). This is an independent 2D-canvas implementation, see the README.
 *
 * Cost class: JS per frame. The whole field is one pass of cheap math plus <= 20 batched strokes
 * (4 widths x 5 colors). The render resolution is capped (dpr <= 1.5, <= 2.5 MP).
 */

const WIDTH_BUCKETS = 4;
const COLOR_BANDS = 5;
const KEYS = WIDTH_BUCKETS * COLOR_BANDS;
/** Dash width in px per bucket, and the alpha factor per bucket. */
const BUCKET_W = [0.9, 1.5, 2.3, 3.2] as const;
const BUCKET_A = [0.5, 0.72, 0.88, 1] as const;
const EDGES = [0.26, 0.62, 1.2] as const;

export class Antigravity extends CanvasBg {
  #n = 0;
  #rx = new Float32Array(0);
  #ry = new Float32Array(0);
  #sc = new Float32Array(0);
  #x = new Float32Array(0);
  #y = new Float32Array(0);
  #cos = new Float32Array(0);
  #sin = new Float32Array(0);
  #len = new Float32Array(0);
  #key = new Uint8Array(0);
  #order = new Int32Array(0);
  #counts = new Int32Array(KEYS + 1);
  #fill = new Int32Array(KEYS);
  #styles: string[] = [];
  #styleDirty = true;
  #ringX = 0;
  #ringY = 0;
  #pending = 0;
  #snap = true;

  protected css(): string {
    return "";
  }

  protected override configure(): void {
    this.#styleDirty = true;
    super.configure();
    const want = Math.max(1, Math.round(this.params.count * this.governor.factor));
    if (want !== this.#n && this.w > 0) this.layout(this.w, this.h);
  }

  protected override paletteChanged(): void {
    this.#styleDirty = true;
  }

  /** Jittered grid: even coverage (like blue noise) at any count, cheap to build. */
  protected layout(w: number, h: number): void {
    const count = Math.max(1, Math.round(this.params.count * this.governor.factor));
    const rand = rng(0x9e3779b1);
    const cell = Math.sqrt((w * h) / count);
    const cols = Math.ceil(w / cell) + 1;
    const rows = Math.ceil(h / cell) + 1;
    const n = cols * rows;
    this.#n = n;
    this.#rx = new Float32Array(n);
    this.#ry = new Float32Array(n);
    this.#sc = new Float32Array(n);
    this.#x = new Float32Array(n);
    this.#y = new Float32Array(n);
    this.#cos = new Float32Array(n);
    this.#sin = new Float32Array(n);
    this.#len = new Float32Array(n);
    this.#key = new Uint8Array(n);
    this.#order = new Int32Array(n);
    let i = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        this.#rx[i] = (c + 0.15 + rand() * 0.7) * cell - cell / 2;
        this.#ry[i] = (r + 0.15 + rand() * 0.7) * cell - cell / 2;
        i++;
      }
    }
    if (this.#ringX === 0 && this.#ringY === 0) {
      this.#ringX = w / 2;
      this.#ringY = h * 0.45;
    }
    this.#snap = true;
  }

  protected step(dt: number): void {
    this.#pending += dt;
    const t = this.time;
    const w = this.w;
    const h = this.h;
    const follow = this.cfg.pointer && performance.now() - this.pointerAt < 6000;
    let tx: number;
    let ty: number;
    if (follow) {
      tx = this.px;
      ty = this.py;
    } else {
      tx = w * 0.5 + Math.sin(t * 0.66 + 94.2) * w * 0.16 + Math.sin(t * 0.31) * w * 0.06;
      ty = h * 0.45 + Math.sin(t * 0.75 + 21) * h * 0.09 + Math.cos(t * 0.4) * h * 0.04;
    }
    const k = 1 - Math.exp(-(follow ? 2.4 : 0.7) * dt);
    this.#ringX += (tx - this.#ringX) * k;
    this.#ringY += (ty - this.#ringY) * k;
  }

  /** Per-particle update, once per drawn frame: ring influence, flow field, dash geometry, batching keys. */
  #update(): void {
    const n = this.#n;
    const t = this.time;
    const dt = this.#pending;
    this.#pending = 0;
    const lerp = this.#snap ? 1 : 1 - Math.exp(-14 * Math.max(dt, 1 / 60));
    this.#snap = false;
    const min = Math.min(this.w, this.h);
    const R = (0.3 + Math.sin(t) * 0.035 + Math.cos(t * 3) * 0.02) * min;
    const W = R * 0.28;
    const W2 = R * 0.08;
    const rx = this.#rx;
    const ry = this.#ry;
    const sc = this.#sc;
    const ringX = this.#ringX;
    const ringY = this.#ringY;
    const k = Math.max(0.7, Math.min(1.6, this.w / 1600));
    const t35 = t * 0.35;
    const t30 = t * 0.3;
    const t22 = t * 0.22;
    const counts = this.#counts;
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      const x0 = rx[i]!;
      const y0 = ry[i]!;
      const dx = x0 - ringX;
      const dy = y0 - ringY;
      const d = Math.sqrt(dx * dx + dy * dy);
      let band = smoothstep(R - 2 * W, R, d) - smoothstep(R, R + W, d);
      band = band > 0 ? band * band : 0;
      let narrow = smoothstep(R - 2 * W2, R, d) - smoothstep(R, R + W2, d);
      narrow = narrow > 0 ? narrow * narrow * narrow : 0;
      const inside = smoothstep(R + W2, R, d);
      const ring = band + narrow * 3 + inside * 0.4;
      const flow = Math.sin(x0 * 0.0045 + t35) * Math.cos(y0 * 0.0052 - t30);
      const f = 0.5 + 0.5 * flow;
      const target = ring + 0.12 + 0.5 * f * f;
      const s = sc[i]! + (target - sc[i]!) * lerp;
      sc[i] = s;
      // Flow-field wobble plus a pull toward the ring along its edge.
      const wx = Math.sin(y0 * 0.012 + t * 0.7) * 6 + Math.sin(x0 * 0.05 + y0 * 0.04 + t * 1.3) * 1.5;
      const wy = Math.cos(x0 * 0.01 + t * 0.6) * 6 + Math.cos(x0 * 0.045 - y0 * 0.05 + t * 1.1) * 1.5;
      const pull = (narrow + band * 0.5) * 0.07;
      this.#x[i] = x0 + wx - dx * pull;
      this.#y[i] = y0 + wy - dy * pull;
      const a = Math.atan2(dy, dx) + Math.sin(x0 * 0.02 + y0 * 0.017 + t * 0.85) * 0.5;
      this.#cos[i] = Math.cos(a);
      this.#sin[i] = Math.sin(a);
      this.#len[i] = s * 5.5 * k;
      const bucket = s < EDGES[0] ? 0 : s < EDGES[1] ? 1 : s < EDGES[2] ? 2 : 3;
      const nc = 0.5 + 0.5 * Math.sin(x0 * 0.0028 - y0 * 0.0021 + t22 + Math.sin(y0 * 0.004) * 1.3);
      const cb = Math.min(COLOR_BANDS - 1, (nc * COLOR_BANDS) | 0);
      const key = bucket * COLOR_BANDS + cb;
      this.#key[i] = key;
      counts[key + 1]!++;
    }
    for (let j = 1; j <= KEYS; j++) counts[j]! += counts[j - 1]!;
  }

  protected draw(ctx: CanvasRenderingContext2D): void {
    if (this.#n === 0) return;
    if (this.#styleDirty) {
      this.#styles = [];
      for (let b = 0; b < WIDTH_BUCKETS; b++) for (let c = 0; c < COLOR_BANDS; c++) this.#styles.push(rgbaString(this.bands[c]!, 0.8 * BUCKET_A[b]! * this.params.alpha));
      this.#styleDirty = false;
    }
    this.#update();
    const n = this.#n;
    const key = this.#key;
    const order = this.#order;
    const counts = this.#counts;
    // Counting sort of the particles by (width bucket, color band).
    const fill = this.#fill;
    fill.fill(0);
    for (let i = 0; i < n; i++) {
      const kk = key[i]!;
      order[counts[kk]! + fill[kk]!++] = i;
    }
    ctx.lineCap = "round";
    const X = this.#x;
    const Y = this.#y;
    const C = this.#cos;
    const S = this.#sin;
    const L = this.#len;
    for (let kk = 0; kk < KEYS; kk++) {
      const from = counts[kk]!;
      const to = counts[kk + 1]!;
      if (from === to) continue;
      ctx.lineWidth = BUCKET_W[(kk / COLOR_BANDS) | 0]!;
      ctx.strokeStyle = this.#styles[kk]!;
      ctx.beginPath();
      for (let j = from; j < to; j++) {
        const i = order[j]!;
        const hx = C[i]! * L[i]! * 0.5;
        const hy = S[i]! * L[i]! * 0.5;
        ctx.moveTo(X[i]! - hx, Y[i]! - hy);
        ctx.lineTo(X[i]! + hx, Y[i]! + hy);
      }
      ctx.stroke();
    }
  }

  protected override still(): void {
    this.#snap = true;
    super.still();
  }

  protected override teardown(): void {
    super.teardown();
    this.#n = 0;
    this.#ringX = 0;
    this.#ringY = 0;
    this.#pending = 0;
  }

  /** Test hook: number of particles in the current layout. */
  get particleCount(): number {
    return this.#n;
  }
}
