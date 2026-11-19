import { activity } from "./bg-activity.js";
import { bgColors, bgParams, blitBlurred, blurPx, blurRenderFactor, BlurShed, FrameGovernor, gradientBands, type BgConfig, type BgParams, type BgPresetKind } from "./bg-model.js";
import { QualityGovernor, qualityProfile, startTier, tierScale, type BgTier, type QualityProfile } from "./bg-perf.js";
import { parseRgb, type Rgb } from "./model.js";
import { markSurfaces } from "./ocean.js";

/**
 * Shared shell of the full-app background presets (everything except Ocean):
 * - one fixed, click-through root behind the app (`z-index:-1`, `pointer-events:none`), inserted as the
 *   first child of <body>; input comes from `window` listeners, never from the root;
 * - the opaque viewport-sized app layers are made transparent while it runs (`markSurfaces`), exactly
 *   like Ocean and the Custom background;
 * - pauses at once while the document is hidden and after the window has been blurred for 5 s;
 * - draws one still frame under `prefers-reduced-motion`, speed 0 or the Static quality;
 * - freezes on its current frame while the user types or scrolls and while the chat streams (`pauseWhileTyping`),
 *   so the compositor only has the app's own frames to produce (see `bg-perf.ts` for why that is the real cost);
 * - quality `auto`: a `QualityGovernor` steps the tier down (and back up) from real frame delivery;
 * - `stop()` removes the root, style, attributes, timers and listeners.
 */

export const BLUR_PAUSE_MS = 5000;
export const THEME_POLL_MS = 1000;
/** Surfaces and theme are re-checked every this many polls (each check forces a style and layout flush). */
export const SURFACE_EVERY = 2;

export interface BgHost {
  config(): BgConfig;
  /** The adaptive-quality governor gave up (still too slow after reducing). The layer has stopped. */
  onAutoStop?(kind: BgPresetKind): void;
  /** The auto quality moved to another tier. */
  onTier?(kind: BgPresetKind, tier: BgTier): void;
}

export const bgIds = (kind: BgPresetKind): { root: string; style: string; attr: string; clear: string } => ({
  root: `t3p-bg-${kind}`,
  style: `t3p-bg-${kind}-style`,
  attr: `data-t3p-bg-${kind}`,
  clear: `data-t3p-bg-${kind}-clear`,
});

export function baseCss(kind: BgPresetKind): string {
  const { root, attr, clear } = bgIds(kind);
  return `
html[${attr}]{background-color:var(--background,canvas)!important}
html[${attr}] body,html[${attr}] #root,html[${attr}] [data-slot="sidebar-wrapper"],html[${attr}] [data-slot="sidebar-inset"]{background-color:transparent!important}
html[${attr}] [${clear}]{background-color:transparent!important}
#${root}{position:fixed;inset:0;z-index:-1;pointer-events:none;display:block;overflow:hidden;contain:strict}
`;
}

/** Computes any CSS color expression (`var()`, `oklch()`, relative colors) to an `rgb(...)` string. */
function computedColor(expr: string): string {
  const probe = document.createElement("i");
  probe.style.cssText = `position:fixed;left:-9999px;top:0;width:0;height:0;pointer-events:none;color:${expr}`;
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

export abstract class BgLayer {
  protected cfg!: BgConfig;
  protected params!: BgParams;
  protected root: HTMLElement | null = null;
  #style: HTMLStyleElement | null = null;
  #poll: ReturnType<typeof setInterval> | null = null;
  #blurTimer: ReturnType<typeof setTimeout> | null = null;
  #hidden = false;
  #blurred = false;
  #autoStopped = false;
  #frozen = false;
  #unsubscribe: (() => void) | null = null;
  #polls = 0;
  /** Adaptive quality for `auto`; null for a fixed tier. */
  protected quality: QualityGovernor | null = null;
  /** Current render tier. */
  tier: BgTier = "high";
  #blurSeen = -1;
  /** Drops the blur when frames get slow (a changed blur setting arms it again). */
  protected readonly blurShed = new BlurShed();

  constructor(
    readonly kind: BgPresetKind,
    protected readonly host: BgHost,
  ) {}

  get running(): boolean {
    return this.root !== null;
  }

  /** The user's whole config says this layer is on. */
  get autoStopped(): boolean {
    return this.#autoStopped;
  }

  /** Applies the current config: starts, retunes or stops. Cheap, call it on every setting change. */
  update(): void {
    const cfg = this.host.config();
    if (!cfg.on) {
      this.#autoStopped = false;
      this.stop();
      return;
    }
    if (this.#autoStopped) return;
    this.cfg = cfg;
    if (cfg.quality === "auto") this.quality ??= new QualityGovernor();
    else this.quality = null;
    this.tier = this.quality ? this.quality.tier : startTier(cfg.quality);
    this.params = bgParams(this.kind, cfg, this.tier);
    if (cfg.blur !== this.#blurSeen) {
      this.#blurSeen = cfg.blur;
      this.blurShed.reset();
    }
    if (!this.root) this.#start();
    this.#syncActivity();
    this.configure();
    this.applyBlur();
    this.#markSurfaces();
    this.syncRunning();
  }

  stop(): void {
    if (!this.root && !this.#style) return;
    this.halt();
    if (this.#poll) clearInterval(this.#poll);
    this.#poll = null;
    if (this.#blurTimer) clearTimeout(this.#blurTimer);
    this.#blurTimer = null;
    window.removeEventListener("blur", this.#onBlur);
    window.removeEventListener("focus", this.#onFocus);
    document.removeEventListener("visibilitychange", this.#onVisibility);
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#frozen = false;
    this.quality = null;
    this.teardown();
    this.root?.remove();
    this.#style?.remove();
    this.root = null;
    this.#style = null;
    this.#hidden = false;
    this.#blurred = false;
    this.#blurSeen = -1;
    this.blurShed.reset();
    const { attr, clear } = bgIds(this.kind);
    for (const el of Array.from(document.querySelectorAll(`[${clear}]`))) el.removeAttribute(clear);
    document.documentElement.removeAttribute(attr);
  }

  /** Stops for good (until the user switches it off and on): used by the adaptive governor. */
  protected autoStop(): void {
    this.#autoStopped = true;
    this.stop();
    this.host.onAutoStop?.(this.kind);
  }

  // ---- hooks ---------------------------------------------------------------------------------------

  /** Extra CSS for the preset (the shared rules are added by the base). */
  protected abstract css(): string;
  protected abstract create(): HTMLElement;
  /** Called on every update with `this.cfg` / `this.params` fresh. */
  protected configure(): void {}
  /** Called once after the root is in the document. */
  protected mounted(): void {}
  /** The layer should animate now (visible, focused, not reduced, speed above 0). */
  protected abstract run(): void;
  /** Stop animating; keep what is on screen. */
  protected abstract halt(): void;
  /** Draw one still frame. */
  protected abstract still(): void;
  protected teardown(): void {}
  /** The blur radius in px that applies now (0 when off or shed). */
  protected effectiveBlur(): number {
    return blurPx(this.cfg.blur, this.blurShed.shed);
  }
  /** Applies {@link effectiveBlur} to the layer. Called after every `configure`. */
  protected applyBlur(): void {}
  /** Called when the page theme may have changed (about every two seconds, never while the user is busy). */
  protected themeTick(): void {}
  /** The render tier changed (auto quality): re-size the backing store etc. `this.params` is fresh. */
  protected tierChanged(): void {}

  /** The current tier's profile. */
  protected get profile(): QualityProfile {
    return qualityProfile(this.kind, this.tier);
  }

  // ---- shared state --------------------------------------------------------------------------------

  protected get paused(): boolean {
    return this.#hidden || this.#blurred || this.#frozen;
  }

  /** Frozen because the user is typing, scrolling or the chat streams. */
  get frozen(): boolean {
    return this.#frozen;
  }

  protected reduced(): boolean {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  }

  /** Starts, pauses or draws a still frame, depending on visibility, focus, motion preference and speed. */
  protected syncRunning(): void {
    if (!this.root) return;
    if (!this.params.animated || this.reduced()) {
      this.halt();
      this.still();
    } else if (this.paused) this.halt();
    else this.run();
  }

  #start(): void {
    const ids = bgIds(this.kind);
    const style = document.createElement("style");
    style.id = ids.style;
    style.textContent = baseCss(this.kind) + this.css();
    document.head.appendChild(style);
    this.#style = style;
    const root = this.create();
    root.id = ids.root;
    root.setAttribute("aria-hidden", "true");
    document.body.insertBefore(root, document.body.firstChild);
    this.root = root;
    document.documentElement.setAttribute(ids.attr, "");
    this.mounted();
    this.#hidden = document.hidden;
    this.#blurred = false;
    window.addEventListener("blur", this.#onBlur);
    window.addEventListener("focus", this.#onFocus);
    document.addEventListener("visibilitychange", this.#onVisibility);
    this.#poll = setInterval(() => this.#tick(), THEME_POLL_MS);
  }

  #tick(): void {
    if (this.quality) {
      const verdict = this.quality.tick(performance.now());
      if (verdict === "down" && this.effectiveBlur() > 0) {
        // Frames are late: the blur goes first, the tier stays (the next bad window lowers it).
        this.quality.level -= 1;
        this.blurShed.shed = true;
        this.applyBlur();
      } else if (verdict !== "keep") this.#setTier(this.quality.tier);
    }
    // markSurfaces and the palette read computed styles (a forced style/layout flush): not while the user is busy.
    if (this.#frozen || ++this.#polls % SURFACE_EVERY !== 0) return;
    this.#markSurfaces();
    this.themeTick();
  }

  #setTier(tier: BgTier): void {
    if (tier === this.tier || !this.root) return;
    this.tier = tier;
    this.params = bgParams(this.kind, this.cfg, tier);
    this.host.onTier?.(this.kind, tier);
    this.tierChanged();
    this.syncRunning();
  }

  /** Long animation frames anywhere on the page, for the auto quality; only while we animate (not our fault otherwise). */
  protected noteBlocking(ms: number): void {
    if (!this.paused) this.quality?.blocking(ms);
  }

  #syncActivity(): void {
    const want = this.cfg.pauseWhileTyping;
    if (want && !this.#unsubscribe) {
      this.#unsubscribe = activity.subscribe({
        busy: (on) => {
          if (on === this.#frozen) return;
          this.#frozen = on;
          this.syncRunning();
        },
        blocking: (ms) => this.noteBlocking(ms),
      });
      this.#frozen = activity.busy;
    } else if (!want && this.#unsubscribe) {
      this.#unsubscribe();
      this.#unsubscribe = null;
      this.#frozen = false;
    }
  }

  #markSurfaces(): void {
    if (this.root) markSurfaces(this.root, bgIds(this.kind).clear);
  }

  readonly #onVisibility = (): void => {
    this.#hidden = document.hidden;
    this.syncRunning();
  };
  readonly #onBlur = (): void => {
    if (this.#blurTimer) clearTimeout(this.#blurTimer);
    this.#blurTimer = setTimeout(() => {
      this.#blurTimer = null;
      this.#blurred = true;
      this.syncRunning();
    }, BLUR_PAUSE_MS);
  };
  readonly #onFocus = (): void => {
    if (this.#blurTimer) clearTimeout(this.#blurTimer);
    this.#blurTimer = null;
    if (!this.#blurred) return;
    this.#blurred = false;
    this.syncRunning();
  };
}

// ---- canvas presets -------------------------------------------------------------------------------

const STEP = 1 / 60;
const MAX_STEPS = 4;

interface PerfWindow {
  __t3pBgPerf?: number[];
}

/** A preset drawn on a fixed 2D canvas: reduced resolution, fixed time step, adaptive quality. */
export abstract class CanvasBg extends BgLayer {
  protected canvas!: HTMLCanvasElement;
  protected ctx: CanvasRenderingContext2D | null = null;
  /** CSS size of the viewport and the internal scale. */
  protected w = 0;
  protected h = 0;
  protected scale = 1;
  /** Simulation time in seconds (already multiplied by the speed). */
  protected time = 0;
  /** Pointer position in CSS px, and whether it moved recently. */
  protected px = 0;
  protected py = 0;
  protected pointerAt = -1e9;
  protected readonly governor = new FrameGovernor();
  /** Palette: 3 base colors and gradient bands, re-read about once a second. */
  protected colors: readonly [Rgb, Rgb, Rgb] = bgColors(null, false);
  protected bands: Rgb[] = [];
  /** Draw cost of the last 60 frames, for the "measure on rig" notes. */
  lastAvgMs = 0;
  frames = 0;

  #raf = 0;
  #last = 0;
  /** Time of the previous rAF callback (drawn or skipped), for the frame-delivery gaps. */
  #lastCb = 0;
  #acc = 0;
  #costSum = 0;
  #costN = 0;
  #paletteKey = "";
  #resizeTimer: ReturnType<typeof setTimeout> | null = null;
  #probe: CanvasRenderingContext2D | null = null;
  /** Offscreen canvas the preset draws into while a blur is on; it is blitted blurred onto the visible canvas. */
  #src: HTMLCanvasElement | null = null;
  #srcCtx: CanvasRenderingContext2D | null = null;

  protected create(): HTMLElement {
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "width:100%;height:100%;display:block";
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: true });
    window.addEventListener("resize", this.#onResize);
    window.addEventListener("pointermove", this.#onMove, { passive: true });
    this.px = window.innerWidth / 2;
    this.py = window.innerHeight / 2;
    return canvas;
  }

  protected override mounted(): void {
    this.#resize();
  }

  protected override teardown(): void {
    window.removeEventListener("resize", this.#onResize);
    window.removeEventListener("pointermove", this.#onMove);
    if (this.#resizeTimer) clearTimeout(this.#resizeTimer);
    this.#resizeTimer = null;
    this.ctx = null;
    this.#src = null;
    this.#srcCtx = null;
    this.#probe = null;
    this.#paletteKey = "";
    this.#appliedBlur = -1;
    this.governor.reset();
    this.#costSum = 0;
    this.#costN = 0;
  }

  protected override configure(): void {
    if (this.ctx && this.root && Math.abs(this.#scaleFor() - this.scale) > 1e-3) this.#resize();
    this.refreshPalette(true);
  }

  protected override tierChanged(): void {
    if (Math.abs(this.#scaleFor() - this.scale) > 1e-3) this.#resize();
  }

  #scaleFor(): number {
    const w = document.documentElement.clientWidth || window.innerWidth;
    return Math.max(0.05, tierScale(w, window.innerHeight, window.devicePixelRatio || 1, this.profile) * this.blurResolution());
  }

  /** Share of the tier resolution rendered under the current blur (detail is lost anyway). Drift bakes its blur in. */
  protected blurResolution(): number {
    return blurRenderFactor(this.effectiveBlur());
  }

  /** Blur radius drawn into the canvas (0 for presets that bake their blur in, like Gradient drift). */
  protected canvasBlur(): number {
    return this.effectiveBlur();
  }

  #appliedBlur = -1;
  /**
   * Blur is drawn into the canvas, never a CSS `filter`: a filtered layer is re-run through the filter
   * on every composite of the page above it (typing, streaming), even while this canvas is frozen
   * (+15 GPU points on rig 4K). The preset draws into an offscreen canvas at reduced resolution and each
   * drawn frame is blitted once through `ctx.filter = blur()`; a frozen layer costs nothing.
   */
  protected override applyBlur(): void {
    const px = this.canvasBlur();
    this.canvas.style.filter = "";
    this.canvas.style.transform = "";
    this.canvas.style.willChange = "";
    if (px !== this.#appliedBlur) {
      this.#appliedBlur = px;
      if (this.w > 0 && this.ctx) this.#resize();
    }
  }

  protected override themeTick(): void {
    this.refreshPalette(false);
  }

  // ---- hooks ---------------------------------------------------------------------------------------

  /** Rebuild layout for a viewport of `w` x `h` CSS px. */
  protected abstract layout(w: number, h: number): void;
  /** Advance the simulation by a fixed step `dt` (seconds, already scaled by speed). */
  protected abstract step(dt: number): void;
  protected abstract draw(ctx: CanvasRenderingContext2D): void;
  /** The palette changed (colors/bands are fresh). */
  protected paletteChanged(_fg: Rgb): void {}

  // ---- loop ----------------------------------------------------------------------------------------

  protected run(): void {
    if (this.#raf) return;
    this.#last = 0;
    this.#lastCb = 0;
    this.#acc = 0;
    this.#raf = requestAnimationFrame(this.#loop);
  }

  protected halt(): void {
    if (this.#raf) cancelAnimationFrame(this.#raf);
    this.#raf = 0;
  }

  protected still(): void {
    this.paintOnce();
  }

  /** Paints a frame without advancing time. */
  protected paintOnce(): void {
    if (!this.ctx || this.bands.length === 0) return;
    const target = this.#srcCtx && this.#src ? this.#srcCtx : this.ctx;
    target.clearRect(0, 0, this.w, this.h);
    this.draw(target);
    if (target === this.#srcCtx && this.#src) blitBlurred(this.canvas, this.#src, this.canvasBlur(), this.scale);
  }

  readonly #loop = (ms: number): void => {
    this.#raf = requestAnimationFrame(this.#loop);
    const gap = this.#lastCb ? ms - this.#lastCb : 0;
    this.#lastCb = ms;
    const interval = 1000 / Math.max(1, this.params.maxFps);
    if (this.#last && ms - this.#last < interval - 1.5) return;
    const elapsed = this.#last ? ms - this.#last : interval;
    this.#last = ms;
    // dt clamping: a long stall (tab switch, GC, breakpoint) advances at most 100 ms.
    this.#acc += Math.min(elapsed, 100) / 1000;
    let n = 0;
    while (this.#acc >= STEP && n < MAX_STEPS) {
      const dt = STEP * this.params.speed;
      this.time += dt;
      this.step(dt);
      this.#acc -= STEP;
      n++;
    }
    if (this.#acc > STEP) this.#acc = 0;
    const began = performance.now();
    this.paintOnce();
    const cost = performance.now() - began;
    this.frames++;
    const log = (window as unknown as PerfWindow).__t3pBgPerf;
    if (Array.isArray(log) && log.length < 20000) log.push(cost);
    this.#costSum += cost;
    if (++this.#costN === 60) {
      this.lastAvgMs = this.#costSum / 60;
      this.#costSum = 0;
      this.#costN = 0;
    }
    this.quality?.frame(cost, gap);
    const verdict = this.governor.push(cost);
    if (verdict === "reduced" && this.effectiveBlur() > 0) {
      // Slow frames: the blur goes first, the density stays.
      this.governor.level -= 1;
      this.blurShed.shed = true;
      this.applyBlur();
    } else if (verdict === "reduced") this.layout(this.w, this.h);
    else if (verdict === "stop") this.autoStop();
  };

  // ---- input and size ------------------------------------------------------------------------------

  readonly #onMove = (e: PointerEvent): void => {
    if (!this.cfg?.pointer) return;
    this.px = e.clientX;
    this.py = e.clientY;
    this.pointerAt = performance.now();
  };

  readonly #onResize = (): void => {
    if (this.#resizeTimer) clearTimeout(this.#resizeTimer);
    this.#resizeTimer = setTimeout(() => {
      this.#resizeTimer = null;
      this.#resize();
    }, 120);
  };

  #resize(): void {
    const ctx = this.ctx;
    if (!ctx || !this.root) return;
    const w = document.documentElement.clientWidth || window.innerWidth;
    const h = window.innerHeight;
    this.w = w;
    this.h = h;
    this.scale = this.#scaleFor();
    this.canvas.width = Math.max(1, Math.ceil(w * this.scale));
    this.canvas.height = Math.max(1, Math.ceil(h * this.scale));
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    this.#appliedBlur = this.canvasBlur();
    if (this.#appliedBlur > 0) {
      const src = this.#src ?? document.createElement("canvas");
      src.width = this.canvas.width;
      src.height = this.canvas.height;
      const sctx = src.getContext("2d", { alpha: true });
      sctx?.setTransform(this.scale, 0, 0, this.scale, 0, 0);
      this.#src = sctx ? src : null;
      this.#srcCtx = sctx;
    } else {
      this.#src = null;
      this.#srcCtx = null;
    }
    this.layout(w, h);
    if (!this.#raf) this.paintOnce();
  }

  // ---- palette -------------------------------------------------------------------------------------

  /** Any CSS color expression (`var()`, relative colors) resolved on the page, then to rgb. */
  protected resolve(expr: string): Rgb | null {
    return this.toRgb(computedColor(expr));
  }

  /** Any CSS color to rgb: parsed directly, or resolved through a 1x1 canvas (oklch, color-mix, names). */
  protected toRgb(css: string): Rgb | null {
    const direct = parseRgb(css);
    if (direct) return direct;
    try {
      this.#probe ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
      const p = this.#probe;
      if (!p) return null;
      p.clearRect(0, 0, 1, 1);
      p.fillStyle = "#000";
      p.fillStyle = css;
      p.fillRect(0, 0, 1, 1);
      const d = p.getImageData(0, 0, 1, 1).data;
      return [d[0]!, d[1]!, d[2]!];
    } catch {
      return null;
    }
  }

  protected refreshPalette(force: boolean): void {
    if (!this.root) return;
    const fgText = computedColor("var(--foreground, currentColor)");
    const accentExpr = this.cfg.hue < 0 ? "var(--primary, oklch(0.72 0.15 165))" : `oklch(0.74 0.15 ${Math.round(this.cfg.hue) % 360})`;
    const accentText = this.cfg.followAccent ? computedColor(accentExpr) : "";
    const key = `${fgText}|${accentText}|${this.cfg.followAccent}`;
    if (!force && key === this.#paletteKey) return;
    this.#paletteKey = key;
    const fg = this.toRgb(fgText) ?? [200, 205, 215];
    const accent = accentText ? this.toRgb(accentText) : null;
    this.colors = bgColors(accent, this.cfg.followAccent);
    this.bands = gradientBands(this.colors, 5);
    this.paletteChanged(fg);
    if (!this.#raf) this.paintOnce();
  }
}
