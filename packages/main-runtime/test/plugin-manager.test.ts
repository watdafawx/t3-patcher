import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PermissionSet } from "@t3p/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerCoreChannels } from "../src/ipc/channels.js";
import { createIpcRouter } from "../src/ipc/router.js";
import { createSenderCheck, type IpcEventLike } from "../src/ipc/sender.js";
import { nullLogger } from "../src/log.js";
import { createNativeServices } from "../src/native/index.js";
import { PatchRegistry } from "../src/patches/registry.js";
import { listPluginDirs, watchPluginDirs } from "../src/plugins/dev-watch.js";
import { PluginHost } from "../src/plugins/host.js";
import { StorageStore } from "../src/storage/store.js";

const platform = process.platform === "win32" ? ("win32" as const) : ("posix" as const);

let home: string;
let pluginsDir: string;
let stateFile: string;
let storageDir: string;

beforeEach(() => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), "t3p-mgr-")));
  pluginsDir = join(home, ".t3-patcher", "plugins");
  stateFile = join(home, ".t3-patcher", "state.json");
  storageDir = join(home, ".t3-patcher", "storage");
  mkdirSync(pluginsDir, { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function writePlugin(id: string, manifest: object, files: Record<string, string> = { "r.js": "export const x = 1;" }): void {
  const dir = join(pluginsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify({ id, version: "1.0.0", tier: 1, t3Versions: ["*"], permissions: [], renderer: "r.js", ...manifest }));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
}
function writeState(state: object): void {
  writeFileSync(stateFile, JSON.stringify({ version: 1, plugins: {}, ...state }));
}

function harness() {
  const handlers = new Map<string, (event: IpcEventLike, ...args: unknown[]) => unknown>();
  const frame = { url: "t3code://app/" };
  const sent: Array<[string, unknown]> = [];
  const main = { isDestroyed: () => false, webContents: { id: 1, mainFrame: frame, isDestroyed: () => false, send: (c: string, p: unknown) => void sent.push([c, p]) } };
  const router = createIpcRouter({
    ipcMain: { handle: (c, fn) => void handlers.set(c, fn), removeHandler: (c) => void handlers.delete(c) },
    checkSender: createSenderCheck(() => main),
    getMainWindow: () => main,
    log: nullLogger,
  });
  const host = new PluginHost({
    pluginsDir,
    stateFile,
    appVersion: "0.1.10",
    router,
    registry: new PatchRegistry(),
    nativeFor: (perms: PermissionSet) => createNativeServices(perms, { platform, home }),
    log: nullLogger,
    platform,
    activateTimeoutMs: 1000,
  });
  const storage = new StorageStore(storageDir, nullLogger);
  registerCoreChannels({
    router,
    log: nullLogger,
    version: "0.1.0",
    appVersion: "0.1.10",
    safe: false,
    permissionsFor: (id) => host.permissionsFor(id),
    nativeFor: (_id, perms) => createNativeServices(perms, { platform, home }),
    pluginsList: () => host.list(),
    patchReport: () => [],
    dev: true,
    storage,
    setEnabled: (id, enabled, options) => host.setEnabled(id, enabled, options),
    setLoadOrder: (order) => host.setLoadOrder(order),
  });
  const call = async (channel: string, payload?: unknown, event: IpcEventLike = { sender: { id: 1 }, senderFrame: frame }): Promise<unknown> => {
    const fn = handlers.get(channel);
    if (!fn) throw new Error(`No handler registered for '${channel}'`);
    return fn(event, payload);
  };
  return { host, router, storage, call, sent, frame };
}

describe("StorageStore", () => {
  it("persists per plugin and survives a new instance", () => {
    const a = new StorageStore(storageDir, nullLogger);
    a.apply("p1", { area: "kv", op: "set", key: "k", value: { n: 1 } });
    a.apply("p1", { area: "settings", op: "set", key: "s", value: true });
    a.apply("p2", { area: "kv", op: "set", key: "k", value: "other" });
    const b = new StorageStore(storageDir, nullLogger);
    expect(b.read("p1").kv).toEqual({ k: { n: 1 } });
    expect(b.read("p1").settings).toEqual({ s: true });
    expect(b.read("p2").kv).toEqual({ k: "other" });
    expect(readdirSync(storageDir).sort()).toEqual(["p1.json", "p2.json"]);
  });

  it("refuses a write past 1 MiB, and keeps the old data", () => {
    const store = new StorageStore(storageDir, nullLogger);
    store.apply("p1", { area: "kv", op: "set", key: "small", value: "x" });
    expect(() => store.apply("p1", { area: "kv", op: "set", key: "big", value: "y".repeat(1024 * 1024) })).toThrow(/quota/);
    expect(store.read("p1").kv).toEqual({ small: "x" });
    expect(JSON.parse(readFileSync(join(storageDir, "p1.json"), "utf8")).kv).toEqual({ small: "x" });
  });

  it("the quota counts kv and settings together, and deleting is always allowed", () => {
    const store = new StorageStore(storageDir, nullLogger, 200);
    store.apply("p1", { area: "kv", op: "set", key: "a", value: "x".repeat(100) });
    expect(() => store.apply("p1", { area: "settings", op: "set", key: "b", value: "y".repeat(100) })).toThrow(/quota/);
    store.apply("p1", { area: "kv", op: "delete", key: "a" });
    expect(store.read("p1").kv).toEqual({});
  });

  it("rejects bad plugin ids and keys (no path traversal, no prototype keys)", () => {
    const store = new StorageStore(storageDir, nullLogger);
    expect(() => store.read("../evil")).toThrow(/invalid plugin id/);
    expect(() => store.apply("..\\evil", { area: "kv", op: "set", key: "k", value: 1 })).toThrow(/invalid plugin id/);
    expect(() => store.apply("p1", { area: "kv", op: "set", key: "__proto__", value: 1 })).toThrow(/invalid storage key/);
    expect(() => store.apply("p1", { area: "kv", op: "set", key: "", value: 1 })).toThrow(/invalid storage key/);
    expect(() => store.apply("p1", { area: "kv", op: "set", key: "k", value: undefined })).toThrow(/undefined/);
  });

  it("clear empties one area only", () => {
    const store = new StorageStore(storageDir, nullLogger);
    store.apply("p1", { area: "kv", op: "set", key: "a", value: 1 });
    store.apply("p1", { area: "settings", op: "set", key: "s", value: 2 });
    store.apply("p1", { area: "kv", op: "clear" });
    expect(store.read("p1")).toMatchObject({ kv: {}, settings: { s: 2 } });
  });

  it("ignores a corrupt file instead of throwing", () => {
    mkdirSync(storageDir, { recursive: true });
    writeFileSync(join(storageDir, "p1.json"), "{not json");
    expect(new StorageStore(storageDir, nullLogger).read("p1").kv).toEqual({});
  });
});

describe("rescan", () => {
  it("adds a new folder, reports a state change, and forgets a removed renderer-only plugin", async () => {
    writePlugin("p1", {});
    writeState({ plugins: { p1: { enabled: true, granted: [] } } });
    const h = harness();
    await h.host.loadAll({ safe: false });
    expect(await h.host.rescan()).toEqual([]);
    writePlugin("p2", {});
    writeState({ plugins: { p1: { enabled: true, granted: [] }, p2: { enabled: true, granted: [] } } });
    expect(await h.host.rescan()).toEqual(["p2"]);
    writeState({ plugins: { p1: { enabled: false, granted: [] }, p2: { enabled: true, granted: [] } } });
    expect(await h.host.rescan()).toEqual(["p1"]);
    rmSync(join(pluginsDir, "p2"), { recursive: true, force: true });
    expect(await h.host.rescan()).toEqual(["p2"]);
    expect(await h.host.rescan()).toEqual([]);
  });
});

describe("storage IPC channels", () => {
  it("round trips through the router, only for loaded plugins", async () => {
    writePlugin("p1", {});
    writeState({ plugins: { p1: { enabled: true, granted: [] } } });
    const h = harness();
    await h.host.loadAll({ safe: false });
    await h.call("t3p:storage:write", { plugin: "p1", area: "kv", op: "set", key: "k", value: [1, 2] });
    const snap = (await h.call("t3p:storage:read", { plugin: "p1" })) as { kv: Record<string, unknown>; limitBytes: number };
    expect(snap.kv).toEqual({ k: [1, 2] });
    expect(snap.limitBytes).toBe(1024 * 1024);
    await expect(h.call("t3p:storage:read", { plugin: "ghost" })).rejects.toThrow(/not loaded/);
    await expect(h.call("t3p:storage:write", { plugin: "p1", area: "kv", op: "set", value: 1 })).rejects.toThrow(/key is required/);
    await expect(h.call("t3p:storage:write", { plugin: "p1", area: "other", op: "set", key: "k", value: 1 })).rejects.toThrow(/invalid payload/);
    await expect(h.call("t3p:storage:write", { plugin: "p1", area: "kv", op: "set", key: "k", value: 1, extra: 1 })).rejects.toThrow(/not allowed/);
  });

  it("null is a storable value", async () => {
    writePlugin("p1", {});
    writeState({ plugins: { p1: { enabled: true, granted: [] } } });
    const h = harness();
    await h.host.loadAll({ safe: false });
    await h.call("t3p:storage:write", { plugin: "p1", area: "kv", op: "set", key: "n", value: null });
    expect(((await h.call("t3p:storage:read", { plugin: "p1" })) as { kv: object }).kv).toEqual({ n: null });
  });

  it("keeps the sender check: a call from another frame is rejected", async () => {
    writePlugin("p1", {});
    writeState({ plugins: { p1: { enabled: true, granted: [] } } });
    const h = harness();
    await h.host.loadAll({ safe: false });
    const other: IpcEventLike = { sender: { id: 2 }, senderFrame: { url: "t3code://app/" } };
    await expect(h.call("t3p:storage:read", { plugin: "p1" }, other)).rejects.toThrow(/rejected \(sender\)/);
    await expect(h.call("t3p:storage:write", { plugin: "p1", area: "kv", op: "set", key: "k", value: 1 }, other)).rejects.toThrow(/rejected \(sender\)/);
    await expect(h.call("t3p:plugins:set-enabled", { id: "p1", enabled: false }, other)).rejects.toThrow(/rejected \(sender\)/);
    await expect(h.call("t3p:plugins:set-load-order", { order: ["p1"] }, other)).rejects.toThrow(/rejected \(sender\)/);
  });

  it("plugins:list reports dev, tier, declared permissions", async () => {
    writePlugin("p1", { permissions: ["rpc"], tier: 2 });
    writeState({ plugins: { p1: { enabled: true, granted: ["rpc"] } } });
    const h = harness();
    await h.host.loadAll({ safe: false });
    const list = (await h.call("t3p:plugins:list")) as { dev: boolean; plugins: Array<{ id: string; tier: number; declared: unknown[]; effective: object; rendererUrl: string }> };
    expect(list.dev).toBe(true);
    expect(list.plugins[0]).toMatchObject({ id: "p1", tier: 2, declared: ["rpc"], effective: { rpc: true } });
    expect(list.plugins[0]!.rendererUrl).toBe("t3code://app/__t3p/plugins/p1/r.js");
  });
});

describe("plugin manager: enable, disable, load order", () => {
  it("enables a renderer-only plugin live, grants rpc only when asked, and persists", async () => {
    writePlugin("p1", { permissions: ["rpc"] });
    writeState({ plugins: {} });
    const h = harness();
    await h.host.loadAll({ safe: false });
    expect(h.host.records.get("p1")?.status).toBe("disabled");
    expect(h.host.rendererDir("p1")).toBeNull();

    await expect(h.call("t3p:plugins:set-enabled", { id: "p1", enabled: true })).resolves.toEqual({ status: "loaded", restartRequired: false });
    expect(h.host.rendererDir("p1")).not.toBeNull();
    expect(h.host.records.get("p1")?.effective).toEqual({}); // enabled, rpc not granted
    expect(JSON.parse(readFileSync(stateFile, "utf8")).plugins.p1).toEqual({ enabled: true, granted: [] });

    await h.call("t3p:plugins:set-enabled", { id: "p1", enabled: true, grantRpc: true });
    expect(h.host.records.get("p1")?.effective).toEqual({ rpc: true });
    expect(JSON.parse(readFileSync(stateFile, "utf8")).plugins.p1).toEqual({ enabled: true, granted: ["rpc"] });

    await expect(h.call("t3p:plugins:set-enabled", { id: "p1", enabled: false })).resolves.toEqual({ status: "disabled", restartRequired: false });
    expect(h.host.rendererDir("p1")).toBeNull();
    expect(JSON.parse(readFileSync(stateFile, "utf8")).plugins.p1.granted).toEqual(["rpc"]); // grants are kept
  });

  it("never grants rpc that the manifest did not declare", async () => {
    writePlugin("p1", {});
    writeState({ plugins: {} });
    const h = harness();
    await h.host.loadAll({ safe: false });
    await h.call("t3p:plugins:set-enabled", { id: "p1", enabled: true, grantRpc: true });
    expect(JSON.parse(readFileSync(stateFile, "utf8")).plugins.p1.granted).toEqual([]);
  });

  it("refuses to enable main-process, patches or spawn plugins from the renderer", async () => {
    writePlugin("m1", { main: "main.cjs", permissions: ["main"] }, { "main.cjs": "exports.activate=()=>{}", "r.js": "" });
    writePlugin("pt", { permissions: ["main", "patches"], main: "main.cjs" }, { "main.cjs": "exports.activate=()=>{}", "r.js": "" });
    writePlugin("sp", { permissions: [{ spawn: { allow: ["C:/x.exe"] } }] });
    writeState({ plugins: {} });
    const h = harness();
    await h.host.loadAll({ safe: false });
    for (const id of ["m1", "pt", "sp"]) {
      await expect(h.call("t3p:plugins:set-enabled", { id, enabled: true })).rejects.toThrow(/t3p enable/);
    }
    expect(JSON.parse(readFileSync(stateFile, "utf8")).plugins).toEqual({}); // nothing written
    await expect(h.call("t3p:plugins:set-enabled", { id: "nope", enabled: true })).rejects.toThrow(/unknown or invalid/);
  });

  it("disabling a running main plugin persists and asks for a restart; main code stays", async () => {
    writePlugin("m1", { main: "main.cjs", permissions: ["main"] }, { "main.cjs": "exports.activate=()=>{}", "r.js": "" });
    writeState({ plugins: { m1: { enabled: true, granted: ["main"] } } });
    const h = harness();
    await h.host.loadAll({ safe: false });
    expect(h.host.records.get("m1")?.status).toBe("active");
    await expect(h.call("t3p:plugins:set-enabled", { id: "m1", enabled: false })).resolves.toEqual({ status: "active", restartRequired: true });
    expect(JSON.parse(readFileSync(stateFile, "utf8")).plugins.m1.enabled).toBe(false);
    expect((h.host.list().find((p) => p.id === "m1") as { restartRequired: boolean }).restartRequired).toBe(true);
  });

  it("load order: listed ids first, the rest by id; persisted in state.json", async () => {
    for (const id of ["a", "b", "c", "d"]) writePlugin(id, {});
    writeState({ plugins: Object.fromEntries(["a", "b", "c", "d"].map((id) => [id, { enabled: true, granted: [] }])) });
    const h = harness();
    await h.host.loadAll({ safe: false });
    expect(h.host.list().map((p) => p.id)).toEqual(["a", "b", "c", "d"]);
    await expect(h.call("t3p:plugins:set-load-order", { order: ["c", "a", "not valid!"] })).rejects.toThrow(/invalid payload/);
    await expect(h.call("t3p:plugins:set-load-order", { order: ["c", "a", "zzz"] })).resolves.toEqual({ order: ["c", "a", "zzz"] });
    expect(h.host.list().map((p) => p.id)).toEqual(["c", "a", "b", "d"]);
    expect(JSON.parse(readFileSync(stateFile, "utf8")).loadOrder).toEqual(["c", "a", "zzz"]);
    // a fresh host reads loadOrder from state.json and sorts the same way
    const h2 = harness();
    await h2.host.loadAll({ safe: false });
    expect(h2.host.list().map((p) => p.id)).toEqual(["c", "a", "b", "d"]);
    await h.call("t3p:plugins:set-load-order", { order: [] });
    expect(JSON.parse(readFileSync(stateFile, "utf8")).loadOrder).toBeUndefined();
  });

  it("the CLI's later edits survive: state is re-read before every write", async () => {
    writePlugin("p1", {});
    writePlugin("p2", {});
    writeState({ plugins: {} });
    const h = harness();
    await h.host.loadAll({ safe: false });
    writeState({ plugins: { p2: { enabled: true, granted: [] } } }); // `t3p enable p2` from a terminal
    await h.call("t3p:plugins:set-enabled", { id: "p1", enabled: true });
    expect(Object.keys(JSON.parse(readFileSync(stateFile, "utf8")).plugins).sort()).toEqual(["p1", "p2"]);
  });
});

describe("dev watcher", () => {
  it("lists junctions as plugin folders (t3p dev links)", () => {
    const source = join(home, "source-plugin");
    mkdirSync(source);
    writeFileSync(join(source, "plugin.json"), "{}");
    writePlugin("real-plugin", {});
    symlinkSync(source, join(pluginsDir, "linked-plugin"), platform === "win32" ? "junction" : "dir");
    expect(listPluginDirs(pluginsDir).sort()).toEqual(["linked-plugin", "real-plugin"]);
  });

  it("emits t3p:event plugin-files-changed (debounced) and refreshes the record", () => {
    vi.useFakeTimers();
    try {
      const sent: Array<[string, unknown]> = [];
      const reloaded: string[] = [];
      const callbacks = new Map<string, (file: string | null) => void>();
      const closed: string[] = [];
      const stop = watchPluginDirs({
        pluginsDir: "P",
        router: { emit: (c: string, p: unknown) => (sent.push([c, p]), true), handle: () => () => undefined, channels: () => [] },
        host: { reloadRecord: (id) => void reloaded.push(id) },
        log: nullLogger,
        debounceMs: 100,
        listDirs: () => ["alpha", "beta", "bad id!"],
        watchDir: (dir, onChange) => {
          callbacks.set(dir, onChange);
          return { close: () => void closed.push(dir) };
        },
      });
      expect([...callbacks.keys()].sort()).toEqual([join("P", "alpha"), join("P", "beta")]);
      const alpha = callbacks.get(join("P", "alpha"))!;
      alpha("a.js");
      alpha("b.js");
      alpha(join("node_modules", "x", "y.js")); // ignored
      vi.advanceTimersByTime(99);
      expect(sent).toEqual([]);
      vi.advanceTimersByTime(2);
      expect(sent).toEqual([["t3p:event", { type: "plugin-files-changed", plugin: "alpha" }]]);
      expect(reloaded).toEqual(["alpha"]);
      stop();
      expect(closed.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells the page to reload when the runtime renderer.js changes", async () => {
    vi.useFakeTimers();
    try {
      const sent: Array<[string, unknown]> = [];
      const callbacks = new Map<string, (file: string | null) => void>();
      const stop = watchPluginDirs({
        pluginsDir: "P",
        runtimeDir: "R",
        router: { emit: (c: string, p: unknown) => (sent.push([c, p]), true), handle: () => () => undefined, channels: () => [] },
        host: { reloadRecord: () => undefined },
        log: nullLogger,
        debounceMs: 100,
        listDirs: () => [],
        watchDir: (dir, onChange) => {
          callbacks.set(dir, onChange);
          return { close: () => undefined };
        },
      });
      const r = callbacks.get("R")!;
      r("main.cjs"); // not the renderer: ignored
      r("renderer.js");
      r("renderer.js");
      await vi.advanceTimersByTimeAsync(500);
      expect(sent).toEqual([["t3p:event", { type: "runtime-renderer-changed" }]]);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("picks up a new plugin folder and a state.json change without a restart", async () => {
    vi.useFakeTimers();
    try {
      const sent: Array<[string, unknown]> = [];
      const callbacks = new Map<string, (file: string | null) => void>();
      let dirs = ["alpha"];
      let rescans = 0;
      const stop = watchPluginDirs({
        pluginsDir: "P",
        stateFile: join("H", "state.json"),
        router: { emit: (c: string, p: unknown) => (sent.push([c, p]), true), handle: () => () => undefined, channels: () => [] },
        host: { reloadRecord: () => undefined, rescan: async () => (rescans++, ["beta"]) },
        log: nullLogger,
        debounceMs: 100,
        listDirs: () => dirs,
        watchDir: (dir, onChange) => {
          callbacks.set(dir, onChange);
          return { close: () => undefined };
        },
      });
      expect([...callbacks.keys()].sort()).toEqual(["H", "P", join("P", "alpha")].sort());
      dirs = ["alpha", "beta"];
      callbacks.get("P")!("beta");
      await vi.advanceTimersByTimeAsync(400);
      expect(rescans).toBe(1);
      expect(sent).toEqual([["t3p:event", { type: "plugin-files-changed", plugin: "beta" }]]);
      expect(callbacks.has(join("P", "beta"))).toBe(true);
      callbacks.get("H")!("other.json"); // not state.json: ignored
      await vi.advanceTimersByTimeAsync(400);
      expect(rescans).toBe(1);
      callbacks.get("H")!("state.json");
      await vi.advanceTimersByTimeAsync(400);
      expect(rescans).toBe(2);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
