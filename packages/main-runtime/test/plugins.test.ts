import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PermissionSet, TurnStartHandler } from "@t3p/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createIpcRouter } from "../src/ipc/router.js";
import { createSenderCheck, type IpcEventLike } from "../src/ipc/sender.js";
import { nullLogger } from "../src/log.js";
import { createNativeServices } from "../src/native/index.js";
import { PatchRegistry } from "../src/patches/registry.js";
import { PluginHost } from "../src/plugins/host.js";

const fixtures = fileURLToPath(new URL("../test-fixtures/", import.meta.url));
const platform = process.platform === "win32" ? ("win32" as const) : ("posix" as const);

let home: string;
let pluginsDir: string;
let stateFile: string;

function harness(opts: { timeoutMs?: number; appVersion?: string | null; addGuardHandler?: (plugin: string, handler: TurnStartHandler, timeoutMs?: number) => () => void } = {}) {
  const handlers = new Map<string, (event: IpcEventLike, ...args: unknown[]) => unknown>();
  const frame = { url: "t3code://app/" };
  const main = { isDestroyed: () => false, webContents: { id: 1, mainFrame: frame, isDestroyed: () => false, send: () => undefined } };
  const router = createIpcRouter({
    ipcMain: { handle: (c, fn) => void handlers.set(c, fn), removeHandler: (c) => void handlers.delete(c) },
    checkSender: createSenderCheck(() => main),
    getMainWindow: () => main,
    log: nullLogger,
  });
  const registry = new PatchRegistry();
  const host = new PluginHost({
    pluginsDir,
    stateFile,
    appVersion: opts.appVersion === undefined ? "0.1.10" : opts.appVersion,
    router,
    registry,
    nativeFor: (perms: PermissionSet) => createNativeServices(perms, { platform, home }),
    log: nullLogger,
    platform,
    activateTimeoutMs: opts.timeoutMs ?? 2000,
    ...(opts.addGuardHandler ? { addGuardHandler: opts.addGuardHandler } : {}),
  });
  const call = async (channel: string, payload?: unknown): Promise<unknown> => {
    const fn = handlers.get(channel);
    if (!fn) throw new Error(`No handler registered for '${channel}'`);
    return fn({ sender: { id: 1 }, senderFrame: frame }, payload);
  };
  return { host, handlers, registry, call };
}

function writePlugin(id: string, manifest: object, files: Record<string, string>): void {
  const dir = join(pluginsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify({ id, version: "1.0.0", tier: 1, t3Versions: ["*"], permissions: [], ...manifest }));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
}
function writeState(plugins: Record<string, { enabled: boolean; granted: unknown[] }>): void {
  writeFileSync(stateFile, JSON.stringify({ version: 1, plugins }));
}

beforeEach(() => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), "t3p-plugins-")));
  pluginsDir = join(home, ".t3-patcher", "plugins");
  stateFile = join(home, ".t3-patcher", "state.json");
  mkdirSync(pluginsDir, { recursive: true });
  mkdirSync(join(home, "fsread-root"), { recursive: true });
  writeFileSync(join(home, "fsread-root", "hello.txt"), "inside root");
  writeFileSync(join(home, "outside.txt"), "outside");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("plugin host with the WP-2 fixtures", () => {
  beforeEach(() => {
    cpSync(join(fixtures, "plugins"), pluginsDir, { recursive: true });
    cpSync(join(fixtures, "state.json"), stateFile);
  });

  it("activates the test plugin and isolates the throwing one", async () => {
    const { host, handlers, call } = harness();
    await host.loadAll({ safe: false });
    const byId = Object.fromEntries(host.list().map((p) => [p.id, p]));
    expect(byId["test-plugin"]).toMatchObject({ status: "active", rendererUrl: "t3code://app/__t3p/plugins/test-plugin/renderer.js" });
    expect(byId["throw-main"]).toMatchObject({ status: "failed", rendererUrl: null });
    expect(byId["throw-main"]!.errors.join()).toContain("activate exploded on purpose");
    expect(byId["throw-renderer"]).toMatchObject({ status: "loaded" });
    expect(byId["after-renderer"]).toMatchObject({ status: "loaded" });
    // The failed plugin's handler was removed.
    expect(handlers.has("t3p:plugin:throw-main:ghost")).toBe(false);
    expect(await call("t3p:plugin:test-plugin:echo", { x: 1 })).toEqual({ echo: { x: 1 }, from: "test-plugin", native: ["fsRead"], patches: true });
    await expect(call("t3p:plugin:test-plugin:boom")).rejects.toThrow("t3p: t3p:plugin:test-plugin:boom failed: handler exploded");
  });

  it("fs.read through ctx.native allows inside the granted root and denies outside", async () => {
    const { host, call } = harness();
    await host.loadAll({ safe: false });
    expect(await call("t3p:plugin:test-plugin:read", { path: join(home, "fsread-root", "hello.txt") })).toMatchObject({ data: "inside root" });
    await expect(call("t3p:plugin:test-plugin:read", { path: join(home, "outside.txt") })).rejects.toThrow(/denied/);
    await expect(call("t3p:plugin:test-plugin:read", { path: join(home, "fsread-root", "..", "outside.txt") })).rejects.toThrow(/denied/);
  });

  it("serves renderer dirs only for plugins whose renderer may load", async () => {
    const { host } = harness();
    await host.loadAll({ safe: false });
    expect(host.rendererDir("test-plugin")).toBe(join(pluginsDir, "test-plugin"));
    expect(host.rendererDir("throw-main")).toBeNull();
    expect(host.rendererDir("missing")).toBeNull();
  });

  it("loads nothing in safe mode", async () => {
    const { host, handlers } = harness();
    await host.loadAll({ safe: true });
    expect(host.list()).toEqual([]);
    expect(handlers.size).toBe(0);
  });
});

describe("plugin host gating", () => {
  const mainSrc = "exports.activate = (ctx) => { ctx.ipc.handle('keys', () => Object.keys(ctx).sort()); };";

  it("permission not granted = API absent; declared-but-not-granted roots are dropped", async () => {
    writePlugin("gated", { permissions: ["main", "patches", { "fs.read": { roots: ["~/fsread-root"] } }], main: "main.cjs" }, { "main.cjs": mainSrc });
    writeState({ gated: { enabled: true, granted: ["main"] } });
    const { host, call } = harness();
    await host.loadAll({ safe: false });
    expect(await call("t3p:plugin:gated:keys")).toEqual(["events", "id", "ipc", "log", "version"]);
  });

  it("granting more than declared does not widen access", async () => {
    writePlugin("narrow", { permissions: ["main", { "fs.read": { roots: ["~/fsread-root/sub"] } }], main: "main.cjs" }, { "main.cjs": mainSrc });
    writeState({ narrow: { enabled: true, granted: ["main", { "fs.read": { roots: ["~/fsread-root"] } }, "spawn"] } });
    const { host } = harness();
    await host.loadAll({ safe: false });
    expect(host.permissionsFor("narrow")).toEqual({ main: true });
  });

  it("disabled, unlisted, incompatible, invalid and ungranted-main plugins do not run", async () => {
    const marker = (id: string) => `require('fs').writeFileSync(${JSON.stringify(join(home, `${id}.ran`))}, '1'); exports.activate = () => {};`;
    writePlugin("off", { permissions: ["main"], main: "main.cjs" }, { "main.cjs": marker("off") });
    writePlugin("unlisted", { permissions: ["main"], main: "main.cjs" }, { "main.cjs": marker("unlisted") });
    writePlugin("old", { permissions: ["main"], main: "main.cjs", t3Versions: ["0.0.x"] }, { "main.cjs": marker("old") });
    writePlugin("nomain", { permissions: ["main"], main: "main.cjs" }, { "main.cjs": marker("nomain") });
    mkdirSync(join(pluginsDir, "broken"));
    writeFileSync(join(pluginsDir, "broken", "plugin.json"), "{not json");
    writePlugin("mismatch", { permissions: ["main"], main: "main.cjs" }, { "main.cjs": marker("mismatch") });
    writeFileSync(join(pluginsDir, "mismatch", "plugin.json"), JSON.stringify({ id: "other", version: "1.0.0", tier: 1, t3Versions: ["*"], permissions: ["main"], main: "main.cjs" }));
    mkdirSync(join(pluginsDir, "Bad Name"));
    writeState({
      off: { enabled: false, granted: ["main"] },
      old: { enabled: true, granted: ["main"] },
      nomain: { enabled: true, granted: [] },
      broken: { enabled: true, granted: ["main"] },
      mismatch: { enabled: true, granted: ["main"] },
    });
    const { host } = harness();
    await host.loadAll({ safe: false });
    const status = Object.fromEntries(host.list().map((p) => [p.id, p.status]));
    expect(status).toEqual({ broken: "invalid", mismatch: "invalid", nomain: "failed", off: "disabled", old: "incompatible", unlisted: "disabled" });
    const { existsSync } = await import("node:fs");
    for (const id of ["off", "unlisted", "old", "nomain", "mismatch"]) expect(existsSync(join(home, `${id}.ran`)), id).toBe(false);
  });

  it("times out a hanging activate() and unregisters its handlers and patches", async () => {
    writePlugin(
      "hang",
      { permissions: ["main", "patches"], main: "main.cjs" },
      { "main.cjs": "exports.activate = (ctx) => { ctx.ipc.handle('x', () => 1); ctx.patches.register([{ find: 'a', replacement: { match: 'a', replace: 'b' } }]); return new Promise(() => {}); };" },
    );
    writePlugin("fine", { permissions: ["main"], main: "main.cjs" }, { "main.cjs": "exports.activate = (ctx) => ctx.ipc.handle('x', () => 'fine');" });
    writeState({ hang: { enabled: true, granted: ["main", "patches"] }, fine: { enabled: true, granted: ["main"] } });
    const { host, handlers, registry, call } = harness({ timeoutMs: 100 });
    await host.loadAll({ safe: false });
    expect(host.list().find((p) => p.id === "hang")).toMatchObject({ status: "failed" });
    expect(handlers.has("t3p:plugin:hang:x")).toBe(false);
    expect(registry.size).toBe(0);
    expect(await call("t3p:plugin:fine:x")).toBe("fine");
  });

  it("offers ctx.threads.beforeStart only with the guard permission", async () => {
    const src = "exports.activate = (ctx) => { ctx.ipc.handle('has', () => typeof ctx.threads); if (ctx.threads) ctx.threads.beforeStart(() => ({ action: 'allow' }), { timeoutMs: 3000 }); };";
    writePlugin("guarded", { permissions: ["main", "guard"], main: "main.cjs" }, { "main.cjs": src });
    writePlugin("plain", { permissions: ["main", "guard"], main: "main.cjs" }, { "main.cjs": src });
    writePlugin("broken", { permissions: ["main", "guard"], main: "main.cjs" }, { "main.cjs": "exports.activate = (ctx) => { ctx.threads.beforeStart(() => undefined); throw new Error('late failure'); };" });
    writeState({ guarded: { enabled: true, granted: ["main", "guard"] }, plain: { enabled: true, granted: ["main"] }, broken: { enabled: true, granted: ["main", "guard"] } });
    const added: Array<[string, number | undefined]> = [];
    let removed = 0;
    const { host, call } = harness({
      addGuardHandler: (plugin, _handler, timeoutMs) => {
        added.push([plugin, timeoutMs]);
        return () => void removed++;
      },
    });
    await host.loadAll({ safe: false });
    expect(await call("t3p:plugin:guarded:has")).toBe("object");
    expect(await call("t3p:plugin:plain:has")).toBe("undefined");
    expect(added.map(([p]) => p).sort()).toEqual(["broken", "guarded"]);
    expect(added.find(([p]) => p === "guarded")).toEqual(["guarded", 3000]);
    // A plugin that fails after registering loses its handler.
    expect(removed).toBe(1);
  });

  it("a plugin cannot register a channel outside its namespace", async () => {
    writePlugin("sneaky", { permissions: ["main"], main: "main.cjs" }, { "main.cjs": "exports.activate = (ctx) => ctx.ipc.handle('../../t3p:ping', () => 1);" });
    writeState({ sneaky: { enabled: true, granted: ["main"] } });
    const { host, handlers } = harness();
    await host.loadAll({ safe: false });
    expect(host.list()[0]).toMatchObject({ status: "failed" });
    expect([...handlers.keys()]).toEqual([]);
  });

  it("rejects a main entry that escapes the plugin dir through a junction", async () => {
    if (platform !== "win32") return;
    const { symlinkSync } = await import("node:fs");
    const outside = join(home, "evil");
    mkdirSync(outside);
    writeFileSync(join(outside, "main.cjs"), `require('fs').writeFileSync(${JSON.stringify(join(home, "evil.ran"))}, '1'); exports.activate = () => {};`);
    writePlugin("jumper", { permissions: ["main"], main: "lib/main.cjs" }, {});
    symlinkSync(outside, join(pluginsDir, "jumper", "lib"), "junction");
    writeState({ jumper: { enabled: true, granted: ["main"] } });
    const { host } = harness();
    await host.loadAll({ safe: false });
    expect(host.list()[0]).toMatchObject({ status: "failed" });
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(home, "evil.ran"))).toBe(false);
  });

  it("garbage state.json enables nothing", async () => {
    writePlugin("p", { permissions: ["main"], main: "main.cjs" }, { "main.cjs": mainSrc });
    writeFileSync(stateFile, "{oops");
    const { host } = harness();
    await host.loadAll({ safe: false });
    expect(host.list()[0]).toMatchObject({ status: "disabled" });
  });
});
