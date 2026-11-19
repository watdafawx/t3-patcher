import { describe, expect, it } from "vitest";

import { registerCoreChannels, schemas } from "../src/ipc/channels.js";
import { createIpcRouter, type IpcMainLike } from "../src/ipc/router.js";
import { s } from "../src/ipc/schema.js";
import { classifyMainWindow, createSenderCheck, type IpcEventLike, MainWindowTracker, preloadMatcher, type WindowLike } from "../src/ipc/sender.js";
import { nullLogger } from "../src/log.js";

function fakeWindow(id: number, url = "t3code://app/"): WindowLike & { destroyed: boolean } {
  const mainFrame = { url };
  const w = {
    destroyed: false,
    isDestroyed: () => w.destroyed,
    webContents: { id, mainFrame, isDestroyed: () => w.destroyed, sent: [] as unknown[][], send: (...a: unknown[]) => w.webContents.sent.push(a) },
  };
  return w;
}

function fakeIpcMain() {
  const handlers = new Map<string, (event: IpcEventLike, ...args: unknown[]) => unknown>();
  const ipcMain: IpcMainLike = {
    handle: (channel, fn) => {
      if (handlers.has(channel)) throw new Error("dup");
      handlers.set(channel, fn);
    },
    removeHandler: (channel) => void handlers.delete(channel),
  };
  const call = async (channel: string, event: IpcEventLike, ...args: unknown[]): Promise<unknown> => {
    const fn = handlers.get(channel);
    if (!fn) throw new Error(`No handler registered for '${channel}'`);
    return fn(event, ...args);
  };
  return { ipcMain, handlers, call };
}

describe("sender check", () => {
  const main = fakeWindow(1);
  const check = createSenderCheck(() => main);
  const ok = { sender: { id: 1 }, senderFrame: main.webContents.mainFrame };

  it("accepts the main window's main frame on t3code://app", () => {
    expect(check(ok)).toEqual({ ok: true });
  });
  it("rejects a second webContents", () => {
    expect(check({ sender: { id: 2 }, senderFrame: main.webContents.mainFrame })).toMatchObject({ ok: false, reason: "sender is not the main window" });
  });
  it("rejects a subframe (iframe) of the main window", () => {
    expect(check({ sender: { id: 1 }, senderFrame: { url: "t3code://app/" } })).toMatchObject({ ok: false, reason: "sender frame is not the main frame" });
  });
  it("rejects a missing frame", () => {
    expect(check({ sender: { id: 1 }, senderFrame: null })).toMatchObject({ ok: false });
  });
  it("rejects the main frame after it navigated to another origin", () => {
    const w = fakeWindow(1, "https://evil.example/");
    expect(createSenderCheck(() => w)({ sender: { id: 1 }, senderFrame: w.webContents.mainFrame })).toMatchObject({ ok: false, reason: expect.stringContaining("origin") });
    const dev = fakeWindow(1, "http://localhost:5173/");
    expect(createSenderCheck(() => dev)({ sender: { id: 1 }, senderFrame: dev.webContents.mainFrame }).ok).toBe(false);
  });
  it("rejects when there is no main window or it is destroyed", () => {
    expect(createSenderCheck(() => null)(ok).ok).toBe(false);
    const gone = fakeWindow(1);
    gone.destroyed = true;
    expect(createSenderCheck(() => gone)({ sender: { id: 1 }, senderFrame: gone.webContents.mainFrame }).ok).toBe(false);
  });
});

describe("main window tracker", () => {
  const isMain = preloadMatcher(["C:/App/resources/_app.asar/apps/desktop/dist-electron/preload.cjs"]);

  it("classifies by preload when Electron reports it, else by webviewTag", () => {
    expect(classifyMainWindow({ preload: "c:/app/resources/_app.asar/apps/desktop/dist-electron/preload.cjs" }, isMain)).toBe(true);
    expect(classifyMainWindow({ preload: "C:/App/resources/_app.asar/apps/desktop/dist-electron/pip-preload.cjs", webviewTag: true }, isMain)).toBe(false);
    // Electron 44: no preload key; T3 Code 0.1.10 main window is the only one with webviewTag.
    expect(classifyMainWindow({ webviewTag: true }, isMain)).toBe(true);
    expect(classifyMainWindow({ webviewTag: false }, isMain)).toBe(false);
    expect(classifyMainWindow({}, isMain)).toBe(false);
    expect(classifyMainWindow(null, isMain)).toBeNull();
  });

  it("classifies lazily, caches the answer, newest live main window wins", () => {
    const tracker = new MainWindowTracker();
    const main1 = fakeWindow(1);
    let prefs: { webviewTag?: boolean } | null = null;
    let reads = 0;
    tracker.watch(main1, () => (reads++, classifyMainWindow(prefs, isMain)));
    expect(tracker.get()).toBeNull();
    prefs = { webviewTag: true };
    expect(tracker.get()).toBe(main1);
    expect(tracker.get()).toBe(main1);
    expect(reads).toBe(2);
    tracker.watch(fakeWindow(5), () => false); // picture-in-picture
    tracker.watch(fakeWindow(6), () => {
      throw new Error("destroyed");
    });
    expect(tracker.get()).toBe(main1);
    const main2 = fakeWindow(2);
    tracker.watch(main2, () => true);
    expect(tracker.get()).toBe(main2);
    main2.destroyed = true;
    expect(tracker.get()).toBe(main1);
    main1.destroyed = true;
    expect(tracker.get()).toBeNull();
  });
});

describe("ipc router", () => {
  const main = fakeWindow(1);
  const goodEvent = { sender: { id: 1 }, senderFrame: main.webContents.mainFrame };
  const setup = () => {
    const fake = fakeIpcMain();
    const router = createIpcRouter({ ipcMain: fake.ipcMain, checkSender: createSenderCheck(() => main), getMainWindow: () => main, log: nullLogger });
    return { ...fake, router };
  };

  it("runs sender check, then schema, then the handler", async () => {
    const { router, call } = setup();
    router.handle("t3p:ping", s.object({ n: s.int() }), (p) => ({ doubled: p.n * 2 }));
    expect(await call("t3p:ping", goodEvent, { n: 2 })).toEqual({ doubled: 4 });
    await expect(call("t3p:ping", { sender: { id: 9 }, senderFrame: main.webContents.mainFrame }, { n: 2 })).rejects.toThrow("t3p: rejected (sender)");
    await expect(call("t3p:ping", goodEvent, { n: "2" })).rejects.toThrow(/invalid payload: payload.n must be an integer/);
    await expect(call("t3p:ping", goodEvent, { n: 2, extra: true })).rejects.toThrow(/payload.extra is not allowed/);
    await expect(call("t3p:ping", goodEvent, { n: 2 }, "second")).rejects.toThrow(/one payload/);
  });

  it("returns results as plain JSON", async () => {
    const { router, call } = setup();
    router.handle("t3p:plugins:list", s.none(), () => ({ set: Object.freeze({ a: [1] }), fn: () => 1, when: new Date(0), big: undefined }));
    expect(await call("t3p:plugins:list", goodEvent)).toEqual({ set: { a: [1] }, when: "1970-01-01T00:00:00.000Z" });
    router.handle("t3p:ping", s.none(), () => ({ n: BigInt(1) }));
    await expect(call("t3p:ping", goodEvent)).rejects.toThrow(/not JSON-serializable/);
  });

  it("returns a short error without a stack when a handler throws", async () => {
    const { router, call } = setup();
    router.handle("t3p:log", s.none(), () => {
      throw new Error("db exploded");
    });
    const error = (await call("t3p:log", goodEvent).catch((e: Error) => e)) as Error;
    expect(error.message).toBe("t3p: t3p:log failed: db exploded");
  });

  it("refuses non-t3p, non-allowlisted and duplicate channels and unregisters", async () => {
    const { router, handlers } = setup();
    expect(() => router.handle("desktop:get-bearer", s.none(), () => 1)).toThrow(/not allowed/);
    expect(() => router.handle("t3p:anything", s.none(), () => 1)).toThrow(/not allowed/);
    const off = router.handle("t3p:plugin:p:echo", s.json(), (p) => p);
    expect(() => router.handle("t3p:plugin:p:echo", s.json(), (p) => p)).toThrow(/already/);
    off();
    expect(handlers.has("t3p:plugin:p:echo")).toBe(false);
  });

  it("emits allowlisted events to the main window only", () => {
    const { router } = setup();
    expect(router.emit("t3p:event", { a: 1 })).toBe(true);
    expect(router.emit("desktop:secret", {})).toBe(false);
    expect((main.webContents as unknown as { sent: unknown[] }).sent).toEqual([["t3p:event", { a: 1 }]]);
  });
});

describe("core channels and permission gating", () => {
  const main = fakeWindow(1);
  const ev = { sender: { id: 1 }, senderFrame: main.webContents.mainFrame };

  it("routes native calls with the named plugin's grants only", async () => {
    const fake = fakeIpcMain();
    const router = createIpcRouter({ ipcMain: fake.ipcMain, checkSender: createSenderCheck(() => main), getMainWindow: () => main, log: nullLogger });
    const calls: unknown[] = [];
    registerCoreChannels({
      router,
      log: nullLogger,
      version: "0.1.0",
      appVersion: "0.1.10",
      safe: false,
      permissionsFor: (id) => (id === "reader" ? { "fs.read": { roots: ["C:/x"] } } : id === "plain" ? {} : null),
      nativeFor: (_id, perms) => (perms["fs.read"] ? { fsRead: (r: unknown) => (calls.push(r), { ok: true }) } : {}) as never,
      pluginsList: async () => [{ id: "async" }],
      patchReport: () => ({}),
    });
    expect(await fake.call("t3p:native:fs.read", ev, { plugin: "reader", path: "C:/x/a.txt" })).toEqual({ ok: true });
    expect(calls).toEqual([{ path: "C:/x/a.txt" }]);
    await expect(fake.call("t3p:native:fs.read", ev, { plugin: "plain", path: "C:/x/a.txt" })).rejects.toThrow(/fs.read is not granted to plain/);
    await expect(fake.call("t3p:native:fs.read", ev, { plugin: "ghost", path: "C:/x/a.txt" })).rejects.toThrow(/not loaded/);
    await expect(fake.call("t3p:native:spawn", ev, { plugin: "reader", exe: "C:/Windows/System32/cmd.exe" })).rejects.toThrow(/spawn is not granted/);
    await expect(fake.call("t3p:native:fs.read", ev, { path: "C:/x/a.txt" })).rejects.toThrow(/invalid payload/);
    expect(await fake.call("t3p:ping", ev)).toMatchObject({ pong: true, version: "0.1.0" });
    expect(await fake.call("t3p:plugins:list", ev)).toMatchObject({ version: "0.1.0", plugins: [{ id: "async" }] });
    expect(await fake.call("t3p:log", ev, { level: "info", message: "hi" })).toBe(true);
    await expect(fake.call("t3p:log", ev, { level: "fatal", message: "hi" })).rejects.toThrow(/invalid payload/);
  });

  it("schemas reject unexpected shapes", () => {
    expect(schemas.sqliteQuery({ plugin: "p", path: "C:/a.db", sql: "SELECT 1", params: [1, "a", null, true] }, "payload").ok).toBe(true);
    expect(schemas.sqliteQuery({ plugin: "p", path: "C:/a.db", sql: "SELECT 1", params: [{}] }, "payload").ok).toBe(false);
    expect(schemas.spawn({ plugin: "p", exe: "C:/a.exe", args: ["a", 1] }, "payload").ok).toBe(false);
    expect(schemas.fsRead({ plugin: "P!", path: "C:/a" }, "payload").ok).toBe(false);
    expect(s.json({ maxBytes: 10 })({ big: "x".repeat(20) }, "payload").ok).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(s.json()(cyclic, "payload").ok).toBe(false);
    expect(s.object({})(Object.create({ evil: 1 }), "payload").ok).toBe(false);
  });
});
