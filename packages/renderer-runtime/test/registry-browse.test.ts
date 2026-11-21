// @vitest-environment jsdom
import type { RegistryEntry } from "@t3p/api";
import { REGISTRY_REQUEST_CHANNEL } from "@t3p/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installGrantClicks } from "../../preload-runtime/src/grant-clicks.js";
import type { ManagedPlugin, RegistryResultEvent, RegistryView } from "../src/manager.js";
import { mountPluginsPage, TAB_KEY, type ManagerFacade } from "../src/ui/plugins-page.js";
import { browseRows, registryTags, riskTone } from "../src/ui/registry-browse.js";

function entry(id: string, extra: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    id,
    name: `Plugin ${id}`,
    description: `Does ${id} things.`,
    author: "Demo Author",
    homepage: `https://example.com/${id}`,
    version: "1.0.0",
    apiVersion: "1",
    permissions: [],
    tags: [],
    download: { url: `https://github.com/example/r/releases/download/v1/t3p-plugin-${id}-1.0.0.zip`, sha256: "a".repeat(64), size: 2048 },
    ...extra,
  };
}

const VIEW: RegistryView = {
  url: "https://registry.example/index.json",
  source: "network",
  fetchedAt: "2026-11-19T10:00:00.000Z",
  error: null,
  offline: false,
  plugins: [
    entry("notes", { tags: ["ui", "productivity"], permissions: ["rpc"] }),
    entry("media", { tags: ["media"], permissions: ["main", { spawn: { allow: ["C:/Tools/x.exe"] } }, "embed.youtube"] as RegistryEntry["permissions"], screenshots: ["https://example.com/shot.png"] }),
    entry("keep-warm", { tags: ["ui"], version: "1.2.0" }),
    entry("devtools", { tags: ["dev"] }),
  ],
  installed: { "keep-warm": { version: "1.0.0", devLink: false }, notes: { version: "1.0.0", devLink: false }, devtools: { version: "0.1.0", devLink: true } },
};

function fakeManager(opts: { view?: RegistryView | (() => Promise<RegistryView>); plugins?: ManagedPlugin[]; registry?: boolean } = {}) {
  const listeners = new Set<() => void>();
  const results = new Set<(r: RegistryResultEvent) => void>();
  const calls: boolean[] = [];
  const manager: ManagerFacade = {
    list: () => opts.plugins ?? [],
    enable: async () => null,
    disable: async () => ({ restartRequired: false }),
    schemas: () => [],
    getSetting: () => null as never,
    setSetting: async () => undefined,
    resetSetting: async () => undefined,
    onChange: (cb) => (listeners.add(cb), () => void listeners.delete(cb)),
    ...(opts.registry === false
      ? {}
      : {
          registry: async (refresh?: boolean) => {
            calls.push(refresh === true);
            const v = opts.view ?? VIEW;
            return typeof v === "function" ? v() : v;
          },
          onRegistryResult: (cb: (r: RegistryResultEvent) => void) => (results.add(cb), () => void results.delete(cb)),
        }),
  };
  return { manager, calls, result: (r: RegistryResultEvent) => [...results].forEach((fn) => fn(r)), changed: () => [...listeners].forEach((fn) => fn()) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const $$ = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(sel));

let host: HTMLElement;
let dispose: (() => void) | null = null;
beforeEach(() => {
  localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => {
  dispose?.();
  dispose = null;
  host.remove();
});

async function openBrowse(f: ReturnType<typeof fakeManager>, notices: string[] = []) {
  dispose = mountPluginsPage(host, f.manager, (m) => notices.push(m));
  $<HTMLButtonElement>("[data-t3p-tab-button=browse]")!.click();
  await flush();
  await flush();
}

describe("browse helpers", () => {
  it("computes install state, filters by text and tags, orders tags and tones permissions by risk", () => {
    const rows = browseRows(VIEW, "", []);
    expect(Object.fromEntries(rows.map((r) => [r.entry.id, r.state]))).toEqual({ notes: "installed", media: "install", "keep-warm": "update", devtools: "dev" });
    expect(browseRows(VIEW, "media", []).map((r) => r.entry.id)).toEqual(["media"]);
    expect(browseRows(VIEW, "", ["ui"]).map((r) => r.entry.id).sort()).toEqual(["keep-warm", "notes"]);
    expect(browseRows(VIEW, "", ["ui", "productivity"]).map((r) => r.entry.id)).toEqual(["notes"]);
    expect(registryTags(VIEW.plugins)[0]).toBe("ui");
    expect(riskTone("main")).toBe("bad");
    expect(riskTone("rpc")).not.toBe("bad");
  });
});

describe("Browse tab", () => {
  it("has Installed | Browse tabs; Installed is the default and Browse loads on first show", async () => {
    const f = fakeManager();
    dispose = mountPluginsPage(host, f.manager, () => undefined);
    expect($$("[role=tab]").map((t) => t.textContent)).toEqual(["Installed", "Browse", "About"]);
    expect($("[data-t3p-installed]")!.hidden).toBe(false);
    expect($("[data-t3p-browse]")!.hidden).toBe(true);
    expect(f.calls).toEqual([]);
    $<HTMLButtonElement>("[data-t3p-tab-button=browse]")!.click();
    await flush();
    expect(f.calls).toEqual([false]);
    expect($("[data-t3p-installed]")!.hidden).toBe(true);
    expect($("[data-t3p-browse]")!.getAttribute("data-t3p-state")).toBe("ready");
    expect(localStorage.getItem(TAB_KEY)).toBe("browse");
  });

  it("renders cards with name, author, description and state; detail has risk badges, screenshots, homepage and actions", async () => {
    await openBrowse(fakeManager());
    expect($$("[data-t3p-card]").map((c) => c.getAttribute("data-t3p-card"))).toEqual(["notes", "media", "keep-warm", "devtools"]);
    expect($("[data-t3p-card=notes]")!.textContent).toMatch(/Plugin notes.*1\.0\.0.*Demo Author · Does notes things\.Installed/);
    expect($("[data-t3p-card=keep-warm] [data-t3p-badge=update]")!.textContent).toBe("Update available");
    $<HTMLButtonElement>("[data-t3p-card=media]")!.click();
    const d = $("[data-t3p-browse-detail]")!;
    expect(d.querySelector("[data-t3p-perm=main]")!.getAttribute("data-tone")).toBe("bad");
    expect(d.querySelector("[data-t3p-perm=spawn]")!.getAttribute("data-tone")).toBe("bad");
    expect(d.querySelector("[data-t3p-shots] img")!.getAttribute("src")).toBe("https://example.com/shot.png");
    expect(d.querySelector("[data-t3p-shots] img")!.getAttribute("referrerpolicy")).toBe("no-referrer");
    const hp = d.querySelector<HTMLAnchorElement>("[data-t3p-homepage]")!;
    expect(hp.href).toBe("https://example.com/media");
    expect(hp.rel).toBe("noopener noreferrer");
    const install = d.querySelector<HTMLButtonElement>("[data-t3p-registry-action]")!;
    expect(install.textContent).toBe("Install");
    expect(install.getAttribute("data-t3p-registry-action")).toBe("install");
    expect(install.getAttribute("data-t3p-registry-id")).toBe("media");
    expect(d.textContent).toMatch(/Installs disabled with no permissions granted/);

    $<HTMLButtonElement>("[data-t3p-card=keep-warm]")!.click();
    expect($$("[data-t3p-browse-detail] [data-t3p-registry-action]").map((b) => [b.getAttribute("data-t3p-registry-action"), b.textContent])).toEqual([
      ["update", "Update to 1.2.0"],
      ["uninstall", "Uninstall"],
    ]);
    $<HTMLButtonElement>("[data-t3p-card=notes]")!.click();
    expect($<HTMLButtonElement>("[data-t3p-is-installed]")!.disabled).toBe(true);
    expect($$("[data-t3p-browse-detail] [data-t3p-registry-action]").map((b) => b.getAttribute("data-t3p-registry-action"))).toEqual(["uninstall"]);
    $<HTMLButtonElement>("[data-t3p-card=devtools]")!.click();
    expect($$("[data-t3p-browse-detail] [data-t3p-registry-action]")).toHaveLength(0);
    expect($("[data-t3p-browse-detail]")!.textContent).toMatch(/dev link/);
  });

  it("filters by search text and tag chips", async () => {
    await openBrowse(fakeManager());
    const search = $<HTMLInputElement>("[data-t3p-browse-search]")!;
    search.value = "keep";
    search.dispatchEvent(new Event("input"));
    expect($$("[data-t3p-card]").map((c) => c.getAttribute("data-t3p-card"))).toEqual(["keep-warm"]);
    expect($("[data-t3p-browse-status]")!.textContent).toMatch(/1 of 4 match/);
    search.value = "";
    search.dispatchEvent(new Event("input"));
    $<HTMLButtonElement>("[data-t3p-tag=media]")!.click();
    expect($<HTMLButtonElement>("[data-t3p-tag=media]")!.getAttribute("aria-pressed")).toBe("true");
    expect($$("[data-t3p-card]").map((c) => c.getAttribute("data-t3p-card"))).toEqual(["media"]);
    search.value = "zzz";
    search.dispatchEvent(new Event("input"));
    expect($("[data-t3p-browse-list] [data-t3p-empty]")!.textContent).toBe("Nothing matches.");
  });

  it("Refresh forces a re-fetch", async () => {
    const f = fakeManager();
    await openBrowse(f);
    $<HTMLButtonElement>("[data-t3p-refresh]")!.click();
    await flush();
    expect(f.calls).toEqual([false, true]);
  });

  it("shows loading, offline, error, stale-cache and empty states", async () => {
    let release!: (v: RegistryView) => void;
    const slow = fakeManager({ view: () => new Promise<RegistryView>((r) => (release = r)) });
    dispose = mountPluginsPage(host, slow.manager, () => undefined);
    $<HTMLButtonElement>("[data-t3p-tab-button=browse]")!.click();
    expect($("[data-t3p-browse]")!.getAttribute("data-t3p-state")).toBe("loading");
    expect($("[data-t3p-browse-status]")!.textContent).toMatch(/Loading/);
    release({ ...VIEW, plugins: [], installed: {} });
    await flush();
    expect($("[data-t3p-browse]")!.getAttribute("data-t3p-state")).toBe("empty");
    expect($("[data-t3p-browse-list]")!.textContent).toMatch(/The registry is empty/);
    dispose();

    await openBrowse(fakeManager({ view: { url: null, source: null, fetchedAt: null, error: "cannot reach registry.example: ENOTFOUND", offline: true, plugins: [], installed: {} } }));
    expect($("[data-t3p-browse]")!.getAttribute("data-t3p-state")).toBe("offline");
    expect($("[data-t3p-problem=offline]")!.textContent).toMatch(/You may be offline.*ENOTFOUND/);
    dispose!();

    await openBrowse(fakeManager({ view: { url: null, source: null, fetchedAt: null, error: "registry index is invalid: plugins[0].id", offline: false, plugins: [], installed: {} } }));
    expect($("[data-t3p-browse]")!.getAttribute("data-t3p-state")).toBe("error");
    expect($("[data-t3p-problem=error]")!.textContent).toMatch(/Cannot load the registry/);
    dispose!();

    await openBrowse(fakeManager({ view: { ...VIEW, source: "cache", offline: true, error: "cannot reach registry.example" } }));
    expect($("[data-t3p-browse]")!.getAttribute("data-t3p-state")).toBe("stale");
    expect($("[data-t3p-problem]")!.textContent).toMatch(/Showing the last copy/);
    expect($$("[data-t3p-card]")).toHaveLength(4);
    dispose!();

    await openBrowse(fakeManager({ view: () => Promise.reject(new Error("bridge gone")) }));
    expect($("[data-t3p-browse]")!.getAttribute("data-t3p-state")).toBe("error");
    expect($("[data-t3p-problem]")!.textContent).toMatch(/bridge gone/);
  });

  it("a click marks the button as waiting; a result clears it and reloads; review opens Installed on permissions", async () => {
    const plugins = [{ id: "media", name: "Media", version: "1.0.0", tier: 1, hostStatus: "disabled", status: "inactive", error: null, hasRenderer: false, declared: ["main"], effective: {}, restartRequired: false, disabledReason: null } as ManagedPlugin];
    const f = fakeManager({ plugins });
    const notices: string[] = [];
    // Capture the button's own click handler so the test can deliver what a real (trusted) click looks like.
    const clickHandlers = new Map<EventTarget, EventListener>();
    const realAdd = HTMLElement.prototype.addEventListener;
    const spy = vi.spyOn(HTMLElement.prototype, "addEventListener").mockImplementation(function (this: HTMLElement, type: string, fn: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions) {
      if (type === "click" && typeof fn === "function") clickHandlers.set(this, fn);
      realAdd.call(this, type, fn, opts);
    });
    await openBrowse(f, notices);
    $<HTMLButtonElement>("[data-t3p-card=media]")!.click();
    const btn = $<HTMLButtonElement>("[data-t3p-browse-detail] [data-t3p-registry-action=install]")!;
    spy.mockRestore();
    btn.click(); // a scripted click opens no dialog, so the button must not claim one is open
    expect(btn.hasAttribute("data-t3p-waiting")).toBe(false);
    expect(btn.textContent).toBe("Install");
    clickHandlers.get(btn)!({ isTrusted: true, currentTarget: btn } as unknown as Event);
    expect(btn.hasAttribute("data-t3p-waiting")).toBe(true);
    expect(btn.textContent).toBe("Confirm in dialog…");
    f.result({ status: "busy", action: "install", plugin: "media" });
    expect(notices.at(-1)).toMatch(/Another T3 Patcher dialog is open/);
    await flush();
    expect(f.calls).toEqual([false, false]);
    f.result({ status: "installed", action: "install", plugin: "media", version: "1.0.0", review: true });
    await flush();
    expect($("[data-t3p-installed]")!.hidden).toBe(false);
    expect($("[role=tab][aria-selected=true]")!.textContent).toBe("Installed");
    expect($("[data-t3p-item=media]")!.getAttribute("aria-selected")).toBe("true");
  });

  it("without registry support on the facade there are no tabs", () => {
    dispose = mountPluginsPage(host, fakeManager({ registry: false }).manager, () => undefined);
    expect($$("[role=tab]")).toHaveLength(0);
    expect($("[data-t3p-browse]")).toBeNull();
  });
});

describe("page scripts cannot install, update or uninstall", () => {
  it("synthetic clicks on the real buttons never reach the privileged channel (preload listener on the same window)", async () => {
    const ipc = { invoke: vi.fn(async () => ({ status: "cancelled" })) };
    let listener: ((e: { isTrusted: boolean; button?: number; target: unknown }) => void) | null = null;
    // The real listener, installed on the page's window (the preload does the same from its isolated world).
    const remove = installGrantClicks(
      {
        addEventListener: (t, fn, c) => {
          listener = fn;
          window.addEventListener(t, fn as unknown as EventListener, c);
        },
        removeEventListener: (t, fn, c) => window.removeEventListener(t, fn as unknown as EventListener, c),
      },
      ipc,
    );
    try {
      await openBrowse(fakeManager());
      for (const id of ["media", "keep-warm", "notes"]) {
        $<HTMLButtonElement>(`[data-t3p-card=${id}]`)!.click();
        for (const b of $$("[data-t3p-browse-detail] [data-t3p-registry-action]")) {
          b.click(); // what a page script or plugin can do
          b.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
          b.dispatchEvent(new Event("click", { bubbles: true }));
        }
      }
      // a page script forging the attributes on its own element gets nowhere either
      const forged = document.createElement("button");
      forged.setAttribute("data-t3p-registry-action", "install");
      forged.setAttribute("data-t3p-registry-id", "media");
      document.body.appendChild(forged);
      forged.click();
      forged.remove();
      expect(ipc.invoke).not.toHaveBeenCalled();
      // sanity: the same listener does act on a trusted event (isTrusted cannot be forged by page code)
      const btn = $<HTMLButtonElement>("[data-t3p-card=media]")!;
      btn.click();
      const install = $("[data-t3p-browse-detail] [data-t3p-registry-action=install]")!;
      expect(() => Object.defineProperty(new MouseEvent("click"), "isTrusted", { value: true })).toThrow(); // page code cannot forge it
      listener!({ isTrusted: true, button: 0, target: install }); // what the browser delivers for a real click
      expect(ipc.invoke).toHaveBeenCalledWith(REGISTRY_REQUEST_CHANNEL, { action: "install", id: "media" });
    } finally {
      remove();
    }
  });

  it("the manager facade the page sees has no install, update or uninstall method", async () => {
    const { PluginManager } = await import("../src/manager.js");
    const m = new PluginManager({ native: null, consoleError: () => undefined, log: () => undefined, systemBus: { emit: () => undefined }, registry: {} } as never);
    const facade = m.facade();
    expect(Object.keys(facade).filter((k) => /^(install|update|uninstall)/i.test(k) || k === "registryResult")).toEqual([]);
    expect(Object.isFrozen(facade)).toBe(true);
  });
});
