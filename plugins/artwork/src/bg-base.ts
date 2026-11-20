import { activity } from "./bg-activity.js";
import { bgColors, bgParams, blitBlurred, blurPx, blurRenderFactor, BlurShed, FrameGovernor, gradientBands, type BgConfig, type BgKind, type BgParams } from "./bg-model.js";
import { QualityGovernor, qualityProfile, startTier, tierScale, type BgTier, type QualityProfile } from "./bg-perf.js";
import { computedColor, markSurfaces, unmarkSurfaces } from "./bg-surfaces.js";
import { parseRgb, type Rgb } from "./model.js";

/**
 * The one engine behind every full-app background (Ocean, Gradient drift, Starfield). A preset only
 * supplies `layout` / `step` / `draw`; this class owns everything with a lifetime:
 *
 * - one fixed, click-through `<canvas>` behind the app (`z-index:-1`, `pointer-events:none`, first child of <body>),
 *   its `<style>`, the `<html>` marker and the big app surfaces it made see-through (`markSurfaces`);
 * - every listener, observer and timer, registered through `#on` / `#later` so `stop()` removes all of them, and a
 *   second `update()` never adds a second set (mount is idempotent, unmount is idempotent);
 * - one frame loop: a timer sleeps until the next frame is due and one `requestAnimationFrame` draws it, so a 20 fps
 *   background wakes the page 20 times a second, not at the display rate (120 Hz on rig);
 * - sizing from a `ResizeObserver` on the canvas (plus a device-pixel-ratio media query for zoom and monitor moves):
 *   the backing store is resized and repainted inside the observer callback, before the browser paints, so a resize
 *   never shows a blank or stretched frame;
 * - theme changes from a `MutationObserver` on `<html>` (class, style, data-theme) and `prefers-color-scheme`, so a
 *   light/dark switch repaints at once, also while the layer is frozen or static;
 * - pause while hidden, 5 s after the window lost focus, and while the user types or the chat streams
 *   (`pauseWhileTyping`); a still frame under reduced motion, speed 0 or the Static quality;
 * - quality `auto` (`QualityGovernor`), the density governor and blur shedding.
 *
 * Root cause of the WP-17 bugs, for the record: Ocean had a second, separate copy of all this (its own loop, poll,
 * listeners and resize path), the loops ran a rAF at the display rate, a resize cleared the canvas and left it blank
 * until the next 20-30 fps frame, and the activity gate counted plugin UI re-renders as streaming.
 */

export const BLUR_PAUSE_MS = 5000;
export const THEME_POLL_MS = 1000;
/** Surfaces and theme are re-checked every this many polls (each check forces a style and layout flush). */
export const SURFACE_EVERY = 2;
/** Frame delays above this sleep on a timer first, then draw on the next animation frame. */
const TIMER_MIN_MS = 12;
/** The timer wakes this much early so the following animation frame lands on time. */
const TIMER_LEAD_MS = 8;

export interface BgHost {
  config(): BgConfig;
  /** The density governor gave up (still too slow after reducing). The layer has stopped. */
  onAutoStop?(kind: BgKind): void;
  /** The auto quality moved to another tier. */
  onTier?(kind: BgKind, tier: BgTier): void;
}

/** DOM ids. Ocean keeps the ids it shipped with, so saved custom CSS and docs that name them keep working. */
export const bgIds = (kind: BgKind): { root: string; style: string; attr: string; clear: string } =>
  kind === "ocean"
    ? { root: "t3p-ocean", style: "t3p-ocean-style", attr: "data-t3p-ocean", clear: "data-t3p-ocean-clear" }
    : { root: `t3p-bg-${kind}`, style: `t3p-bg-${kind}-style`, attr: `data-t3p-bg-${kind}`, clear: `data-t3p-bg-${kind}-clear` };

export function baseCss(kind: BgKind): string {
  const { root, attr, clear } = bgIds(kind);
  return `
html[${attr}]{background-color:var(--background,canvas)!important}
html[${attr}] body,html[${attr}] #root,html[${attr}] [data-slot="sidebar-wrapper"],html[${attr}] [data-slot="sidebar-inset"]{background-color:transparent!important}
html[${attr}] [${clear}]{background-color:transparent!important}
#${root}{position:fixed;inset:0;width:100%;height:100%;z-index:-1;pointer-events:none;display:block;contain:strict}
`;
}

const STEP = 1 / 60;
const MAX_STEPS = 4;

interface PerfWindow {
  __t3pBgPerf?: number[];
}

type Listener = (e: Event) => void;

export abstract class CanvasBg {
  /**
   * Sleep on a timer between frames (the default). Tests that drive frames by hand through a fake
   * `requestAnimationFrame` turn it off to get one rAF per display frame, as a browser without timers would.
   */
  static frameTimers = true;
  protected cfg!: BgConfig;
  protected params!: BgParams;
  protected root: HTMLCanvasElement | null = null;
  protected canvas!: HTMLCanvasElement;
  protected ctx: CanvasRenderingContext2D | null = null;
  /** CSS size of the viewport and the internal scale (canvas px per CSS px). */
  protected w = 0;
  protected h = 0;
  protected scale = 1;
  /** Simulation time in seconds (already multiplied by the speed). */
  protected time = 0;
  /** Pointer position in CSS px, and when it last moved (only while Pointer reactive is on). */
  protected px = 0;
  protected py = 0;
  protected pointerAt = -1e9;
  /** Density governor; presets without a density (Ocean) opt out with {@link usesDensityGovernor}. */
  protected readonly governor = new FrameGovernor();
  protected readonly usesDensityGovernor: boolean = true;
  /** Incremental presets (Ocean) repaint only what changed: the base does not clear the canvas before `draw`. */
  protected readonly incremental: boolean = false;
  /** Palette: 3 base colors, gradient bands and the raw accent, re-read when the theme changes. */
  protected colors: readonly [Rgb, Rgb, Rgb] = bgColors(null, false);
  protected bands: Rgb[] = [];
  protected accent: Rgb | null = null;
  /** Drops the blur when frames get slow (a changed blur setting arms it again). */
  protected readonly blurShed = new BlurShed();
  /** Adaptive quality for `auto`; null for a fixed tier. */
  protected quality: QualityGovernor | null = null;
  /** Current render tier. */
  tier: BgTier = "high";
  /** Draw cost of the last 60 frames, for the "measure on rig" notes. */
  lastAvgMs = 0;
  frames = 0;

  #style: HTMLStyleElement | null = null;
  #disposers: Array<() => void> = [];
  #poll: ReturnType<typeof setInterval> | null = null;
  #blurTimer: ReturnType<typeof setTimeout> | null = null;
  #frameTimer: ReturnType<typeof setTimeout> | null = null;
  #raf = 0;
  #hidden = false;
  #blurred = false;
  #frozen = false;
  #autoStopped = false;
  #unsubscribe: (() => void) | null = null;
  #polls = 0;
  #blurSeen = -1;
  #appliedBlur = -1;
  #last = 0;
  #acc = 0;
  #costSum = 0;
  #costN = 0;
  #advancing = false;
  #paletteKey = "";
  #probe: CanvasRenderingContext2D | null = null;
  /** Offscreen canvas the preset draws into while a blur is on; it is blitted blurred onto the visible canvas. */
  #src: HTMLCanvasElement | null = null;
  #srcCtx: CanvasRenderingContext2D | null = null;
  #dprQuery: MediaQueryList | null = null;

  constructor(
    readonly kind: BgKind,
    protected readonly host: BgHost,
  ) {}

  get running(): boolean {
    return this.root !== null;
  }

  /** The host config says this layer should be on (used to stop the others first when switching). */
  get wanted(): boolean {
    return this.host.config().on;
  }

  /** Stopped by the density governor until the user switches it off and on. */
  get autoStopped(): boolean {
    return this.#autoStopped;
  }

  /** Frozen because the user is typing, scrolling or the chat streams. */
  get frozen(): boolean {
    return this.#frozen;
  }

  /** A frame is scheduled (animation frame or the timer before it). */
  get looping(): boolean {
    return this.#raf !== 0 || this.#frameTimer !== null;
  }

  /** Applies the current config: starts, retunes or stops. Cheap and idempotent: call it on every setting change. */
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
    if (!this.root) this.#mount();
    this.#syncActivity();
    this.configure();
    this.applyBlur();
    this.#markSurfaces();
    this.syncRunning();
  }

  stop(): void {
    if (!this.root && !this.#style) return;
    this.#cancelFrame();
    for (const off of this.#disposers.splice(0).reverse()) {
      try {
        off();
      } catch {
        /* best effort */
      }
    }
    if (this.#poll) clearInterval(this.#poll);
    this.#poll = null;
    if (this.#blurTimer) clearTimeout(this.#blurTimer);
    this.#blurTimer = null;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#frozen = false;
    this.quality = null;
    this.teardown();
    this.root?.remove();
    this.#style?.remove();
    this.root = null;
    this.#style = null;
    this.ctx = null;
    this.#src = null;
    this.#srcCtx = null;
    this.#probe = null;
    this.#dprQuery = null;
    this.#hidden = false;
    this.#blurred = false;
    this.#blurSeen = -1;
    this.#appliedBlur = -1;
    this.#paletteKey = "";
    this.#costSum = 0;
    this.#costN = 0;
    this.w = 0;
    this.h = 0;
    this.blurShed.reset();
    this.governor.reset();
    const { attr, clear } = bgIds(this.kind);
    unmarkSurfaces(clear);
    document.documentElement.removeAttribute(attr);
  }

  /** Stops for good (until the user switches it off and on): used by the density governor. */
  protected autoStop(): void {
    this.#autoStopped = true;
    this.stop();
    this.host.onAutoStop?.(this.kind);
  }

  // ---- hooks ---------------------------------------------------------------------------------------

  /** Extra CSS for the preset (the shared rules are added by the base). */
  protected css(): string {
    return "";
  }
  /** Rebuild layout for a viewport of `w` x `h` CSS px. The canvas was just cleared. */
  protected abstract layout(w: number, h: number): void;
  /** Advance the simulation by a fixed step `dt` (seconds, already scaled by speed). */
  protected abstract step(dt: number): void;
  /** Draw a frame. Incremental presets return false when nothing changed (no blur blit then). */
  protected abstract draw(ctx: CanvasRenderingContext2D): boolean | void;
  /** The palette changed (colors, bands and accent are fresh). */
  protected paletteChanged(_fg: Rgb): void {}
  /** A primary-button press anywhere in the window (the canvas itself never gets events). */
  protected pointerDown(_x: number, _y: number): void {}
  /** The pointer moved (only while Pointer reactive is on); `px`/`py`/`pointerAt` are fresh. */
  protected pointerMoved(): void {}
  protected teardown(): void {}

  /** Called on every update with `this.cfg` / `this.params` fresh. */
  protected configure(): void {
    if (this.ctx && this.root && Math.abs(this.#scaleFor() - this.scale) > 1e-3) this.#resize(true);
    this.refreshPalette(true);
  }

  /** The blur radius in px that applies now (0 when off or shed). */
  protected effectiveBlur(): number {
    return blurPx(this.cfg.blur, this.blurShed.shed);
  }

  /** Share of the tier resolution rendered under the current blur (detail is lost anyway). Drift bakes its blur in. */
  protected blurResolution(): number {
    return blurRenderFactor(this.effectiveBlur());
  }

  /** Blur radius drawn into the canvas (0 for presets that bake their blur in, like Gradient drift). */
  protected canvasBlur(): number {
    return this.effectiveBlur();
  }

  /**
   * Blur is drawn into the canvas, never a CSS `filter`: a filtered layer is re-run through the filter on every
   * composite of the page above it (typing, streaming), even while this canvas is frozen (+15 GPU points on rig 4K).
   * The preset draws into an offscreen canvas and each changed frame is blitted once through `ctx.filter = blur()`.
   */
  protected applyBlur(): void {
    if (!this.root) return;
    const px = this.canvasBlur();
    if (px !== this.#appliedBlur && this.w > 0) this.#resize(true);
  }

  /** The current tier's profile. */
  protected get profile(): QualityProfile {
    return qualityProfile(this.kind, this.tier);
  }

  /** True while the loop is advancing time (false for still frames, resizes and palette repaints). */
  protected get advancing(): boolean {
    return this.#advancing;
  }

  /** Where the preset draws: the offscreen source while a blur is on, else the visible canvas. */
  protected get target(): CanvasRenderingContext2D | null {
    return this.#srcCtx ?? this.ctx;
  }

  /** Size of the drawing target in canvas px. */
  protected get targetSize(): { width: number; height: number } {
    const c = this.#src ?? this.canvas;
    return { width: c.width, height: c.height };
  }

  // ---- shared state --------------------------------------------------------------------------------

  protected get paused(): boolean {
    return this.#hidden || this.#blurred || this.#frozen;
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
      this.#cancelFrame();
      this.paintOnce();
    } else if (this.paused) this.#cancelFrame();
    else if (!this.looping) {
      this.#last = 0;
      this.#acc = 0;
      this.#raf = requestAnimationFrame(this.#loop);
    }
  }

  // ---- mount / unmount -----------------------------------------------------------------------------

  #on(target: EventTarget, type: string, fn: Listener, opts?: AddEventListenerOptions): void {
    target.addEventListener(type, fn, opts);
    this.#disposers.push(() => target.removeEventListener(type, fn, opts));
  }

  #mount(): void {
    const ids = bgIds(this.kind);
    const style = document.createElement("style");
    style.id = ids.style;
    style.textContent = baseCss(this.kind) + this.css();
    document.head.appendChild(style);
    this.#style = style;
    const canvas = document.createElement("canvas");
    canvas.id = ids.root;
    canvas.setAttribute("aria-hidden", "true");
    this.canvas = canvas;
    this.root = canvas;
    document.body.insertBefore(canvas, document.body.firstChild);
    document.documentElement.setAttribute(ids.attr, "");
    this.ctx = canvas.getContext("2d", { alpha: true });
    this.px = window.innerWidth / 2;
    this.py = window.innerHeight / 2;
    this.#hidden = document.hidden;
    this.#blurred = false;
    // Input from window, never from the canvas: it ignores pointer events so the app keeps every click.
    this.#on(window, "pointermove", this.#onMove as Listener, { passive: true });
    this.#on(window, "pointerdown", this.#onDown as Listener, { passive: true });
    this.#on(window, "blur", this.#onBlur);
    this.#on(window, "focus", this.#onFocus);
    this.#on(document, "visibilitychange", this.#onVisibility);
    // A lost GPU context (driver reset, long sleep) comes back blank: repaint everything.
    this.#on(canvas, "contextrestored", () => this.#resize(true));
    if (typeof ResizeObserver === "function") {
      const ro = new ResizeObserver(() => this.#resize(false));
      ro.observe(canvas);
      this.#disposers.push(() => ro.disconnect());
    } else this.#on(window, "resize", () => this.#resize(false));
    this.#watchDpr();
    if (typeof MutationObserver === "function") {
      const mo = new MutationObserver(() => this.refreshPalette(false));
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
      this.#disposers.push(() => mo.disconnect());
    }
    this.#onMedia("(prefers-color-scheme: dark)", () => this.refreshPalette(false));
    this.#poll = setInterval(() => this.#tick(), THEME_POLL_MS);
    this.#resize(true);
  }

  /** Listens to a media query's `change` (guarded: older engines and test stubs lack it). */
  #onMedia(query: string, fn: () => void): MediaQueryList | null {
    try {
      const mq = window.matchMedia(query);
      if (typeof mq?.addEventListener !== "function") return null;
      mq.addEventListener("change", fn);
      this.#disposers.push(() => mq.removeEventListener("change", fn));
      return mq;
    } catch {
      return null;
    }
  }

  /** Device pixel ratio changes (zoom, moving to another monitor) do not always resize the canvas box: watch them. */
  #watchDpr(): void {
    const dpr = window.devicePixelRatio || 1;
    const mq = this.#onMedia(`(resolution: ${dpr}dppx)`, () => {
      if (this.#dprQuery !== mq) return;
      this.#dprQuery = null;
      this.#resize(false);
      if (this.root) this.#watchDpr();
    });
    this.#dprQuery = mq;
  }

  // ---- loop ----------------------------------------------------------------------------------------

  #cancelFrame(): void {
    if (this.#raf) cancelAnimationFrame(this.#raf);
    this.#raf = 0;
    if (this.#frameTimer) clearTimeout(this.#frameTimer);
    this.#frameTimer = null;
  }

  #wantsLoop(): boolean {
    return this.root !== null && this.params.animated && !this.paused && !this.reduced();
  }

  /** Schedules the next frame in `ms`: a timer for long waits (no wake-up per display frame), then one rAF. */
  #queue(ms: number): void {
    if (CanvasBg.frameTimers && ms > TIMER_MIN_MS) {
      this.#frameTimer = setTimeout(() => {
        this.#frameTimer = null;
        if (this.#wantsLoop()) this.#raf = requestAnimationFrame(this.#loop);
      }, ms - TIMER_LEAD_MS);
    } else this.#raf = requestAnimationFrame(this.#loop);
  }

  readonly #loop = (ms: number): void => {
    this.#raf = 0;
    if (!this.#wantsLoop()) return;
    const interval = 1000 / Math.max(1, this.params.maxFps);
    if (this.#last && ms - this.#last < interval - 1.5) {
      this.#queue(this.#last + interval - ms);
      return;
    }
    const late = this.#last ? Math.max(0, ms - this.#last - interval) : 0;
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
    this.#advancing = true;
    try {
      this.paintOnce();
    } finally {
      this.#advancing = false;
    }
    const cost = performance.now() - began;
    this.#queue(interval);
    this.frames++;
    const log = (window as unknown as PerfWindow).__t3pBgPerf;
    if (Array.isArray(log) && log.length < 20000) log.push(cost);
    this.#costSum += cost;
    if (++this.#costN === 60) {
      this.lastAvgMs = this.#costSum / 60;
      this.#costSum = 0;
      this.#costN = 0;
    }
    this.quality?.frame(cost, late);
    if (!this.usesDensityGovernor) {
      if (this.blurShed.push(cost, this.effectiveBlur() > 0)) this.applyBlur();
      return;
    }
    const verdict = this.governor.push(cost);
    if (verdict === "reduced" && this.effectiveBlur() > 0) {
      // Slow frames: the blur goes first, the density stays.
      this.governor.level -= 1;
      this.blurShed.shed = true;
      this.applyBlur();
    } else if (verdict === "reduced") this.#relayout();
    else if (verdict === "stop") this.autoStop();
  };

  /** Paints a frame without advancing time. */
  protected paintOnce(): void {
    if (!this.ctx || !this.root || this.bands.length === 0 || this.w === 0) return;
    const target = this.#srcCtx ?? this.ctx;
    if (!this.incremental) target.clearRect(0, 0, this.w, this.h);
    const changed = this.draw(target) !== false;
    if (changed && this.#src && this.#srcCtx) blitBlurred(this.canvas, this.#src, this.canvasBlur(), this.scale);
  }

  #relayout(): void {
    const t = this.target;
    if (!t) return;
    t.save();
    t.setTransform(1, 0, 0, 1, 0, 0);
    t.clearRect(0, 0, this.targetSize.width, this.targetSize.height);
    t.restore();
    this.layout(this.w, this.h);
  }

  // ---- timers and state ----------------------------------------------------------------------------

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
    this.refreshPalette(false);
  }

  #setTier(tier: BgTier): void {
    if (tier === this.tier || !this.root) return;
    this.tier = tier;
    this.params = bgParams(this.kind, this.cfg, tier);
    this.host.onTier?.(this.kind, tier);
    if (Math.abs(this.#scaleFor() - this.scale) > 1e-3) this.#resize(true);
    this.syncRunning();
  }

  #syncActivity(): void {
    const want = this.cfg.pauseWhileTyping;
    if (want && !this.#unsubscribe) {
      this.#unsubscribe = activity.subscribe({
        busy: (on) => {
          if (on === this.#frozen) return;
          this.#frozen = on;
          // Back from a burst (thread switch, end of a stream): new page layers may cover the canvas.
          if (!on) this.#markSurfaces();
          this.syncRunning();
        },
        blocking: (ms) => {
          if (!this.paused) this.quality?.blocking(ms);
        },
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
  readonly #onMove = (e: PointerEvent): void => {
    if (!this.cfg?.pointer) return;
    this.px = e.clientX;
    this.py = e.clientY;
    this.pointerAt = performance.now();
    this.pointerMoved();
  };
  readonly #onDown = (e: PointerEvent): void => {
    if (e.button === 0 && this.root) this.pointerDown(e.clientX, e.clientY);
  };

  // ---- size ----------------------------------------------------------------------------------------

  #scaleFor(w = this.#cssSize().w, h = this.#cssSize().h): number {
    return Math.max(0.05, tierScale(w, h, window.devicePixelRatio || 1, this.profile) * this.blurResolution());
  }

  #cssSize(): { w: number; h: number } {
    const c = this.root;
    const w = (c && c.clientWidth) || document.documentElement.clientWidth || window.innerWidth;
    const h = (c && c.clientHeight) || window.innerHeight;
    return { w, h };
  }

  /**
   * Sizes the backing store to the canvas box and repaints at once (the old frame is gone the moment the size is
   * set, so waiting for the next 20-30 fps frame showed a blank canvas). `force` also rebuilds an unchanged size.
   */
  #resize(force: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.root) return;
    const { w, h } = this.#cssSize();
    const scale = this.#scaleFor(w, h);
    const blur = this.canvasBlur();
    if (!force && w === this.w && h === this.h && Math.abs(scale - this.scale) < 1e-3 && blur === this.#appliedBlur) return;
    this.w = w;
    this.h = h;
    this.scale = scale;
    this.canvas.width = Math.max(1, Math.ceil(w * scale));
    this.canvas.height = Math.max(1, Math.ceil(h * scale));
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    this.#appliedBlur = blur;
    if (blur > 0) {
      const src = this.#src ?? document.createElement("canvas");
      src.width = this.canvas.width;
      src.height = this.canvas.height;
      const sctx = src.getContext("2d", { alpha: true });
      sctx?.setTransform(scale, 0, 0, scale, 0, 0);
      this.#src = sctx ? src : null;
      this.#srcCtx = sctx;
    } else {
      this.#src = null;
      this.#srcCtx = null;
    }
    this.layout(w, h);
    this.paintOnce();
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

  /** Re-reads the theme colors; repaints a still or frozen layer when they changed (a running loop picks them up). */
  protected refreshPalette(force: boolean): void {
    if (!this.root || !this.cfg) return;
    const fgText = computedColor("var(--foreground, currentColor)");
    const accentExpr = this.cfg.hue < 0 ? "var(--primary, oklch(0.72 0.15 165))" : `oklch(0.74 0.15 ${Math.round(this.cfg.hue) % 360})`;
    const accentText = this.cfg.followAccent ? computedColor(accentExpr) : "";
    const key = `${fgText}|${accentText}|${this.cfg.followAccent}`;
    if (!force && key === this.#paletteKey) return;
    this.#paletteKey = key;
    const fg = this.toRgb(fgText) ?? [200, 205, 215];
    this.accent = accentText ? this.toRgb(accentText) : null;
    this.colors = bgColors(this.accent, this.cfg.followAccent);
    this.bands = gradientBands(this.colors, 5);
    this.paletteChanged(fg);
    if (!this.looping) this.paintOnce();
  }
}

/** @deprecated name kept for older imports; every layer is a {@link CanvasBg}. */
export { CanvasBg as BgLayer };

/**
 * Applies the config to a set of layers where at most one is on: the ones switching off stop first, then the one
 * switching on starts. A preset switch therefore never has two canvases, two loops or two activity subscriptions
 * alive at the same time.
 */
export function syncBackgrounds(layers: readonly CanvasBg[]): CanvasBg | null {
  const on = layers.filter((l) => l.wanted);
  for (const l of layers) if (!on.includes(l)) l.update();
  for (const l of on) l.update();
  return layers.find((l) => l.running) ?? null;
}
