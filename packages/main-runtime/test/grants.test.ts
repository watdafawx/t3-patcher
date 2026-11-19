import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { GRANT_REQUEST_CHANNEL, HIGH_RISK_PERMISSIONS, isAllowedInvokeChannel, type PermissionSet } from "@t3p/api";
import { createBridge } from "../../preload-runtime/src/bridge.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerCoreChannels } from "../src/ipc/channels.js";
import { createIpcRouter } from "../src/ipc/router.js";
import { createSenderCheck, type IpcEventLike } from "../src/ipc/sender.js";
import { nullLogger } from "../src/log.js";
import { createNativeServices } from "../src/native/index.js";
import { PatchRegistry } from "../src/patches/registry.js";
import { CANCEL_BUTTON, GRANT_BUTTON, GrantFlow, grantDialogOptions, type MessageBoxOptions } from "../src/plugins/grants.js";
import { PluginHost } from "../src/plugins/host.js";
import { readStateForWrite, writeStateFile } from "../src/plugins/state-io.js";

const platform = process.platform === "win32" ? ("win32" as const) : ("posix" as const);

let home: string;
let pluginsDir: string;
let stateFile: string;

beforeEach(() => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), "t3p-grants-")));
  pluginsDir = join(home, ".t3-patcher", "plugins");
  stateFile = join(home, ".t3-patcher", "state.json");
  mkdirSync(pluginsDir, { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function writePlugin(id: string, manifest: object, files: Record<string, string> = { "r.js": "export const x = 1;" }): void {
  const dir = join(pluginsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify({ id, name: `Plugin ${id}`, version: "1.2.3", tier: 1, t3Versions: ["*"], permissions: [], renderer: "r.js", ...manifest }));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
}
function writeState(state: object): void {
  writeFileSync(stateFile, JSON.stringify({ version: 1, plugins: {}, ...state }));
}
const granted = (id: string): unknown => (JSON.parse(readFileSync(stateFile, "utf8")) as { plugins: Record<string, { granted: unknown }> }).plugins[id]?.granted;

type Win = { id: number };

/** Real router, host and core channels with a fake native dialog. `answer` decides the button. */
function harness(opts: { answer?: number; window?: Win | null; now?: () => number; cooldownMs?: number } = {}) {
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
    load: () => ({ activate: () => undefined }),
  });
  const dialogs: Array<{ window: Win; options: MessageBoxOptions }> = [];
  let release: (() => void) | null = null;
  const dialog = {
    showMessageBox: vi.fn((window: Win, options: MessageBoxOptions) => {
      dialogs.push({ window, options });
      return new Promise<{ response: number }>((resolve) => {
        release = () => resolve({ response: opts.answer ?? CANCEL_BUTTON });
        if (opts.answer !== undefined) release();
      });
    }),
  };
  const win: Win | null = opts.window === undefined ? { id: 7 } : opts.window;
  const flow = new GrantFlow<Win>({
    dialog,
    getWindow: () => win,
    target: (id) => host.grantTarget(id),
    readState: () => readStateForWrite(stateFile),
    writeState: (state) => writeStateFile(stateFile, state),
    applied: (id) => host.applyPermissionChange(id),
    emit: (payload) => void router.emit("t3p:event", payload),
    log: nullLogger,
    cooldownMs: opts.cooldownMs ?? 0,
    ...(opts.now ? { now: opts.now } : {}),
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
    grants: flow,
  });
  const call = async (channel: string, payload?: unknown, event: IpcEventLike = { sender: { id: 1 }, senderFrame: frame }): Promise<unknown> => {
    const fn = handlers.get(channel);
    if (!fn) throw new Error(`No handler registered for '${channel}'`);
    return fn(event, payload);
  };
  return { host, router, flow, dialog, dialogs, call, sent, handlers, release: () => release?.() };
}

describe("grant dialog", () => {
  it("names the plugin, id, version and each permission with its risk; Cancel is the default", () => {
    const options = grantDialogOptions(
      { id: "notes", name: "Notes", version: "1.2.3", declared: { "fs.read": { roots: ["~/.t3/caches"] }, rpc: true }, effective: {}, hasMain: false },
      ["fs.read", "rpc"],
    );
    expect(options.detail).toContain("Notes (notes) v1.2.3");
    expect(options.detail).toContain("fs.read (high risk): Read files.");
    expect(options.detail).toContain("Scope: ~/.t3/caches");
    expect(options.detail).toContain("rpc (medium risk)");
    expect(options.detail).toContain("High risk: fs.read");
    expect(options.buttons[options.defaultId]).toBe("Cancel");
    expect(options.cancelId).toBe(options.defaultId);
    expect(options.buttons[GRANT_BUTTON]).toBe("Grant 2 permissions");
    expect(options.noLink).toBe(true);
  });
});

describe("GrantFlow through the privileged channel", () => {
  it("Grant writes state.json and reloads the renderer-only plugin live", async () => {
    writePlugin("p1", { permissions: ["rpc", { "fs.read": { roots: ["~/data"] } }] });
    writeState({ plugins: { p1: { enabled: true, granted: [] } } });
    const h = harness({ answer: GRANT_BUTTON });
    await h.host.loadAll({ safe: false });
    expect(h.host.permissionsFor("p1")).toEqual({});

    const result = await h.call(GRANT_REQUEST_CHANNEL, { id: "p1", permissions: "*" });
    expect(result).toEqual({ status: "granted", plugin: "p1", changed: ["rpc", "fs.read"], restartRequired: false });
    expect(h.dialogs).toHaveLength(1);
    expect(h.dialogs[0]!.window).toEqual({ id: 7 }); // parented to the main window
    expect(granted("p1")).toEqual(["rpc", { "fs.read": { roots: ["~/data"] } }]);
    expect(h.host.permissionsFor("p1")).toEqual({ rpc: true, "fs.read": { roots: ["~/data"] } }); // live, no restart
    expect(h.sent).toContainEqual(["t3p:event", { type: "plugin-permissions-changed", plugin: "p1", status: "granted", permissions: ["rpc", "fs.read"], restartRequired: false }]);
  });

  it("Cancel (and a dialog that fails) writes nothing", async () => {
    writePlugin("p1", { permissions: ["rpc"] });
    writeState({ plugins: { p1: { enabled: true, granted: [] } } });
    const h = harness({ answer: CANCEL_BUTTON });
    await h.host.loadAll({ safe: false });
    const before = readFileSync(stateFile, "utf8");
    await expect(h.call(GRANT_REQUEST_CHANNEL, { id: "p1", permissions: ["rpc"] })).resolves.toMatchObject({ status: "cancelled" });
    expect(readFileSync(stateFile, "utf8")).toBe(before);
    expect(h.sent).toContainEqual(["t3p:event", { type: "plugin-grant-result", plugin: "p1", status: "cancelled" }]);

    h.dialog.showMessageBox.mockImplementationOnce(() => Promise.reject(new Error("no display")));
    await expect(h.call(GRANT_REQUEST_CHANNEL, { id: "p1", permissions: ["rpc"] })).resolves.toMatchObject({ status: "cancelled" });
    expect(readFileSync(stateFile, "utf8")).toBe(before);
  });

  it("shows one dialog at a time and ignores repeats while it is open", async () => {
    writePlugin("p1", { permissions: ["rpc"] });
    writeState({ plugins: { p1: { enabled: true, granted: [] } } });
    const h = harness();
    await h.host.loadAll({ safe: false });
    const first = h.call(GRANT_REQUEST_CHANNEL, { id: "p1", permissions: ["rpc"] });
    await vi.waitFor(() => expect(h.dialogs).toHaveLength(1));
    for (let i = 0; i < 5; i++) await expect(h.call(GRANT_REQUEST_CHANNEL, { id: "p1", permissions: ["rpc"] })).resolves.toMatchObject({ status: "busy" });
    expect(h.dialogs).toHaveLength(1);
    h.release();
    await expect(first).resolves.toMatchObject({ status: "cancelled" });
  });

  it("rate-limits dialogs: a repeat inside the cooldown is ignored", async () => {
    writePlugin("p1", { permissions: ["rpc"] });
    writeState({ plugins: { p1: { enabled: true, granted: [] } } });
    let t = 1000;
    const h = harness({ answer: CANCEL_BUTTON, now: () => t, cooldownMs: 1500 });
    const flow = h.flow;
    await h.host.loadAll({ safe: false });
    await expect(flow.request("p1", ["rpc"])).resolves.toMatchObject({ status: "cancelled" });
    t += 500;
    await expect(flow.request("p1", ["rpc"])).resolves.toMatchObject({ status: "busy" });
    t += 1500;
    await expect(flow.request("p1", ["rpc"])).resolves.toMatchObject({ status: "cancelled" });
    expect(h.dialogs).toHaveLength(2);
  });

  it("every high-risk permission goes through the dialog; no window means no dialog and no grant", async () => {
    const declared = ["main", "patches", "guard", "embed.youtube", { "fs.read": { roots: ["~/a"] } }, { spawn: { allow: ["C:/Tools/git.exe"] } }];
    writePlugin("hr", { permissions: declared });
    writeState({ plugins: { hr: { enabled: false, granted: [] } } });
    const none = harness({ answer: GRANT_BUTTON, window: null });
    await none.host.loadAll({ safe: false });
    await expect(none.call(GRANT_REQUEST_CHANNEL, { id: "hr", permissions: "*" })).resolves.toMatchObject({ status: "unavailable" });
    expect(none.dialogs).toHaveLength(0);
    expect(granted("hr")).toEqual([]);

    for (const name of HIGH_RISK_PERMISSIONS) {
      const h = harness({ answer: CANCEL_BUTTON });
      await h.host.loadAll({ safe: false });
      await h.call(GRANT_REQUEST_CHANNEL, { id: "hr", permissions: [name] });
      expect(h.dialogs.map((d) => d.options.detail)).toEqual([expect.stringContaining(`${name} (high risk)`)]);
    }
    expect(granted("hr")).toEqual([]);
  });

  it("refuses undeclared permissions and unknown plugins, and needs no dialog when nothing is missing", async () => {
    writePlugin("p1", { permissions: ["rpc"] });
    writeState({ plugins: { p1: { enabled: true, granted: ["rpc"] } } });
    const h = harness({ answer: GRANT_BUTTON });
    await h.host.loadAll({ safe: false });
    await expect(h.call(GRANT_REQUEST_CHANNEL, { id: "p1", permissions: ["spawn"] })).rejects.toThrow(/does not declare spawn/);
    await expect(h.call(GRANT_REQUEST_CHANNEL, { id: "ghost", permissions: "*" })).rejects.toThrow(/unknown or invalid plugin ghost/);
    await expect(h.call(GRANT_REQUEST_CHANNEL, { id: "p1", permissions: "*" })).resolves.toMatchObject({ status: "nothing" });
    await expect(h.call(GRANT_REQUEST_CHANNEL, { id: "p1", permissions: ["root"] })).rejects.toThrow(/invalid payload/);
    expect(h.dialogs).toHaveLength(0);
  });

  it("a main plugin's grant is written but needs a restart", async () => {
    writePlugin("m1", { main: "main.cjs", permissions: ["main", "patches"] }, { "main.cjs": "", "r.js": "" });
    writeState({ plugins: { m1: { enabled: true, granted: ["main"] } } });
    const h = harness({ answer: GRANT_BUTTON });
    await h.host.loadAll({ safe: false });
    await expect(h.call(GRANT_REQUEST_CHANNEL, { id: "m1", permissions: ["patches"] })).resolves.toMatchObject({ status: "granted", restartRequired: true });
    expect(granted("m1")).toEqual(["main", "patches"]);
    expect(h.host.records.get("m1")?.restartRequired).toBe(true);
  });

  it("never overwrites a state.json it cannot read (checked before the dialog)", async () => {
    writePlugin("p1", { permissions: ["rpc"] });
    writeState({ plugins: { p1: { enabled: true, granted: [] } } });
    const h = harness({ answer: GRANT_BUTTON });
    await h.host.loadAll({ safe: false });
    writeFileSync(stateFile, "{broken");
    await expect(h.call(GRANT_REQUEST_CHANNEL, { id: "p1", permissions: ["rpc"] })).rejects.toThrow(/not valid JSON/);
    expect(readFileSync(stateFile, "utf8")).toBe("{broken");
    expect(h.dialogs).toHaveLength(0);
  });
});

describe("revoke", () => {
  it("needs no dialog, writes state.json and applies live", async () => {
    writePlugin("p1", { permissions: ["rpc", { "fs.read": { roots: ["~/data"] } }] });
    writeState({ plugins: { p1: { enabled: true, granted: ["rpc", { "fs.read": { roots: ["~/data"] } }] } } });
    const h = harness({ answer: GRANT_BUTTON });
    await h.host.loadAll({ safe: false });
    await expect(h.call("t3p:plugins:revoke", { id: "p1", permissions: ["fs.read"] })).resolves.toMatchObject({ status: "revoked", changed: ["fs.read"], restartRequired: false });
    expect(h.dialogs).toHaveLength(0);
    expect(granted("p1")).toEqual(["rpc"]);
    expect(h.host.permissionsFor("p1")).toEqual({ rpc: true });
  });
});

describe("plugin code cannot trigger a grant", () => {
  it("the page bridge (the only IPC object page and plugin code can reach) refuses the channel", async () => {
    const ipc = { invoke: vi.fn(async () => true), on: vi.fn(), removeListener: vi.fn() };
    const bridge = createBridge(ipc);
    await expect(bridge.invoke(GRANT_REQUEST_CHANNEL, { id: "p1", permissions: "*" })).rejects.toThrow(/not allowed/);
    expect(ipc.invoke).not.toHaveBeenCalled();
    expect(isAllowedInvokeChannel(GRANT_REQUEST_CHANNEL)).toBe(false);
  });

  it("there is no grant channel in the page allowlist; set-enabled cannot carry a grant", async () => {
    writePlugin("p1", { permissions: ["rpc"] });
    writeState({ plugins: { p1: { enabled: false, granted: [] } } });
    const h = harness({ answer: GRANT_BUTTON });
    await h.host.loadAll({ safe: false });
    const pageChannels = [...h.handlers.keys()].filter((c) => isAllowedInvokeChannel(c));
    expect(pageChannels.some((c) => /grant/.test(c))).toBe(false);
    await expect(h.call("t3p:plugins:set-enabled", { id: "p1", enabled: true, grantRpc: true })).rejects.toThrow(/grantRpc/);
    expect(granted("p1")).toEqual([]);
  });

  it("the privileged channel still runs the sender check (subframes, other windows rejected)", async () => {
    writePlugin("p1", { permissions: ["rpc"] });
    writeState({ plugins: { p1: { enabled: true, granted: [] } } });
    const h = harness({ answer: GRANT_BUTTON });
    await h.host.loadAll({ safe: false });
    await expect(h.call(GRANT_REQUEST_CHANNEL, { id: "p1", permissions: "*" }, { sender: { id: 1 }, senderFrame: { url: "t3code://app/" } })).rejects.toThrow(/sender/);
    await expect(h.call(GRANT_REQUEST_CHANNEL, { id: "p1", permissions: "*" }, { sender: { id: 2 }, senderFrame: null })).rejects.toThrow(/sender/);
    expect(h.dialogs).toHaveLength(0);
    expect(granted("p1")).toEqual([]);
  });
});

describe("state sync with the CLI", () => {
  const cli = fileURLToPath(new URL("../../installer/dist/cli.mjs", import.meta.url));
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, T3P_HOME: home }, encoding: "utf8" });

  it.skipIf(!existsSync(cli))("a dialog grant is read back by `t3p plugins`, and a CLI grant/revoke is picked up on reload", async () => {
    writePlugin("p1", { permissions: ["rpc", { "fs.read": { roots: ["~/data"] } }] });
    writeState({ plugins: { p1: { enabled: true, granted: [] } } });
    const h = harness({ answer: GRANT_BUTTON });
    await h.host.loadAll({ safe: false });
    await h.call(GRANT_REQUEST_CHANNEL, { id: "p1", permissions: ["fs.read"] });

    const listed = run(["plugins", "--json"]);
    expect(listed.status).toBe(0);
    const entry = (JSON.parse(listed.stdout) as Array<{ id: string; granted: unknown }>).find((p) => p.id === "p1");
    expect(entry?.granted).toEqual({ "fs.read": { roots: ["~/data"] } });

    // CLI grant without --root gets the declared scope through the same grantDeclared; identical entry.
    expect(run(["revoke", "p1", "fs.read"]).status).toBe(0);
    expect(run(["grant", "p1", "fs.read"]).status).toBe(0);
    expect(run(["grant", "p1", "rpc"]).status).toBe(0);
    expect(granted("p1")).toEqual(["rpc", { "fs.read": { roots: ["~/data"] } }]);
    await h.host.applyPermissionChange("p1");
    expect(h.host.permissionsFor("p1")).toEqual({ rpc: true, "fs.read": { roots: ["~/data"] } });
  });
});
