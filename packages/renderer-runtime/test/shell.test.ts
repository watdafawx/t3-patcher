// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { Scope } from "../src/scope.js";
import { Shell } from "../src/shell.js";
import { matchesChord, parseChord } from "../src/keybinds.js";
import { createEventBus } from "../src/events.js";

function makeShell(native: { invoke: ReturnType<typeof vi.fn> } | null = null) {
  const bus = createEventBus(() => undefined);
  const shell = new Shell({
    native: native ? { version: "t", invoke: native.invoke as never, on: () => () => undefined } : null,
    systemBus: bus,
    log: () => undefined,
    consoleError: () => undefined,
  });
  return { shell, bus };
}

const wait = (ms = 120): Promise<void> => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  document.body.innerHTML = "";
  window.location.hash = "";
});

describe("chords", () => {
  it("parses and matches", () => {
    const chord = parseChord("mod+shift+K");
    expect(chord).toMatchObject({ key: "k", shift: true, mod: true });
    const event = new KeyboardEvent("keydown", { key: "K", code: "KeyK", ctrlKey: true, shiftKey: true });
    expect(matchesChord(chord, event, false)).toBe(true);
    expect(matchesChord(chord, new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true }), false)).toBe(false);
    expect(() => parseChord("ctrl+")).toThrow();
  });
});

describe("commands and keybinds", () => {
  it("registers, lists, runs and disposes with the scope", async () => {
    const { shell } = makeShell();
    const scope = new Scope();
    const ns = shell.namespaces("demo", scope, {});
    const run = vi.fn();
    ns.commands.register({ id: "hi", title: "Say hi", run });
    expect(ns.commands.list().map((c) => c.id)).toContain("demo:hi");
    await ns.commands.run("demo:hi");
    expect(run).toHaveBeenCalledOnce();
    expect(shell.commands.paletteItems().some((i) => i.title === "Say hi")).toBe(true);
    scope.disposeAll(() => undefined);
    expect(shell.commands.list().some((c) => c.plugin === "demo")).toBe(false);
  });

  it("document fallback fires a keybind and ignores editable targets", async () => {
    const { shell } = makeShell();
    const scope = new Scope();
    const ns = shell.namespaces("demo", scope, {});
    const run = vi.fn();
    ns.commands.register({ id: "go", title: "Go", run });
    ns.keybinds.register({ id: "k", key: "alt+g", command: "demo:go" });
    expect(shell.keybinds.mode).toBe("document");
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "g", code: "KeyG", altKey: true, bubbles: true, cancelable: true }));
    await wait(5);
    expect(run).not.toHaveBeenCalled();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "g", code: "KeyG", altKey: true, bubbles: true, cancelable: true }));
    await wait(5);
    expect(run).toHaveBeenCalledOnce();
    scope.disposeAll(() => undefined);
    expect(shell.keybinds.list()).toEqual([]);
  });

  it("uses the captured dispatcher when present", () => {
    const { shell } = makeShell();
    const off = vi.fn();
    const registerCommands = vi.fn(() => off);
    shell.hub.capture("shortcutDispatcher", { registerCommands });
    const scope = new Scope();
    const ns = shell.namespaces("demo", scope, {});
    ns.commands.register({ id: "go", title: "Go", run: () => undefined });
    ns.keybinds.register({ id: "k", key: "mod+j", command: "demo:go" });
    expect(shell.keybinds.mode).toBe("dispatcher");
    expect(registerCommands).toHaveBeenCalledOnce();
    scope.disposeAll(() => undefined);
    expect(off).toHaveBeenCalledOnce();
  });
});

describe("ui slots", () => {
  it("mounts into an anchor, remounts after the anchor is replaced, tears down on dispose", async () => {
    const { shell } = makeShell();
    document.body.innerHTML = '<div data-slot="sidebar-content"></div>';
    const scope = new Scope();
    const ns = shell.namespaces("demo", scope, {});
    const cleanup = vi.fn();
    ns.ui.register({ slot: "sidebarSection", id: "a", render: (host) => { host.textContent = "hello"; return cleanup; } });
    await wait();
    expect(document.querySelector('[data-t3p-plugin="demo"][data-t3p-slot="sidebarSection"]')?.textContent).toBe("hello");
    // route change: React replaces the anchor
    document.body.innerHTML = '<div data-slot="sidebar-content"></div>';
    await wait();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('[data-t3p-slot="sidebarSection"]').length).toBe(1);
    scope.disposeAll(() => undefined);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-t3p-slot="sidebarSection"]')).toBeNull();
    shell.slots.dispose();
  });

  it("rejects unknown slots and duplicate ids; render errors stay inside the plugin", async () => {
    const { shell } = makeShell();
    document.body.innerHTML = '<div data-slot="sidebar-content"></div>';
    const scope = new Scope();
    const ns = shell.namespaces("demo", scope, {});
    expect(() => ns.ui.register({ slot: "nope" as never, id: "a", render: () => undefined })).toThrow(/unknown slot/);
    ns.ui.register({ slot: "sidebarSection", id: "a", render: () => { throw new Error("boom"); } });
    expect(() => ns.ui.register({ slot: "sidebarSection", id: "a", render: () => undefined })).toThrow(/already registered/);
    await wait();
    expect(document.querySelector('[data-t3p-slot="sidebarSection"]')).not.toBeNull();
    shell.slots.dispose();
  });

  it("statusBar and rightPanel mount without app anchors (rightPanel needs sidebar-inset)", async () => {
    const { shell } = makeShell();
    document.body.innerHTML = '<div data-slot="sidebar-inset"></div>';
    const scope = new Scope();
    const ns = shell.namespaces("demo", scope, {});
    ns.ui.register({ slot: "statusBar", id: "s", render: (h) => void (h.textContent = "bar") });
    ns.ui.register({ slot: "rightPanel", id: "r", title: "R", render: (h) => void (h.textContent = "panel") });
    await wait();
    expect(shell.slots.mounted().map((m) => m.slot).sort()).toEqual(["rightPanel", "statusBar"]);
    shell.slots.dispose();
  });

  it("themeVars returns resolved custom properties", () => {
    const { shell } = makeShell();
    document.documentElement.style.setProperty("--background", "#123456");
    const scope = new Scope();
    const vars = shell.namespaces("demo", scope, {}).ui.themeVars();
    expect(vars["--background"]).toBe("#123456");
  });

  it("toast and modal", async () => {
    const { shell } = makeShell();
    const scope = new Scope();
    const ns = shell.namespaces("demo", scope, {});
    ns.ui.toast({ message: "hi", durationMs: 0 });
    expect(document.querySelector(".t3p-toast")?.textContent).toContain("hi");
    const result = ns.ui.modal({ title: "T", body: "b", buttons: ["No", "Yes"] });
    (document.querySelectorAll(".t3p-modal button")[1] as HTMLElement).click();
    await expect(result).resolves.toBe(1);
    const pending = ns.ui.modal({ title: "T", body: "b" });
    scope.disposeAll(() => undefined);
    await expect(pending).resolves.toBe(-1);
  });
});

describe("internals", () => {
  it("reports captured, fallback and failed to main", async () => {
    const invoke = vi.fn(async () => ({}));
    const { shell } = makeShell({ invoke });
    shell.hub.capture("router", { navigate: () => undefined });
    shell.hub.finalize();
    const status = shell.namespaces("demo", new Scope(), {}).internals.status();
    expect(status.router).toBe("captured");
    expect(status.shortcutDispatcher).toBe("fallback");
    expect(status.atomRegistry).toBe("missing");
    const calls = invoke.mock.calls.map((c) => c[1] as { name: string; state: string });
    expect(calls).toContainEqual(expect.objectContaining({ name: "router", state: "captured" }));
    expect(calls).toContainEqual(expect.objectContaining({ name: "atomRegistry", state: "failed" }));
    expect(calls).toContainEqual(expect.objectContaining({ name: "commandPalette", state: "fallback" }));
  });

  it("palette adds one group and is idempotent", () => {
    const { shell } = makeShell();
    const core = shell.core() as { palette(i: unknown): { activeGroups: Array<{ value: string }> } };
    const input = { activeGroups: [{ value: "actions" }], isInSubmenu: false };
    const once = core.palette(input);
    expect(once.activeGroups.map((g) => g.value)).toEqual(["actions", "t3p-commands"]);
    expect(core.palette(once).activeGroups).toHaveLength(2);
    expect(core.palette({ activeGroups: [], isInSubmenu: true })).toEqual({ activeGroups: [], isInSubmenu: true });
  });
});

describe("t3.patches", () => {
  it("needs the patches permission and ships regexes as JSON", async () => {
    const invoke = vi.fn(async () => ({ registered: 1 }));
    const { shell } = makeShell({ invoke });
    const denied = shell.namespaces("demo", new Scope(), {});
    expect(() => denied.patches.register([{ find: "x", replacements: [{ match: "x", replace: "y" }] }])).toThrow(/patches/);
    const scope = new Scope();
    const ok = shell.namespaces("demo", scope, { patches: true });
    ok.patches.register([{ find: "abc", replacements: [{ match: /a(b)/g, replace: "$1" }] }]);
    expect(invoke).toHaveBeenCalledWith("t3p:patches:register", {
      plugin: "demo",
      batch: "b1",
      patches: [{ find: "abc", replacements: [{ match: { regex: { source: "a(b)", flags: "g" } }, replace: "$1" }] }],
    });
    scope.disposeAll(() => undefined);
    expect(invoke).toHaveBeenCalledWith("t3p:patches:unregister", { plugin: "demo", batch: "b1" });
  });
});
