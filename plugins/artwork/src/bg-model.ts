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

export const BG_KEYS = ["bgIntensity", "bgSpeed", "bgDensity", "bgPointer", "bgFollowAccent", "bgLowPower"] as const;

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

export function bgParams(kind: BgPresetKind, cfg: Pick<BgConfig, "intensity" | "speed" | "density" | "lowPower">): BgParams {
  const speed = clamp(cfg.speed, 0, 100) / 50;
  const d = clamp(cfg.density, 0, 100) / 100;
  const count = kind === "starfield" ? Math.round(STARFIELD_MIN + d * STARFIELD_SPAN) : Math.round(ANTIGRAVITY_MIN + d * ANTIGRAVITY_SPAN);
  return {
    alpha: Math.round((clamp(cfg.intensity, 0, 100) / 60) * 1000) / 1000,
    speed,
    animated: speed > 0,
    count,
    // The starfield is 30 fps by design; Low power caps the others too.
    maxFps: kind === "starfield" || cfg.lowPower ? 30 : 60,
  };
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

// ---- render resolution ----------------------------------------------------------------------------

/** Device pixel ratio cap for every canvas preset. */
export const MAX_DPR = 1.5;
/** Internal pixel budget: a 4K screen renders at about 1080p-class resolution and is scaled up by CSS. */
export const MAX_PIXELS = 2_500_000;

/** Canvas scale (internal px per CSS px): dpr capped at 1.5, then reduced to fit the pixel budget. */
export function renderScale(cssW: number, cssH: number, dpr: number, maxDpr = MAX_DPR, maxPixels = MAX_PIXELS): number {
  if (!(cssW > 0) || !(cssH > 0)) return 1;
  const cap = Math.min(Math.max(dpr || 1, 0.5), maxDpr);
  return Math.max(0.5, Math.min(cap, Math.sqrt(maxPixels / (cssW * cssH))));
}

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
