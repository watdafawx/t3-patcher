// @vitest-environment jsdom
import type { TimelineRecord } from "@t3p/api";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createEnvironmentApi } from "../src/environment.js";
import { createEventBus } from "../src/events.js";
import { Scope } from "../src/scope.js";
import { Shell } from "../src/shell.js";
import { environmentIdFromLocation } from "../src/threads.js";
import { createTimelineApi } from "../src/timeline.js";
import type { SharedRpc } from "../src/rpc.js";

function makeShell(): Shell {
  return new Shell({ native: null, systemBus: createEventBus(() => undefined), log: () => undefined, consoleError: () => undefined });
}

const wait = (ms = 120): Promise<void> => new Promise((r) => setTimeout(r, ms));
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  document.body.innerHTML = "";
});

describe("t3.ui.toast onDismiss, primary and handle", () => {
  it("onDismiss fires on a body click and on timeout, not after an action or dispose()", () => {
    vi.useFakeTimers();
    try {
      const ns = makeShell().namespaces("demo", new Scope(), {});
      const dismissed = vi.fn();
      ns.ui.toast({ message: "a", durationMs: 0, onDismiss: dismissed });
      (document.querySelector(".t3p-toast") as HTMLElement).click();
      expect(dismissed).toHaveBeenCalledTimes(1);
      ns.ui.toast({ message: "b", durationMs: 1000, onDismiss: dismissed });
      vi.advanceTimersByTime(1000);
      expect(dismissed).toHaveBeenCalledTimes(2);
      ns.ui.toast({ message: "c", durationMs: 0, onDismiss: dismissed, actions: [{ label: "Go", primary: true, onClick: () => undefined }] });
      const button = document.querySelector(".t3p-toast button") as HTMLElement;
      expect(button.hasAttribute("data-primary")).toBe(true);
      button.click();
      expect(dismissed).toHaveBeenCalledTimes(2);
      const handle = ns.ui.toast({ message: "d", durationMs: 0, onDismiss: dismissed });
      handle.dispose();
      handle.dispose();
      expect(document.querySelector(".t3p-toast")).toBeNull();
      expect(dismissed).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("t3.ui.toast actions", () => {
  it("renders t3p-btn buttons, runs the action and dismisses the toast", () => {
    const ns = makeShell().namespaces("demo", new Scope(), {});
    const onClick = vi.fn();
    ns.ui.toast({ title: "T", message: "m", durationMs: 0, actions: [{ label: "Undo", onClick }, { label: "Other", onClick: () => undefined }] });
    const buttons = [...document.querySelectorAll(".t3p-toast button.t3p-btn")] as HTMLButtonElement[];
    expect(buttons.map((b) => b.textContent)).toEqual(["Undo", "Other"]);
    buttons[0]!.click();
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".t3p-toast")).toBeNull();
  });

  it("dismisses even when the action throws or rejects", async () => {
    const ns = makeShell().namespaces("demo", new Scope(), {});
    ns.ui.toast({ message: "a", durationMs: 0, actions: [{ label: "Boom", onClick: () => { throw new Error("x"); } }] });
    (document.querySelector(".t3p-toast button") as HTMLElement).click();
    expect(document.querySelector(".t3p-toast")).toBeNull();
    ns.ui.toast({ message: "b", durationMs: 0, actions: [{ label: "Reject", onClick: () => Promise.reject(new Error("y")) }] });
    (document.querySelector(".t3p-toast button") as HTMLElement).click();
    await tick();
    expect(document.querySelector(".t3p-toast")).toBeNull();
  });

  it("toasts without actions and persistent toasts still work", () => {
    const ns = makeShell().namespaces("demo", new Scope(), {});
    ns.ui.toast({ message: "plain", durationMs: 0 });
    expect(document.querySelector(".t3p-toast")?.textContent).toContain("plain");
    expect(document.querySelector(".t3p-toast button")).toBeNull();
    ns.ui.toast({ message: "bad", durationMs: 0, actions: [{ label: 1 as never, onClick: 1 as never }] });
    expect(document.querySelectorAll(".t3p-toast button").length).toBe(0);
  });
});

describe("t3.ui.dock", () => {
  it("opens, selects a tab by registration id, toggles, closes", async () => {
    const shell = makeShell();
    document.body.innerHTML = '<div data-slot="sidebar-inset"></div>';
    const ns = shell.namespaces("demo", new Scope(), {});
    const other = shell.namespaces("other", new Scope(), {});
    ns.ui.register({ slot: "rightPanel", id: "a", title: "A", render: (h) => void (h.textContent = "panel a") });
    ns.ui.register({ slot: "rightPanel", id: "b", title: "B", render: (h) => void (h.textContent = "panel b") });
    await wait();
    const dock = document.querySelector(".t3p-dock") as HTMLElement;
    expect(ns.ui.dock.isOpen()).toBe(false);
    expect(dock.hidden).toBe(true);

    ns.ui.dock.open("b");
    expect(ns.ui.dock.isOpen()).toBe(true);
    expect(dock.hidden).toBe(false);
    expect(document.body.classList.contains("t3p-dock-open")).toBe(true);
    expect(document.querySelector('[data-t3p-tab="b"]')?.getAttribute("aria-selected")).toBe("true");
    expect((document.querySelector('[data-t3p-id="a"]') as HTMLElement).hidden).toBe(true);
    expect((document.querySelector('[data-t3p-id="b"]') as HTMLElement).hidden).toBe(false);
    // state is shared by every plugin
    expect(other.ui.dock.isOpen()).toBe(true);

    ns.ui.dock.toggle();
    expect(ns.ui.dock.isOpen()).toBe(false);
    expect(dock.hidden).toBe(true);
    ns.ui.dock.toggle("a");
    expect(ns.ui.dock.isOpen()).toBe(true);
    expect(document.querySelector('[data-t3p-tab="a"]')?.getAttribute("aria-selected")).toBe("true");
    ns.ui.dock.close();
    expect(ns.ui.dock.isOpen()).toBe(false);
    shell.slots.dispose();
  });

  it("unknown tab ids (also another plugin's) throw; without a dock it is a no-op", async () => {
    const shell = makeShell();
    const ns = shell.namespaces("demo", new Scope(), {});
    const other = shell.namespaces("other", new Scope(), {});
    expect(() => ns.ui.dock.open()).not.toThrow();
    expect(ns.ui.dock.isOpen()).toBe(false);
    document.body.innerHTML = '<div data-slot="sidebar-inset"></div>';
    ns.ui.register({ slot: "rightPanel", id: "a", render: () => undefined });
    await wait();
    expect(() => ns.ui.dock.open("nope")).toThrow(/no rightPanel registration/);
    expect(() => other.ui.dock.open("a")).toThrow(/no rightPanel registration/);
    expect(ns.ui.dock.isOpen()).toBe(false);
    shell.slots.dispose();
  });

  it("is frozen and refuses calls after the plugin scope ended", () => {
    const scope = new Scope();
    const ns = makeShell().namespaces("demo", scope, {});
    expect(Object.isFrozen(ns.ui.dock)).toBe(true);
    scope.disposeAll(() => undefined);
    expect(() => ns.ui.dock.open()).toThrow();
  });
});

describe("t3.environment", () => {
  const shared = (value: { id: string | null; label: string | null } | null) => ({ localEnvironment: async () => value });

  it("parses the environment id from the route", () => {
    expect(environmentIdFromLocation({ hash: "#/env-1/thread-9" })).toBe("env-1");
    expect(environmentIdFromLocation({ hash: "#/settings/general" })).toBeNull();
    expect(environmentIdFromLocation({ hash: "" })).toBeNull();
    expect(environmentIdFromLocation({ hash: "", pathname: "/env-2/t?x=1" })).toBe("env-2");
  });

  it("returns nulls until the bridge answered, then the local id and label", async () => {
    const env = createEnvironmentApi({ shared: shared({ id: "local-1", label: "This PC" }), location: () => ({ hash: "#/settings" }) });
    expect(env.current()).toEqual({ id: null, label: null });
    await tick();
    expect(env.current()).toEqual({ id: "local-1", label: "This PC" });
  });

  it("route id wins; the label only goes with the local environment", async () => {
    let hash = "#/local-1/t1";
    const env = createEnvironmentApi({ shared: shared({ id: "local-1", label: "This PC" }), location: () => ({ hash }) });
    await tick();
    expect(env.current()).toEqual({ id: "local-1", label: "This PC" });
    hash = "#/remote-9/t2";
    expect(env.current()).toEqual({ id: "remote-9", label: null });
  });

  it("route id still works without a bridge", async () => {
    const env = createEnvironmentApi({ shared: shared(null), location: () => ({ hash: "#/e/t" }) });
    await tick();
    expect(env.current()).toEqual({ id: "e", label: null });
    expect(Object.isFrozen(env)).toBe(true);
  });
});

describe("t3.timeline.enrichFromProviderLog", () => {
  const api = () => createTimelineApi({ id: "p", allowed: false, shared: {} as SharedRpc, scope: new Scope(), log: () => undefined });
  const record = (raw: unknown): TimelineRecord => ({ id: "r1", kind: "command", raw }) as unknown as TimelineRecord;
  const log = '[2026-11-19T10:00:03.000Z] NTIVE: {"type":"tool_use","id":"toolu_0123456789"}\nnot json\n';

  it("is pure, needs no permission and attaches matching frames", () => {
    const t = api();
    const hit = record({ nativeItemRef: { nativeId: "toolu_0123456789" } });
    const miss = record({ nativeItemRef: { nativeId: "toolu_other_00000" } });
    const input = [hit, miss];
    const out = t.enrichFromProviderLog(input, log);
    expect(out).toHaveLength(2);
    expect(out[0]?.enrichment?.matchedBy).toEqual(["toolu_0123456789"]);
    expect(out[0]?.enrichment?.frames[0]?.stream).toBe("native");
    expect(out[1]).toBe(miss);
    expect(hit.enrichment).toBeUndefined();
    expect(input[0]).toBe(hit);
  });

  it("validates its arguments", () => {
    const t = api();
    expect(() => t.enrichFromProviderLog("x" as never, "")).toThrow(TypeError);
    expect(() => t.enrichFromProviderLog([], 1 as never)).toThrow(TypeError);
    expect(t.enrichFromProviderLog([], "")).toEqual([]);
  });
});
