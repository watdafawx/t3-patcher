import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { install } from "../src/install.js";
import { buildWrapper, ensureLogonTask, removeLogonTask } from "../src/logon-task.js";
import { repairRecorded } from "../src/repair.js";
import { status } from "../src/status.js";
import { createFakeInstall, createRuntimeSource, safeReadFuses, simulateUpstreamUpdate, type FakeInstall } from "./fake-install.js";

let tree: FakeInstall;
beforeEach(async () => {
  tree = await createFakeInstall();
});
afterEach(() => tree.cleanup());

function bundle(): string {
  const f = join(tree.root, "t3p.cjs");
  writeFileSync(f, "// bundle\n");
  return f;
}

describe("logon task", () => {
  it("registers a per-user ONLOGON task that runs a wrapper outside the install dir", () => {
    const calls: string[][] = [];
    const nodeDir = join(tree.root, "nodebin");
    mkdirSync(nodeDir);
    writeFileSync(join(nodeDir, "node.exe"), "");
    const r = ensureLogonTask({
      homeDir: tree.homeDir,
      selfPath: bundle(),
      installDir: tree.installDir,
      platform: "win32",
      env: { PATH: nodeDir, T3P_HOME: tree.homeDir, T3P_TASK_NAME: "t-test" },
      schtasks: (a) => (calls.push(a), { status: 0, stderr: "" }),
    });
    expect(r).toBe("registered");
    expect(calls[0]).toEqual(expect.arrayContaining(["/Create", "/SC", "ONLOGON", "/F"]));
    expect(calls[0][calls[0].indexOf("/TN") + 1]).toBe("t-test");
    const wrapper = join(tree.homeDir, ".t3-patcher", "repair-logon.cmd");
    const text = readFileSync(wrapper, "utf8");
    expect(text).toContain(`set "T3P_HOME=${tree.homeDir}"`);
    expect(text).toContain("repair --if-stale");
    expect(text).not.toContain(tree.installDir);
    expect(existsSync(join(tree.homeDir, ".t3-patcher", "t3p.cjs"))).toBe(true);
  });

  it("uses the Electron copy with RUN_AS_NODE and NO_ASAR when no node is on PATH", () => {
    const bin = join(tree.homeDir, ".t3-patcher", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "t3p-node.exe"), "");
    const r = ensureLogonTask({ homeDir: tree.homeDir, selfPath: bundle(), platform: "win32", env: { PATH: "" }, schtasks: () => ({ status: 0, stderr: "" }) });
    expect(r).toBe("registered");
    const text = readFileSync(join(tree.homeDir, ".t3-patcher", "repair-logon.cmd"), "utf8");
    expect(text).toContain("ELECTRON_RUN_AS_NODE=1");
    expect(text).toContain("ELECTRON_NO_ASAR=1");
  });

  it("skips off Windows, without a bundle, or without an interpreter; reports schtasks failure", () => {
    const ok = () => ({ status: 0, stderr: "" });
    expect(ensureLogonTask({ homeDir: tree.homeDir, platform: "linux", schtasks: ok })).toBe("skipped-not-windows");
    expect(ensureLogonTask({ homeDir: tree.homeDir, selfPath: "x.js", platform: "win32", schtasks: ok })).toBe("skipped-not-bundle");
    expect(ensureLogonTask({ homeDir: tree.homeDir, selfPath: bundle(), platform: "win32", env: { PATH: "" }, schtasks: ok })).toBe("skipped-no-interpreter");
    const nodeDir = join(tree.root, "n2");
    mkdirSync(nodeDir);
    writeFileSync(join(nodeDir, "node.exe"), "");
    expect(ensureLogonTask({ homeDir: tree.homeDir, selfPath: bundle(), platform: "win32", env: { PATH: nodeDir }, schtasks: () => ({ status: 1, stderr: "denied" }) })).toBe("failed");
  });

  it("removes the task and its files", () => {
    const nodeDir = join(tree.root, "n3");
    mkdirSync(nodeDir);
    writeFileSync(join(nodeDir, "node.exe"), "");
    const calls: string[][] = [];
    const sch = (a: string[]) => (calls.push(a), { status: 0, stderr: "" });
    ensureLogonTask({ homeDir: tree.homeDir, selfPath: bundle(), platform: "win32", env: { PATH: nodeDir }, schtasks: sch });
    expect(removeLogonTask({ homeDir: tree.homeDir, platform: "win32", schtasks: sch })).toBe("removed");
    expect(calls.at(-1)).toContain("/Delete");
    expect(existsSync(join(tree.homeDir, ".t3-patcher", "repair-logon.cmd"))).toBe(false);
  });

  it("buildWrapper omits T3P_HOME when it was not overridden", () => {
    const t = buildWrapper({ home: "H", bundle: "B", logFile: "L", node: { exe: "N", electron: false }, hasHomeOverride: false });
    expect(t).not.toContain("T3P_HOME");
  });
});

describe("repairRecorded (logon task entry)", () => {
  it("repairs a stale recorded install without a path, and is a no-op when patched", async () => {
    const runtimeSource = createRuntimeSource(tree.root);
    const base = { homeDir: tree.homeDir, readFuses: safeReadFuses, ifStale: true };
    expect(await repairRecorded(base)).toBeNull();
    await install({ ...base, path: tree.installDir, runtimeSource });
    expect((await repairRecorded(base))?.[0].result).toBe("noop");
    await simulateUpstreamUpdate(tree, { version: "0.1.11" });
    const out = await repairRecorded(base);
    expect(out?.[0].error).toBeUndefined();
    expect(out?.[0].result).not.toBe("noop");
    expect((await status({ path: tree.installDir, homeDir: tree.homeDir })).layout).toBe("patched");
  });
});
