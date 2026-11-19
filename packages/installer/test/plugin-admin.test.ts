import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { install } from "../src/install.js";
import { enable, grant, listPlugins, readState, revoke, safeMode } from "../src/plugin-admin.js";
import { ensureWorkerNode, findSystemNode, WORKER_NODE_DATA, WORKER_NODE_EXE } from "../src/worker-node.js";
import { createFakeInstall, createRuntimeSource, type FakeInstall, safeReadFuses } from "./fake-install.js";

const CLI = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "t3p-admin-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function cli(args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", windowsHide: true, env: { ...process.env, T3P_HOME: home } });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("state commands", () => {
  it("grant merges scopes, revoke removes, enable toggles", () => {
    grant({ homeDir: home, id: "p", permission: "main" });
    grant({ homeDir: home, id: "p", permission: "fs.read", scope: ["~/a"] });
    grant({ homeDir: home, id: "p", permission: "fs.read", scope: ["~/b"] });
    enable({ homeDir: home, id: "p", enabled: true });
    expect(readState(home).plugins.p).toEqual({ enabled: true, granted: ["main", { "fs.read": { roots: ["~/a", "~/b"] } }] });
    revoke({ homeDir: home, id: "p", permission: "fs.read" });
    enable({ homeDir: home, id: "p", enabled: false });
    expect(readState(home).plugins.p).toEqual({ enabled: false, granted: ["main"] });
  });

  it("rejects unknown permissions, scope-less roots and relative spawn paths", () => {
    expect(() => grant({ homeDir: home, id: "p", permission: "net" })).toThrow(/unknown permission/);
    expect(() => grant({ homeDir: home, id: "p", permission: "fs.read" })).toThrow();
    expect(() => grant({ homeDir: home, id: "p", permission: "spawn", scope: ["git.exe"] })).toThrow();
    expect(existsSync(join(home, ".t3-patcher", "state.json"))).toBe(false);
  });

  it("refuses to overwrite a state.json it cannot read", () => {
    mkdirSync(join(home, ".t3-patcher"));
    writeFileSync(join(home, ".t3-patcher", "state.json"), "{broken");
    expect(() => grant({ homeDir: home, id: "p", permission: "main" })).toThrow(/not valid JSON/);
    expect(readFileSync(join(home, ".t3-patcher", "state.json"), "utf8")).toBe("{broken");
  });

  it("safe writes and removes the one-shot marker", () => {
    const on = safeMode({ homeDir: home });
    expect(existsSync(on.marker)).toBe(true);
    safeMode({ homeDir: home, off: true });
    expect(existsSync(on.marker)).toBe(false);
  });

  it("lists plugins with manifest status and state", () => {
    const dir = join(home, ".t3-patcher", "plugins");
    mkdirSync(join(dir, "good"), { recursive: true });
    writeFileSync(join(dir, "good", "plugin.json"), JSON.stringify({ id: "good", version: "1.2.3", tier: 1, t3Versions: ["*"], permissions: ["main"], main: "m.cjs" }));
    mkdirSync(join(dir, "bad"));
    grant({ homeDir: home, id: "good", permission: "main" });
    enable({ homeDir: home, id: "good", enabled: true });
    const list = listPlugins(home);
    expect(list.map((p) => [p.id, p.valid, p.enabled])).toEqual([
      ["bad", false, false],
      ["good", true, true],
    ]);
  });
});

describe("cli", () => {
  it("grant/enable/plugins/safe round trip through the real CLI", () => {
    expect(cli(["grant", "test-plugin", "fs.read", "--root", "~/fsread-root"]).status).toBe(0);
    expect(cli(["grant", "test-plugin", "main"]).status).toBe(0);
    expect(cli(["enable", "test-plugin"]).status).toBe(0);
    expect(readState(home).plugins["test-plugin"]).toEqual({ enabled: true, granted: ["main", { "fs.read": { roots: ["~/fsread-root"] } }] });
    expect(cli(["grant", "test-plugin"]).status).toBe(2);
    expect(cli(["status", "extra"]).status).toBe(2);
    const bad = cli(["grant", "x", "net"]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/unknown permission/);
    expect(cli(["safe"]).stdout).toMatch(/safe mode/);
    expect(existsSync(join(home, ".t3-patcher", "safe-mode"))).toBe(true);
    expect(cli(["install", "--worker-node", "maybe"]).status).toBe(2);
  });
});

describe("repair-worker interpreter", () => {
  let tree: FakeInstall;
  beforeEach(async () => {
    tree = await createFakeInstall();
    for (const f of WORKER_NODE_DATA) writeFileSync(join(tree.installDir, f), f);
  });
  afterEach(() => tree.cleanup());

  it("finds node.exe on PATH but never inside the install dir", () => {
    const exists = (p: string) => p.endsWith("node.exe");
    expect(findSystemNode({ PATH: `C:\\App;D:\\n` }, "C:\\App", exists)).toBe(join("D:\\n", "node.exe"));
    expect(findSystemNode({ PATH: "C:\\App" }, "C:\\App", exists)).toBeNull();
  });

  it("copies the exe and its two data files when there is no system node", async () => {
    const info = { installDir: tree.installDir, exePath: tree.exePath, resourcesDir: join(tree.installDir, "resources"), version: "0.1.10", channel: "beta" as const };
    expect(ensureWorkerNode(info, tree.homeDir, { env: { PATH: "" }, platform: "win32" })).toBe("copied");
    const bin = join(tree.homeDir, ".t3-patcher", "bin");
    expect(readFileSync(join(bin, WORKER_NODE_EXE))).toEqual(readFileSync(tree.exePath));
    for (const f of WORKER_NODE_DATA) expect(existsSync(join(bin, f))).toBe(true);
    expect(ensureWorkerNode(info, tree.homeDir, { env: { PATH: "" }, platform: "win32" })).toBe("present");
    expect(ensureWorkerNode(info, tree.homeDir, { env: { PATH: process.env.PATH }, platform: "linux" })).toBe("not-windows");
  });

  it("install copies it (workerNode copy) and uninstall --purge removes it", async () => {
    const result = await install({ path: tree.installDir, homeDir: tree.homeDir, readFuses: safeReadFuses, runtimeSource: createRuntimeSource(tree.root), workerNode: "copy", platform: "win32" });
    expect(result.workerNode).toBe("copied");
    const { uninstall } = await import("../src/uninstall.js");
    await uninstall({ path: tree.installDir, homeDir: tree.homeDir, purge: true, platform: "win32" });
    expect(existsSync(join(tree.homeDir, ".t3-patcher", "bin"))).toBe(false);
  });

  it("a failed copy is a warning, not a failed install", async () => {
    rmSync(join(tree.installDir, "icudtl.dat"));
    const result = await install({ path: tree.installDir, homeDir: tree.homeDir, readFuses: safeReadFuses, runtimeSource: createRuntimeSource(tree.root), workerNode: "copy", platform: "win32" });
    expect(result.status).toBe("installed");
    expect(result.workerNode).toBe("failed");
    expect(result.warnings.join()).toMatch(/repair-worker interpreter/);
  });
});

describe("crash-loop guard in the CLI", () => {
  function tripped(): void {
    mkdirSync(join(home, ".t3-patcher", "plugins", "p"), { recursive: true });
    writeFileSync(join(home, ".t3-patcher", "plugins", "p", "plugin.json"), JSON.stringify({ id: "p", version: "1.0.0", tier: 1, t3Versions: ["*"], permissions: [], renderer: "renderer.js" }));
    writeFileSync(join(home, ".t3-patcher", "state.json"), JSON.stringify({ version: 1, plugins: { p: { enabled: false, granted: [], disabledReason: "crash-loop" } } }));
    writeFileSync(join(home, ".t3-patcher", "health.json"), JSON.stringify({ version: 1, plugins: { p: { failures: 3 } } }));
  }

  it("plugins lists the reason; enable clears reason and counter", () => {
    tripped();
    expect(listPlugins(home)[0]).toMatchObject({ id: "p", enabled: false, disabledReason: "crash-loop", failures: 3 });
    expect(cli(["plugins"]).stdout).toContain("disabled: crash-loop");
    enable({ homeDir: home, id: "p", enabled: true });
    expect(listPlugins(home)[0]).toMatchObject({ enabled: true });
    expect(listPlugins(home)[0]!.disabledReason).toBeUndefined();
    expect(JSON.parse(readFileSync(join(home, ".t3-patcher", "health.json"), "utf8")).plugins).toEqual({});
  });
});
