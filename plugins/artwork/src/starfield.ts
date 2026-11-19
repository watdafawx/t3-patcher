import { CanvasBg } from "./bg-base.js";
import { rgbaString, rng } from "./bg-model.js";
import type { Rgb } from "./model.js";

/**
 * "Starfield" background: sparse twinkling dots (about 200 at the default density) on one low-res
 * canvas, drawn at 30 fps. A slow upward drift and an optional pointer parallax add depth.
 *
 * Cost class: JS per frame, but tiny. No per-star allocations, 8 batched fills (4 brightness levels x 2
 * tints), device pixel ratio 1, at most 1.2 MP.
 */

const LEVELS = 4;
const TINTS = 2;

export class Starfield extends CanvasBg {

  #n = 0;
  #x = new Float32Array(0);
  #y = new Float32Array(0);
  #depth = new Float32Array(0);
  #phase = new Float32Array(0);
  #freq = new Float32Array(0);
  #size = new Uint8Array(0);
  #tint = new Uint8Array(0);
  #offX = 0;
  #offY = 0;
  #fg: Rgb = [220, 225, 235];
  #styles: string[] = [];
  #styleDirty = true;
  #buckets: Int32Array[] = [];
  #bucketN = new Int32Array(LEVELS * TINTS);

  protected css(): string {
    return "";
  }

  protected override configure(): void {
    this.#styleDirty = true;
    super.configure();
    const want = Math.max(1, Math.round(this.params.count * this.governor.factor));
    if (want !== this.#n && this.w > 0) this.layout(this.w, this.h);
  }

  protected override paletteChanged(fg: Rgb): void {
    this.#fg = fg;
    this.#styleDirty = true;
  }

  protected layout(w: number, h: number): void {
    const n = Math.max(1, Math.round(this.params.count * this.governor.factor));
    const rand = rng(0x51ed270b);
    this.#n = n;
    this.#x = new Float32Array(n);
    this.#y = new Float32Array(n);
    this.#depth = new Float32Array(n);
    this.#phase = new Float32Array(n);
    this.#freq = new Float32Array(n);
    this.#size = new Uint8Array(n);
    this.#tint = new Uint8Array(n);
    this.#buckets = Array.from({ length: LEVELS * TINTS }, () => new Int32Array(n));
    for (let i = 0; i < n; i++) {
      this.#x[i] = rand() * w;
      this.#y[i] = rand() * h;
      this.#depth[i] = 0.25 + rand() * 0.75;
      this.#phase[i] = rand() * Math.PI * 2;
      this.#freq[i] = 0.35 + rand() * 1.1;
      this.#size[i] = rand() < 0.12 ? 2 : 1;
      this.#tint[i] = rand() < 0.22 ? 1 : 0;
    }
  }

  protected step(dt: number): void {
    const h = this.h;
    const y = this.#y;
    const depth = this.#depth;
    // Slow upward drift, nearer stars (larger depth) move faster; wraps around.
    for (let i = 0; i < this.#n; i++) {
      let v = y[i]! - dt * 2.5 * depth[i]!;
      if (v < 0) v += h;
      y[i] = v;
    }
    const tx = this.cfg.pointer ? ((this.px - this.w / 2) / Math.max(1, this.w)) * -26 : 0;
    const ty = this.cfg.pointer ? ((this.py - this.h / 2) / Math.max(1, this.h)) * -16 : 0;
    const k = 1 - Math.exp(-3 * dt);
    this.#offX += (tx - this.#offX) * k;
    this.#offY += (ty - this.#offY) * k;
  }

  protected draw(ctx: CanvasRenderingContext2D): void {
    const n = this.#n;
    if (n === 0) return;
    if (this.#styleDirty) {
      this.#styles = [];
      const alpha = this.params.alpha;
      for (let tint = 0; tint < TINTS; tint++) {
        const base = tint === 0 ? this.#fg : this.colors[1];
        for (let l = 0; l < LEVELS; l++) this.#styles.push(rgbaString(base, (0.32 + (l / (LEVELS - 1)) * 0.63) * alpha));
      }
      this.#styleDirty = false;
    }
    const t = this.time;
    const counts = this.#bucketN;
    counts.fill(0);
    const { w, h } = this;
    for (let i = 0; i < n; i++) {
      const tw = 0.5 + 0.5 * Math.sin(t * this.#freq[i]! * 2.4 + this.#phase[i]!);
      const level = Math.min(LEVELS - 1, (tw * LEVELS) | 0);
      const b = this.#tint[i]! * LEVELS + level;
      this.#buckets[b]![counts[b]!++] = i;
    }
    const ox = this.#offX;
    const oy = this.#offY;
    for (let b = 0; b < LEVELS * TINTS; b++) {
      const cnt = counts[b]!;
      if (cnt === 0) continue;
      ctx.fillStyle = this.#styles[b]!;
      const list = this.#buckets[b]!;
      ctx.beginPath();
      for (let j = 0; j < cnt; j++) {
        const i = list[j]!;
        const d = this.#depth[i]!;
        let x = this.#x[i]! + ox * d;
        let y = this.#y[i]! + oy * d;
        if (x < 0) x += w;
        else if (x >= w) x -= w;
        if (y < 0) y += h;
        else if (y >= h) y -= h;
        const s = this.#size[i]!;
        ctx.rect(x, y, s, s);
      }
      ctx.fill();
    }
  }

  protected override teardown(): void {
    super.teardown();
    this.#n = 0;
    this.#offX = 0;
    this.#offY = 0;
  }

  get starCount(): number {
    return this.#n;
  }
}
