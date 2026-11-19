// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { activity } from "../src/bg-activity.js";
import { oceanPalette, oceanParams, parseRgb, type OceanConfig } from "../src/model.js";
import { OCEAN_ATTR, OCEAN_CLEAR_ATTR, OCEAN_CANVAS_ID, OCEAN_STYLE_ID, Ocean } from "../src/ocean.js";

describe("ocean model", () => {
  it("maps intensity and speed to params, speed 0 is not animated", () => {
    expect(oceanParams({ intensity: 60, speed: 50 })).toMatchObject({ alpha: 1, drift: 0.035, shimmer: 0.015, rippleSpeed: 300, animated: true });
    expect(oceanParams({ intensity: 0, speed: 0 })).toMatchObject({ alpha: 0, drift: 0, shimmer: 0, animated: false });
    expect(oceanParams({ intensity: 999, speed: 999 }).alpha).toBeCloseTo(100 / 60, 2);
  });

  it("builds ink from the foreground and glow from the accent, never fixed colors", () => {
    const dark = oceanPalette([240, 240, 240], [10, 200, 120], 1);
    const light = oceanPalette([20, 20, 20], [10, 200, 120], 1);
    expect(dark.ink).toHaveLength(5);
    expect(dark.ink[0]).toBe("rgba(240,240,240,0.035)");
    expect(light.ink[4]).toBe("rgba(20,20,20,0.18)");
    expect(dark.glow[0]).toBe("rgba(10,200,120,0.45)");
    expect(oceanPalette([0, 0, 0], [0, 0, 0], 0).ink.every((c) => c.endsWith(",0)"))).toBe(true);
  });

  it("parses rgb and hex, rejects the rest", () => {
    expect(parseRgb("rgb(1, 2, 3)")).toEqual([1, 2, 3]);
    expect(parseRgb("rgba(10 20 30 / 0.5)")).toEqual([10, 20, 30]);
    expect(parseRgb("#fff")).toEqual([255, 255, 255]);
    expect(parseRgb("#0a141e")).toEqual([10, 20, 30]);
    expect(parseRgb("oklch(0.7 0.1 100)")).toBeNull();
  });
});

function fakeCtx() {
  return {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    measureText: (s: string) => ({ width: s.length * 9 }),
    getImageData: () => ({ data: new Uint8ClampedArray([1, 2, 3, 255]) }),
    font: "",
    textBaseline: "",
    fillStyle: "",
  };
}

let cfg: OceanConfig;
let raf: Map<number, FrameRequestCallback>;
let nextId: number;
let reduced: boolean;
let ocean: Ocean;
const flush = (ms = 100): void => {
  const pending = [...raf.values()];
  raf.clear();
  for (const cb of pending) cb(ms);
};
const setHidden = (hidden: boolean): void => {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
};

beforeEach(() => {
  cfg = { on: true, intensity: 60, speed: 50, ripples: true, hue: -1 };
  raf = new Map();
  nextId = 1;
  reduced = false;
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  HTMLCanvasElement.prototype.getContext = (() => fakeCtx()) as never;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    raf.set(nextId, cb);
    return nextId++;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => void raf.delete(id));
  vi.stubGlobal("matchMedia", () => ({ matches: reduced }));
  setHidden(false);
  document.documentElement.style.setProperty("--foreground", "rgb(230, 230, 230)");
  document.documentElement.style.setProperty("--primary", "rgb(10, 200, 120)");
  ocean = new Ocean({ config: () => cfg });
});

afterEach(() => {
  ocean.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

const canvas = (): HTMLCanvasElement | null => document.getElementById(OCEAN_CANVAS_ID) as HTMLCanvasElement | null;

function pointerDown(target: EventTarget, x = 40, y = 40): Event {
  const down = new Event("pointerdown", { bubbles: true, cancelable: true });
  Object.assign(down, { button: 0, clientX: x, clientY: y });
  target.dispatchEvent(down);
  return down;
}

describe("ocean lifecycle", () => {
  it("creates a fixed, click-through canvas behind the app and marks <html>", () => {
    ocean.update();
    const c = canvas()!;
    expect(c).not.toBeNull();
    expect(document.body.firstElementChild).toBe(c);
    expect(document.documentElement.hasAttribute(OCEAN_ATTR)).toBe(true);
    const css = document.getElementById(OCEAN_STYLE_ID)!.textContent!;
    expect(css).toContain("pointer-events:none");
    expect(css).toContain("z-index:-1");
    expect(css).toContain("position:fixed");
    // theme variables only: no hard-coded color literals
    expect(css).toContain("var(--background");
    expect(css).not.toMatch(/#[0-9a-f]{3,6}\b|rgba?\(/i);
    expect(raf.size).toBe(1);
  });

  it("is a no-op while off, and update() twice keeps a single canvas", () => {
    cfg.on = false;
    ocean.update();
    expect(canvas()).toBeNull();
    cfg.on = true;
    ocean.update();
    ocean.update();
    expect(document.querySelectorAll(`#${OCEAN_CANVAS_ID}`)).toHaveLength(1);
    expect(document.querySelectorAll(`#${OCEAN_STYLE_ID}`)).toHaveLength(1);
    expect(raf.size).toBe(1);
  });

  it("switching off removes canvas, style, attribute, raf, timer and listeners", () => {
    const removed = vi.spyOn(window, "removeEventListener");
    ocean.update();
    expect(raf.size).toBe(1);
    cfg.on = false;
    ocean.update();
    expect(canvas()).toBeNull();
    expect(document.getElementById(OCEAN_STYLE_ID)).toBeNull();
    expect(document.documentElement.hasAttribute(OCEAN_ATTR)).toBe(false);
    expect(raf.size).toBe(0);
    expect(removed.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(["resize", "pointerdown", "pointermove", "scroll"]));
    expect(vi.getTimerCount()).toBe(0);
    expect(ocean.running).toBe(false);
    expect(() => pointerDown(window)).not.toThrow();
  });

  it("listens on window, not the canvas, and never blocks the app", () => {
    const adds = vi.spyOn(window, "addEventListener");
    ocean.update();
    expect(adds.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(["pointerdown", "pointermove"]));
    const target = document.createElement("button");
    const seen = vi.fn();
    target.addEventListener("pointerdown", seen);
    document.body.append(target);
    const down = pointerDown(target);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(down.defaultPrevented).toBe(false);
  });

  it("pauses while hidden and resumes when visible again", () => {
    ocean.update();
    expect(raf.size).toBe(1);
    setHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(raf.size).toBe(0);
    setHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(raf.size).toBe(1);
  });

  it("draws one still frame and never loops under reduced motion or speed 0", () => {
    reduced = true;
    ocean.update();
    expect(canvas()).not.toBeNull();
    expect(raf.size).toBe(0);
    reduced = false;
    cfg.speed = 0;
    ocean.update();
    expect(raf.size).toBe(0);
    cfg.speed = 50;
    ocean.update();
    expect(raf.size).toBe(1);
  });

  it("frames run, a click ripple draws, and ripples off ignores clicks", () => {
    const ctx = fakeCtx();
    HTMLCanvasElement.prototype.getContext = (() => ctx) as never;
    ocean.update();
    flush(100);
    pointerDown(window, 100, 100);
    expect(() => flush(200)).not.toThrow();
    expect(ctx.fillText.mock.calls.length).toBeGreaterThan(0);
    cfg.ripples = false;
    ocean.update();
    ctx.fillText.mockClear();
    ctx.clearRect.mockClear();
    pointerDown(window, 300, 300);
    expect(ctx.fillText).not.toHaveBeenCalled();
  });

  it("quality tiers: Static draws one frame, Low shrinks the backing store; pause while typing freezes it", () => {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
    cfg.quality = "static";
    ocean.update();
    expect(raf.size).toBe(0);
    const canvas = ocean.canvas!;
    const css = document.documentElement.clientWidth || window.innerWidth;
    expect(canvas.width / css).toBeLessThanOrEqual(1.01);
    cfg.quality = "low";
    ocean.update();
    expect(raf.size).toBe(1);
    expect(canvas.width / css).toBeLessThanOrEqual(0.76);
    vi.useRealTimers(); // re-install with timeouts too (the activity monitor re-checks with one)
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    let clock = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    cfg.pauseWhileTyping = true;
    ocean.update();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "x" }));
    expect(ocean.frozen).toBe(true);
    expect(raf.size).toBe(0);
    // clicks still ripple: a pointer press is not "busy"
    window.dispatchEvent(new Event("pointerdown"));
    clock += 2000;
    vi.advanceTimersByTime(2000);
    expect(ocean.frozen).toBe(false);
    expect(raf.size).toBe(1);
    ocean.stop();
    expect(activity.busy).toBe(false);
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 });
  });

  it("repaints with new ink after the app text color changes", () => {
    const ctx = fakeCtx();
    const styles: string[] = [];
    Object.defineProperty(ctx, "fillStyle", { get: () => "", set: (v: string) => void styles.push(v) });
    HTMLCanvasElement.prototype.getContext = (() => ctx) as never;
    // jsdom does not resolve var() in computed color: stand in for the browser
    let fg = "rgb(230, 230, 230)";
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element, pseudo?: string | null) => {
      const color = (el as HTMLElement).style?.color ?? "";
      if (color.includes("--foreground")) return { color: fg } as CSSStyleDeclaration;
      if (color.includes("--primary")) return { color: "rgb(10, 200, 120)" } as CSSStyleDeclaration;
      return real(el, pseudo);
    });
    ocean.update();
    flush(100);
    styles.length = 0;
    fg = "rgb(20, 40, 60)";
    vi.advanceTimersByTime(2100); // the theme poll reads computed styles every other second
    flush(200);
    expect(styles.some((s) => s.startsWith("rgba(20,40,60,"))).toBe(true);
  });

  it("marks only big opaque layers see-through and unmarks them on stop", () => {
    const big = document.createElement("div");
    const card = document.createElement("div");
    const clear = document.createElement("div");
    document.body.append(big, card, clear);
    const rect = (w: number, h: number) => () => ({ width: w, height: h }) as DOMRect;
    big.getBoundingClientRect = rect(window.innerWidth, window.innerHeight);
    card.getBoundingClientRect = rect(200, 100);
    clear.getBoundingClientRect = rect(window.innerWidth, window.innerHeight);
    const bgs = new Map<Element, string>([[big, "rgb(0, 0, 0)"], [card, "rgb(9, 9, 9)"], [clear, "rgba(0, 0, 0, 0)"]]);
    const real = window.getComputedStyle.bind(window);
    vi.stubGlobal("getComputedStyle", (el: Element, p?: string | null) => (bgs.has(el) ? ({ backgroundColor: bgs.get(el), color: "rgb(1, 2, 3)" } as CSSStyleDeclaration) : real(el, p)));
    document.elementsFromPoint = () => [card, big, clear];
    ocean.update();
    expect(big.hasAttribute(OCEAN_CLEAR_ATTR)).toBe(true);
    expect(card.hasAttribute(OCEAN_CLEAR_ATTR)).toBe(false);
    expect(clear.hasAttribute(OCEAN_CLEAR_ATTR)).toBe(false);
    expect(document.getElementById(OCEAN_STYLE_ID)!.textContent).toContain(OCEAN_CLEAR_ATTR);
    cfg.on = false;
    ocean.update();
    expect(big.hasAttribute(OCEAN_CLEAR_ATTR)).toBe(false);
  });
});
