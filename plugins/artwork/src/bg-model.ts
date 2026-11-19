import { qualityProfile, startTier, type BgQuality, type BgTier } from "./bg-perf.js";
import { clamp, type Rgb } from "./model.js";

/**
 * Pure helpers shared by the full-app background presets (Antigravity, Starfield, Gradient drift).
 * Ocean predates them and keeps its own model in `model.ts`.
 */

export const BG_KINDS = ["ocean", "antigravity", "drift", "starfield"] as const;
export type BgKind = (typeof BG_KINDS)[number];
export const BG_LABELS: Record<BgKind, string> = {
  ocean: "Ocean",
  antigravity: "Antigravity",
  drift: "Gradient drift",
  starfield: "Starfield",
};
/** The three presets built on `BgLayer` (Ocean has its own engine). */
export type BgPresetKind = Exclude<BgKind, "ocean">;

export const BG_KEYS = ["bgIntensity", "bgSpeed", "bgDensity", "bgDim", "bgBlur", "bgPointer", "bgFollowAccent", "bgLowPower", "bgQuality", "bgPauseWhileTyping"] as const;

export function isBgKind(value: unknown): value is BgKind {
  return typeof value === "string" && (BG_KINDS as readonly string[]).includes(value);
}

export interface BgConfig {
  on: boolean;
  /** 0 to 100 */
  intensity: number;
  /** 0 (still) to 100 */
  speed: number;
  /** 0 to 100 */
  density: number;
  pointer: boolean;
  /** True: colors come from the app accent (or the artwork hue). False: the preset's own palette. */
  followAccent: boolean;
  /** Same hue setting as the sidebar artwork: negative follows the app accent. */
  hue: number;
  /** Cap at 30 fps. */
  lowPower: boolean;
  /** Render quality tier, or `auto` (adaptive, see `bg-perf.ts`). */
  quality: BgQuality;
  /** Freeze on the current frame while the user types or scrolls and while the chat streams. */
  pauseWhileTyping: boolean;
  /** 0 to {@link DIM_MAX}: flat overlay between the background and the app. */
  dim: number;
  /** 0 to {@link BLUR_MAX} px: softness of the background layer itself. */
  blur: number;
}

export interface BgParams {
  /** Multiplier for every alpha, 1 at the default intensity of 60. */
  alpha: number;
  /** Time multiplier, 1 at the default speed of 50. */
  speed: number;
  animated: boolean;
  /** Particle or star count before the adaptive quality factor. */
  count: number;
  maxFps: number;
}

export const ANTIGRAVITY_MIN = 500;
export const ANTIGRAVITY_SPAN = 2400;
export const STARFIELD_MIN = 80;
export const STARFIELD_SPAN = 240;

export function bgParams(kind: BgPresetKind, cfg: Pick<BgConfig, "intensity" | "speed" | "density" | "lowPower"> & { quality?: BgQuality }, tier: BgTier = startTier(cfg.quality ?? "high")): BgParams {
  const fps = qualityProfile(kind, tier).fps;
  const speed = clamp(cfg.speed, 0, 100) / 50;
  const d = clamp(cfg.density, 0, 100) / 100;
  const count = kind === "starfield" ? Math.round(STARFIELD_MIN + d * STARFIELD_SPAN) : Math.round(ANTIGRAVITY_MIN + d * ANTIGRAVITY_SPAN);
  return {
    alpha: Math.round((clamp(cfg.intensity, 0, 100) / 60) * 1000) / 1000,
    speed,
    animated: speed > 0 && fps > 0,
    count,
    // The quality tier sets the frame rate (Starfield is 30 fps at most); Low power caps everything at 30.
    maxFps: cfg.lowPower ? Math.min(30, fps) : fps,
  };
}

// ---- dim and blur ---------------------------------------------------------------------------------

/** Highest dim in percent: past this the background is barely visible. */
export const DIM_MAX = 80;
/** Highest blur in px. Measured on rig at ~4K: see plugins/artwork/README.md. */
export const BLUR_MAX = 20;

/** Opacity (0 to 0.8) of the dim overlay for a setting value. */
export const dimOpacity = (dim: number): number => Math.round(clamp(Number.isFinite(dim) ? dim : 0, 0, DIM_MAX)) / 100;

/** Blur radius in whole px that is really applied: 0 once the frame governor has shed it. */
export const blurPx = (blur: number, shed = false): number => (shed ? 0 : Math.round(clamp(Number.isFinite(blur) ? blur : 0, 0, BLUR_MAX)));

/** Share of the normal canvas resolution worth rendering under a blur (detail is lost anyway). */
export const blurRenderFactor = (px: number): number => clamp(1 - px / 30, 0.5, 1);

/**
 * Geometry of the in-canvas blur (no CSS filter, see docs/artwork-perf.md): the source canvas is drawn
 * onto the visible one through `ctx.filter = blur(sigma)`, scaled up by a margin so the filter's
 * transparent edge bleed lands off screen. All values are canvas pixels.
 */
export function blurBlit(px: number, scale: number, cw: number, ch: number): { sigma: number; x: number; y: number; w: number; h: number } {
  if (px <= 0) return { sigma: 0, x: 0, y: 0, w: cw, h: ch };
  const sigma = Math.round(px * scale * 100) / 100;
  const m = Math.ceil(3 * sigma);
  return { sigma, x: -m, y: -m, w: cw + 2 * m, h: ch + 2 * m };
}

/** Draws `src` onto `dst` blurred by `px` CSS px (one GPU pass per drawn frame; nothing while the layer is frozen). */
export function blitBlurred(dst: HTMLCanvasElement, src: HTMLCanvasElement, px: number, scale: number): void {
  const ctx = dst.getContext("2d");
  if (!ctx) return;
  const g = blurBlit(px, scale, dst.width, dst.height);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, dst.width, dst.height);
  if (g.sigma > 0) ctx.filter = `blur(${g.sigma}px)`;
  ctx.drawImage(src, g.x, g.y, g.w, g.h);
  ctx.restore();
}

/**
 * Watches the draw cost like {@link FrameGovernor}, but only to decide when to drop the blur: the
 * first sign of slow frames (average above `limitMs` over `window` frames) sheds it for good (until
 * the user changes the blur value). The blur is the first thing to go, before density.
 */
export class BlurShed {
  #sum = 0;
  #n = 0;
  shed = false;

  constructor(
    readonly window = 60,
    readonly limitMs = 10,
  ) {}

  /** True exactly once, when the blur should be dropped now. */
  push(ms: number, blurActive: boolean): boolean {
    if (this.shed || !blurActive) {
      this.#sum = 0;
      this.#n = 0;
      return false;
    }
    this.#sum += ms;
    if (++this.#n < this.window) return false;
    const avg = this.#sum / this.#n;
    this.#sum = 0;
    this.#n = 0;
    if (avg > this.limitMs) {
      this.shed = true;
      return true;
    }
    return false;
  }

  reset(): void {
    this.shed = false;
    this.#sum = 0;
    this.#n = 0;
  }
}

// ---- colors ---------------------------------------------------------------------------------------

export function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === R) h = (G - B) / d + (G < B ? 6 : 0);
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  return [h * 60, s, l];
}

export function hslToRgb(h: number, s: number, l: number): Rgb {
  const hh = (((h % 360) + 360) % 360) / 360;
  const f = (n: number): number => {
    const k = (n + hh * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

export const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];

/** Own warm-to-cool palette used when "Follow app accent" is off. */
export const FIXED_PALETTE: readonly [Rgb, Rgb, Rgb] = [
  [245, 166, 35],
  [150, 96, 214],
  [66, 133, 244],
];

/** Three colors for a preset: the accent with its hue spread 45 degrees each way, or the fixed palette. */
export function bgColors(accent: Rgb | null, follow: boolean): readonly [Rgb, Rgb, Rgb] {
  if (!follow || !accent) return FIXED_PALETTE;
  const [h, s, l] = rgbToHsl(accent);
  const sat = Math.max(0.55, s);
  const lig = clamp(l, 0.5, 0.68);
  return [hslToRgb(h - 45, sat, lig), hslToRgb(h, sat, lig), hslToRgb(h + 45, sat, lig)];
}

/** `bands` colors sampled along the 3-color gradient (the middle color sits at 80%, like the reference look). */
export function gradientBands(colors: readonly [Rgb, Rgb, Rgb], bands: number): Rgb[] {
  const out: Rgb[] = [];
  for (let i = 0; i < bands; i++) {
    const p = bands === 1 ? 0 : i / (bands - 1);
    out.push(p < 0.8 ? mixRgb(colors[0], colors[1], p / 0.8) : mixRgb(colors[1], colors[2], (p - 0.8) / 0.2));
  }
  return out;
}

export const rgbaString = (c: Rgb, a: number): string => `rgba(${c[0]},${c[1]},${c[2]},${Math.round(clamp(a, 0, 1) * 1000) / 1000})`;

// Render resolution and frame rate per quality tier: bg-perf.ts (qualityProfile, tierScale).

// ---- adaptive quality -----------------------------------------------------------------------------

export type GovernorVerdict = "ok" | "reduced" | "stop";

/**
 * Watches the per-frame draw cost. Every `window` frames: average above `stopMs` after at least one
 * reduction means stop; above `reduceMs` lowers the density one step (up to `maxLevel`).
 */
export class FrameGovernor {
  #sum = 0;
  #n = 0;
  level = 0;

  constructor(
    readonly window = 60,
    readonly reduceMs = 10,
    readonly stopMs = 16,
    readonly maxLevel = 2,
  ) {}

  /** Share of the particles still drawn. */
  get factor(): number {
    return [1, 0.6, 0.35][Math.min(this.level, 2)]!;
  }

  push(ms: number): GovernorVerdict {
    this.#sum += ms;
    if (++this.#n < this.window) return "ok";
    const avg = this.#sum / this.#n;
    this.#sum = 0;
    this.#n = 0;
    if (avg > this.stopMs && this.level >= 1) return "stop";
    if (avg > this.reduceMs && this.level < this.maxLevel) {
      this.level += 1;
      return "reduced";
    }
    if (avg > this.stopMs) return "stop";
    return "ok";
  }

  reset(): void {
    this.#sum = 0;
    this.#n = 0;
    this.level = 0;
  }
}

// ---- small math -----------------------------------------------------------------------------------

export const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Deterministic PRNG (mulberry32) so layouts are testable. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
