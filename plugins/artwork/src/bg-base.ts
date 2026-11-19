import { bgColors, bgParams, FrameGovernor, gradientBands, MAX_DPR, MAX_PIXELS, renderScale, type BgConfig, type BgParams, type BgPresetKind } from "./bg-model.js";
import { parseRgb, type Rgb } from "./model.js";
import { markSurfaces } from "./ocean.js";

/**
 * Shared shell of the full-app background presets (everything except Ocean):
 * - one fixed, click-through root behind the app (`z-index:-1`, `pointer-events:none`), inserted as the
 *   first child of <body>; input comes from `window` listeners, never from the root;
 * - the opaque viewport-sized app layers are made transparent while it runs (`markSurfaces`), exactly
 *   like Ocean and the Custom background;
 * - pauses at once while the document is hidden and after the window has been blurred for 5 s;
 * - draws one still frame under `prefers-reduced-motion` or speed 0;
 * - `stop()` removes the root, style, attributes, timers and listeners.
 */

export const BLUR_PAUSE_MS = 5000;
export const THEME_POLL_MS = 1000;

export interface BgHost {
  config(): BgConfig;
  /** The adaptive-quality governor gave up (still too slow after reducing). The layer has stopped. */
  onAutoStop?(kind: BgPresetKind): void;
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
    this.params = bgParams(this.kind, cfg);
    if (!this.root) this.#start();
    this.configure();
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
    this.teardown();
    this.root?.remove();
    this.#style?.remove();
    this.root = null;
    this.#style = null;
    this.#hidden = false;
    this.#blurred = false;
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
  /** Called when the page theme may have changed (about once a second). */
  protected themeTick(): void {}

  // ---- shared state --------------------------------------------------------------------------------

  protected get paused(): boolean {
    return this.#hidden || this.#blurred;
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
    this.#poll = setInterval(() => {
      this.#markSurfaces();
      this.themeTick();
    }, THEME_POLL_MS);
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
  /** Render resolution caps (subclasses lower them). */
  protected maxDpr = MAX_DPR;
  protected maxPixels = MAX_PIXELS;
  /** Palette: 3 base colors and gradient bands, re-read about once a second. */
  protected colors: readonly [Rgb, Rgb, Rgb] = bgColors(null, false);
  protected bands: Rgb[] = [];
  /** Draw cost of the last 60 frames, for the "measure on rig" notes. */
  lastAvgMs = 0;
  frames = 0;

  #raf = 0;
  #last = 0;
  #acc = 0;
  #costSum = 0;
  #costN = 0;
  #paletteKey = "";
  #resizeTimer: ReturnType<typeof setTimeout> | null = null;
  #probe: CanvasRenderingContext2D | null = null;

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
    this.#probe = null;
    this.#paletteKey = "";
    this.governor.reset();
    this.#costSum = 0;
    this.#costN = 0;
  }

  protected override configure(): void {
    this.refreshPalette(true);
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
    this.ctx.clearRect(0, 0, this.w, this.h);
    this.draw(this.ctx);
  }

  readonly #loop = (ms: number): void => {
    this.#raf = requestAnimationFrame(this.#loop);
    const interval = 1000 / this.params.maxFps;
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
    const verdict = this.governor.push(cost);
    if (verdict === "reduced") this.layout(this.w, this.h);
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
    this.scale = renderScale(w, h, window.devicePixelRatio || 1, this.maxDpr, this.maxPixels);
    this.canvas.width = Math.max(1, Math.ceil(w * this.scale));
    this.canvas.height = Math.max(1, Math.ceil(h * this.scale));
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    this.layout(w, h);
    if (!this.#raf) this.paintOnce();
  }

  // ---- palette -------------------------------------------------------------------------------------

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
