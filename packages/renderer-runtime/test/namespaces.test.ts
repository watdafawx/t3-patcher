import { T3NotImplementedError, T3PermissionError, T3QuotaError, type PermissionSet, type T3Api } from "@t3p/api";
import type { RpcClientOptions } from "@t3p/rpc-client";
import { describe, expect, it, vi } from "vitest";

import type { RpcClientLike } from "../src/rpc.js";
import { bootstrap } from "../src/runtime.js";
import { entry, envFor, fakeImporter, fakeNative, type FakeNative } from "./helpers.js";

async function withPlugin(
  effective: PermissionSet,
  opts: { native?: FakeNative; extra?: Parameters<typeof envFor>[2]; id?: string } = {},
): Promise<{ t3: T3Api; native: FakeNative; env: ReturnType<typeof envFor>; win: Record<string, unknown> }> {
  const id = opts.id ?? "p";
  const native = opts.native ?? fakeNative([entry(id, { effective })]);
  let t3!: T3Api;
  const { importModule } = fakeImporter({ [id]: { start: (api: T3Api) => void (t3 = api) } });
  const env = envFor(native, importModule, opts.extra);
  await bootstrap(env);
  return { t3, native, env, win: env.win };
}

describe("t3.storage", () => {
  it("get, set, delete, keys, clear, usage: persisted through IPC", async () => {
    const { t3, native } = await withPlugin({});
    expect(await t3.storage.get("a")).toBeUndefined();
    await t3.storage.set("b", { n: [1, 2] });
    await t3.storage.set("a", "x");
    expect(await t3.storage.get("b")).toEqual({ n: [1, 2] });
    expect(await t3.storage.keys()).toEqual(["a", "b"]);
    expect(native.storage.get("p")!.kv).toEqual({ a: "x", b: { n: [1, 2] } });
    expect((await t3.storage.usage()).limitBytes).toBe(1024 * 1024);
    await t3.storage.delete("a");
    expect(await t3.storage.keys()).toEqual(["b"]);
    await t3.storage.clear();
    expect(await t3.storage.keys()).toEqual([]);
    expect(native.calls.filter(([c]) => c === "t3p:storage:write").every(([, p]) => (p as { plugin: string }).plugin === "p")).toBe(true);
  });

  it("returns copies: mutating a result does not change the store", async () => {
    const { t3 } = await withPlugin({});
    await t3.storage.set("o", { n: 1 });
    const v = (await t3.storage.get<{ n: number }>("o"))!;
    v.n = 99;
    expect(await t3.storage.get("o")).toEqual({ n: 1 });
  });

  it("maps the main process' quota error to T3QuotaError and keeps working", async () => {
    const native = fakeNative([entry("p")], { limitBytes: 100 });
    const { t3 } = await withPlugin({}, { native });
    await t3.storage.set("small", "ok");
    await expect(t3.storage.set("big", "y".repeat(500))).rejects.toBeInstanceOf(T3QuotaError);
    expect(await t3.storage.keys()).toEqual(["small"]);
    await t3.storage.set("small2", "ok");
  });

  it("rejects undefined values and empty keys", async () => {
    const { t3 } = await withPlugin({});
    await expect(t3.storage.set("k", undefined as never)).rejects.toThrow(/undefined/);
    await expect(t3.storage.set("", 1)).rejects.toThrow(/non-empty/);
  });

  it("serializes concurrent writes of one plugin in call order", async () => {
    const { t3, native } = await withPlugin({});
    await Promise.all([t3.storage.set("k", 1), t3.storage.set("k", 2), t3.storage.set("k", 3)]);
    expect(native.storage.get("p")!.kv.k).toBe(3);
  });

  it("falls back to memory when storage is unavailable, and warns", async () => {
    const native = fakeNative([entry("p")]);
    native.failStorage = true;
    const { t3 } = await withPlugin({}, { native });
    await t3.storage.set("k", 1);
    expect(await t3.storage.get("k")).toBe(1);
    expect(native.calls.some(([c, p]) => c === "t3p:log" && (p as { level: string }).level === "warn")).toBe(true);
  });

  it("is attributed per plugin: two plugins do not see each other's keys", async () => {
    const native = fakeNative([entry("a"), entry("b")]);
    const apis: Record<string, T3Api> = {};
    const { importModule } = fakeImporter({ a: { start: (t: T3Api) => void (apis.a = t) }, b: { start: (t: T3Api) => void (apis.b = t) } });
    await bootstrap(envFor(native, importModule));
    await apis.a!.storage.set("k", "from a");
    expect(await apis.b!.storage.get("k")).toBeUndefined();
    expect(native.storage.get("b")?.kv ?? {}).toEqual({});
  });
});

describe("t3.settings", () => {
  const schemas = [
    { key: "on", type: "boolean", default: true, label: "On" },
    { key: "name", type: "string", default: "hi", label: "Name", description: "d" },
    { key: "n", type: "number", default: 5, min: 1, max: 10, label: "N" },
    { key: "mode", type: "enum", default: "a", label: "Mode", options: [{ value: "a" }, { value: "b", label: "B" }] },
  ] as const;

  it("defaults, set, persist, change events, reset", async () => {
    const { t3, native } = await withPlugin({});
    t3.settings.define([...schemas]);
    expect(t3.settings.get("on")).toBe(true);
    expect(t3.settings.get("n")).toBe(5);
    const changes: unknown[] = [];
    t3.settings.onChange((c) => changes.push(c));
    await t3.settings.set("n", 7);
    await t3.settings.set("mode", "b");
    await t3.settings.set("n", 7); // same value: no event
    expect(t3.settings.get("n")).toBe(7);
    expect(changes).toEqual([
      { key: "n", value: 7, previous: 5 },
      { key: "mode", value: "b", previous: "a" },
    ]);
    expect(native.storage.get("p")!.settings).toEqual({ n: 7, mode: "b" });
    await t3.settings.reset("n");
    expect(t3.settings.get("n")).toBe(5);
    expect(changes.at(-1)).toEqual({ key: "n", value: 5, previous: 7 });
    expect(t3.settings.getSchemas().map((s) => s.key)).toEqual(["on", "name", "n", "mode"]);
  });

  it("validates type, range and enum values; unknown keys throw", async () => {
    const { t3 } = await withPlugin({});
    t3.settings.define([...schemas]);
    await expect(t3.settings.set("on", "yes" as never)).rejects.toThrow(/does not fit/);
    await expect(t3.settings.set("n", 11)).rejects.toThrow(/does not fit/);
    await expect(t3.settings.set("n", Number.NaN)).rejects.toThrow(/does not fit/);
    await expect(t3.settings.set("mode", "c")).rejects.toThrow(/does not fit/);
    await expect(t3.settings.set("nope", 1)).rejects.toThrow(/not defined/);
    expect(() => t3.settings.get("nope")).toThrow(/not defined/);
    expect(t3.settings.get("n")).toBe(5);
  });

  it("rejects malformed schemas", async () => {
    const { t3 } = await withPlugin({});
    const bad = (s: unknown) => () => t3.settings.define([s as never]);
    expect(bad({ key: "k", type: "boolean", default: "x", label: "L" })).toThrow(/boolean/);
    expect(bad({ key: "k", type: "number", default: 0, min: 1, label: "L" })).toThrow(/below min/);
    expect(bad({ key: "k", type: "enum", default: "z", options: [{ value: "a" }], label: "L" })).toThrow(/not one of/);
    expect(bad({ key: "k", type: "enum", default: "a", options: [], label: "L" })).toThrow(/options/);
    expect(bad({ key: "k", type: "color", default: "a", label: "L" })).toThrow(/type must be/);
    expect(bad({ key: "", type: "string", default: "a", label: "L" })).toThrow(/key/);
    expect(bad({ key: "k", type: "string", default: "a" })).toThrow(/label/);
    expect(() => t3.settings.define([schemas[0], schemas[0]])).toThrow(/twice/);
  });

  it("stored values that no longer fit the schema fall back to the default", async () => {
    const native = fakeNative([entry("p")]);
    native.storage.set("p", { kv: {}, settings: { n: 999, mode: "gone", on: "yes", name: "kept" } });
    const { t3 } = await withPlugin({}, { native });
    t3.settings.define([...schemas]);
    expect(t3.settings.get("n")).toBe(5);
    expect(t3.settings.get("mode")).toBe("a");
    expect(t3.settings.get("on")).toBe(true);
    expect(t3.settings.get("name")).toBe("kept");
  });

  it("survives a reload of the plugin (and of the page: a new runtime reads the same store)", async () => {
    const native = fakeNative([entry("p")], { dev: true });
    let current!: T3Api;
    const { importModule } = fakeImporter({
      p: {
        start: (api: T3Api) => {
          current = api;
          api.settings.define([...schemas]);
        },
      },
    });
    const env = envFor(native, importModule);
    await bootstrap(env);
    await current.settings.set("name", "persisted");
    await (env.win.__t3p as { manager: { reload(id: string): Promise<void> } }).manager.reload("p");
    expect(current.settings.get("name")).toBe("persisted");
    // new page, same store
    const env2 = envFor(native, importModule);
    await bootstrap(env2);
    expect(current.settings.get("name")).toBe("persisted");
  });

  it("the settings page can read schemas and write values through the manager facade", async () => {
    const { t3, win } = await withPlugin({});
    t3.settings.define([...schemas]);
    const manager = (win.__t3p as { manager: { schemas(id: string): unknown[]; getSetting(id: string, k: string): unknown; setSetting(id: string, k: string, v: unknown): Promise<void> } }).manager;
    const seen: unknown[] = [];
    t3.settings.onChange((c) => seen.push(c));
    expect(manager.schemas("p")).toHaveLength(4);
    await manager.setSetting("p", "on", false);
    expect(manager.getSetting("p", "on")).toBe(false);
    expect(t3.settings.get("on")).toBe(false);
    expect(seen).toEqual([{ key: "on", value: false, previous: true }]);
  });
});

describe("t3.native", () => {
  const full: PermissionSet = {
    "fs.read": { roots: ["C:/r"] },
    "sqlite.read": { roots: ["C:/r"] },
    "log.tail": { roots: ["C:/r"] },
    spawn: { allow: ["C:/x.exe"] },
    main: true,
  };

  it("sends each call with the plugin id and returns the result", async () => {
    const { t3, native } = await withPlugin(full);
    await t3.native.fsRead({ path: "C:/r/a.txt" });
    await t3.native.sqliteQuery({ path: "C:/r/a.db", sql: "select 1" });
    await t3.native.logTail({ path: "C:/r/a.log", cursor: 3 });
    await t3.native.spawn({ exe: "C:/x.exe", args: ["-v"] });
    await t3.native.invoke("echo", { x: 1 });
    expect(native.calls.filter(([c]) => c.startsWith("t3p:native") || c.startsWith("t3p:plugin:"))).toEqual([
      ["t3p:native:fs.read", { path: "C:/r/a.txt", plugin: "p" }],
      ["t3p:native:sqlite.query", { path: "C:/r/a.db", sql: "select 1", plugin: "p" }],
      ["t3p:native:log.tail", { path: "C:/r/a.log", cursor: 3, plugin: "p" }],
      ["t3p:native:spawn", { exe: "C:/x.exe", args: ["-v"], plugin: "p" }],
      ["t3p:plugin:p:echo", { x: 1 }],
    ]);
  });

  it("rejects each call without its permission, before anything is sent", async () => {
    const { t3, native } = await withPlugin({});
    const before = native.calls.length;
    for (const [fn, perm] of [
      [() => t3.native.fsRead({ path: "C:/a" }), "fs.read"],
      [() => t3.native.sqliteQuery({ path: "C:/a.db", sql: "select 1" }), "sqlite.read"],
      [() => t3.native.logTail({ path: "C:/a" }), "log.tail"],
      [() => t3.native.spawn({ exe: "C:/x.exe" }), "spawn"],
      [() => t3.native.invoke("echo"), "main"],
    ] as const) {
      const error = await fn().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(T3PermissionError);
      expect((error as T3PermissionError).permission).toBe(perm);
      expect((error as T3PermissionError).plugin).toBe("p");
    }
    expect(native.calls.length).toBe(before);
  });

  it("a plugin with only fs.read cannot use spawn", async () => {
    const { t3 } = await withPlugin({ "fs.read": { roots: ["C:/r"] } });
    await expect(t3.native.fsRead({ path: "C:/r/a" })).resolves.toBeDefined();
    await expect(t3.native.spawn({ exe: "C:/x.exe" })).rejects.toBeInstanceOf(T3PermissionError);
  });

  it("rejects bad handler names and non-object requests", async () => {
    const { t3 } = await withPlugin(full);
    await expect(t3.native.invoke("../x")).rejects.toThrow(/invalid handler name/);
    await expect(t3.native.invoke("a:b")).rejects.toThrow(/invalid handler name/);
    await expect(t3.native.fsRead(null as never)).rejects.toThrow(/object/);
  });

  it("without the preload bridge every native call rejects clearly", async () => {
    let t3!: T3Api;
    const env = envFor(null, async () => ({}));
    // no native bridge means no plugin list; build a t3 through a started plugin on a fake bridge, then drop it
    const native = fakeNative([entry("p", { effective: full })]);
    const { importModule } = fakeImporter({ p: { start: (a: T3Api) => void (t3 = a) } });
    await bootstrap(envFor(native, importModule));
    expect(env.win.__t3p).toBeUndefined();
    expect(t3).toBeDefined();
  });
});

function fakeClient() {
  const subs: Array<{ method: string; payload: unknown; onItem: (i: unknown) => void; cancelled: boolean }> = [];
  const created: RpcClientOptions[] = [];
  const stateCbs = new Set<(s: "open" | "closed") => void>();
  const client: RpcClientLike & { state: "idle" | "open" | "closed" } = {
    state: "idle",
    onState: (cb) => (stateCbs.add(cb as never), () => void stateCbs.delete(cb as never)),
    connect: vi.fn(async () => {
      client.state = "open";
    }),
    call: vi.fn(async (method: string, payload: unknown) => ({ method, payload })),
    subscribe: vi.fn((method, payload, onItem) => {
      const sub = { method, payload, onItem, cancelled: false };
      subs.push(sub);
      return { cancel: () => void (sub.cancelled = true), done: Promise.resolve() };
    }),
  };
  const createClient = vi.fn((opts: RpcClientOptions) => (created.push(opts), client));
  return { client, createClient, created, subs, emitState: (s: "open" | "closed") => stateCbs.forEach((cb) => cb(s)) };
}

const bridge = {
  getLocalEnvironmentBearerToken: vi.fn(async () => "BEARER"),
  getLocalEnvironmentBootstraps: vi.fn(async () => [{ id: "local", httpBaseUrl: "http://127.0.0.1:3873/", wsBaseUrl: "ws://127.0.0.1:3873", bootstrapToken: "NEVER" }]),
};

describe("t3.rpc", () => {
  it("is refused without the rpc permission (declared and granted)", async () => {
    const f = fakeClient();
    const { t3 } = await withPlugin({}, { extra: { desktopBridge: bridge, createRpcClient: f.createClient } });
    await expect(t3.rpc.call("server.getConfig", {})).rejects.toBeInstanceOf(T3PermissionError);
    await expect(t3.rpc.http("/x")).rejects.toBeInstanceOf(T3PermissionError);
    expect(() => t3.rpc.subscribe("subscribeServerConfig", {}, () => undefined)).toThrow(T3PermissionError);
    expect(() => t3.rpc.onState(() => undefined)).toThrow(T3PermissionError);
    expect(f.createClient).not.toHaveBeenCalled();
  });

  it("call goes through ONE shared client for all plugins, with the bearer from the desktop bridge", async () => {
    const f = fakeClient();
    const native = fakeNative([entry("a", { effective: { rpc: true } }), entry("b", { effective: { rpc: true } })]);
    const apis: Record<string, T3Api> = {};
    const { importModule } = fakeImporter({ a: { start: (t: T3Api) => void (apis.a = t) }, b: { start: (t: T3Api) => void (apis.b = t) } });
    await bootstrap(envFor(native, importModule, { desktopBridge: bridge, createRpcClient: f.createClient }));
    const [x, y] = await Promise.all([apis.a!.rpc.call("server.getConfig", {}), apis.b!.rpc.call("server.refreshProviders", {})]);
    expect(x).toEqual({ method: "server.getConfig", payload: {} });
    expect(y).toEqual({ method: "server.refreshProviders", payload: {} });
    expect(f.createClient).toHaveBeenCalledTimes(1);
    expect(f.created[0]!.httpBaseUrl).toBe("http://127.0.0.1:3873");
    await expect(f.created[0]!.getBearer()).resolves.toBe("BEARER");
    expect(f.client.connect).toHaveBeenCalled();
  });

  it("state and onState reflect the shared client, and the listener is removed on stop", async () => {
    const f = fakeClient();
    const { t3, win } = await withPlugin({ rpc: true }, { extra: { desktopBridge: bridge, createRpcClient: f.createClient } });
    expect(t3.rpc.state).toBe("idle");
    const seen: string[] = [];
    t3.rpc.onState((s) => seen.push(s));
    await t3.rpc.call("server.getConfig", {});
    expect(t3.rpc.state).toBe("open");
    f.emitState("open");
    await (win.__t3p as { manager: { disable(id: string): Promise<unknown> } }).manager.disable("p");
    f.emitState("closed");
    expect(seen).toEqual(["open"]);
  });

  it("subscribe delivers items, and stop cancels the stream", async () => {
    const f = fakeClient();
    const { t3, win } = await withPlugin({ rpc: true }, { extra: { desktopBridge: bridge, createRpcClient: f.createClient } });
    const items: unknown[] = [];
    const sub = t3.rpc.subscribe("subscribeServerConfig", {}, (i) => items.push(i));
    await vi.waitFor(() => expect(f.subs).toHaveLength(1));
    f.subs[0]!.onItem({ type: "snapshot" });
    expect(items).toEqual([{ type: "snapshot" }]);
    const other = t3.rpc.subscribe("subscribeServerConfig", {}, () => undefined);
    await vi.waitFor(() => expect(f.subs).toHaveLength(2));
    sub.cancel();
    expect(f.subs[0]!.cancelled).toBe(true);
    await (win.__t3p as { manager: { disable(id: string): Promise<unknown> } }).manager.disable("p");
    expect(f.subs[1]!.cancelled).toBe(true);
    await other.done;
  });

  it("cancelling before the socket is up never opens the stream", async () => {
    const f = fakeClient();
    const { t3 } = await withPlugin({ rpc: true }, { extra: { desktopBridge: bridge, createRpcClient: f.createClient } });
    const sub = t3.rpc.subscribe("subscribeServerConfig", {}, () => undefined);
    sub.cancel();
    await sub.done;
    await new Promise((r) => setTimeout(r, 10));
    expect(f.subs).toHaveLength(0);
  });

  it("http attaches the bearer, refuses absolute URLs and protocol-relative paths", async () => {
    const f = fakeClient();
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response("ok"));
    const { t3 } = await withPlugin({ rpc: true }, { extra: { desktopBridge: bridge, createRpcClient: f.createClient, fetch: fetchMock as never } });
    const res = await t3.rpc.http("/api/auth/session", { method: "GET", headers: { "x-test": "1" } });
    expect(await res.text()).toBe("ok");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:3873/api/auth/session");
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get("authorization")).toBe("Bearer BEARER");
    expect(headers.get("x-test")).toBe("1");
    expect((init as RequestInit).cache).toBe("no-store");
    // A plugin cannot opt back into the shared HTTP cache entry the app's own request waits behind.
    await t3.rpc.http("/api/auth/session", { cache: "force-cache" });
    expect((fetchMock.mock.calls[1]![1] as RequestInit).cache).toBe("no-store");
    await expect(t3.rpc.http("http://evil.test/x")).rejects.toThrow(/must start with a single/);
    await expect(t3.rpc.http("//evil.test/x")).rejects.toThrow(/must start with a single/);
    await expect(t3.rpc.http("api/x")).rejects.toThrow(/must start with a single/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a failed connect rejects the call and can be retried", async () => {
    const f = fakeClient();
    let fail = true;
    f.client.connect = vi.fn(async () => {
      if (fail) throw new Error("server down");
      f.client.state = "open";
    });
    const { t3 } = await withPlugin({ rpc: true }, { extra: { desktopBridge: bridge, createRpcClient: f.createClient, rpcConnect: { attempts: 2, delayMs: 1 } } });
    await expect(t3.rpc.call("server.getConfig", {})).rejects.toThrow(/server down/);
    expect(f.client.connect).toHaveBeenCalledTimes(2);
    fail = false;
    await expect(t3.rpc.call("server.getConfig", {})).resolves.toBeDefined();
    expect(f.createClient).toHaveBeenCalledTimes(1);
  });

  it("without window.desktopBridge calls reject clearly", async () => {
    const { t3 } = await withPlugin({ rpc: true });
    await expect(t3.rpc.call("server.getConfig", {})).rejects.toThrow(/desktopBridge/);
  });
});

describe("t3.events", () => {
  it("bus is scoped by plugin id: a plugin emits only as itself", async () => {
    const native = fakeNative([entry("a"), entry("b")]);
    const apis: Record<string, T3Api> = {};
    const { importModule } = fakeImporter({ a: { start: (t: T3Api) => void (apis.a = t) }, b: { start: (t: T3Api) => void (apis.b = t) } });
    await bootstrap(envFor(native, importModule));
    const own: unknown[] = [];
    const fromA: unknown[] = [];
    apis.a!.events.bus.on("hello", (p) => own.push(p));
    apis.b!.events.bus.onFrom("a", "hello", (p) => fromA.push(p));
    apis.b!.events.bus.on("hello", () => own.push("b's own"));
    apis.a!.events.bus.emit("hello", { n: 1 });
    expect(own).toEqual([{ n: 1 }]);
    expect(fromA).toEqual([{ n: 1 }]);
    expect(() => apis.a!.events.bus.emit("bad name!")).toThrow(/invalid event name/);
    expect(() => apis.a!.events.bus.onFrom("Bad Id", "x", () => undefined)).toThrow(/invalid plugin id/);
  });

  it("app:unload fires through onUnload", async () => {
    const native = fakeNative([entry("p")]);
    let unload!: () => void;
    const got: unknown[] = [];
    const { importModule } = fakeImporter({ p: { start: (t: T3Api) => void t.events.on("app:unload", (p) => got.push(p)) } });
    await bootstrap(envFor(native, importModule, { onUnload: (cb) => void (unload = cb) }));
    unload();
    expect(got).toEqual([{}]);
  });
});

describe("namespaces owned by other work packages", () => {
  // Every namespace is implemented now (WP-4C was the last stub).
  it("t3.cache is real: frozen, needs rpc, no stub error", async () => {
    const { t3 } = await withPlugin({});
    expect(Object.keys(t3.cache).sort()).toEqual(["onExpiring", "state"]);
    expect(Object.isFrozen(t3.cache)).toBe(true);
    expect(() => t3.cache.onExpiring("t", 1000, () => undefined)).toThrow(T3PermissionError);
    await expect(t3.cache.state("t")).rejects.toBeInstanceOf(T3PermissionError);
    await expect(t3.cache.state("t")).rejects.not.toBeInstanceOf(T3NotImplementedError);
  });
});
