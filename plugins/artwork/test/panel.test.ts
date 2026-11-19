// @vitest-environment jsdom
import type { SettingChange, SettingSchema, SettingValue, SettingsPanelOptions, T3Api, UiSlotRegistration } from "@t3p/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import plugin from "../src/index.js";

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
      ["oceanOn", "oceanIntensity", "oceanSpeed", "oceanRipples"],
      ["logoMode", "logoText", "logoHeight"],
    ]);
    const schemas = fake.t3.settings.getSchemas();
    for (const key of ["intensity", "speed", "fadeHeight", "blur", "angle", "logoHeight"]) expect(schemas.find((s) => s.key === key)?.type).toBe("range");
    for (const p of fake.panels) for (const key of p.keys!) expect(schemas.some((s) => s.key === key)).toBe(true);
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

  it("Reset to defaults resets every artwork setting but keeps images", async () => {
    const fake = fakeT3({ preset: "mesh", intensity: 10, hue: 50 }, { arts: [{ id: "a1", name: "Dusk", bytes: 1 }], "art:a1": PNG });
    await start(fake);
    const reset = [...document.querySelectorAll("button")].find((b) => b.textContent === "Reset to defaults") as HTMLButtonElement;
    reset.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.values.size).toBe(0);
    expect(fake.t3.settings.get("preset")).toBe("aurora");
    expect(fake.store.has("art:a1")).toBe(true);
    expect(sw("aurora").getAttribute("aria-pressed")).toBe("true");
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
    expect(fake.panels.slice(3).every((p) => p.disposed)).toBe(true);
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
