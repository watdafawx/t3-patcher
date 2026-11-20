// @vitest-environment jsdom
import type { SettingChange, SettingSchema, SettingValue, SettingsPanelOptions, T3Api, UiSlotRegistration } from "@t3p/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import plugin from "../src/index.js";
import { resetAllArtwork } from "../src/reset.js";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

function fakeT3(initial: Record<string, SettingValue> = {}, stored: Record<string, unknown> = {}) {
  let schemas: SettingSchema[] = [];
  const values = new Map<string, SettingValue>(Object.entries(initial));
  const listeners = new Set<(c: SettingChange) => void>();
  const sets: Array<[string, SettingValue]> = [];
  const get = (key: string): SettingValue => values.get(key) ?? schemas.find((s) => s.key === key)!.default;
  const regs: UiSlotRegistration[] = [];
  const commands = new Map<string, { run(): unknown }>();
  const panels: Array<{ keys?: string[]; options: SettingsPanelOptions; disposed: boolean }> = [];
  const open = vi.fn();
  const store = new Map<string, unknown>(Object.entries(stored));
  const t3 = {
    settings: {
      define: (s: SettingSchema[]) => {
        schemas = s;
        return { dispose: () => undefined };
      },
      get,
      set: async (key: string, value: SettingValue) => {
        sets.push([key, value]);
        const previous = get(key);
        values.set(key, value);
        for (const l of listeners) l({ key, value, previous });
      },
      reset: async (key: string) => {
        const previous = get(key);
        values.delete(key);
        for (const l of listeners) l({ key, value: get(key), previous });
      },
      onChange: (cb: (c: SettingChange) => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      getSchemas: () => schemas,
    },
    storage: {
      get: async (k: string) => store.get(k),
      set: async (k: string, v: unknown) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
      usage: async () => ({ usedBytes: 0, limitBytes: 1_048_576 }),
    },
    ui: {
      register(reg: UiSlotRegistration) {
        regs.push(reg);
        return { dispose: () => void regs.splice(regs.indexOf(reg), 1) };
      },
      toast: () => undefined,
      modal: async () => 0,
      settingsPanel(_host: HTMLElement, options: SettingsPanelOptions = {}) {
        const entry = { keys: options.keys, options, disposed: false };
        panels.push(entry);
        return { dispose: () => void (entry.disposed = true) };
      },
      dock: { open, close: vi.fn(), toggle: vi.fn(), isOpen: () => false },
    },
    commands: {
      register(c: { id: string; run(): unknown }) {
        commands.set(c.id, c);
        return { dispose: () => void commands.delete(c.id) };
      },
    },
  };
  return { t3: t3 as unknown as T3Api, sets, regs, commands, panels, open, values, store };
}

const sw = (preset: string): HTMLButtonElement => document.querySelector(`[data-t3p-preset="${preset}"]`) as HTMLButtonElement;

let stop: void | (() => void);
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => {
  if (typeof stop === "function") stop();
  stop = undefined;
  vi.useRealTimers();
  document.body.innerHTML = "";
  document.head.querySelectorAll("style").forEach((s) => s.remove());
});

async function start(fake: ReturnType<typeof fakeT3>, mount = true): Promise<HTMLElement> {
  stop = plugin.start(fake.t3) as () => void;
  const host = document.createElement("div");
  document.body.appendChild(host);
  if (mount) fake.regs.find((r) => r.slot === "rightPanel")!.render(host, {} as never);
  await vi.advanceTimersByTimeAsync(0);
  return host;
}

describe("artwork dock tab", () => {
  it("registers a rightPanel tab titled Artwork and keeps the settingsPage card", async () => {
    const fake = fakeT3();
    await start(fake, false);
    const tab = fake.regs.find((r) => r.slot === "rightPanel")!;
    expect(tab.id).toBe("panel");
    expect(tab.title).toBe("Artwork");
    expect(fake.regs.some((r) => r.slot === "settingsPage")).toBe(true);
  });

  it("renders a swatch per preset with the current one pressed", async () => {
    const fake = fakeT3({ preset: "mesh" });
    await start(fake);
    expect([...document.querySelectorAll("[data-t3p-preset]")].map((b) => b.getAttribute("data-t3p-preset"))).toEqual(["aurora", "gradient", "mesh", "image", "none"]);
    expect(sw("mesh").getAttribute("aria-pressed")).toBe("true");
    expect(sw("aurora").getAttribute("aria-pressed")).toBe("false");
  });

  it("clicking a swatch writes the preset and shows it at once", async () => {
    const fake = fakeT3();
    await start(fake);
    sw("gradient").click();
    expect(fake.sets).toContainEqual(["preset", "gradient"]);
    expect(sw("gradient").getAttribute("aria-pressed")).toBe("true");
  });

  it("uses the generic settings helper for the plain controls", async () => {
    const fake = fakeT3();
    await start(fake);
    expect(fake.panels.map((p) => p.keys)).toEqual([
      ["intensity", "speed", "fadeHeight", "blur", "angle", "scrim", "mainGlow"],
      ["oceanIntensity", "oceanSpeed", "bgDim", "bgBlur", "oceanRipples"],
      ["bgIntensity", "bgSpeed", "bgDensity", "bgDim", "bgBlur", "bgFollowAccent", "bgLowPower"],
      ["bgIntensity", "bgSpeed", "bgDensity", "bgDim", "bgBlur", "bgPointer", "bgFollowAccent", "bgLowPower"],
      ["bgQuality", "bgPauseWhileTyping"],
      ["logoMode", "logoText", "logoHeight"],
    ]);
    const schemas = fake.t3.settings.getSchemas();
    for (const key of ["intensity", "speed", "fadeHeight", "blur", "angle", "logoHeight"]) expect(schemas.find((s) => s.key === key)?.type).toBe("range");
    for (const p of fake.panels) for (const key of p.keys!) expect(schemas.some((s) => s.key === key)).toBe(true);
  });

  describe("background kind (radio)", () => {
    const chip = (id: string): HTMLButtonElement => document.querySelector(`[data-t3p-bg-kind="${id}"]`) as HTMLButtonElement;
    const roots = (): string[] => ["t3p-ocean", "t3p-bg-drift", "t3p-bg-starfield"].filter((id) => document.getElementById(id));

    it("shows Off plus three kinds as a radio group, Off checked by default", async () => {
      await start(fakeT3());
      expect([...document.querySelectorAll("[data-t3p-bg-kind]")].map((b) => b.getAttribute("data-t3p-bg-kind"))).toEqual(["off", "ocean", "drift", "starfield"]);
      expect(document.querySelector("[data-t3p-bg]")!.getAttribute("role")).toBe("radiogroup");
      expect(chip("off").getAttribute("aria-checked")).toBe("true");
      expect(chip("ocean").getAttribute("aria-checked")).toBe("false");
      expect(roots()).toEqual([]);
    });

    it("picking a kind turns the app background on with that kind; only one runs at a time", async () => {
      const fake = fakeT3();
      await start(fake);
      chip("starfield").click();
      await vi.advanceTimersByTimeAsync(0);
      expect(fake.sets).toEqual(expect.arrayContaining([["bgKind", "starfield"], ["oceanOn", true]]));
      expect(chip("starfield").getAttribute("aria-checked")).toBe("true");
      expect(roots()).toEqual(["t3p-bg-starfield"]);
      chip("drift").click();
      await vi.advanceTimersByTimeAsync(0);
      expect(roots()).toEqual(["t3p-bg-drift"]);
      chip("ocean").click();
      await vi.advanceTimersByTimeAsync(0);
      expect(roots()).toEqual(["t3p-ocean"]);
      chip("off").click();
      await vi.advanceTimersByTimeAsync(0);
      expect(roots()).toEqual([]);
      expect(fake.t3.settings.get("oceanOn")).toBe(false);
      expect(chip("off").getAttribute("aria-checked")).toBe("true");
    });

    it("shows only the settings block of the active kind", async () => {
      await start(fakeT3({ oceanOn: true, bgKind: "starfield" }));
      const visible = [...document.querySelectorAll<HTMLElement>("[data-t3p-bg-settings]")].filter((b) => !b.hidden).map((b) => b.getAttribute("data-t3p-bg-settings"));
      expect(visible).toEqual(["starfield", "performance"]); // the Performance group belongs to every kind
      chip("off").click();
      expect([...document.querySelectorAll<HTMLElement>("[data-t3p-bg-settings]")].every((b) => b.hidden)).toBe(true);
    });

    it("a saved Antigravity (dropped in WP-17) falls back to the Ocean", async () => {
      await start(fakeT3({ oceanOn: true, bgKind: "antigravity" }));
      expect(roots()).toEqual(["t3p-ocean"]);
      expect(document.getElementById("t3p-bg-antigravity")).toBeNull();
      expect(document.querySelector('[data-t3p-bg-kind="antigravity"]')).toBeNull();
      expect(chip("ocean").getAttribute("aria-checked")).toBe("true");
    });

    it("an old install with only oceanOn=true still gets the Ocean", async () => {
      await start(fakeT3({ oceanOn: true }));
      expect(roots()).toEqual(["t3p-ocean"]);
    });

    it("stopping the plugin removes whichever background is running", async () => {
      const fake = fakeT3({ oceanOn: true, bgKind: "drift" });
      await start(fake);
      expect(roots()).toEqual(["t3p-bg-drift"]);
      (stop as () => void)();
      stop = undefined;
      expect(roots()).toEqual([]);
      expect(document.documentElement.getAttribute("data-t3p-bg-drift")).toBeNull();
    });
  });

  it("slider moves preview live (onLive) before any write", async () => {
    const fake = fakeT3();
    await start(fake);
    const layer = document.querySelector(".t3p-art-layer") as HTMLElement | null;
    fake.panels[0]!.options.onLive!("intensity", 100);
    expect(fake.sets).toEqual([]);
    if (layer) expect(layer.style.getPropertyValue("--t3p-art-opacity")).toBe("0.85");
    // the real write arrives: preview override is dropped, value stays
    await fake.t3.settings.set("intensity", 100);
    expect(document.querySelector(".t3p-art-grid")).not.toBeNull();
  });

  it("hue: follow-accent switch writes -1, turning it off restores a fixed hue", async () => {
    const fake = fakeT3({ hue: 200 });
    await start(fake);
    const follow = document.querySelector("[data-t3p-follow]") as HTMLInputElement;
    const hueIn = document.querySelector("[data-t3p-hue-input]") as HTMLInputElement;
    expect(follow.checked).toBe(false);
    expect(hueIn.value).toBe("200");
    follow.checked = true;
    follow.dispatchEvent(new Event("change"));
    expect(fake.sets.at(-1)).toEqual(["hue", -1]);
    expect(document.querySelector("[data-t3p-hue]")!.hasAttribute("data-follow")).toBe(true);
    follow.checked = false;
    follow.dispatchEvent(new Event("change"));
    expect(fake.sets.at(-1)).toEqual(["hue", 200]);
    expect(document.querySelector("[data-t3p-hue]")!.hasAttribute("data-follow")).toBe(false);
  });

  it("hue slider debounces writes and releasing writes at once", async () => {
    const fake = fakeT3({ hue: 100 });
    await start(fake);
    const hueIn = document.querySelector("[data-t3p-hue-input]") as HTMLInputElement;
    for (const v of ["110", "120", "130"]) {
      hueIn.value = v;
      hueIn.dispatchEvent(new Event("input"));
    }
    expect(fake.sets).toEqual([]);
    vi.advanceTimersByTime(121);
    expect(fake.sets).toEqual([["hue", 130]]);
    hueIn.value = "140";
    hueIn.dispatchEvent(new Event("input"));
    hueIn.dispatchEvent(new Event("change"));
    expect(fake.sets.at(-1)).toEqual(["hue", 140]);
    vi.advanceTimersByTime(500);
    expect(fake.sets.length).toBe(2);
  });

  it("lists saved images with Use and Delete", async () => {
    const arts = [{ id: "a1", name: "Dusk", bytes: 20480 }, { id: "a2", name: "Forest", bytes: 10240 }];
    const fake = fakeT3({ artworkName: "Forest" }, { arts, "art:a1": PNG, "art:a2": PNG });
    await start(fake);
    await vi.advanceTimersByTimeAsync(5);
    const rows = [...document.querySelectorAll("[data-t3p-image]")];
    expect(rows.map((r) => r.getAttribute("data-t3p-image"))).toEqual(["Dusk", "Forest"]);
    expect(rows[1]!.hasAttribute("data-active")).toBe(true);
    expect((rows[0]!.querySelector("img") as HTMLImageElement).src).toContain("data:image/png");
    const use = rows[0]!.querySelectorAll("button")[0] as HTMLButtonElement;
    expect(use.textContent).toBe("Use");
    use.click();
    await vi.advanceTimersByTimeAsync(5);
    expect(fake.sets).toContainEqual(["artworkName", "Dusk"]);
    expect(fake.sets).toContainEqual(["preset", "image"]);
    const del = document.querySelector('[data-t3p-image="Dusk"]')!.querySelectorAll("button")[1] as HTMLButtonElement;
    del.click();
    await vi.advanceTimersByTimeAsync(5);
    expect(fake.store.has("art:a1")).toBe(false);
    expect([...document.querySelectorAll("[data-t3p-image]")].map((r) => r.getAttribute("data-t3p-image"))).toEqual(["Forest"]);
  });

  it("shows an empty state without images", async () => {
    await start(fakeT3());
    expect(document.querySelector("[data-t3p-images]")!.textContent).toContain("No saved images");
  });

  const q = (sel: string): HTMLElement => document.querySelector(sel) as HTMLElement;
  const clickReset = async (clear = false): Promise<void> => {
    q("[data-t3p-reset-start]").click();
    expect(q("[data-t3p-reset-confirm]").hidden).toBe(false);
    if (clear) {
      const tick = q("[data-t3p-reset-clear]") as HTMLInputElement;
      tick.checked = true;
    }
    q("[data-t3p-reset-yes]").click();
    await vi.advanceTimersByTimeAsync(300);
  };

  it("Reset all needs a second click and keeps images", async () => {
    const fake = fakeT3({ preset: "mesh", intensity: 10, hue: 50, oceanOn: true }, { arts: [{ id: "a1", name: "Dusk", bytes: 1 }], "art:a1": PNG });
    await start(fake);
    expect(q("[data-t3p-reset-start]").textContent).toBe("Reset all to defaults");
    expect(q("[data-t3p-reset-confirm]").hidden).toBe(true);
    q("[data-t3p-reset-start]").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.values.size).toBe(4); // nothing reset yet
    q("[data-t3p-reset-yes]").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.values.size).toBe(0);
    expect(fake.t3.settings.get("preset")).toBe("aurora");
    expect(fake.t3.settings.get("oceanOn")).toBe(false);
    expect(fake.store.has("art:a1")).toBe(true);
    expect(sw("aurora").getAttribute("aria-pressed")).toBe("true");
    expect(q("[data-t3p-reset-confirm]").hidden).toBe(true);
  });

  it("Cancel aborts the reset", async () => {
    const fake = fakeT3({ preset: "mesh" });
    await start(fake);
    q("[data-t3p-reset-start]").click();
    q("[data-t3p-reset-no]").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.t3.settings.get("preset")).toBe("mesh");
    expect(q("[data-t3p-reset-confirm]").hidden).toBe(true);
  });

  async function setupCustom(fake: ReturnType<typeof fakeT3>): Promise<void> {
    const box = q('[data-t3p-custom-target="header"]');
    const html = box.querySelector("[data-t3p-ct-html]") as HTMLTextAreaElement;
    const css = box.querySelector("[data-t3p-ct-css]") as HTMLTextAreaElement;
    html.value = "<div class=\"x\"></div>";
    css.value = ".x{opacity:.5}";
    html.dispatchEvent(new Event("input"));
    const enable = box.querySelector("[data-t3p-ct-enable]") as HTMLInputElement;
    enable.checked = true;
    enable.dispatchEvent(new Event("change"));
    await vi.advanceTimersByTimeAsync(600);
    expect((fake.store.get("custom") as { header: { enabled: boolean } }).header.enabled).toBe(true);
  }

  it("Reset all turns custom off but keeps its code unless the tick is set", async () => {
    const fake = fakeT3({ oceanOn: true });
    await start(fake);
    await setupCustom(fake);
    await clickReset(false);
    await vi.advanceTimersByTimeAsync(600);
    const header = (fake.store.get("custom") as { header: { enabled: boolean; html: string; css: string } }).header;
    expect(header.enabled).toBe(false);
    expect(header.html).toContain("class");
    expect(header.css).toContain(".x");
    expect(fake.t3.settings.get("oceanOn")).toBe(false);
  });

  it("Reset all with the tick clears the custom code and applies at once", async () => {
    const fake = fakeT3({ preset: "none", intensity: 5 });
    await start(fake);
    await setupCustom(fake);
    await clickReset(true);
    await vi.advanceTimersByTimeAsync(600);
    const header = (fake.store.get("custom") as { header: { enabled: boolean; html: string; css: string } }).header;
    expect(header).toEqual({ enabled: false, html: "", css: "" });
    expect(fake.values.size).toBe(0);
    expect(document.querySelector("[data-t3p-custom]")).toBeNull();
    expect((q('[data-t3p-custom-target="header"] [data-t3p-ct-html]') as HTMLTextAreaElement).value).toBe("");
  });

  it("the settings page card has the same reset control", async () => {
    const fake = fakeT3({ preset: "mesh" });
    await start(fake, false);
    const host = document.createElement("div");
    document.body.appendChild(host);
    fake.regs.find((r) => r.slot === "settingsPage")!.render(host, {} as never);
    await vi.advanceTimersByTimeAsync(0);
    (host.querySelector("[data-t3p-reset-start]") as HTMLElement).click();
    (host.querySelector("[data-t3p-reset-yes]") as HTMLElement).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.t3.settings.get("preset")).toBe("aurora");
  });

  it("follows settings changed elsewhere (Settings > Plugins)", async () => {
    const fake = fakeT3();
    await start(fake);
    await fake.t3.settings.set("preset", "none");
    expect(sw("none").getAttribute("aria-pressed")).toBe("true");
    expect(sw("aurora").getAttribute("aria-pressed")).toBe("false");
  });

  it("cleanup removes the tab body and disposes the helper panels", async () => {
    const fake = fakeT3();
    const host = await start(fake);
    expect(host.querySelector("[data-t3p-artwork-panel]")).not.toBeNull();
    // unmount the way the slot engine does: run the cleanup render returned
    const cleanup = fake.regs.find((r) => r.slot === "rightPanel")!.render(document.createElement("div"), {} as never) as () => void;
    cleanup();
    expect(fake.panels.slice(7).every((p) => p.disposed)).toBe(true);
  });
});

describe("Artwork: open panel command", () => {
  it("opens the dock on the panel tab", async () => {
    const fake = fakeT3();
    await start(fake, false);
    await fake.commands.get("open-panel")!.run();
    expect(fake.open).toHaveBeenCalledWith("panel");
  });

  it("keeps the other commands", async () => {
    const fake = fakeT3();
    await start(fake, false);
    expect([...fake.commands.keys()].sort()).toEqual(["next-preset", "open-panel", "switch-image", "switch-preset"]);
  });
});

describe("background dim and blur", () => {
  const dimEl = (): HTMLElement | null => document.getElementById("t3p-bg-dim");
  const set = async (fake: ReturnType<typeof fakeT3>, key: string, value: SettingValue): Promise<void> => {
    await fake.t3.settings.set(key, value);
    await vi.advanceTimersByTimeAsync(0);
  };
  const rootIds = { ocean: "t3p-ocean", drift: "t3p-bg-drift", starfield: "t3p-bg-starfield" } as const;

  it("an old install (no dim, no blur) gets no overlay and no filter", async () => {
    await start(fakeT3({ oceanOn: true, oceanIntensity: 30, oceanSpeed: 20, oceanRipples: false, bgKind: "starfield", bgIntensity: 70 }));
    expect(dimEl()).toBeNull();
    expect(document.getElementById("t3p-bg-starfield")!.style.filter).toBe("");
    expect(document.getElementById("t3p-ocean")).toBeNull();
  });

  for (const kind of ["ocean", "drift", "starfield"] as const) {
    it(`${kind}: one fixed click-through overlay right after the running preset`, async () => {
      await start(fakeT3({ oceanOn: true, bgKind: kind, bgDim: 40 }));
      const dim = dimEl()!;
      expect(document.querySelectorAll("#t3p-bg-dim")).toHaveLength(1);
      expect(dim.style.opacity).toBe("0.4");
      expect(dim.style.zIndex).toBe("-1");
      expect(dim.style.pointerEvents).toBe("none");
      expect(dim.style.position).toBe("fixed");
      expect(dim.style.cssText).not.toMatch(/filter/);
      expect(dim.previousElementSibling).toBe(document.getElementById(rootIds[kind]));
    });
  }

  it("the slider retunes it live and 0 removes it", async () => {
    const fake = fakeT3({ oceanOn: true, bgKind: "drift", bgDim: 20 });
    await start(fake);
    expect(dimEl()!.style.opacity).toBe("0.2");
    await set(fake, "bgDim", 80);
    expect(dimEl()!.style.opacity).toBe("0.8");
    await set(fake, "bgDim", 0);
    expect(dimEl()).toBeNull();
    await set(fake, "bgDim", 55);
    expect(dimEl()!.style.opacity).toBe("0.55");
    expect(dimEl()!.previousElementSibling).toBe(document.getElementById("t3p-bg-drift"));
  });

  it("dim previews live from the dock slider before any write", async () => {
    const fake = fakeT3({ oceanOn: true, bgKind: "starfield" });
    await start(fake);
    const panel = fake.panels.find((p) => p.keys?.includes("bgDim") && p.keys.includes("bgPointer"))!;
    panel.options.onLive?.("bgDim", 30);
    expect(dimEl()!.style.opacity).toBe("0.3");
    panel.options.onLive?.("bgDim", 0);
    expect(dimEl()).toBeNull();
  });

  it("switching the master off, or stopping the plugin, removes the overlay", async () => {
    const fake = fakeT3({ oceanOn: true, bgKind: "starfield", bgDim: 30 });
    await start(fake);
    expect(dimEl()).not.toBeNull();
    await set(fake, "oceanOn", false);
    expect(dimEl()).toBeNull();
    await set(fake, "oceanOn", true);
    expect(dimEl()).not.toBeNull();
    (stop as () => void)();
    stop = undefined;
    expect(dimEl()).toBeNull();
    expect(document.getElementById("t3p-bg-starfield")).toBeNull();
  });

  it("switching the kind keeps one overlay, after the new preset", async () => {
    const fake = fakeT3({ oceanOn: true, bgKind: "drift", bgDim: 30 });
    await start(fake);
    await set(fake, "bgKind", "starfield");
    expect(document.querySelectorAll("#t3p-bg-dim")).toHaveLength(1);
    expect(dimEl()!.previousElementSibling).toBe(document.getElementById("t3p-bg-starfield"));
  });

  it("reset all puts dim and blur back to 0 and removes both", async () => {
    const fake = fakeT3({ oceanOn: true, bgKind: "starfield", bgDim: 45, bgBlur: 12 });
    await start(fake);
    expect(dimEl()).not.toBeNull();
    expect(document.getElementById("t3p-bg-starfield")!.style.filter).toBe("");
    await resetAllArtwork(fake.t3, { update: () => undefined }, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.t3.settings.get("bgDim")).toBe(0);
    expect(fake.t3.settings.get("bgBlur")).toBe(0);
    expect(dimEl()).toBeNull();
    expect(document.getElementById("t3p-bg-starfield")).toBeNull();
  });

  it("dim and blur still apply under reduced motion (a still frame)", async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as never;
    try {
      await start(fakeT3({ oceanOn: true, bgKind: "drift", bgDim: 25, bgBlur: 10 }));
      expect(dimEl()!.style.opacity).toBe("0.25");
      // a still frame: the drift canvas is there, nothing animates
      expect(document.getElementById("t3p-bg-drift")!.tagName).toBe("CANVAS");
    } finally {
      window.matchMedia = original;
    }
  });

  describe("blur", () => {
    it("is drawn into the canvas: no CSS filter, no will-change, no transform, never a backdrop-filter", async () => {
      const fake = fakeT3({ oceanOn: true, bgKind: "starfield", bgBlur: 8 });
      await start(fake);
      const canvas = document.getElementById("t3p-bg-starfield") as HTMLCanvasElement;
      expect(canvas.style.filter).toBe("");
      expect(canvas.style.willChange).toBe("");
      expect(canvas.style.transform).toBe("");
      expect(document.body.style.filter).toBe("");
      expect(document.documentElement.style.filter).toBe("");
      const css = [...document.querySelectorAll("style")].map((el) => el.textContent).join("\n");
      expect(css).not.toMatch(/backdrop-filter/);
      await set(fake, "bgBlur", 0);
      expect(canvas.style.filter).toBe("");
    });

    it("Ocean blurs inside its canvas the same way (no CSS filter)", async () => {
      const fake = fakeT3({ oceanOn: true, bgKind: "ocean", bgBlur: 6 });
      await start(fake);
      const canvas = document.getElementById("t3p-ocean") as HTMLCanvasElement;
      expect(canvas.style.filter).toBe("");
      expect(canvas.style.willChange).toBe("");
      await set(fake, "bgBlur", 0);
      expect(canvas.style.filter).toBe("");
    });

    it("Gradient drift bakes it into the blobs instead of a filter (blob size: test/background.test.ts)", async () => {
      const fake = fakeT3({ oceanOn: true, bgKind: "drift", bgBlur: 20 });
      await start(fake);
      const root = document.getElementById("t3p-bg-drift")!;
      expect(root.style.filter).toBe("");
      expect(root.style.transform).toBe("");
    });
  });
});
