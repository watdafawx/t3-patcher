// @vitest-environment jsdom
import type { SettingSchema, SettingValue } from "@t3p/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEventBus } from "../src/events.js";
import type { ManagedPlugin } from "../src/manager.js";
import { Scope } from "../src/scope.js";
import { Shell } from "../src/shell.js";
import { COLLAPSED_KEY, SELECTED_KEY, filterPlugins, groupSchemas, highlight, matchingSchemas, missingPermissions, mountPluginsPage, selectPlugin, WAITING_RESET_MS, type ManagerFacade } from "../src/ui/plugins-page.js";

const ART: SettingSchema[] = [
  { key: "preset", type: "enum", default: "aurora", label: "Preset", description: "What sits behind the header.", options: [{ value: "aurora" }, { value: "mesh" }] },
  { key: "intensity", type: "range", default: 60, min: 0, max: 100, label: "Intensity" },
  { key: "oceanOn", type: "boolean", default: false, label: "Ocean background", description: "Drifting letters." },
  { key: "oceanSpeed", type: "range", default: 50, min: 0, max: 100, label: "Ocean speed" },
];
const KEEP: SettingSchema[] = [{ key: "interval", type: "number", default: 5, label: "Ping interval", description: "Minutes between pings." }];

function plugin(id: string, name: string, extra: Partial<ManagedPlugin> = {}): ManagedPlugin {
  return { id, name, version: "1.0.0", tier: 1, hostStatus: "active", status: "started", error: null, hasRenderer: true, declared: [], effective: {}, restartRequired: false, disabledReason: null, ...extra };
}

function fakeManager(plugins: ManagedPlugin[], schemas: Record<string, SettingSchema[]> = { artwork: ART, "keep-warm": KEEP }) {
  const values = new Map<string, SettingValue>();
  const listeners = new Set<() => void>();
  const sets: Array<[string, string, SettingValue]> = [];
  const resets: Array<[string, string]> = [];
  const revokes: Array<[string, string[]]> = [];
  const key = (id: string, k: string): string => `${id}/${k}`;
  const manager: ManagerFacade = {
    list: () => plugins,
    enable: async (id) => plugins.find((p) => p.id === id) ?? null,
    disable: async () => ({ restartRequired: false }),
    revoke: async (id, perms) => {
      revokes.push([id, perms]);
      return { restartRequired: false };
    },
    schemas: (id) => schemas[id] ?? [],
    getSetting: (id, k) => values.get(key(id, k)) ?? (schemas[id] ?? []).find((s) => s.key === k)!.default,
    setSetting: async (id, k, v) => void (sets.push([id, k, v]), values.set(key(id, k), v)),
    resetSetting: async (id, k) => void (resets.push([id, k]), values.delete(key(id, k))),
    onChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  return { manager, values, sets, resets, revokes, fire: () => listeners.forEach((l) => l()), plugins };
}

const PLUGINS = (): ManagedPlugin[] => [
  plugin("artwork", "Artwork"),
  plugin("keep-warm", "Keep warm", { declared: ["rpc"], effective: { rpc: true } }),
  plugin("notes", "Notes", { declared: ["rpc", "guard"], effective: { rpc: true }, status: "inactive" }),
  plugin("media", "Media", { status: "failed", error: "boom" }),
];

const q = <T extends Element>(sel: string, root: ParentNode = document): T => root.querySelector(sel) as T;
const all = <T extends Element>(sel: string, root: ParentNode = document): T[] => Array.from(root.querySelectorAll(sel)) as T[];
const key = (el: Element, k: string, init: KeyboardEventInit = {}): void => void el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
const items = (): string[] => all("[data-t3p-item]").map((e) => e.getAttribute("data-t3p-item")!);
const selectedId = (): string | null => q("[data-t3p-item][data-active]")?.getAttribute("data-t3p-item") ?? null;
const detailName = (): string => q("[data-t3p-detail] .t3p-card-title")?.textContent ?? "";
function type(text: string): void {
  const input = q<HTMLInputElement>("[data-t3p-search]");
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

let stop: (() => void) | null = null;
function mount(f = fakeManager(PLUGINS())): ReturnType<typeof fakeManager> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  stop = mountPluginsPage(host, f.manager, () => undefined);
  return f;
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  stop?.();
  stop = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("helpers", () => {
  it("matchingSchemas searches key, label and description", () => {
    expect(matchingSchemas(ART, "ocean").map((s) => s.key)).toEqual(["oceanOn", "oceanSpeed"]);
    expect(matchingSchemas(ART, "BEHIND").map((s) => s.key)).toEqual(["preset"]);
    expect(matchingSchemas(ART, "  ")).toBe(ART);
  });
  it("filterPlugins matches name, id and setting text", () => {
    const list = PLUGINS();
    const schemasOf = (id: string): SettingSchema[] => ({ artwork: ART, "keep-warm": KEEP })[id] ?? [];
    expect(filterPlugins(list, "", schemasOf)).toBe(list);
    expect(filterPlugins(list, "keep", schemasOf).map((p) => p.id)).toEqual(["keep-warm"]);
    expect(filterPlugins(list, "minutes", schemasOf).map((p) => p.id)).toEqual(["keep-warm"]);
    expect(filterPlugins(list, "ocean", schemasOf).map((p) => p.id)).toEqual(["artwork"]);
    expect(filterPlugins(list, "zzz", schemasOf)).toEqual([]);
  });
  it("groupSchemas puts shared prefixes in a group and the rest in General", () => {
    expect(groupSchemas(ART).map((g) => [g.title, g.schemas.map((s) => s.key)])).toEqual([
      ["General", ["preset", "intensity"]],
      ["Ocean", ["oceanOn", "oceanSpeed"]],
    ]);
    expect(groupSchemas(KEEP).map((g) => g.title)).toEqual(["General"]);
    expect(groupSchemas([])).toEqual([]);
  });
  it("highlight wraps matches in mark elements", () => {
    const nodes = highlight("Ocean speed of the ocean", "ocean");
    const wrap = document.createElement("div");
    wrap.append(...nodes);
    expect(all("mark.t3p-hl", wrap).map((m) => m.textContent)).toEqual(["Ocean", "ocean"]);
    expect(wrap.textContent).toBe("Ocean speed of the ocean");
    expect(highlight("abc", "")).toEqual(["abc"]);
  });
  it("missingPermissions lists declared but ungranted", () => {
    expect(missingPermissions(PLUGINS()[2]!)).toEqual(["guard"]);
    expect(missingPermissions(PLUGINS()[0]!)).toEqual([]);
  });
});

describe("master-detail page", () => {
  it("lists every plugin with dot and badges, and shows the first one", () => {
    mount();
    expect(items()).toEqual(["artwork", "keep-warm", "notes", "media"]);
    expect(selectedId()).toBe("artwork");
    expect(detailName()).toBe("Artwork");
    expect(q("[data-t3p-item='artwork'] [data-t3p-badge=settings]").textContent).toBe("4");
    expect(q("[data-t3p-item='notes'] [data-t3p-badge=perm]")).not.toBeNull();
    expect(q("[data-t3p-item='artwork'] [data-t3p-badge=perm]")).toBeNull();
    expect(q("[data-t3p-item='artwork'] [data-t3p-dot]").getAttribute("data-tone")).toBe("ok");
    expect(q("[data-t3p-item='media'] [data-t3p-dot]").getAttribute("data-tone")).toBe("bad");
    expect(q("[data-t3p-count]").textContent).toBe("4 installed");
  });

  it("shows only the selected plugin's settings, grouped in sections", () => {
    mount();
    expect(all("[data-t3p-group]").map((g) => g.getAttribute("data-t3p-group"))).toEqual(["General", "Ocean"]);
    expect(all("[data-t3p-setting-row]").length).toBe(4);
    expect(q("[data-t3p-setting-row='interval']")).toBeNull();
    q<HTMLElement>("[data-t3p-item='keep-warm']").click();
    expect(detailName()).toBe("Keep warm");
    expect(all("[data-t3p-setting-row]").map((r) => r.getAttribute("data-t3p-setting-row"))).toEqual(["interval"]);
    expect(q("[data-t3p-perms]").textContent).toContain("rpc");
  });

  it("keeps the slider, enum and boolean controls working", () => {
    const f = mount();
    const slider = q<HTMLInputElement>("input[data-t3p-setting=intensity]");
    expect(slider.type).toBe("range");
    slider.value = "90";
    slider.dispatchEvent(new Event("change"));
    expect(f.sets).toContainEqual(["artwork", "intensity", 90]);
    const reset = q<HTMLButtonElement>("[data-t3p-reset=intensity]");
    expect(reset.hidden).toBe(false);
    reset.click();
    expect(f.resets).toContainEqual(["artwork", "intensity"]);
  });

  it("enable switch calls the manager", () => {
    const f = mount();
    const spy = vi.spyOn(f.manager, "disable");
    const toggle = q<HTMLInputElement>("[data-t3p-toggle=artwork]");
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    expect(spy).toHaveBeenCalledWith("artwork");
  });

  it("Reset plugin settings needs a second click", async () => {
    const f = mount();
    const btn = q<HTMLButtonElement>("[data-t3p-reset-plugin=artwork]");
    btn.click();
    expect(btn.textContent).toBe("Really reset?");
    expect(f.resets).toEqual([]);
    btn.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.resets.map((r) => r[1])).toEqual(["preset", "intensity", "oceanOn", "oceanSpeed"]);
  });

  it("a plugin that is not running explains why there are no settings", () => {
    mount();
    q<HTMLElement>("[data-t3p-item='notes']").click();
    expect(q("[data-t3p-no-settings]").textContent).toContain("running");
    expect(q("[data-t3p-perms]").textContent).toContain("guard");
    q<HTMLElement>("[data-t3p-item='media']").click();
    expect(q("[data-t3p-error]").textContent).toBe("boom");
  });
});

describe("search", () => {
  it("filters by plugin name", () => {
    mount();
    type("note");
    expect(items()).toEqual(["notes"]);
    expect(detailName()).toBe("Notes");
    expect(q("[data-t3p-count]").textContent).toBe("1 of 4 match");
    expect(q("[data-t3p-item='notes'] mark.t3p-hl")?.textContent).toBe("Note");
  });

  it("filters by setting name or description and highlights it", () => {
    mount();
    type("minutes");
    expect(items()).toEqual(["keep-warm"]);
    expect(q("[data-t3p-item='keep-warm'] [data-t3p-badge=match]").textContent).toBe("1");
    expect(q("[data-t3p-setting-row=interval] small mark.t3p-hl").textContent).toBe("Minutes");
    type("ocean");
    expect(items()).toEqual(["artwork"]);
    expect(all("[data-t3p-setting-row]").map((r) => r.getAttribute("data-t3p-setting-row"))).toEqual(["oceanOn", "oceanSpeed"]);
    expect(all("[data-t3p-setting-row] label mark").length).toBe(2);
  });

  it("opens collapsed sections that hold a match", () => {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(["artwork/Ocean"]));
    mount();
    expect(q<HTMLElement>("[data-t3p-group=Ocean] .t3p-pg-sec-body").hidden).toBe(true);
    type("ocean speed");
    expect(q<HTMLElement>("[data-t3p-group=Ocean] .t3p-pg-sec-body").hidden).toBe(false);
  });

  it("shows an empty state, Escape clears the search", () => {
    mount();
    type("zzzz");
    expect(items()).toEqual([]);
    expect(q("[data-t3p-list] [data-t3p-empty]").textContent).toContain("zzzz");
    key(q("[data-t3p-search]"), "Escape");
    expect(items().length).toBe(4);
    expect(q<HTMLInputElement>("[data-t3p-search]").value).toBe("");
  });

  it("a name match shows every setting of that plugin", () => {
    mount();
    type("artwork");
    expect(all("[data-t3p-setting-row]").length).toBe(4);
  });
});

describe("persistence", () => {
  it("remembers the selected plugin across mounts", () => {
    mount();
    q<HTMLElement>("[data-t3p-item='keep-warm']").click();
    expect(localStorage.getItem(SELECTED_KEY)).toBe("keep-warm");
    stop!();
    document.body.innerHTML = "";
    mount();
    expect(selectedId()).toBe("keep-warm");
  });

  it("remembers collapsed sections", () => {
    mount();
    const head = q<HTMLElement>("[data-t3p-section='artwork/Ocean']");
    expect(head.getAttribute("aria-expanded")).toBe("true");
    head.click();
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(JSON.parse(localStorage.getItem(COLLAPSED_KEY)!)).toEqual(["artwork/Ocean"]);
    stop!();
    document.body.innerHTML = "";
    mount();
    expect(q<HTMLElement>("[data-t3p-group=Ocean] .t3p-pg-sec-body").hidden).toBe(true);
    q<HTMLElement>("[data-t3p-section='artwork/Ocean']").click();
    expect(JSON.parse(localStorage.getItem(COLLAPSED_KEY)!)).toEqual([]);
  });

  it("works when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    mount();
    expect(selectedId()).toBe("artwork");
    q<HTMLElement>("[data-t3p-item='keep-warm']").click();
    expect(detailName()).toBe("Keep warm");
    q<HTMLElement>("[data-t3p-section='keep-warm/General']").click();
  });

  it("falls back to the first plugin when the remembered one is gone", () => {
    localStorage.setItem(SELECTED_KEY, "removed");
    mount();
    expect(selectedId()).toBe("artwork");
  });
});

describe("keyboard", () => {
  it("ArrowDown and ArrowUp move the selection in the list", () => {
    mount();
    const list = q<HTMLElement>("[data-t3p-list]");
    q<HTMLElement>("[data-t3p-item='artwork']").focus();
    key(q("[data-t3p-item='artwork']"), "ArrowDown");
    expect(selectedId()).toBe("keep-warm");
    expect(detailName()).toBe("Keep warm");
    expect(document.activeElement).toBe(q("[data-t3p-item='keep-warm']"));
    key(list, "ArrowDown");
    key(list, "ArrowDown");
    key(list, "ArrowDown");
    expect(selectedId()).toBe("media");
    key(list, "ArrowUp");
    expect(selectedId()).toBe("notes");
    key(list, "Home");
    expect(selectedId()).toBe("artwork");
    key(list, "End");
    expect(selectedId()).toBe("media");
  });

  it("ArrowUp on the first item returns to the search box, ArrowDown in the search enters the list", () => {
    mount();
    key(q("[data-t3p-list]"), "ArrowUp");
    expect(document.activeElement).toBe(q("[data-t3p-search]"));
    key(q("[data-t3p-search]"), "ArrowDown");
    expect(document.activeElement).toBe(q("[data-t3p-item='artwork']"));
  });

  it("arrows follow the filtered list", () => {
    mount();
    type("e");
    const shown = items();
    expect(shown.length).toBeGreaterThan(1);
    key(q("[data-t3p-list]"), "End");
    expect(selectedId()).toBe(shown.at(-1));
  });

  it("/ focuses the search unless typing elsewhere", () => {
    mount();
    const outside = document.createElement("textarea");
    document.body.appendChild(outside);
    outside.focus();
    key(outside, "/");
    expect(document.activeElement).toBe(outside);
    outside.blur();
    const ev = new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(q("[data-t3p-search]"));
  });

  it("stops listening for / after unmount", () => {
    mount();
    stop!();
    stop = null;
    const ev = new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });
});

describe("narrow layout (list, then detail)", () => {
  const view = (): string | null => q("[data-t3p-page=plugins]").getAttribute("data-t3p-view");

  it("starts on the list, a click opens the detail, Back returns", () => {
    mount();
    expect(view()).toBe("list");
    q<HTMLElement>("[data-t3p-item='keep-warm']").click();
    expect(view()).toBe("detail");
    q<HTMLElement>("[data-t3p-back]").click();
    expect(view()).toBe("list");
    expect(selectedId()).toBe("keep-warm");
  });

  it("arrow keys keep the detail view, / returns to the list", () => {
    mount();
    q<HTMLElement>("[data-t3p-item='artwork']").click();
    expect(view()).toBe("detail");
    key(q("[data-t3p-list]"), "ArrowDown");
    expect(view()).toBe("detail");
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true }));
    expect(view()).toBe("list");
  });

  it("has a Back button and the container query CSS", () => {
    mount();
    expect(q("[data-t3p-back]")).not.toBeNull();
    const css = Array.from(document.querySelectorAll("style")).map((s) => s.textContent).join("");
    expect(css).toContain("@container (max-width:639px)");
    expect(css).toContain(".t3p-pgw{container-type:inline-size}");
  });
});

describe("deep link", () => {
  it("selectPlugin before mount opens on that plugin in detail view", () => {
    selectPlugin("media");
    mount();
    expect(selectedId()).toBe("media");
    expect(q("[data-t3p-page=plugins]").getAttribute("data-t3p-view")).toBe("detail");
  });

  it("selectPlugin on an open page switches it and clears the search", () => {
    mount();
    type("art");
    selectPlugin("keep-warm");
    expect(q<HTMLInputElement>("[data-t3p-search]").value).toBe("");
    expect(selectedId()).toBe("keep-warm");
    expect(detailName()).toBe("Keep warm");
  });
});

describe("settingsPage slot", () => {
  it("renders the anchor inside the detail pane and shows only the selected plugin's UI", async () => {
    mount();
    const anchor = q("[data-t3p-slot-anchor=settingsPage]");
    expect(anchor.closest("[data-t3p-detail]")).not.toBeNull();
    for (const id of ["artwork", "keep-warm"]) {
      const root = document.createElement("div");
      root.setAttribute("data-t3p-plugin", id);
      anchor.appendChild(root);
    }
    await new Promise((r) => setTimeout(r, 0));
    const hidden = (id: string): boolean => q(`[data-t3p-slot-anchor] [data-t3p-plugin=${id}]`).hasAttribute("data-t3p-hidden");
    expect(hidden("artwork")).toBe(false);
    expect(hidden("keep-warm")).toBe(true);
    q<HTMLElement>("[data-t3p-item='keep-warm']").click();
    expect(q("[data-t3p-slot-anchor=settingsPage]")).toBe(anchor);
    expect(hidden("artwork")).toBe(true);
    expect(hidden("keep-warm")).toBe(false);
  });

  it("keeps the same anchor element across redraws, so mounted plugin UI survives", () => {
    const f = mount();
    const anchor = q("[data-t3p-slot-anchor=settingsPage]");
    f.fire();
    type("a");
    expect(q("[data-t3p-slot-anchor=settingsPage]")).toBe(anchor);
  });
});

describe("shell integration", () => {
  function makeShell(): Shell {
    return new Shell({ native: null, systemBus: createEventBus(() => undefined), log: () => undefined, consoleError: () => undefined });
  }

  it("registers a palette command per plugin and follows the list", () => {
    const f = fakeManager(PLUGINS());
    const shell = makeShell();
    shell.attach(f.manager);
    const titles = (): string[] => shell.commands.paletteItems().map((i) => i.title).filter((t) => t.startsWith("Plugins: open "));
    expect(titles()).toContain("Plugins: open Artwork settings");
    expect(titles()).toContain("Plugins: open Keep warm settings");
    f.plugins.push(plugin("extra", "Extra"));
    f.fire();
    expect(titles()).toContain("Plugins: open Extra settings");
    f.plugins.splice(0, 1);
    f.fire();
    expect(titles()).not.toContain("Plugins: open Artwork settings");
  });

  it("palette command and t3.ui.openSettings select the plugin on the page", async () => {
    const f = fakeManager(PLUGINS());
    const shell = makeShell();
    shell.attach(f.manager);
    mount(f);
    await shell.commands.run("t3p.core:open-settings.keep-warm");
    expect(selectedId()).toBe("keep-warm");
    const ns = shell.namespaces("notes", new Scope(), {});
    ns.ui.openSettings();
    expect(selectedId()).toBe("notes");
    ns.ui.openSettings("media");
    expect(selectedId()).toBe("media");
  });
});

describe("permissions section", () => {
  const PERMS = (): ManagedPlugin[] => [
    plugin("notes", "Notes", { declared: ["rpc", "guard", { "fs.read": { roots: ["~/.t3/caches"] } }], effective: { rpc: true } }),
    plugin("keep-warm", "Keep warm", { declared: ["rpc"], effective: { rpc: true } }),
  ];

  it("lists each declared permission with meaning, risk, state and scope; badge says needs N", () => {
    mount(fakeManager(PERMS()));
    expect(q("[data-t3p-item='notes'] [data-t3p-badge=perm]").textContent).toBe("needs 2");
    expect(q("[data-t3p-item='keep-warm'] [data-t3p-badge=perm]")).toBeNull();
    const rows = all("[data-t3p-perm-section='notes'] [data-t3p-perm]");
    expect(rows.map((r) => [r.getAttribute("data-t3p-perm"), r.getAttribute("data-t3p-granted")])).toEqual([
      ["rpc", "true"],
      ["guard", "false"],
      ["fs.read", "false"],
    ]);
    const fs = q("[data-t3p-perm='fs.read']");
    expect(q("[data-t3p-risk]", fs).textContent).toBe("high risk");
    expect(fs.textContent).toContain("Reads any file inside the listed folders.");
    expect(q("[data-t3p-perm-scope]", fs).textContent).toBe("Folders: ~/.t3/caches");
    expect(q("[data-t3p-perm='rpc'] [data-t3p-risk]").textContent).toBe("medium risk");
    expect(q("[data-t3p-perm-count]").textContent).toBe("1 of 3 granted");
  });

  it("Grant buttons only carry the request for the preload; clicking sends nothing from the page", () => {
    const f = mount(fakeManager(PERMS()));
    const grant = q<HTMLButtonElement>("[data-t3p-perm='guard'] [data-t3p-grant-request]");
    expect(grant.getAttribute("data-t3p-grant-request")).toBe("notes");
    expect(grant.getAttribute("data-t3p-grant-perms")).toBe("guard");
    const grantAll = q<HTMLButtonElement>("[data-t3p-perm-section='notes'] .t3p-perm-head [data-t3p-grant-request]");
    expect(grantAll.getAttribute("data-t3p-grant-perms")).toBe("*");
    expect(grantAll.textContent).toBe("Grant all requested (2)");
    grantAll.click(); // untrusted: the preload ignores it; the page only shows a waiting state
    expect(grant.hasAttribute("data-t3p-waiting")).toBe(true);
    expect(grant.textContent).toBe("Confirm in dialog…");
    expect(f.revokes).toEqual([]);
    f.fire(); // the main process answered (list refreshed): waiting clears
    expect(q("[data-t3p-perm='guard'] [data-t3p-grant-request]").hasAttribute("data-t3p-waiting")).toBe(false);
  });

  it("drops the waiting label when no answer comes (a click the preload ignored)", () => {
    vi.useFakeTimers();
    try {
      mount(fakeManager(PERMS()));
      q<HTMLButtonElement>("[data-t3p-perm='guard'] [data-t3p-grant-request]").click();
      expect(q("[data-t3p-perm='guard'] [data-t3p-grant-request]").textContent).toBe("Confirm in dialog…");
      vi.advanceTimersByTime(WAITING_RESET_MS);
      const after = q("[data-t3p-perm='guard'] [data-t3p-grant-request]");
      expect(after.hasAttribute("data-t3p-waiting")).toBe(false);
      expect(after.textContent).toBe("Grant");
    } finally {
      vi.useRealTimers();
    }
  });

  it("Revoke goes through the manager without a dialog and re-renders live", async () => {
    const f = mount(fakeManager(PERMS()));
    q<HTMLButtonElement>("[data-t3p-perm='rpc'] [data-t3p-revoke]").click();
    await vi.waitFor(() => expect(f.revokes).toEqual([["notes", ["rpc"]]]));
    f.plugins[0]!.effective = {};
    f.fire();
    expect(q("[data-t3p-perm='rpc']").getAttribute("data-t3p-granted")).toBe("false");
    expect(q("[data-t3p-item='notes'] [data-t3p-badge=perm]").textContent).toBe("needs 3");
  });

  it("a plugin without permissions has no section", () => {
    mount(fakeManager([plugin("artwork", "Artwork")]));
    expect(q("[data-t3p-perm-section]")).toBeNull();
  });

  it("palette 'Plugins: review permissions' opens the first plugin that needs one", async () => {
    const f = fakeManager([plugin("keep-warm", "Keep warm", { declared: ["rpc"], effective: { rpc: true } }), ...PERMS().slice(0, 1)]);
    const shell = new Shell({ native: null, systemBus: createEventBus(() => undefined), log: () => undefined, consoleError: () => undefined });
    shell.attach(f.manager);
    expect(shell.commands.paletteItems().map((i) => i.title)).toContain("Plugins: review permissions");
    mount(f);
    await shell.commands.run("t3p.core:review-permissions");
    expect(selectedId()).toBe("notes");
    expect(q("[data-t3p-perm-section='notes']")).not.toBeNull();
  });
});
