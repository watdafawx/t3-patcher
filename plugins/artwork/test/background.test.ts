// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Antigravity } from "../src/antigravity.js";
import { BLUR_PAUSE_MS, bgIds, type BgHost } from "../src/bg-base.js";
import { activity } from "../src/bg-activity.js";
import { BG_KINDS, BLUR_MAX, BlurShed, DIM_MAX, bgColors, bgParams, blurPx, blurBlit, blurRenderFactor, dimOpacity, FIXED_PALETTE, FrameGovernor, gradientBands, hslToRgb, isBgKind, rgbToHsl, rng, type BgConfig, type BgPresetKind } from "../src/bg-model.js";
import { qualityProfile, tierScale } from "../src/bg-perf.js";
import { GradientDrift } from "../src/drift.js";
import { Starfield } from "../src/starfield.js";

describe("background model", () => {
  it("maps intensity, speed, density and low power to params", () => {
    const base = { intensity: 60, speed: 50, density: 50, lowPower: false };
    expect(bgParams("antigravity", base)).toMatchObject({ alpha: 1, speed: 1, animated: true, count: 1700, maxFps: 60 });
    expect(bgParams("antigravity", { ...base, lowPower: true }).maxFps).toBe(30);
    expect(bgParams("starfield", base)).toMatchObject({ count: 200, maxFps: 30 });
    expect(bgParams("antigravity", { ...base, speed: 0 }).animated).toBe(false);
    expect(bgParams("antigravity", { ...base, density: 999 }).count).toBe(2900);
    expect(bgParams("starfield", { ...base, density: -5 }).count).toBe(80);
    // quality tiers set the frame rate; static never animates; low power still caps at 30
    expect(bgParams("antigravity", base, "balanced").maxFps).toBe(30);
    expect(bgParams("antigravity", base, "low").maxFps).toBe(15);
    expect(bgParams("antigravity", base, "static")).toMatchObject({ animated: false, maxFps: 0 });
    expect(bgParams("drift", { ...base, lowPower: true }, "high").maxFps).toBe(30);
    expect(bgParams("antigravity", { ...base, quality: "auto" }).maxFps).toBe(30); // auto starts at balanced
  });

  it("caps the render scale per tier: never above the device ratio, within the pixel budget", () => {
    const high = qualityProfile("antigravity", "high");
    expect(tierScale(1280, 720, 1, high)).toBe(1);
    expect(tierScale(1280, 720, 2, high)).toBe(1); // dpr 2 still renders 1 px per CSS px
    // 4K at 175%: 2195x1187 css
    const s = tierScale(2195, 1187, 1.75, qualityProfile("antigravity", "balanced"));
    expect(2195 * s * 1187 * s).toBeLessThanOrEqual(1_500_000 + 1);
    // soft blobs render at a fifth of the css resolution
    expect(tierScale(2195, 1187, 1.75, qualityProfile("drift", "balanced"))).toBeCloseTo(0.2);
    expect(tierScale(0, 0, 2, high)).toBe(1);
  });

  it("converts hsl and rgb and spreads the accent hue", () => {
    const [h, s, l] = rgbToHsl([10, 200, 120]);
    expect(hslToRgb(h, s, l)).toEqual([10, 200, 120]);
    const [a, b, c] = bgColors([10, 200, 120], true);
    expect(new Set([a, b, c].map((x) => x.join())).size).toBe(3);
    expect(bgColors([10, 200, 120], false)).toBe(FIXED_PALETTE);
    expect(bgColors(null, true)).toBe(FIXED_PALETTE);
    const bands = gradientBands(FIXED_PALETTE, 5);
    expect(bands).toHaveLength(5);
    expect(bands[0]).toEqual(FIXED_PALETTE[0]);
    expect(bands[4]).toEqual(FIXED_PALETTE[2]);
  });

  it("rng is deterministic and isBgKind guards", () => {
    expect(rng(1)()).toBe(rng(1)());
    expect(rng(1)()).not.toBe(rng(2)());
    expect(BG_KINDS.every(isBgKind)).toBe(true);
    expect(isBgKind("nope")).toBe(false);
  });

  it("governor: ok when fast, reduces above 10 ms, stops above 16 ms after a reduction", () => {
    const g = new FrameGovernor();
    const feed = (ms: number): string => {
      let v = "ok";
      for (let i = 0; i < 60; i++) v = g.push(ms);
      return v;
    };
    expect(feed(2)).toBe("ok");
    expect(g.factor).toBe(1);
    expect(feed(12)).toBe("reduced");
    expect(g.factor).toBe(0.6);
    expect(feed(12)).toBe("reduced");
    expect(g.factor).toBe(0.35);
    expect(feed(12)).toBe("ok"); // at the floor, between 10 and 16 ms: keep running
    expect(feed(20)).toBe("stop");
    g.reset();
    expect(g.level).toBe(0);
    // first window already above 16 ms: reduce first, then stop if still slow
    expect(feed(20)).toBe("reduced");
    expect(feed(20)).toBe("stop");
  });
});

// ---- lifecycle ------------------------------------------------------------------------------------

function fakeCtx() {
  const calls: Record<string, number> = {};
  const count = (name: string) => () => void (calls[name] = (calls[name] ?? 0) + 1);
  const filters: string[] = [];
  return {
    calls,
    filters,
    set filter(v: string) {
      filters.push(v);
    },
    save: count("save"),
    restore: count("restore"),
    drawImage: count("drawImage"),
    setTransform: vi.fn(),
    clearRect: count("clearRect"),
    beginPath: count("beginPath"),
    moveTo: count("moveTo"),
    lineTo: count("lineTo"),
    stroke: count("stroke"),
    rect: count("rect"),
    fill: count("fill"),
    getImageData: () => ({ data: new Uint8ClampedArray([1, 2, 3, 255]) }),
    createRadialGradient: () => ({ addColorStop: vi.fn() }),
    fillRect: count("fillRect"),
    globalAlpha: 1,
    lineCap: "",
    lineWidth: 0,
    strokeStyle: "",
    fillStyle: "",
  };
}

let cfg: BgConfig;
let raf: Map<number, FrameRequestCallback>;
let nextId: number;
let reduced: boolean;
let ctxs: Array<ReturnType<typeof fakeCtx>>;
let stopped: BgPresetKind[];
const host: BgHost = { config: () => cfg, onAutoStop: (k) => void stopped.push(k) };

/** Runs every queued rAF callback once at time `ms`. */
const flush = (ms: number): void => {
  const pending = [...raf.values()];
  raf.clear();
  for (const cb of pending) cb(ms);
};
const setHidden = (hidden: boolean): void => {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
};

beforeEach(() => {
  cfg = { on: true, intensity: 60, speed: 50, density: 50, pointer: true, followAccent: true, hue: -1, lowPower: false, quality: "high", pauseWhileTyping: false, dim: 0, blur: 0 };
  raf = new Map();
  nextId = 1;
  reduced = false;
  ctxs = [];
  stopped = [];
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  HTMLCanvasElement.prototype.getContext = (() => {
    const c = fakeCtx();
    ctxs.push(c);
    return c;
  }) as never;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    raf.set(nextId, cb);
    return nextId++;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => void raf.delete(id));
  vi.stubGlobal("matchMedia", () => ({ matches: reduced }));
  setHidden(false);
  document.documentElement.style.setProperty("--foreground", "rgb(230, 230, 230)");
  document.documentElement.style.setProperty("--primary", "rgb(10, 200, 120)");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("style");
});

const make = (kind: BgPresetKind) => (kind === "antigravity" ? new Antigravity(kind, host) : kind === "starfield" ? new Starfield(kind, host) : new GradientDrift(kind, host));
const kinds: BgPresetKind[] = ["antigravity", "starfield", "drift"];

describe.each(kinds)("%s lifecycle", (kind) => {
  const ids = bgIds(kind);
  const root = (): HTMLElement | null => document.getElementById(ids.root);

  it("creates one fixed, click-through root behind the app and marks <html>", () => {
    const bg = make(kind);
    bg.update();
    bg.update();
    expect(document.querySelectorAll(`#${ids.root}`)).toHaveLength(1);
    expect(document.body.firstElementChild).toBe(root());
    expect(document.documentElement.hasAttribute(ids.attr)).toBe(true);
    const css = document.getElementById(ids.style)!.textContent!;
    expect(css).toContain("pointer-events:none");
    expect(css).toContain("z-index:-1");
    expect(css).toContain("position:fixed");
    expect(css).toContain("var(--background");
    expect(css).not.toMatch(/#[0-9a-f]{3,6}\b|rgba?\(/i);
    expect(root()!.getAttribute("aria-hidden")).toBe("true");
    bg.stop();
  });

  it("is a no-op while off", () => {
    cfg.on = false;
    const bg = make(kind);
    bg.update();
    expect(root()).toBeNull();
    expect(bg.running).toBe(false);
  });

  it("stop removes root, style, attributes, timers, listeners and the frame", () => {
    const winRemoved = vi.spyOn(window, "removeEventListener");
    const bg = make(kind);
    bg.update();
    cfg.on = false;
    bg.update();
    expect(root()).toBeNull();
    expect(document.getElementById(ids.style)).toBeNull();
    expect(document.documentElement.hasAttribute(ids.attr)).toBe(false);
    expect(raf.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(bg.running).toBe(false);
    const types = winRemoved.mock.calls.map((c) => c[0]);
    expect(types).toEqual(expect.arrayContaining(["blur", "focus"]));
    expect(types).toEqual(expect.arrayContaining(["resize", "pointermove"]));
    // pointer input after stop is harmless
    expect(() => window.dispatchEvent(new Event("pointermove"))).not.toThrow();
  });

  it("clears transparent surfaces it marked when it stops", () => {
    const bg = make(kind);
    const page = document.createElement("div");
    page.setAttribute(ids.clear, "");
    document.body.appendChild(page);
    bg.update();
    bg.stop();
    expect(page.hasAttribute(ids.clear)).toBe(false);
  });

  it("pauses while the document is hidden and resumes when visible", () => {
    const bg = make(kind);
    bg.update();
    const animating = (): boolean => raf.size > 0;
    expect(animating()).toBe(true);
    setHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(animating()).toBe(false);
    setHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(animating()).toBe(true);
    bg.stop();
  });

  it("pauses only after the window was blurred for more than 5 s", () => {
    const bg = make(kind);
    bg.update();
    const animating = (): boolean => raf.size > 0;
    window.dispatchEvent(new Event("blur"));
    vi.advanceTimersByTime(BLUR_PAUSE_MS - 100);
    expect(animating()).toBe(true);
    window.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(BLUR_PAUSE_MS * 2);
    expect(animating()).toBe(true);
    window.dispatchEvent(new Event("blur"));
    vi.advanceTimersByTime(BLUR_PAUSE_MS + 50);
    expect(animating()).toBe(false);
    window.dispatchEvent(new Event("focus"));
    expect(animating()).toBe(true);
    bg.stop();
  });

  it("reduced motion or speed 0 draws one still frame and never animates", () => {
    reduced = true;
    const bg = make(kind);
    bg.update();
    expect(raf.size).toBe(0);
    reduced = false;
    cfg.speed = 0;
    bg.update();
    expect(raf.size).toBe(0);
    cfg.speed = 50;
    bg.update();
    expect(raf.size).toBe(1);
    // the Static quality is one still frame too
    cfg.quality = "static";
    bg.update();
    expect(raf.size).toBe(0);
    bg.stop();
  });

  it("pause while typing: a key press freezes the frame, it resumes after the quiet period", () => {
    let clock = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    cfg.pauseWhileTyping = true;
    const bg = make(kind);
    bg.update();
    expect(raf.size).toBe(1);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(bg.frozen).toBe(true);
    expect(raf.size).toBe(0);
    clock += 2000;
    vi.advanceTimersByTime(2000);
    expect(bg.frozen).toBe(false);
    expect(raf.size).toBe(1);
    // off: input never freezes
    cfg.pauseWhileTyping = false;
    bg.update();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(raf.size).toBe(1);
    bg.stop();
  });
});

describe("canvas presets", () => {
  it("antigravity draws in batched strokes (at most 20 per frame) and not per particle", () => {
    const bg = new Antigravity("antigravity", host);
    bg.update();
    expect(bg.particleCount).toBeGreaterThan(1000);
    const c = ctxs.find((x) => x.calls.stroke)!;
    expect(c.calls.stroke).toBeGreaterThan(0);
    expect(c.calls.stroke).toBeLessThanOrEqual(20);
    expect(c.calls.moveTo).toBeGreaterThan(500);
    bg.stop();
  });

  it("density changes the particle count and the canvas is capped to the render scale", () => {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 3 });
    const bg = new Antigravity("antigravity", host);
    bg.update();
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    const css = document.documentElement.clientWidth || window.innerWidth;
    expect(canvas.width / css).toBeLessThanOrEqual(1 + 0.01);
    // a cheaper tier re-sizes the backing store at once
    cfg.quality = "low";
    bg.update();
    expect(canvas.width / css).toBeLessThanOrEqual(0.5 + 0.01);
    cfg.quality = "high";
    const before = bg.particleCount;
    cfg.density = 100;
    bg.update();
    expect(bg.particleCount).toBeGreaterThan(before);
    bg.stop();
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 });
  });

  it("starfield has about 200 stars at the default density, one low-res canvas, batched fills", () => {
    const bg = new Starfield("starfield", host);
    bg.update();
    expect(bg.starCount).toBe(200);
    expect(document.querySelectorAll("canvas")).toHaveLength(1);
    const c = ctxs.find((x) => x.calls.fill)!;
    expect(c.calls.fill).toBeLessThanOrEqual(8);
    expect(c.calls.rect).toBe(200);
    bg.stop();
  });

  it("runs at 30 fps for the starfield and for Low power: a 60 Hz callback is skipped every other frame", () => {
    cfg.lowPower = true;
    const bg = new Antigravity("antigravity", host);
    bg.update();
    const draws = (): number => ctxs.reduce((n, c) => n + (c.calls.clearRect ?? 0), 0);
    flush(1000); // first frame always draws
    const first = draws();
    flush(1016.7);
    expect(draws()).toBe(first); // skipped
    flush(1033.4);
    expect(draws()).toBeGreaterThan(first);
    bg.stop();
  });

  it("clamps dt: a long stall advances the simulation by at most 100 ms", () => {
    const bg = new Starfield("starfield", host);
    bg.update();
    flush(1000);
    const y0 = (bg as unknown as { time: number }).time;
    flush(60_000); // a minute later
    const dt = (bg as unknown as { time: number }).time - y0;
    expect(dt).toBeLessThanOrEqual(4 / 60 + 1e-9);
    bg.stop();
  });

  it("pointer moves are ignored when Pointer reactive is off", () => {
    cfg.pointer = false;
    const bg = new Antigravity("antigravity", host);
    bg.update();
    const move = new Event("pointermove");
    Object.assign(move, { clientX: 5, clientY: 5 });
    window.dispatchEvent(move);
    expect((bg as unknown as { pointerAt: number }).pointerAt).toBe(-1e9);
    cfg.pointer = true;
    bg.update();
    window.dispatchEvent(move);
    expect((bg as unknown as { pointerAt: number }).pointerAt).toBeGreaterThan(-1e9);
    bg.stop();
  });

  it("adaptive quality: slow frames lower the density, still slow stops it and tells the host once", () => {
    const bg = new Antigravity("antigravity", host);
    bg.update();
    const full = bg.particleCount;
    let t = 0;
    const slow = vi.spyOn(performance, "now").mockImplementation(() => {
      t += 12; // every draw (two now() calls) costs 12 ms
      return t;
    });
    let ms = 1000;
    const frames = (n: number): void => {
      for (let i = 0; i < n; i++) {
        ms += 17;
        flush(ms);
      }
    };
    frames(61);
    expect(bg.particleCount).toBeLessThan(full);
    expect(stopped).toEqual([]);
    slow.mockRestore();
    // very slow now: 20 ms per draw
    t = 0;
    vi.spyOn(performance, "now").mockImplementation(() => {
      t += 20;
      return t;
    });
    frames(61 * 3);
    expect(stopped).toEqual(["antigravity"]);
    expect(document.getElementById(bgIds("antigravity").root)).toBeNull();
    expect(bg.autoStopped).toBe(true);
    // a settings change does not bring it back by itself...
    bg.update();
    expect(document.getElementById(bgIds("antigravity").root)).toBeNull();
    // ...switching it off and on again does
    cfg.on = false;
    bg.update();
    cfg.on = true;
    vi.restoreAllMocks();
    bg.update();
    expect(document.getElementById(bgIds("antigravity").root)).not.toBeNull();
    bg.stop();
  });

  it("follow accent off uses the fixed palette for the drift blobs", () => {
    cfg.followAccent = false;
    const bg = new GradientDrift("drift", host);
    bg.update();
    expect(bg.colorsNow[0]).toEqual(FIXED_PALETTE[0]);
    cfg.followAccent = true;
    bg.update();
    expect(bg.colorsNow[0]).not.toEqual(FIXED_PALETTE[0]);
    bg.stop();
  });

  it("gradient drift is a tiny canvas: a fifth of the CSS resolution, 4 gradient fills per frame, at most 30 fps", () => {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
    const bg = new GradientDrift("drift", host);
    bg.update();
    const canvas = document.querySelector(`#${bgIds("drift").root}`) as HTMLCanvasElement;
    expect(canvas.tagName).toBe("CANVAS");
    const css = document.documentElement.clientWidth || window.innerWidth;
    expect(canvas.width / css).toBeLessThanOrEqual(0.26);
    const c = ctxs.find((x) => x.calls.fillRect)!;
    const before = c.calls.fillRect!;
    flush(1000);
    expect(c.calls.fillRect! - before).toBe(4);
    expect(bgParams("drift", cfg).maxFps).toBeLessThanOrEqual(30);
    bg.stop();
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 });
  });

  it("gradient drift bakes the blur into bigger, flatter blobs (no filter), and sheds it like the others", () => {
    cfg.blur = 20;
    const bg = new GradientDrift("drift", host);
    bg.update();
    const blurred = bg.blobStyle;
    const canvas = document.querySelector(`#${bgIds("drift").root}`) as HTMLCanvasElement;
    expect(canvas.style.filter).toBe("");
    cfg.blur = 0;
    bg.update();
    expect(bg.blobStyle.size).toBeLessThan(blurred.size);
    expect(bg.blobStyle.opacity).toBeGreaterThan(blurred.opacity);
    expect(blurred.opacity).toBeCloseTo(0.54 * 0.76, 2);
    bg.stop();
  });

  it("auto quality: a slow window sheds the blur first, the next one lowers the tier", () => {
    cfg.quality = "auto";
    cfg.blur = 8;
    const bg = new Antigravity("antigravity", host);
    bg.update();
    const canvas = document.querySelector(`#${bgIds("antigravity").root}`) as HTMLCanvasElement;
    expect(bg.tier).toBe("balanced");
    expect(canvas.style.filter).toBe(""); // never a CSS filter
    const blits = (): number => ctxs.reduce((n, c) => n + (c.calls.drawImage ?? 0), 0);
    const filterSeen = (): string[] => ctxs.flatMap((c) => c.filters);
    flush(2000);
    expect(blits()).toBeGreaterThan(0);
    expect(filterSeen().every((f) => /^blur\(\d+(\.\d+)?px\)$/.test(f))).toBe(true);
    let t = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (t += 5)); // every draw costs ~5 ms: over the 4 ms limit
    let ms = 1000;
    const frames = (n: number): void => {
      for (let i = 0; i < n; i++) flush((ms += 34));
    };
    vi.advanceTimersByTime(1000); // the first tick opens the window
    frames(400);
    vi.advanceTimersByTime(1000);
    const after = blits();
    frames(20);
    expect(blits()).toBe(after); // shed: frames go straight to the visible canvas, no blur pass
    expect(canvas.style.filter).toBe("");
    expect(bg.tier).toBe("balanced");
    frames(400);
    vi.advanceTimersByTime(1000);
    expect(bg.tier).toBe("low");
    bg.stop();
  });

  it("several layers share one activity monitor and its listeners go away with the last one", () => {
    cfg.pauseWhileTyping = true;
    const added = vi.spyOn(window, "addEventListener");
    const a = new Starfield("starfield", host);
    const b = new Antigravity("antigravity", host);
    a.update();
    b.update();
    expect(added.mock.calls.filter((c) => c[0] === "keydown")).toHaveLength(1);
    activity.poke();
    expect(a.frozen && b.frozen).toBe(true);
    a.stop();
    b.stop();
    expect(activity.busy).toBe(false);
  });
});

describe("dim and blur model", () => {
  it("dimOpacity maps 0 to 80 percent and clamps", () => {
    expect(dimOpacity(0)).toBe(0);
    expect(dimOpacity(40)).toBe(0.4);
    expect(dimOpacity(DIM_MAX)).toBe(0.8);
    expect(dimOpacity(500)).toBe(0.8);
    expect(dimOpacity(-5)).toBe(0);
    expect(dimOpacity(Number.NaN)).toBe(0);
  });
  it("blurPx clamps to the cap, rounds, and is 0 once shed", () => {
    expect(blurPx(0)).toBe(0);
    expect(blurPx(7.6)).toBe(8);
    expect(blurPx(999)).toBe(BLUR_MAX);
    expect(blurPx(-3)).toBe(0);
    expect(blurPx(10, true)).toBe(0);
    expect(blurPx(Number.NaN)).toBe(0);
  });
  it("the render factor only shrinks under a blur and never below half", () => {
    expect(blurRenderFactor(0)).toBe(1);
    expect(blurRenderFactor(6)).toBeCloseTo(0.8, 5);
    expect(blurRenderFactor(BLUR_MAX)).toBeGreaterThanOrEqual(0.5);
    expect(blurRenderFactor(BLUR_MAX)).toBeLessThan(1);
    expect(blurRenderFactor(500)).toBe(0.5);
  });
  it("blurBlit: no blur is the plain rect, a blur oversizes it so the edge bleed is off screen", () => {
    expect(blurBlit(0, 1, 1920, 1080)).toEqual({ sigma: 0, x: 0, y: 0, w: 1920, h: 1080 });
    const g = blurBlit(20, 0.5, 1000, 600);
    expect(g.sigma).toBe(10);
    expect(g.x).toBe(-30);
    expect(g.y).toBe(-30);
    expect(g.w).toBe(1060);
    expect(g.h).toBe(660);
    expect(blurBlit(20, 1, 1000, 600).w).toBeGreaterThan(g.w);
  });
  it("BlurShed sheds once after a slow window and not at all when fast or off", () => {
    const fast = new BlurShed(10, 10);
    for (let i = 0; i < 50; i++) expect(fast.push(2, true)).toBe(false);
    expect(fast.shed).toBe(false);
    const slow = new BlurShed(10, 10);
    const hits: boolean[] = [];
    for (let i = 0; i < 25; i++) hits.push(slow.push(14, true));
    expect(hits.filter(Boolean)).toHaveLength(1);
    expect(hits[9]).toBe(true);
    expect(slow.shed).toBe(true);
    slow.reset();
    expect(slow.shed).toBe(false);
    const off = new BlurShed(10, 10);
    for (let i = 0; i < 30; i++) expect(off.push(50, false)).toBe(false);
    expect(off.shed).toBe(false);
  });
});
