import type { BgKind } from "./bg-model.js";

/**
 * Pure performance model of the full-app backgrounds (Ocean, Gradient drift, Starfield).
 *
 * What costs the app is not our draw() (< 1 ms) but every frame we produce: the GPU process replays the canvas
 * commands (strokes, fills) and re-composites the whole 4K window, competing with the app's own frames (typing,
 * scrolling, streamed chat). A/B on rig: hiding the canvas but still drawing cost nearly the same, opaque app
 * surfaces did not help, a still frame cost about nothing; fps and internal pixels did. So the
 * levers are: fewer frames (fps cap, freezing during input and streaming), fewer pixels (internal resolution), and
 * backing off when real frame delivery suffers. Measured on rig, see docs/artwork-perf.md.
 */

export const BG_QUALITIES = ["auto", "high", "balanced", "low", "static"] as const;
export type BgQuality = (typeof BG_QUALITIES)[number];
export type BgTier = Exclude<BgQuality, "auto">;
export const BG_QUALITY_LABELS: Record<BgQuality, string> = {
  auto: "Auto (recommended)",
  high: "High (heavy: full frame rate)",
  balanced: "Balanced",
  low: "Low",
  static: "Static",
};
/** Tiers from best looking to cheapest. `auto` starts at `AUTO_START` and moves down (and back up) by itself. */
export const TIERS: readonly BgTier[] = ["high", "balanced", "low", "static"];
export const AUTO_START: BgTier = "balanced";

export function isBgQuality(value: unknown): value is BgQuality {
  return typeof value === "string" && (BG_QUALITIES as readonly string[]).includes(value);
}

export interface QualityProfile {
  /** Frames per second; 0 means one still frame (re-drawn on resize and theme changes only). */
  fps: number;
  /** Internal pixels per CSS pixel, before the pixel budget. The canvas is scaled up by CSS. */
  scale: number;
  /** Internal pixel budget. */
  maxPixels: number;
}

/** Soft presets (blobs, sparse dots) look the same at a fraction of the resolution; letters and dashes need more. */
const SCALE: Record<BgKind, Record<BgTier, number>> = {
  ocean: { high: 1.25, balanced: 1, low: 0.75, static: 1 },
  starfield: { high: 1, balanced: 0.75, low: 0.6, static: 0.75 },
  drift: { high: 0.25, balanced: 0.2, low: 0.15, static: 0.2 },
};
const FPS: Record<BgKind, Record<BgTier, number>> = {
  ocean: { high: 30, balanced: 20, low: 12, static: 0 },
  starfield: { high: 30, balanced: 20, low: 12, static: 0 },
  drift: { high: 30, balanced: 20, low: 10, static: 0 },
};
const PIXELS: Record<BgTier, number> = { high: 2_500_000, balanced: 1_500_000, low: 800_000, static: 1_500_000 };

export function qualityProfile(kind: BgKind, tier: BgTier): QualityProfile {
  return { fps: FPS[kind][tier], scale: SCALE[kind][tier], maxPixels: PIXELS[tier] };
}

/** The tier a quality setting starts at. */
export const startTier = (q: BgQuality): BgTier => (q === "auto" ? AUTO_START : q);

/** Canvas scale (internal px per CSS px): the tier's scale, never above the device ratio, reduced to fit the budget. */
export function tierScale(cssW: number, cssH: number, dpr: number, p: Pick<QualityProfile, "scale" | "maxPixels">): number {
  if (!(cssW > 0) || !(cssH > 0)) return Math.min(1, p.scale);
  const cap = Math.min(Math.max(dpr || 1, 0.1), p.scale);
  return Math.max(0.05, Math.min(cap, Math.sqrt(p.maxPixels / (cssW * cssH))));
}

// ---- activity gate ----------------------------------------------------------------------------------

export const INPUT_QUIET_MS = 1200;
export const STREAM_QUIET_MS = 1500;
/** DOM mutation records per second that count as "the chat is streaming" (a ticking clock stays below). */
export const STREAM_RATE = 12;

/**
 * Decides whether the user is busy with the app: typing, scrolling, clicking, or the app streaming output
 * (a burst of DOM mutations). While busy, the background freezes on its current frame, so the compositor only
 * has the app's own frames to produce.
 */
export class ActivityGate {
  #until = 0;
  #bucketStart = -Infinity;
  #bucketCount = 0;

  constructor(
    readonly inputQuietMs = INPUT_QUIET_MS,
    readonly streamQuietMs = STREAM_QUIET_MS,
    readonly streamRate = STREAM_RATE,
  ) {}

  /** Key, wheel, scroll or pointer down. Returns true when this starts a busy period. */
  input(now: number): boolean {
    const was = this.busy(now);
    this.#until = Math.max(this.#until, now + this.inputQuietMs);
    return !was;
  }

  /** `count` mutation records arrived. Returns true when this starts a busy period. */
  mutations(count: number, now: number): boolean {
    if (now - this.#bucketStart >= 1000) {
      this.#bucketStart = now;
      this.#bucketCount = 0;
    }
    this.#bucketCount += count;
    if (this.#bucketCount < this.streamRate) return false;
    const was = this.busy(now);
    this.#until = Math.max(this.#until, now + this.streamQuietMs);
    return !was;
  }

  busy(now: number): boolean {
    return now < this.#until;
  }

  /** Milliseconds until the gate opens (0 when idle). */
  remaining(now: number): number {
    return Math.max(0, this.#until - now);
  }

  reset(): void {
    this.#until = 0;
    this.#bucketStart = -Infinity;
    this.#bucketCount = 0;
  }
}

// ---- adaptive quality (auto) ------------------------------------------------------------------------

export interface GovernorLimits {
  /** Evaluation window. */
  windowMs: number;
  /** Average draw cost above this is "slow". */
  drawMs: number;
  /** Share of drawn frames that came more than `stallMs` after they were due (the main thread was blocked). */
  lateRatio: number;
  stallMs: number;
  /**
   * Lateness above this is not a main-thread stall but the window being minimized or occluded (Chromium throttles
   * frames to ~2/s there): ignored, or one minimize would cost a tier (seen on rig: Ocean fell to Low).
   */
  throttledMs: number;
  /** Long animation frame blocking time per window above this is "janky". */
  blockingMs: number;
  /** Clean windows in a row before stepping back up. */
  recoverWindows: number;
}

export const GOVERNOR_LIMITS: GovernorLimits = { windowMs: 3000, drawMs: 4, lateRatio: 0.25, stallMs: 50, throttledMs: 250, blockingMs: 150, recoverWindows: 5 };

export type QualityVerdict = "keep" | "down" | "up";

/**
 * The `auto` quality: watches what the user feels, not only our draw time. Every window it looks at the average
 * draw cost, how often the main thread was blocked between our frames, and the long-animation-frame blocking time
 * of the whole page. Any of them over the limit steps one tier down (balanced -> low -> static); a run of clean
 * windows steps one tier back up, never above the start tier.
 */
export class QualityGovernor {
  level: number;
  #windowStart = -1;
  #drawSum = 0;
  #draws = 0;
  #late = 0;
  #blocking = 0;
  #clean = 0;

  constructor(
    readonly start: BgTier = AUTO_START,
    readonly limits: GovernorLimits = GOVERNOR_LIMITS,
  ) {
    this.level = TIERS.indexOf(start);
  }

  get tier(): BgTier {
    return TIERS[this.level]!;
  }

  /** One drawn frame: its draw cost and how late it came (ms after it was due). */
  frame(drawMs: number, lateMs: number): void {
    if (lateMs > this.limits.throttledMs) return;
    this.#drawSum += drawMs;
    this.#draws++;
    if (lateMs > this.limits.stallMs) this.#late++;
  }

  /** Long-animation-frame blocking time observed on the page (any source). */
  blocking(ms: number): void {
    this.#blocking += ms;
  }

  /** Call regularly (about once a second); returns a verdict at the end of each window. */
  tick(now: number): QualityVerdict {
    if (this.#windowStart < 0) this.#windowStart = now;
    if (now - this.#windowStart < this.limits.windowMs) return "keep";
    const avg = this.#draws ? this.#drawSum / this.#draws : 0;
    const late = this.#draws >= 5 ? this.#late / this.#draws : 0;
    const bad = avg > this.limits.drawMs || late > this.limits.lateRatio || this.#blocking > this.limits.blockingMs;
    this.#windowStart = now;
    this.#drawSum = 0;
    this.#draws = 0;
    this.#late = 0;
    this.#blocking = 0;
    if (bad) {
      this.#clean = 0;
      if (this.level < TIERS.length - 1) {
        this.level++;
        return "down";
      }
      return "keep";
    }
    if (++this.#clean >= this.limits.recoverWindows && this.level > TIERS.indexOf(this.start)) {
      this.#clean = 0;
      this.level--;
      return "up";
    }
    return "keep";
  }

  reset(): void {
    this.level = TIERS.indexOf(this.start);
    this.#windowStart = -1;
    this.#drawSum = 0;
    this.#draws = 0;
    this.#late = 0;
    this.#blocking = 0;
    this.#clean = 0;
  }
}
