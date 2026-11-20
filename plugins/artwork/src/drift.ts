import { CanvasBg } from "./bg-base.js";
import { FIXED_PALETTE, rgbaString } from "./bg-model.js";
import { accentColor, clamp, shiftedColor, type Rgb } from "./model.js";

/**
 * "Gradient drift" background: four large soft blobs that slowly drift and breathe behind the app.
 *
 * Cost class: tiny canvas. The blobs are radial gradients drawn on a canvas at about a fifth of the CSS
 * resolution (they are pure soft gradients, so the CSS upscale looks the same) at 20 fps or less. The first
 * version animated four huge CSS layers with `transform`: no JavaScript, but the compositor then ticked at the
 * display rate (120 Hz on rig) and blended four viewport-sized layers over the app every frame, which is what
 * actually made typing and streaming stutter (docs/artwork-perf.md). The Blur setting is baked in (bigger, flatter
 * blobs), never a CSS filter.
 */

/** Per blob: start position (share of the viewport), motion from/to (vw, vh, scale), period and phase multipliers. */
interface Blob {
  x: number;
  y: number;
  from: readonly [number, number, number];
  to: readonly [number, number, number];
  period: number;
  delay: number;
}
const BLOBS: readonly Blob[] = [
  { x: 0.18, y: 0.22, from: [-6, -4, 1], to: [9, 8, 1.2], period: 1, delay: 0 },
  { x: 0.82, y: 0.28, from: [5, -6, 1.1], to: [-10, 7, 0.9], period: 1.25, delay: -0.4 },
  { x: 0.3, y: 0.86, from: [-8, 4, 0.95], to: [8, -8, 1.18], period: 1.5, delay: -0.9 },
  { x: 0.76, y: 0.82, from: [6, 6, 1.15], to: [-7, -6, 0.92], period: 1.8, delay: -1.3 },
];
/** Seconds for one leg of the shortest blob at the default speed (time is already multiplied by the speed). */
export const DRIFT_LEG_S = 50;

const ease = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t));

/** Blob center (CSS px) and radius at simulation time `t` for a `w` x `h` viewport. Pure, for tests. */
export function blobAt(i: number, t: number, w: number, h: number, sizeVmax: number): { x: number; y: number; r: number } {
  const b = BLOBS[i]!;
  const leg = DRIFT_LEG_S * b.period;
  const p = (((t + b.delay * DRIFT_LEG_S) / leg) % 2 + 2) % 2;
  const k = ease(p < 1 ? p : 2 - p);
  const lerp = (j: number): number => b.from[j]! + (b.to[j]! - b.from[j]!) * k;
  const vmax = Math.max(w, h) / 100;
  return { x: b.x * w + (lerp(0) * w) / 100, y: b.y * h + (lerp(1) * h) / 100, r: (sizeVmax * vmax * lerp(2)) / 2 };
}

export class GradientDrift extends CanvasBg {
  #blobColors: Rgb[] = [];
  #opacity = 0.54;
  #size = 45;

  protected override configure(): void {
    this.#bake();
    super.configure();
  }

  /** Blur is baked into the blobs: up to 50 % bigger and flatter (the energy spreads), no filter involved. */
  #bake(): void {
    const { intensity, density } = this.cfg;
    const blur = this.effectiveBlur();
    this.#opacity = Math.round(clamp(intensity, 0, 100) * 0.9 * (1 - blur * 0.012)) / 100;
    this.#size = Math.round((32 + clamp(density, 0, 100) * 0.26) * (1 + blur * 0.025));
  }

  protected override applyBlur(): void {
    this.#bake();
  }

  /** The blur is baked into the blobs: no in-canvas blur pass. */
  protected override canvasBlur(): number {
    return 0;
  }

  /** The blobs are already soft: no extra resolution drop under a blur. */
  protected override blurResolution(): number {
    return 1;
  }

  protected override paletteChanged(): void {
    const { followAccent, hue } = this.cfg;
    const exprs = followAccent ? [accentColor(hue), shiftedColor(hue, 35), shiftedColor(hue, -30), shiftedColor(hue, 70)] : null;
    const fixed: Rgb[] = [FIXED_PALETTE[0], FIXED_PALETTE[1], FIXED_PALETTE[2], FIXED_PALETTE[1]];
    this.#blobColors = exprs ? exprs.map((e, i) => this.resolve(e) ?? fixed[i]!) : fixed;
  }

  protected layout(): void {}

  protected step(): void {}

  protected draw(ctx: CanvasRenderingContext2D): void {
    if (this.#blobColors.length === 0) return;
    ctx.globalAlpha = this.#opacity;
    for (let i = 0; i < BLOBS.length; i++) {
      const { x, y, r } = blobAt(i, this.time, this.w, this.h, this.#size);
      const c = this.#blobColors[i]!;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, rgbaString(c, 1));
      g.addColorStop(1, rgbaString(c, 0));
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
  }

  /** Test hook: blob diameter (vmax) and opacity after the baked-in blur. */
  get blobStyle(): { size: number; opacity: number } {
    return { size: this.#size, opacity: this.#opacity };
  }

  /** Test hook: resolved blob colors. */
  get colorsNow(): readonly Rgb[] {
    return this.#blobColors;
  }
}
