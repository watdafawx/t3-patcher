// @vitest-environment jsdom
import type { SettingChange, SettingSchema, SettingValue, T3Settings } from "@t3p/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEventBus } from "../src/events.js";
import { Scope } from "../src/scope.js";
import { Shell } from "../src/shell.js";
import { checkSchema, valueFits } from "../src/storage.js";
import { mountSettingsPanel } from "../src/ui/setting-controls.js";

const SCHEMAS: SettingSchema[] = [
  { key: "preset", type: "enum", default: "aurora", label: "Preset", options: [{ value: "aurora", label: "Aurora" }, { value: "mesh" }] },
  { key: "intensity", type: "range", default: 60, min: 0, max: 100, label: "Intensity" },
  { key: "scrim", type: "boolean", default: true, label: "Scrim" },
  { key: "text", type: "string", default: "T3", label: "Text" },
  { key: "n", type: "number", default: 3, min: 1, max: 9, label: "N" },
];

function fakeSettings(schemas = SCHEMAS) {
  const values = new Map<string, SettingValue>();
  const listeners = new Set<(c: SettingChange) => void>();
  const sets: Array<[string, SettingValue]> = [];
  const get = (key: string): SettingValue => values.get(key) ?? schemas.find((s) => s.key === key)!.default;
  const settings: T3Settings = {
    define: () => ({ dispose: () => undefined }),
    get: get as T3Settings["get"],
    set: async (key, value) => {
      sets.push([key, value]);
      const previous = get(key);
      values.set(key, value);
      for (const l of listeners) l({ key, value, previous });
    },
    reset: async (key) => {
      const previous = get(key);
      values.delete(key);
      for (const l of listeners) l({ key, value: get(key), previous });
    },
    onChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getSchemas: () => schemas,
  };
  return { settings, sets, listeners };
}

const q = <T extends Element>(sel: string): T => document.querySelector(sel) as T;
const fire = (el: Element, type: string): void => void el.dispatchEvent(new Event(type, { bubbles: true }));

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("range schema", () => {
  it("accepts a valid range and rejects bad ones", () => {
    expect(checkSchema({ key: "k", type: "range", default: 5, min: 0, max: 10, label: "K" })).toBeNull();
    expect(checkSchema({ key: "k", type: "range", default: 5, min: 0, max: 10, step: 0.5, label: "K" })).toBeNull();
    expect(checkSchema({ key: "k", type: "range", default: 5, label: "K" })).toMatch(/min below max/);
    expect(checkSchema({ key: "k", type: "range", default: 5, min: 10, max: 10, label: "K" })).toMatch(/min below max/);
    expect(checkSchema({ key: "k", type: "range", default: -1, min: 0, max: 10, label: "K" })).toMatch(/below min/);
    expect(checkSchema({ key: "k", type: "range", default: 11, min: 0, max: 10, label: "K" })).toMatch(/above max/);
    expect(checkSchema({ key: "k", type: "range", default: 5, min: 0, max: 10, step: 0, label: "K" })).toMatch(/step/);
  });

  it("validates values like a bounded number", () => {
    const s = SCHEMAS[1]!;
    expect(valueFits(s, 0)).toBe(true);
    expect(valueFits(s, 100)).toBe(true);
    expect(valueFits(s, 101)).toBe(false);
    expect(valueFits(s, "5")).toBe(false);
    expect(valueFits(s, Number.NaN)).toBe(false);
  });

  it("number schemas still work", () => {
    expect(checkSchema({ key: "k", type: "number", default: 0, label: "K" })).toBeNull();
  });
});

describe("mountSettingsPanel", () => {
  it("renders one row per schema with the right control", () => {
    const { settings } = fakeSettings();
    mountSettingsPanel(document.body, settings);
    expect(document.querySelectorAll("[data-t3p-setting-row]").length).toBe(5);
    expect(q<HTMLSelectElement>('select[data-t3p-setting="preset"]').value).toBe("aurora");
    const slider = q<HTMLInputElement>('input[data-t3p-setting="intensity"]');
    expect(slider.type).toBe("range");
    expect([slider.min, slider.max, slider.value]).toEqual(["0", "100", "60"]);
    expect(q<HTMLInputElement>('input[data-t3p-setting="scrim"]').checked).toBe(true);
    expect(q<HTMLInputElement>('input[data-t3p-setting="text"]').value).toBe("T3");
    expect(q<HTMLInputElement>('input[data-t3p-setting="n"]').type).toBe("number");
  });

  it("keys limits and orders the rows", () => {
    const { settings } = fakeSettings();
    mountSettingsPanel(document.body, settings, { keys: ["scrim", "nope", "preset"] });
    expect([...document.querySelectorAll("[data-t3p-setting-row]")].map((r) => r.getAttribute("data-t3p-setting-row"))).toEqual(["scrim", "preset"]);
  });

  it("slider drag updates the readout at once and writes once, debounced", () => {
    const { settings, sets } = fakeSettings();
    mountSettingsPanel(document.body, settings, { debounceMs: 100 });
    const slider = q<HTMLInputElement>('input[data-t3p-setting="intensity"]');
    for (const v of ["61", "70", "80"]) {
      slider.value = v;
      fire(slider, "input");
    }
    expect(q("[data-t3p-range-out]").textContent).toBe("80");
    expect(sets).toEqual([]);
    vi.advanceTimersByTime(99);
    expect(sets).toEqual([]);
    vi.advanceTimersByTime(2);
    expect(sets).toEqual([["intensity", 80]]);
  });

  it("onLive fires for every slider move before the write", () => {
    const { settings, sets } = fakeSettings();
    const live: Array<[string, number]> = [];
    mountSettingsPanel(document.body, settings, { onLive: (k, v) => live.push([k, v]) });
    const slider = q<HTMLInputElement>('input[data-t3p-setting="intensity"]');
    for (const v of ["10", "20"]) {
      slider.value = v;
      fire(slider, "input");
    }
    expect(live).toEqual([["intensity", 10], ["intensity", 20]]);
    expect(sets).toEqual([]);
  });

  it("slider release (change) writes immediately and drops the pending write", () => {
    const { settings, sets } = fakeSettings();
    mountSettingsPanel(document.body, settings, { debounceMs: 100 });
    const slider = q<HTMLInputElement>('input[data-t3p-setting="intensity"]');
    slider.value = "40";
    fire(slider, "input");
    fire(slider, "change");
    expect(sets).toEqual([["intensity", 40]]);
    vi.advanceTimersByTime(500);
    expect(sets).toEqual([["intensity", 40]]);
  });

  it("switch, select, text and number commit on change", () => {
    const { settings, sets } = fakeSettings();
    mountSettingsPanel(document.body, settings);
    const sw = q<HTMLInputElement>('input[data-t3p-setting="scrim"]');
    sw.checked = false;
    fire(sw, "change");
    const sel = q<HTMLSelectElement>('select[data-t3p-setting="preset"]');
    sel.value = "mesh";
    fire(sel, "change");
    const text = q<HTMLInputElement>('input[data-t3p-setting="text"]');
    text.value = "Hi";
    fire(text, "change");
    const n = q<HTMLInputElement>('input[data-t3p-setting="n"]');
    n.value = "7";
    fire(n, "change");
    expect(sets).toEqual([["scrim", false], ["preset", "mesh"], ["text", "Hi"], ["n", 7]]);
  });

  it("follows changes made elsewhere", async () => {
    const { settings } = fakeSettings();
    mountSettingsPanel(document.body, settings);
    await settings.set("preset", "mesh");
    await settings.set("intensity", 12);
    expect(q<HTMLSelectElement>('select[data-t3p-setting="preset"]').value).toBe("mesh");
    expect(q<HTMLInputElement>('input[data-t3p-setting="intensity"]').value).toBe("12");
    expect(q("[data-t3p-range-out]").textContent).toBe("12");
  });

  it("does not overwrite a slider while a write is pending", async () => {
    const { settings } = fakeSettings();
    mountSettingsPanel(document.body, settings, { debounceMs: 100 });
    const slider = q<HTMLInputElement>('input[data-t3p-setting="intensity"]');
    slider.value = "90";
    fire(slider, "input");
    await settings.set("intensity", 20); // stale echo from elsewhere
    expect(slider.value).toBe("90");
  });

  it("reset button shows only when the value differs and restores the default", async () => {
    const { settings } = fakeSettings();
    mountSettingsPanel(document.body, settings);
    const reset = q<HTMLButtonElement>('[data-t3p-setting-row="intensity"] .t3p-sp-reset');
    expect(reset.hidden).toBe(true);
    await settings.set("intensity", 10);
    expect(reset.hidden).toBe(false);
    reset.click();
    await Promise.resolve();
    expect(settings.get("intensity")).toBe(60);
    expect(reset.hidden).toBe(true);
    expect(q<HTMLInputElement>('input[data-t3p-setting="intensity"]').value).toBe("60");
  });

  it("resetButtons: false renders none", () => {
    const { settings } = fakeSettings();
    mountSettingsPanel(document.body, settings, { resetButtons: false });
    expect(document.querySelector(".t3p-sp-reset")).toBeNull();
  });

  it("cleanup removes the rows, stops listening and cancels pending writes", () => {
    const { settings, sets, listeners } = fakeSettings();
    const stop = mountSettingsPanel(document.body, settings, { debounceMs: 100 });
    const slider = q<HTMLInputElement>('input[data-t3p-setting="intensity"]');
    slider.value = "5";
    fire(slider, "input");
    stop();
    vi.advanceTimersByTime(500);
    expect(sets).toEqual([]);
    expect(listeners.size).toBe(0);
    expect(document.querySelector("[data-t3p-settings-panel]")).toBeNull();
  });
});

describe("t3.ui.settingsPanel", () => {
  const shell = (): Shell => new Shell({ native: null, systemBus: createEventBus(() => undefined), log: () => undefined, consoleError: () => undefined });

  it("mounts via the shell and is removed with the plugin scope", () => {
    const { settings } = fakeSettings();
    const scope = new Scope();
    const ns = shell().namespaces("demo", scope, {}, settings);
    const handle = ns.ui.settingsPanel(document.body, { keys: ["preset"] });
    expect(document.querySelectorAll("[data-t3p-setting-row]").length).toBe(1);
    scope.disposeAll();
    expect(document.querySelector("[data-t3p-settings-panel]")).toBeNull();
    handle.dispose();
  });

  it("dispose removes it", () => {
    const { settings } = fakeSettings();
    const ns = shell().namespaces("demo", new Scope(), {}, settings);
    ns.ui.settingsPanel(document.body).dispose();
    expect(document.querySelector("[data-t3p-settings-panel]")).toBeNull();
  });

  it("throws without settings", () => {
    const ns = shell().namespaces("demo", new Scope(), {});
    expect(() => ns.ui.settingsPanel(document.body)).toThrow(/not available/);
  });
});
