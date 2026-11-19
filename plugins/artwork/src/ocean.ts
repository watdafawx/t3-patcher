import { activity } from "./bg-activity.js";
import { QualityGovernor, qualityProfile, startTier, tierScale, type BgTier } from "./bg-perf.js";
import { blitBlurred, blurPx, blurRenderFactor, BlurShed } from "./bg-model.js";
import { oceanPalette, oceanParams, parseRgb, type OceanConfig, type OceanParams, type Rgb } from "./model.js";

/**
 * Ocean background: a drifting field of letters on a fixed full-viewport canvas behind the app, with
 * click ripples and a pointer glow. Adapted from the user-supplied ocean.js.
 *
 * - The canvas is created on `start()` and removed on `stop()`. It is `pointer-events: none`, so the app
 *   never loses a click; pointer and click input come from `window` listeners.
 * - Ink colors come from the app's computed `--foreground`, the glow from the artwork accent (or the
 *   app's `--primary`), re-read about once a second so a theme switch follows.
 * - Pauses while the document is hidden, draws one still frame for reduced motion, speed 0 or the Static quality.
 * - Quality tiers (`bg-perf.ts`): frame rate 30/20/12 fps and the backing store at 1.25/1/0.75 px per CSS px instead
 *   of the full device ratio; `auto` steps down from real frame delivery. With `pauseWhileTyping` it freezes on the
 *   current frame while the user types or scrolls and while the chat streams.
 */

const CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const CELL_H = 16;
const FONT = 11;
const GAP = 3;
const FONT_CSS = `500 ${FONT}px "IBM Plex Mono", ui-monospace, Consolas, monospace`;
const TAU = Math.PI * 2;
const THEME_POLL_MS = 1000;

export const OCEAN_CANVAS_ID = "t3p-ocean";
export const OCEAN_ATTR = "data-t3p-ocean";
export const OCEAN_STYLE_ID = "t3p-ocean-style";
export const OCEAN_CLEAR_ATTR = "data-t3p-ocean-clear";

/**
 * While the ocean is on, the big app surfaces become see-through, only as much as the canvas needs
 * (the viewport-sized wrappers). The root keeps `--background`, so light and dark themes keep their look.
 * The page-sized layers the app stacks inside (several `bg-background` wrappers) are found at runtime
 * (`#clearSurfaces`: elements under a sample grid that cover most of the viewport) and marked, so cards,
 * popovers, inputs and the composer keep their own opaque fills.
 */
export const OCEAN_CSS = `
html[${OCEAN_ATTR}]{background-color:var(--background,canvas)!important}
html[${OCEAN_ATTR}] body,html[${OCEAN_ATTR}] #root,html[${OCEAN_ATTR}] [data-slot="sidebar-wrapper"],html[${OCEAN_ATTR}] [data-slot="sidebar-inset"]{background-color:transparent!important}
html[${OCEAN_ATTR}] [${OCEAN_CLEAR_ATTR}]{background-color:transparent!important}
#${OCEAN_CANVAS_ID}{position:fixed;inset:0;width:100vw;height:100vh;z-index:-1;pointer-events:none;display:block}
`;

interface Ripple {
  x: number;
  y: number;
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

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Marks the opaque, viewport-sized layers stacked over `anchor` with `attr` (also used by the custom background). */
export function markSurfaces(anchor: Element, attr: string): void {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (!(vw > 0 && vh > 0) || typeof document.elementsFromPoint !== "function") return;
  for (const fx of [0.5, 0.3, 0.7]) {
    for (const fy of [0.5, 0.3, 0.7]) {
      for (const el of document.elementsFromPoint(vw * fx, vh * fy)) {
        if (el === anchor || el === document.documentElement || el === document.body || el.hasAttribute(attr)) continue;
        if (el.closest("[data-t3p-root]")) continue;
        const r = el.getBoundingClientRect();
        if (r.width * r.height < vw * vh * 0.35) continue;
        const bg = getComputedStyle(el).backgroundColor;
        if (bg && bg !== "transparent" && !/^rgba\(.*,\s*0\)$|\/\s*0\)$/.test(bg)) el.setAttribute(attr, "");
      }
    }
  }
}

export interface OceanHost {
  config(): OceanConfig;
  onTier?(tier: BgTier): void;
}

export class Ocean {
  #canvas: HTMLCanvasElement | null = null;
  /** Where the letters are drawn: the visible canvas, or {@link #src} while a blur is on. */
  #ctx: CanvasRenderingContext2D | null = null;
  #src: HTMLCanvasElement | null = null;
  #style: HTMLStyleElement | null = null;
  #probe: CanvasRenderingContext2D | null = null;
  #raf = 0;
  #poll: ReturnType<typeof setInterval> | null = null;
  #params: OceanParams = oceanParams({ intensity: 60, speed: 50 });
  #ripplesOn = true;
  #ink: string[] = [];
  #glow: string[] = [];
  #paletteKey = "";
  #hue = -1;
  #blur = 0;
  #blurSeen = -1;
  #shed = new BlurShed();

  #cols = 0;
  #rows = 0;
  #dpr = 1;
  #cellW = 9;
  #grid = new Uint8Array(0);
  #painted = new Uint8Array(0);
  #letters = new Uint8Array(0);
  #dirty = new Uint16Array(0);
  #advances: number[] = [];
  #ripples: Ripple[] = [];
  #px = -1e4;
  #py = -1e4;
  #pAmp = 0;
  #last = 0;
  #cost = 0;
  #calmUntil = 0;
  #noise = new Uint8Array(512);
  #tier: BgTier = "high";
  #quality: QualityGovernor | null = null;
  #frozen = false;
  #unsubscribe: (() => void) | null = null;
  #polls = 0;
  #lastCb = 0;

  constructor(private readonly host: OceanHost) {
    const p = [...Array(256).keys()];
    for (let i = 255; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [p[i], p[j]] = [p[j]!, p[i]!];
    }
    for (let i = 0; i < 512; i++) this.#noise[i] = p[i & 255]!;
  }

  get running(): boolean {
    return this.#canvas !== null;
  }

  get canvas(): HTMLCanvasElement | null {
    return this.#canvas;
  }

  get tier(): BgTier {
    return this.#tier;
  }

  get frozen(): boolean {
    return this.#frozen;
  }

  get #fps(): number {
    return qualityProfile("ocean", this.#tier).fps;
  }

  /** Animate now: animated, not static, not reduced, visible, not frozen by input. */
  #shouldRun(): boolean {
    return this.#params.animated && this.#fps > 0 && !this.#reduced() && !document.hidden && !this.#frozen;
  }

  /** Starts or stops the loop; a still frame when it cannot animate at all. */
  #sync(): void {
    if (!this.#canvas) return;
    if (!this.#params.animated || this.#fps === 0 || this.#reduced()) {
      this.#stopLoop();
      this.#frame(4000);
    } else if (!this.#shouldRun()) this.#stopLoop();
    else if (!this.#raf) {
      this.#lastCb = 0;
      this.#raf = requestAnimationFrame(this.#loop);
    }
  }

  #syncActivity(want: boolean): void {
    if (want && !this.#unsubscribe) {
      this.#unsubscribe = activity.subscribe({
        busy: (on) => {
          if (on === this.#frozen) return;
          this.#frozen = on;
          this.#sync();
        },
        blocking: (ms) => {
          if (this.#shouldRun()) this.#quality?.blocking(ms);
        },
      });
      this.#frozen = activity.busy;
    } else if (!want && this.#unsubscribe) {
      this.#unsubscribe();
      this.#unsubscribe = null;
      this.#frozen = false;
    }
  }

  #setTier(tier: BgTier): void {
    if (tier === this.#tier) return;
    const scale = this.#dpr;
    this.#tier = tier;
    this.host.onTier?.(tier);
    if (Math.abs(this.#scaleFor() - scale) > 1e-3) this.#resize();
    this.#sync();
  }

  #scaleFor(): number {
    const w = document.documentElement.clientWidth || window.innerWidth;
    const blur = blurRenderFactor(blurPx(this.#blur, this.#shed.shed));
    return Math.max(0.05, tierScale(w, window.innerHeight, window.devicePixelRatio || 1, qualityProfile("ocean", this.#tier)) * blur);
  }

  /** Applies the current config: starts, retunes or stops. Cheap, call it on every setting change. */
  update(): void {
    const cfg = this.host.config();
    if (!cfg.on) {
      this.stop();
      return;
    }
    this.#params = oceanParams(cfg);
    this.#ripplesOn = cfg.ripples;
    this.#hue = cfg.hue;
    this.#blur = cfg.blur ?? 0;
    if (this.#blur !== this.#blurSeen) {
      this.#blurSeen = this.#blur;
      this.#shed.reset();
    }
    const quality = cfg.quality ?? "high";
    if (quality === "auto") this.#quality ??= new QualityGovernor();
    else this.#quality = null;
    const tier = this.#quality ? this.#quality.tier : startTier(quality);
    const started = !this.#canvas;
    if (started) {
      this.#tier = tier;
      this.#start();
    } else this.#setTier(tier);
    this.#syncActivity(cfg.pauseWhileTyping ?? false);
    this.#applyBlur();
    this.#refreshPalette(true);
    this.#clearSurfaces();
    this.#sync();
  }

  stop(): void {
    this.#stopLoop();
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#frozen = false;
    this.#quality = null;
    if (this.#poll) clearInterval(this.#poll);
    this.#poll = null;
    window.removeEventListener("resize", this.#onResize);
    window.removeEventListener("pointerdown", this.#onDown);
    window.removeEventListener("pointermove", this.#onMove);
    window.removeEventListener("scroll", this.#onScroll, true);
    document.removeEventListener("visibilitychange", this.#onVisibility);
    this.#canvas?.remove();
    this.#style?.remove();
    this.#canvas = null;
    this.#ctx = null;
    this.#src = null;
    this.#style = null;
    this.#probe = null;
    this.#ripples = [];
    this.#paletteKey = "";
    this.#blurSeen = -1;
    this.#appliedBlur = -1;
    this.#shed.reset();
    for (const el of Array.from(document.querySelectorAll(`[${OCEAN_CLEAR_ATTR}]`))) el.removeAttribute(OCEAN_CLEAR_ATTR);
    document.documentElement.removeAttribute(OCEAN_ATTR);
  }

  // ---- lifecycle -----------------------------------------------------------------------------------

  #reduced(): boolean {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  }

  #start(): void {
    const style = document.createElement("style");
    style.id = OCEAN_STYLE_ID;
    style.textContent = OCEAN_CSS;
    document.head.appendChild(style);
    this.#style = style;
    const canvas = document.createElement("canvas");
    canvas.id = OCEAN_CANVAS_ID;
    canvas.setAttribute("aria-hidden", "true");
    document.body.insertBefore(canvas, document.body.firstChild);
    this.#canvas = canvas;
    this.#ctx = canvas.getContext("2d", { alpha: true });
    document.documentElement.setAttribute(OCEAN_ATTR, "");
    window.addEventListener("resize", this.#onResize);
    // Listen on window, never on the canvas: the canvas ignores pointer events so the app stays usable.
    window.addEventListener("pointerdown", this.#onDown, { passive: true });
    window.addEventListener("pointermove", this.#onMove, { passive: true });
    window.addEventListener("scroll", this.#onScroll, { capture: true, passive: true });
    document.addEventListener("visibilitychange", this.#onVisibility);
    this.#poll = setInterval(() => {
      if (this.#quality) {
        const verdict = this.#quality.tick(performance.now());
        if (verdict === "down" && blurPx(this.#blur, this.#shed.shed) > 0) {
          // Frames are late: the blur goes first, the tier stays (the next bad window lowers it).
          this.#quality.level -= 1;
          this.#shed.shed = true;
          this.#applyBlur();
        } else if (verdict !== "keep") this.#setTier(this.#quality.tier);
      }
      // Both read computed styles (a forced style/layout flush): every other second, never while the user is busy.
      if (this.#frozen || ++this.#polls % 2 !== 0) return;
      this.#refreshPalette(false);
      this.#clearSurfaces();
    }, THEME_POLL_MS);
    this.#resize();
  }

  #appliedBlur = -1;
  /**
   * Blur is drawn into the canvas, not a CSS filter (a filtered layer is re-filtered on every composite of
   * the app above it, even frozen). Letters go to an offscreen canvas at reduced resolution; each frame that
   * changed something is blitted once through `ctx.filter = blur()`. Shed when frames are slow.
   */
  #applyBlur(): void {
    const canvas = this.#canvas;
    if (!canvas) return;
    canvas.style.filter = "";
    canvas.style.transform = "";
    canvas.style.willChange = "";
    const px = blurPx(this.#blur, this.#shed.shed);
    if (px !== this.#appliedBlur && this.#appliedBlur !== -1) this.#resize();
    this.#appliedBlur = px;
  }

  #stopLoop(): void {
    if (this.#raf) cancelAnimationFrame(this.#raf);
    this.#raf = 0;
  }

  readonly #onVisibility = (): void => {
    if (!this.#canvas) return;
    this.#sync();
  };
  readonly #onResize = (): void => this.#resize();
  readonly #onScroll = (): void => {
    this.#calmUntil = performance.now() + 200;
  };
  readonly #onDown = (e: PointerEvent): void => {
    if (e.button === 0 && this.#ripplesOn) this.#splash(e.clientX, e.clientY);
  };
  readonly #onMove = (e: PointerEvent): void => {
    this.#px = e.clientX;
    this.#py = e.clientY;
    this.#pAmp = Math.min(1, this.#pAmp + 0.05);
  };

  /** Marks the opaque, viewport-sized layers over the canvas so the letters show through them. */
  #clearSurfaces(): void {
    if (this.#canvas) markSurfaces(this.#canvas, OCEAN_CLEAR_ATTR);
  }

  // ---- colors --------------------------------------------------------------------------------------

  /** Any CSS color (`oklch()`, `color-mix()`, a named color) to rgb via a 1x1 canvas. */
  #toRgb(css: string): Rgb | null {
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

  /** Resolves a color expression through a throwaway element, so `var()` and relative colors work. */
  #computed(expr: string): string {
    const probe = document.createElement("i");
    probe.style.cssText = `position:fixed;left:-9999px;top:0;width:0;height:0;pointer-events:none;color:${expr}`;
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }

  #refreshPalette(force: boolean): void {
    if (!this.#canvas) return;
    const fgText = this.#computed("var(--foreground, currentColor)");
    const accentExpr = this.#hue < 0 ? "var(--primary, oklch(0.72 0.15 165))" : `oklch(0.74 0.15 ${Math.round(this.#hue) % 360})`;
    const accentText = this.#computed(accentExpr);
    const key = `${fgText}|${accentText}|${this.#params.alpha}`;
    if (!force && key === this.#paletteKey) return;
    this.#paletteKey = key;
    const fg = this.#toRgb(fgText) ?? [200, 205, 215];
    const accent = this.#toRgb(accentText) ?? [249, 115, 22];
    const { ink, glow } = oceanPalette(fg, accent, this.#params.alpha);
    this.#ink = ink;
    this.#glow = glow;
    // Force a full repaint with the new colors.
    this.#painted.fill(255);
    const target = this.#src ?? this.#canvas;
    this.#ctx?.clearRect(0, 0, target.width, target.height);
    if (!this.#raf) this.#frame(4000);
  }

  // ---- noise ---------------------------------------------------------------------------------------

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

  // ---- drawing -------------------------------------------------------------------------------------

  #resize(): void {
    const canvas = this.#canvas;
    if (!canvas) return;
    this.#dpr = this.#scaleFor();
    const w = document.documentElement.clientWidth || window.innerWidth;
    const h = window.innerHeight;
    canvas.width = Math.ceil(w * this.#dpr);
    canvas.height = Math.ceil(h * this.#dpr);
    this.#appliedBlur = blurPx(this.#blur, this.#shed.shed);
    let ctx: CanvasRenderingContext2D | null;
    if (this.#appliedBlur > 0) {
      const src = this.#src ?? document.createElement("canvas");
      src.width = canvas.width;
      src.height = canvas.height;
      ctx = src.getContext("2d", { alpha: true });
      this.#src = ctx ? src : null;
    } else {
      this.#src = null;
      ctx = canvas.getContext("2d", { alpha: true });
    }
    this.#ctx = ctx;
    if (!ctx) return;
    ctx.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
    ctx.font = FONT_CSS;
    ctx.textBaseline = "top";
    if ("letterSpacing" in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${GAP}px`;
    this.#cellW = ctx.measureText("0123456789").width / 10 || 9;
    this.#cols = Math.ceil(w / this.#cellW) + 1;
    this.#rows = Math.ceil(h / CELL_H) + 1;
    this.#advances = Array.from({ length: this.#cols + 1 }, (_, c) => ctx.measureText(" ".repeat(c)).width || c * this.#cellW);
    const size = this.#cols * this.#rows;
    this.#grid = new Uint8Array(size);
    this.#painted = new Uint8Array(size).fill(255);
    this.#letters = new Uint8Array(size);
    this.#dirty = new Uint16Array(this.#cols);
    for (let i = 0; i < size; i++) this.#grid[i] = (Math.random() * CHARS.length) | 0;
    if (!this.#raf) this.#frame(4000);
  }

  readonly #loop = (ms: number): void => {
    this.#raf = requestAnimationFrame(this.#loop);
    const gap = this.#lastCb ? ms - this.#lastCb : 0;
    this.#lastCb = ms;
    const scrolling = ms < this.#calmUntil;
    const interval = 1000 / Math.max(1, this.#fps) - 1.5;
    if (ms - this.#last < (scrolling ? Math.max(50, this.#cost * 5, interval) : interval)) return;
    this.#last = ms;
    const began = performance.now();
    this.#frame(ms);
    this.#cost = performance.now() - began;
    this.#quality?.frame(this.#cost, gap);
    if (this.#shed.push(this.#cost, this.#blur > 0)) this.#applyBlur();
  };

  #frame(ms: number): void {
    const ctx = this.#ctx;
    const canvas = this.#src ?? this.#canvas;
    if (!ctx || !canvas || this.#ink.length === 0) return;
    let drew = false;
    const { drift: driftSpeed, shimmer, rippleSpeed } = this.#params;
    const cols = this.#cols;
    const rows = this.#rows;
    const grid = this.#grid;
    const painted = this.#painted;
    const letters = this.#letters;
    const dpr = this.#dpr;
    const INK = this.#ink;
    const GLOW = this.#glow;
    const t = ms / 1000;
    const scroll = window.scrollY * 0.25;
    const nowS = performance.now() / 1000;
    for (let i = this.#ripples.length - 1; i >= 0; i--) {
      const rp = this.#ripples[i]!;
      const age = nowS - rp.t;
      if (age > 3.4) {
        this.#ripples.splice(i, 1);
        continue;
      }
      rp.front = age * rippleSpeed;
      rp.fade = Math.max(0, 1 - age / 3.2) * rp.a;
      rp.reach = (rp.front + 30) * rp.extent + 1;
    }
    this.#pAmp *= 0.93;

    const perFrame = shimmer * (30 / Math.max(1, this.#fps || 30));
    if (shimmer > 0) for (let k = (grid.length * perFrame) | 0; k > 0; k--) grid[(Math.random() * grid.length) | 0] = (Math.random() * CHARS.length) | 0;

    const drift = t * driftSpeed;
    for (let r = 0; r < rows; r++) {
      const cy = r * CELL_H;
      let changed = 0;
      for (let c = 0; c < cols; c++) {
        const cx = c * this.#cellW;
        const i = r * cols + c;
        const n = this.#fbm(cx * 0.0056 + drift, (cy + scroll) * 0.0074 - drift * 0.6);
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
        if (this.#pAmp > 0.01) {
          const d = Math.hypot(cx - this.#px, cy - this.#py);
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
        ctx.clearRect(0, top / dpr, canvas.width, height);
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
    if (drew && this.#src && this.#canvas) blitBlurred(this.#canvas, this.#src, blurPx(this.#blur, this.#shed.shed), this.#dpr);
  }

  #splash(x: number, y: number): void {
    const rot = Math.random() * TAU;
    const stretch = Math.random() < 0.4 ? 1 + Math.random() * 0.9 : 1;
    const idx = (Math.random() * SHAPES.length) | 0;
    const rp: Ripple = {
      x,
      y,
      t: performance.now() / 1000,
      a: 1,
      shape: SHAPES[idx]!,
      n: 3 + ((Math.random() * 5) | 0),
      cos: Math.cos(rot),
      sin: Math.sin(rot),
      sx: stretch,
      sy: 1 / Math.sqrt(stretch),
      front: 0,
      fade: 1,
      reach: 0,
      extent: 1,
    };
    const radius = [1, 1 / 0.78, Math.SQRT2, 1 / Math.cos(Math.PI / rp.n), 1.32, 1.14];
    rp.extent = radius[idx]! * Math.max(rp.sx, rp.sy);
    this.#ripples.push(rp);
    if (this.#ripples.length > 8) this.#ripples.shift();
    if (!this.#raf) this.#frame(4000);
  }
}
