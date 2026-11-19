import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GRANT_REQUEST_CHANNEL, isAllowedInvokeChannel, type PermissionSet, REGISTRY_REQUEST_CHANNEL } from "@t3p/api";
import { createBridge } from "../../preload-runtime/src/bridge.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { entryFor, fakeFetch, indexOf, pluginZip, REGISTRY_URL } from "../../installer/test/registry-helpers.js";
import { registerCoreChannels } from "../src/ipc/channels.js";
import { createIpcRouter } from "../src/ipc/router.js";
import { createSenderCheck, type IpcEventLike } from "../src/ipc/sender.js";
import { nullLogger } from "../src/log.js";
import { createNativeServices } from "../src/native/index.js";
import { PatchRegistry } from "../src/patches/registry.js";
import { DialogGate } from "../src/plugins/dialog-gate.js";
import { GrantFlow, type MessageBoxOptions } from "../src/plugins/grants.js";
import { PluginHost } from "../src/plugins/host.js";
import { CANCEL_BUTTON, CONFIRM_BUTTON, installDialogOptions, RegistryFlow, REVIEW_BUTTON, uninstallDialogOptions } from "../src/plugins/registry-flow.js";
import { readStateForWrite, writeStateFile } from "../src/plugins/state-io.js";

const platform = process.platform === "win32" ? ("win32" as const) : ("posix" as const);

let home: string;
let base: string;
const pluginDir = (id = "demo") => join(base, "plugins", id);
const state = (): { plugins: Record<string, { enabled: boolean; granted: unknown[]; install?: { version: string } }> } => JSON.parse(readFileSync(join(base, "state.json"), "utf8"));

beforeEach(() => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), "t3p-regflow-")));
  base = join(home, ".t3-patcher");
  mkdirSync(join(base, "plugins"), { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

type Win = { id: number };

function world(version = "1.0.0", opts: { permissions?: unknown[]; tamper?: boolean } = {}) {
  const zip = pluginZip({ version, permissions: opts.permissions ?? ["rpc"] });
  const entry = entryFor(zip, { version, permissions: opts.permissions ?? ["rpc"] });
  const served = opts.tamper ? pluginZip({ version, permissions: opts.permissions ?? ["rpc"], manifest: { description: "evil" } }) : zip;
  return { entry, routes: { [REGISTRY_URL]: { body: JSON.stringify(indexOf(entry)) }, [entry.download.url]: { body: served } } };
}

/** Real router, host and core channels; fake native dialog and fake network. */
function harness(opts: { answer?: number; routes?: Record<string, { body: string | Buffer }>; window?: Win | null } = {}) {
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
    pluginsDir: join(base, "plugins"),
    stateFile: join(base, "state.json"),
    appVersion: "0.1.10",
    router,
    registry: new PatchRegistry(),
    nativeFor: (perms: PermissionSet) => createNativeServices(perms, { platform, home }),
    log: nullLogger,
    platform,
    activateTimeoutMs: 1000,
    load: () => ({ activate: () => undefined }),
  });
  const dialogs: MessageBoxOptions[] = [];
  let release: ((response: number) => void) | null = null;
  const dialog = {
    showMessageBox: vi.fn((_w: Win, options: MessageBoxOptions) => {
      dialogs.push(options);
      return new Promise<{ response: number }>((resolve) => {
        release = (response) => resolve({ response });
        if (opts.answer !== undefined) release(opts.answer);
      });
    }),
  };
  const win: Win | null = opts.window === undefined ? { id: 7 } : opts.window;
  const gate = new DialogGate({ cooldownMs: 0 });
  const fetch = fakeFetch(opts.routes ?? world().routes);
  const flow = new RegistryFlow<Win>({
    dialog,
    getWindow: () => win,
    gate,
    homeDir: home,
    env: { T3P_REGISTRY_URL: REGISTRY_URL },
    fetch,
    runtimeVersion: "0.1.0",
    refreshed: (id) => host.refreshInstalled(id),
    emit: (payload) => void router.emit("t3p:event", payload),
    log: nullLogger,
    refreshIntervalMs: 0,
  });
  const grants = new GrantFlow<Win>({
    dialog,
    gate,
    getWindow: () => win,
    target: (id) => host.grantTarget(id),
    readState: () => readStateForWrite(join(base, "state.json")),
    writeState: (s) => writeStateFile(join(base, "state.json"), s),
    applied: (id) => host.applyPermissionChange(id),
    emit: (payload) => void router.emit("t3p:event", payload),
    log: nullLogger,
  });
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
    setEnabled: (id, enabled) => host.setEnabled(id, enabled),
    grants,
    registry: flow,
  });
  const call = async (channel: string, payload?: unknown, event: IpcEventLike = { sender: { id: 1 }, senderFrame: frame }): Promise<unknown> => {
    const fn = handlers.get(channel);
    if (!fn) throw new Error(`No handler registered for '${channel}'`);
    return fn(event, payload);
  };
  const events = () => sent.filter(([c]) => c === "t3p:event").map(([, p]) => p as Record<string, unknown>);
  return { host, flow, dialog, dialogs, call, events, fetch, handlers, release: (r: number) => release?.(r) };
}

describe("registry dialogs", () => {
  it("name plugin, id, version, author and URLs, list permissions with risk, warn about code, default to Cancel", () => {
    const { entry } = world("1.0.0", { permissions: ["rpc", "main"] });
    const o = installDialogOptions(entry, REGISTRY_URL, null);
    expect(o.defaultId).toBe(CANCEL_BUTTON);
    expect(o.cancelId).toBe(CANCEL_BUTTON);
    expect(o.buttons).toEqual(["Cancel", "Install", "Install and review permissions"]);
    expect(o.message).toContain('"Demo demo" 1.0.0');
    for (const text of ["Plugin: Demo demo (demo) v1.0.0", "Author: Tests", "Homepage: https://example.com/demo", `Download: ${entry.download.url}`, `SHA-256: ${entry.download.sha256}`, `Registry: ${REGISTRY_URL}`]) {
      expect(o.detail).toContain(text);
    }
    expect(o.detail).toMatch(/This runs code on your PC with your user rights/);
    expect(o.detail).toMatch(/none are granted by installing/);
    expect(o.detail).toMatch(/High risk: main/);
    expect(o.detail).toMatch(/• main/);
    const u = installDialogOptions(entry, REGISTRY_URL, "0.9.0");
    expect(u.buttons[1]).toBe("Update");
    expect(u.detail).toMatch(/settings and stored data are kept/);
    const none = installDialogOptions(world("1.0.0", { permissions: [] }).entry, REGISTRY_URL, null);
    expect(none.buttons).toEqual(["Cancel", "Install"]);
    const un = uninstallDialogOptions("demo", "Demo", "1.0.0");
    expect(un.defaultId).toBe(CANCEL_BUTTON);
    expect(un.buttons).toEqual(["Cancel", "Uninstall"]);
  });
});

describe("RegistryFlow through the privileged channel", () => {
  it("Install writes the plugin disabled with no grants and tells the page", async () => {
    const h = harness({ answer: CONFIRM_BUTTON });
    await h.host.loadAll({ safe: false });
    const res = await h.call(REGISTRY_REQUEST_CHANNEL, { action: "install", id: "demo" });
    expect(res).toMatchObject({ status: "installed", plugin: "demo", version: "1.0.0", review: false });
    expect(h.dialogs).toHaveLength(1);
    expect(state().plugins.demo).toMatchObject({ enabled: false, granted: [] });
    expect(h.host.records.get("demo")?.status).toBe("disabled");
    expect(h.events().at(-1)).toMatchObject({ type: "plugin-registry-result", action: "install", status: "installed", plugin: "demo" });
  });

  it("Install and review permissions reports review", async () => {
    const h = harness({ answer: REVIEW_BUTTON });
    expect(await h.call(REGISTRY_REQUEST_CHANNEL, { action: "install", id: "demo" })).toMatchObject({ status: "installed", review: true });
    expect(state().plugins.demo).toMatchObject({ enabled: false, granted: [] });
  });

  it("Cancel, a failing dialog and no window write nothing", async () => {
    const h = harness({ answer: CANCEL_BUTTON });
    expect(await h.call(REGISTRY_REQUEST_CHANNEL, { action: "install", id: "demo" })).toMatchObject({ status: "cancelled" });
    expect(existsSync(pluginDir())).toBe(false);
    expect(h.fetch.calls.map((c) => c.url)).toEqual([REGISTRY_URL]); // the zip is never downloaded
    const n = harness({ window: null });
    expect(await n.call(REGISTRY_REQUEST_CHANNEL, { action: "install", id: "demo" })).toMatchObject({ status: "unavailable" });
    expect(n.dialogs).toHaveLength(0);
    expect(existsSync(pluginDir())).toBe(false);
  });

  it("a tampered zip is refused after confirming; nothing is installed and the page gets the error", async () => {
    const h = harness({ answer: CONFIRM_BUTTON, routes: world("1.0.0", { tamper: true }).routes });
    const res = await h.call(REGISTRY_REQUEST_CHANNEL, { action: "install", id: "demo" });
    expect(res).toMatchObject({ status: "error" });
    expect((res as { error: string }).error).toMatch(/SHA-256 mismatch|bytes, the registry says|larger than/);
    expect(existsSync(pluginDir())).toBe(false);
    expect(h.events().at(-1)).toMatchObject({ type: "plugin-registry-result", status: "error" });
  });

  it("one dialog at a time, shared with grants", async () => {
    const h = harness();
    const first = h.call(REGISTRY_REQUEST_CHANNEL, { action: "install", id: "demo" });
    await vi.waitFor(() => expect(h.dialogs).toHaveLength(1));
    expect(await h.call(REGISTRY_REQUEST_CHANNEL, { action: "install", id: "demo" })).toMatchObject({ status: "busy" });
    expect(await h.call(GRANT_REQUEST_CHANNEL, { id: "demo", permissions: "*" })).toMatchObject({ status: "busy" });
    h.release(CANCEL_BUTTON);
    expect(await first).toMatchObject({ status: "cancelled" });
    expect(h.dialogs).toHaveLength(1);
  });

  it("update keeps enabled, grants and storage; uninstall needs its own confirm", async () => {
    const h1 = harness({ answer: CONFIRM_BUTTON });
    await h1.call(REGISTRY_REQUEST_CHANNEL, { action: "install", id: "demo" });
    const st = state();
    st.plugins.demo!.enabled = true;
    st.plugins.demo!.granted = ["rpc"];
    writeFileSync(join(base, "state.json"), JSON.stringify(st));
    mkdirSync(join(base, "storage"), { recursive: true });
    writeFileSync(join(base, "storage", "demo.json"), '{"settings":{"x":1}}');

    const h2 = harness({ answer: CONFIRM_BUTTON, routes: world("1.1.0").routes });
    await h2.host.loadAll({ safe: false });
    expect(h2.host.records.get("demo")?.status).toBe("loaded");
    const view = (await h2.call("t3p:registry:index", {})) as { installed: Record<string, { version: string }> };
    expect(view.installed.demo!.version).toBe("1.0.0");
    expect(await h2.call(REGISTRY_REQUEST_CHANNEL, { action: "update", id: "demo" })).toMatchObject({ status: "updated", version: "1.1.0" });
    expect(state().plugins.demo).toMatchObject({ enabled: true, granted: ["rpc"], install: { version: "1.1.0" } });
    expect(readFileSync(join(base, "storage", "demo.json"), "utf8")).toBe('{"settings":{"x":1}}');
    expect(h2.host.list().find((p) => p.id === "demo")?.version).toBe("1.1.0");
    expect(await h2.call(REGISTRY_REQUEST_CHANNEL, { action: "update", id: "demo" })).toMatchObject({ status: "nothing" });

    const h3 = harness({ answer: CANCEL_BUTTON });
    await h3.host.loadAll({ safe: false });
    expect(await h3.call(REGISTRY_REQUEST_CHANNEL, { action: "uninstall", id: "demo" })).toMatchObject({ status: "cancelled" });
    expect(existsSync(pluginDir())).toBe(true);
    const h4 = harness({ answer: CONFIRM_BUTTON });
    await h4.host.loadAll({ safe: false });
    expect(await h4.call(REGISTRY_REQUEST_CHANNEL, { action: "uninstall", id: "demo" })).toMatchObject({ status: "uninstalled", version: "1.1.0" });
    expect(h4.dialogs[0]!.title).toMatch(/uninstall/);
    expect(existsSync(pluginDir())).toBe(false);
    expect(state().plugins.demo).toBeUndefined();
    expect(h4.host.records.has("demo")).toBe(false);
    expect(existsSync(join(base, "storage", "demo.json"))).toBe(true);
  });

  it("the index view is read-only and reports offline without a cache", async () => {
    const h = harness({ answer: CONFIRM_BUTTON });
    const view = (await h.call("t3p:registry:index", { refresh: true })) as { plugins: Array<{ id: string }>; error: string | null; offline: boolean };
    expect(view.plugins.map((p) => p.id)).toEqual(["demo"]);
    expect(view.error).toBeNull();
    expect(h.dialogs).toHaveLength(0);
    expect(existsSync(pluginDir())).toBe(false);
    const cached = harness({ routes: {} });
    expect(await cached.call("t3p:registry:index", {})).toMatchObject({ source: "cache", offline: true, plugins: [{ id: "demo" }] });
    rmSync(join(base, "cache"), { recursive: true, force: true });
    const off = harness({ routes: {} });
    expect(await off.call("t3p:registry:index", {})).toMatchObject({ plugins: [], offline: true, url: null });
    expect(((await off.call("t3p:registry:index", {})) as { error: string }).error).toMatch(/cannot reach/);
  });
});

describe("page scripts cannot install, update or uninstall", () => {
  it("the page bridge refuses the privileged channel; the index channel is the only registry channel it can reach", async () => {
    const ipc = { invoke: vi.fn(async () => true), on: vi.fn(), removeListener: vi.fn() };
    const bridge = createBridge(ipc);
    for (const action of ["install", "update", "uninstall"]) {
      await expect(bridge.invoke(REGISTRY_REQUEST_CHANNEL, { action, id: "demo" })).rejects.toThrow(/not allowed/);
    }
    expect(ipc.invoke).not.toHaveBeenCalled();
    expect(isAllowedInvokeChannel(REGISTRY_REQUEST_CHANNEL)).toBe(false);
    const h = harness({ answer: CONFIRM_BUTTON });
    const pageChannels = [...h.handlers.keys()].filter((c) => isAllowedInvokeChannel(c) && /registry/.test(c));
    expect(pageChannels).toEqual(["t3p:registry:index"]);
  });

  it("the privileged channel still runs the sender check and the schema (no page-supplied URL or hash)", async () => {
    const h = harness({ answer: CONFIRM_BUTTON });
    await expect(h.call(REGISTRY_REQUEST_CHANNEL, { action: "install", id: "demo" }, { sender: { id: 1 }, senderFrame: { url: "t3code://app/" } })).rejects.toThrow(/sender/);
    await expect(h.call(REGISTRY_REQUEST_CHANNEL, { action: "install", id: "demo" }, { sender: { id: 2 }, senderFrame: null })).rejects.toThrow(/sender/);
    await expect(h.call(REGISTRY_REQUEST_CHANNEL, { action: "install", id: "demo", url: "https://evil.example/x.zip", sha256: "0".repeat(64) })).rejects.toThrow(/url/);
    await expect(h.call(REGISTRY_REQUEST_CHANNEL, { action: "enable", id: "demo" })).rejects.toThrow(/action/);
    expect(h.dialogs).toHaveLength(0);
    expect(existsSync(pluginDir())).toBe(false);
  });
});
