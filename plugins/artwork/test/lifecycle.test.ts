// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activity, isPluginRecord, isPluginUi } from "../src/bg-activity.js";
import { bgIds, CanvasBg, syncBackgrounds, type BgHost } from "../src/bg-base.js";
import { BG_KINDS, type BgConfig, type BgKind } from "../src/bg-model.js";
import { GOVERNOR_LIMITS, QualityGovernor } from "../src/bg-perf.js";
import { COLOR_PROBE_ID, isOpaqueColor } from "../src/bg-surfaces.js";
import { GradientDrift } from "../src/drift.js";
import { cellLetter, Ocean } from "../src/ocean.js";
import { Starfield } from "../src/starfield.js";

/**
 * WP-17 lifecycle guarantees for all four backgrounds: exactly one canvas and one frame loop after any sequence of
 * mount, unmount, switch and resize; nothing left behind (listeners, observers, timers, DOM); no blank frame after
 * a resize; theme changes repaint at once, also while frozen.
 */

/** A 2D context stand-in: every method is a counted no-op. */
function fakeCtx(): CanvasRenderingContext2D & { calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const props: Record<string, unknown> = { calls, font: "", textBaseline: "", fillStyle: "", strokeStyle: "", lineWidth: 1, lineCap: "", globalAlpha: 1, filter: "none" };
  return new Proxy(props, {
    get(t, k: string) {
      if (k in t) return t[k];
      if (k === "measureText") return (s: string) => ({ width: s.length * 9 });
      if (k === "getImageData") return () => ({ data: new Uint8ClampedArray([1, 2, 3, 255]) });
      if (k === "createRadialGradient") return () => ({ addColorStop: () => {} });
      return () => {
        calls[k] = (calls[k] ?? 0) + 1;
      };
    },
    set(t, k: string, v) {
      t[k] = v;
      return true;
    },
  }) as never;
}

let kind: BgKind;
let on: boolean;
let cfg: Omit<BgConfig, "on">;
let raf: Map<number, FrameRequestCallback>;
let nextId: number;
let ctxs: Array<ReturnType<typeof fakeCtx>>;
let media: Array<{ query: string; listeners: Set<() => void> }>;
let live: Map<string, number>;
let realAdd: typeof EventTarget.prototype.addEventListener;
let realRemove: typeof EventTarget.prototype.removeEventListener;

const hostFor = (k: BgKind): BgHost => ({ config: () => ({ ...cfg, on: on && kind === k }) });
const make = (k: BgKind): CanvasBg =>
  k === "ocean" ? new Ocean(hostFor(k)) : k === "starfield" ? new Starfield(k, hostFor(k)) : new GradientDrift(k, hostFor(k));
const draws = (): number => ctxs.reduce((n, c) => n + (c.calls.fillText ?? 0) + (c.calls.stroke ?? 0) + (c.calls.fill ?? 0) + (c.calls.fillRect ?? 0) + (c.calls.drawImage ?? 0), 0);
const flush = (ms: number): void => {
  const pending = [...raf.values()];
  raf.clear();
  for (const cb of pending) cb(ms);
};
const canvases = (): number => document.querySelectorAll("canvas").length;
/** Listeners still attached, by target and type (only ones added during the test). */
const liveListeners = (): string[] => [...live.entries()].filter(([, n]) => n > 0).map(([k]) => k);

const label = (t: EventTarget): string => (t === window ? "window" : t === document ? "document" : t instanceof HTMLCanvasElement ? "canvas" : "other");
const fnIds = new WeakMap<object, number>();
let fnSeq = 0;
const key = (t: EventTarget, type: string, fn: unknown, opts: unknown): string => {
  const capture = typeof opts === "boolean" ? opts : !!(opts as { capture?: boolean } | undefined)?.capture;
  if (fn && !fnIds.has(fn as object)) fnIds.set(fn as object, ++fnSeq);
  return `${label(t)}:${type}:${capture}:${fn ? fnIds.get(fn as object) : 0}`;
};

beforeEach(() => {
  CanvasBg.frameTimers = false;
  kind = "ocean";
  on = true;
  cfg = { intensity: 60, speed: 50, density: 50, pointer: true, ripples: true, followAccent: true, hue: -1, lowPower: false, quality: "high", pauseWhileTyping: false, dim: 0, blur: 0 };
  raf = new Map();
  nextId = 1;
  ctxs = [];
  media = [];
  live = new Map();
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
  vi.stubGlobal("matchMedia", (query: string) => {
    const entry = { query, listeners: new Set<() => void>() };
    media.push(entry);
    return { matches: false, addEventListener: (_: string, fn: () => void) => entry.listeners.add(fn), removeEventListener: (_: string, fn: () => void) => entry.listeners.delete(fn) };
  });
  realAdd = EventTarget.prototype.addEventListener;
  realRemove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, fn: never, opts?: never) {
    const k = key(this, type, fn, opts);
    live.set(k, (live.get(k) ?? 0) + 1);
    return realAdd.call(this, type, fn, opts);
  } as never;
  EventTarget.prototype.removeEventListener = function (this: EventTarget, type: string, fn: never, opts?: never) {
    const k = key(this, type, fn, opts);
    if (live.has(k)) live.set(k, Math.max(0, live.get(k)! - 1));
    return realRemove.call(this, type, fn, opts);
  } as never;
  document.documentElement.style.setProperty("--foreground", "rgb(230, 230, 230)");
  document.documentElement.style.setProperty("--primary", "rgb(10, 200, 120)");
});

afterEach(() => {
  EventTarget.prototype.addEventListener = realAdd;
  EventTarget.prototype.removeEventListener = realRemove;
  CanvasBg.frameTimers = true;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("class");
});

describe.each(BG_KINDS)("%s: one canvas, one loop, nothing left behind", (k) => {
  beforeEach(() => {
    kind = k;
  });

  it("mount is idempotent and unmount removes every listener, observer, timer and node", () => {
    const bg = make(k);
    // Warm-up with another instance: jsdom adds a few document listeners of its own on first use. Our listeners are
    // per instance, so a leak of the real one still shows against this baseline.
    const warm = make(k);
    warm.update();
    warm.stop();
    const baseline = liveListeners();
    bg.update();
    bg.update();
    bg.update();
    expect(canvases()).toBe(1);
    expect(raf.size).toBe(1);
    expect(bg.looping).toBe(true);
    expect(liveListeners().length).toBeGreaterThan(0);
    on = false;
    bg.update();
    bg.update();
    bg.stop();
    expect(canvases()).toBe(0);
    expect(document.getElementById(bgIds(k).style)).toBeNull();
    expect(document.documentElement.hasAttribute(bgIds(k).attr)).toBe(false);
    expect(raf.size).toBe(0);
    expect(bg.looping).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(liveListeners()).toEqual(baseline);
    expect(media.every((m) => m.listeners.size === 0)).toBe(true);
  });

  it("frames, resizes and setting changes keep exactly one loop", () => {
    const bg = make(k);
    bg.update();
    for (let i = 0; i < 20; i++) {
      flush(1000 + i * 34);
      if (i % 3 === 0) window.dispatchEvent(new Event("resize"));
      if (i % 4 === 0) {
        cfg = { ...cfg, intensity: 40 + i };
        bg.update();
      }
      expect(raf.size).toBe(1);
      expect(canvases()).toBe(1);
    }
    bg.stop();
    expect(raf.size).toBe(0);
  });

  it("a resize repaints at once (no blank frame until the next loop frame)", () => {
    const bg = make(k);
    bg.update();
    flush(1000);
    const before = draws();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 });
    window.dispatchEvent(new Event("resize"));
    expect(draws()).toBeGreaterThan(before);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    bg.stop();
  });

  it("a theme switch repaints at once, also while frozen by typing", async () => {
    cfg.pauseWhileTyping = true;
    let fg = "rgb(230, 230, 230)";
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element, pseudo?: string | null) => {
      const color = (el as HTMLElement).style?.color ?? "";
      if (color.includes("--foreground")) return { color: fg } as CSSStyleDeclaration;
      if (color.includes("--primary")) return { color: "rgb(10, 200, 120)" } as CSSStyleDeclaration;
      return real(el, pseudo);
    });
    const bg = make(k);
    bg.update();
    flush(1000);
    activity.poke();
    expect(bg.frozen).toBe(true);
    expect(raf.size).toBe(0);
    const before = draws();
    fg = "rgb(20, 40, 60)";
    document.documentElement.classList.add("dark");
    await Promise.resolve(); // MutationObserver callbacks run as microtasks
    // Starfield tints by the foreground; Drift and Ocean repaint on any palette change.
    expect(draws()).toBeGreaterThan(before);
    expect(raf.size).toBe(0); // still frozen: the repaint did not restart the loop
    bg.stop();
    expect(activity.busy).toBe(false);
  });
});

describe("switching presets", () => {
  it("syncBackgrounds stops the old layer before the new one mounts: never two canvases", () => {
    const baseline = liveListeners();
    const layers = BG_KINDS.map(make);
    const seen: number[] = [];
    const insert = document.body.insertBefore.bind(document.body);
    vi.spyOn(document.body, "insertBefore").mockImplementation(((node: Node, ref: Node | null) => {
      if (node instanceof HTMLCanvasElement) seen.push(canvases());
      return insert(node, ref);
    }) as never);
    for (const k of [...BG_KINDS, ...BG_KINDS].reverse()) {
      kind = k;
      const running = syncBackgrounds(layers);
      expect(running?.kind).toBe(k);
      expect(canvases()).toBe(1);
      expect(raf.size).toBe(1);
    }
    expect(seen.every((n) => n === 0)).toBe(true);
    on = false;
    expect(syncBackgrounds(layers)).toBeNull();
    expect(canvases()).toBe(0);
    expect(raf.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(liveListeners()).toEqual(baseline);
  });
});

describe("frame scheduling", () => {
  it("sleeps on a timer between frames instead of waking every display frame", () => {
    CanvasBg.frameTimers = true;
    kind = "starfield";
    const bg = make("starfield");
    bg.update();
    flush(1000);
    // Between frames: no animation frame requested, one timer armed.
    expect(raf.size).toBe(0);
    expect(bg.looping).toBe(true);
    vi.advanceTimersByTime(30);
    expect(raf.size).toBe(1);
    // A 120 Hz display would call rAF 120 times a second; the loop asks for about one per drawn frame.
    let requests = 0;
    const counted = globalThis.requestAnimationFrame;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      requests++;
      return counted(cb);
    });
    let ms = 1034;
    for (let i = 0; i < 30; i++) {
      flush(ms);
      vi.advanceTimersByTime(34);
      ms += 34;
    }
    expect(requests).toBeLessThanOrEqual(31);
    bg.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("throttled frames (minimized window) do not count against the auto quality", () => {
    const gov = new QualityGovernor();
    gov.tick(0);
    for (let i = 0; i < 20; i++) gov.frame(0.5, GOVERNOR_LIMITS.throttledMs + 200); // 2 rAF/s while minimized
    expect(gov.tick(GOVERNOR_LIMITS.windowMs)).toBe("keep");
    gov.tick(0);
    const fresh = new QualityGovernor();
    fresh.tick(0);
    for (let i = 0; i < 20; i++) fresh.frame(0.5, i % 2 ? GOVERNOR_LIMITS.stallMs + 20 : 0); // real stalls
    expect(fresh.tick(GOVERNOR_LIMITS.windowMs)).toBe("down");
  });
});

describe("presets", () => {
  it("Starfield does not re-layout (snap) on a settings change that keeps the count", () => {
    kind = "starfield";
    const layout = vi.spyOn(Starfield.prototype as unknown as { layout(w: number, h: number): void }, "layout");
    const bg = make("starfield");
    bg.update();
    const n = layout.mock.calls.length;
    cfg = { ...cfg, intensity: 80 };
    bg.update();
    cfg = { ...cfg, speed: 70 };
    bg.update();
    expect(layout.mock.calls.length).toBe(n);
    cfg = { ...cfg, density: 90 };
    bg.update();
    expect(layout.mock.calls.length).toBe(n + 1);
    bg.stop();
  });

  it("Ocean letters come from the cell, so a resize keeps them in place", () => {
    expect(cellLetter(3, 7)).toBe(cellLetter(3, 7));
    const letters = new Set(Array.from({ length: 200 }, (_, i) => cellLetter(i % 20, (i / 20) | 0)));
    expect(letters.size).toBeGreaterThan(30);
  });

  it("Ocean ignores clicks while frozen or still (no stray ripple), ripples while running", () => {
    kind = "ocean";
    const bg = make("ocean") as Ocean;
    bg.update();
    const down = (): void => {
      const e = new Event("pointerdown");
      Object.assign(e, { button: 0, clientX: 50, clientY: 50 });
      window.dispatchEvent(e);
    };
    down();
    expect(bg.ripples).toBe(1);
    cfg = { ...cfg, speed: 0 };
    bg.update();
    down();
    expect(bg.ripples).toBe(1);
    bg.stop();
  });
});

describe("activity gate input", () => {
  it("plugin UI re-renders and color probes are not streaming", () => {
    const dock = document.createElement("div");
    dock.className = "t3p-dock";
    const card = document.createElement("article");
    dock.append(card);
    document.body.append(dock);
    const plain = document.createElement("div");
    document.body.append(plain);
    const probe = document.createElement("i");
    probe.id = COLOR_PROBE_ID;
    const rec = (target: Node, added: Node[] = []): Pick<MutationRecord, "target" | "type" | "addedNodes" | "removedNodes"> => ({
      target,
      type: "childList",
      addedNodes: added as unknown as NodeList,
      removedNodes: [] as unknown as NodeList,
    });
    expect(isPluginUi(card)).toBe(true);
    expect(isPluginUi(plain)).toBe(false);
    expect(isPluginUi(document.body)).toBe(false);
    // A plugin state class on <body> (the open dock) must not hide the whole page.
    document.body.classList.add("t3p-dock-open");
    expect(isPluginUi(plain)).toBe(false);
    expect(isPluginRecord(rec(plain))).toBe(false);
    expect(isPluginUi(card)).toBe(true);
    document.body.classList.remove("t3p-dock-open");
    expect(isPluginRecord(rec(card))).toBe(true);
    expect(isPluginRecord(rec(document.body, [probe]))).toBe(true);
    expect(isPluginRecord(rec(document.body, [plain]))).toBe(false);
    expect(isPluginRecord(rec(plain))).toBe(false);
  });

  it("a busy plugin dock does not freeze the background; the chat streaming does", async () => {
    vi.useRealTimers();
    const off = activity.subscribe({ busy: () => {} });
    const dock = document.createElement("div");
    dock.className = "t3p-dock";
    document.body.append(dock);
    for (let i = 0; i < 40; i++) {
      dock.append(document.createElement("article"));
      await Promise.resolve();
    }
    expect(activity.busy).toBe(false);
    document.body.classList.add("t3p-dock-open");
    const chat = document.createElement("main");
    document.body.append(chat);
    for (let i = 0; i < 40; i++) {
      chat.append(document.createElement("p"));
      await Promise.resolve();
    }
    expect(activity.busy).toBe(true);
    off();
    expect(activity.busy).toBe(false);
  });
});

describe("see-through surfaces", () => {
  it("only fully opaque layers are cleared, never a tinting backdrop", () => {
    expect(isOpaqueColor("rgb(10, 10, 10)")).toBe(true);
    expect(isOpaqueColor("rgba(10, 10, 10, 1)")).toBe(true);
    expect(isOpaqueColor("oklch(0.2 0.01 250)")).toBe(true);
    expect(isOpaqueColor("rgba(0, 0, 0, 0.32)")).toBe(false);
    expect(isOpaqueColor("rgba(0, 0, 0, 0)")).toBe(false);
    expect(isOpaqueColor("rgb(0 0 0 / 0.5)")).toBe(false);
    expect(isOpaqueColor("oklch(0.2 0.01 250 / 50%)")).toBe(false);
    expect(isOpaqueColor("color(srgb 1 1 1 / 1)")).toBe(true);
    expect(isOpaqueColor("transparent")).toBe(false);
    expect(isOpaqueColor("")).toBe(false);
  });
});
