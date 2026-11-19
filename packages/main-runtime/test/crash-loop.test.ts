import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PermissionSet } from "@t3p/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createIpcRouter } from "../src/ipc/router.js";
import { createSenderCheck } from "../src/ipc/sender.js";
import { nullLogger } from "../src/log.js";
import { createNativeServices } from "../src/native/index.js";
import { PatchRegistry } from "../src/patches/registry.js";
import { PluginHost } from "../src/plugins/host.js";

const platform = process.platform === "win32" ? ("win32" as const) : ("posix" as const);
let home: string;
let stateFile: string;
let healthFile: string;

function host(opts: { dev?: boolean; threshold?: number } = {}): PluginHost {
  const frame = { url: "t3code://app/" };
  const main = { isDestroyed: () => false, webContents: { id: 1, mainFrame: frame, isDestroyed: () => false, send: () => undefined } };
  const router = createIpcRouter({
    ipcMain: { handle: () => undefined, removeHandler: () => undefined },
    checkSender: createSenderCheck(() => main),
    getMainWindow: () => main,
    log: nullLogger,
  });
  return new PluginHost({
    pluginsDir: join(home, "plugins"),
    stateFile,
    healthFile,
    appVersion: "0.1.10",
    router,
    registry: new PatchRegistry(),
    nativeFor: (perms: PermissionSet) => createNativeServices(perms, { platform, home }),
    log: nullLogger,
    platform,
    dev: opts.dev === true,
    crashThreshold: opts.threshold ?? 3,
    load: () => {
      throw new Error("main exploded");
    },
  });
}

const state = (): { plugins: Record<string, { enabled: boolean; disabledReason?: string }> } => JSON.parse(readFileSync(stateFile, "utf8"));
const health = (): { plugins: Record<string, { failures: number }> } => JSON.parse(readFileSync(healthFile, "utf8"));

beforeEach(() => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), "t3p-crash-")));
  stateFile = join(home, "state.json");
  healthFile = join(home, "health.json");
  const dir = join(home, "plugins", "rp");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify({ id: "rp", version: "1.0.0", tier: 1, t3Versions: ["*"], permissions: [], renderer: "renderer.js" }));
  const mdir = join(home, "plugins", "mp");
  mkdirSync(mdir, { recursive: true });
  writeFileSync(join(mdir, "plugin.json"), JSON.stringify({ id: "mp", version: "1.0.0", tier: 1, t3Versions: ["*"], permissions: ["main"], main: "main.cjs" }));
  writeFileSync(join(mdir, "main.cjs"), "");
  writeFileSync(stateFile, JSON.stringify({ version: 1, plugins: { rp: { enabled: true, granted: [] }, mp: { enabled: true, granted: ["main"] } } }));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("crash-loop guard in the host", () => {
  it("disables a renderer plugin after 3 failed starts across launches, with the reason", async () => {
    for (let launch = 1; launch <= 3; launch++) {
      const h = host();
      await h.loadAll({ safe: false });
      expect(h.records.get("rp")!.status).toBe("loaded");
      expect(h.reportHealth("rp", false, "start() threw")).toBe(launch === 3);
    }
    expect(state().plugins.rp).toMatchObject({ enabled: false, disabledReason: "crash-loop" });
    const next = host();
    await next.loadAll({ safe: false });
    expect(next.list().find((p) => p.id === "rp")).toMatchObject({ status: "disabled", disabledReason: "crash-loop" });
  });

  it("a clean window resets the counter, so 2 + clean + 2 failures never trips", async () => {
    const h = host();
    await h.loadAll({ safe: false });
    h.reportHealth("rp", false);
    h.reportHealth("rp", false);
    h.reportHealth("rp", true);
    h.reportHealth("rp", false);
    h.reportHealth("rp", false);
    expect(state().plugins.rp!.enabled).toBe(true);
    expect(health().plugins.rp!.failures).toBe(2);
  });

  it("counts a main entry that fails to activate", async () => {
    for (let i = 0; i < 3; i++) await host().loadAll({ safe: false });
    expect(state().plugins.mp).toMatchObject({ enabled: false, disabledReason: "crash-loop" });
  });

  it("dev mode counts but never disables", async () => {
    const h = host({ dev: true });
    await h.loadAll({ safe: false });
    for (let i = 0; i < 5; i++) expect(h.reportHealth("rp", false)).toBe(false);
    expect(state().plugins.rp!.enabled).toBe(true);
    expect(health().plugins.rp!.failures).toBe(5);
  });

  it("honours a custom threshold", async () => {
    const h = host({ threshold: 1 });
    await h.loadAll({ safe: false });
    expect(h.reportHealth("rp", false)).toBe(true);
  });

  it("ignores unknown plugins", async () => {
    const h = host();
    await h.loadAll({ safe: false });
    expect(h.reportHealth("ghost", false)).toBe(false);
  });
});
