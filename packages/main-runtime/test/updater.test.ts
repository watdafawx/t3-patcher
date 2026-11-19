import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { nullLogger } from "../src/log.js";
import { chooseWorkerNode, installUpdaterHook, spawnRepairWorker, type UpdaterHookDeps } from "../src/updater/hook.js";
import { type LayoutState, runRepairLoop, type WorkerDeps } from "../src/updater/worker-core.js";

function hookDeps(over: Partial<UpdaterHookDeps> = {}) {
  const spawned: Array<{ exe: string; args: string[]; options: Record<string, unknown> }> = [];
  const child = { on: vi.fn(), unref: vi.fn() };
  const deps: UpdaterHookDeps = {
    autoUpdater: new EventEmitter(),
    log: nullLogger,
    env: { PATH: "C:\\Users\\me\\AppData\\Local\\Programs\\T3 Code (Beta);C:\\Program Files\\nodejs", SECRET: "x", ELECTRON_RUN_AS_NODE: "1" },
    installDir: "C:\\Users\\me\\AppData\\Local\\Programs\\T3 Code (Beta)",
    binDir: "C:\\Users\\me\\.t3-patcher\\bin",
    workerFile: "C:\\Users\\me\\.t3-patcher\\runtime\\repair-worker.cjs",
    home: "C:\\Users\\me",
    pid: 4242,
    exists: (p) => p.endsWith("repair-worker.cjs") || p.toLowerCase().endsWith("node.exe"),
    spawnImpl: ((exe: string, args: string[], options: Record<string, unknown>) => {
      spawned.push({ exe, args, options });
      return child;
    }) as never,
    ...over,
  };
  return { deps, spawned, child };
}

describe("updater hook", () => {
  it("spawns a detached worker on before-quit-for-update, never from the install dir", () => {
    const { deps, spawned, child } = hookDeps();
    installUpdaterHook(deps);
    expect(spawned).toHaveLength(0);
    (deps.autoUpdater as EventEmitter).emit("before-quit-for-update");
    expect(spawned).toHaveLength(1);
    const [s] = spawned;
    expect(s!.exe).toBe("C:\\Program Files\\nodejs\\node.exe");
    expect(s!.args).toEqual([deps.workerFile, "--install-dir", deps.installDir, "--pid", "4242"]);
    expect(s!.options).toMatchObject({ detached: true, stdio: "ignore", windowsHide: true });
    const env = s!.options.env as Record<string, string>;
    expect(env.T3P_HOME).toBe("C:\\Users\\me");
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.ELECTRON_NO_ASAR).toBeUndefined();
    expect(child.unref).toHaveBeenCalled();
    // once: a second emit does nothing
    (deps.autoUpdater as EventEmitter).emit("before-quit-for-update");
    expect(spawned).toHaveLength(1);
  });

  it("falls back to the Electron copy with ELECTRON_RUN_AS_NODE=1", () => {
    const { deps, spawned } = hookDeps({ env: { PATH: "C:\\Windows" }, exists: (p) => p.endsWith("repair-worker.cjs") || p.endsWith("t3p-node.exe") });
    expect(spawnRepairWorker(deps)).toBe(true);
    expect(spawned[0]!.exe).toBe("C:\\Users\\me\\.t3-patcher\\bin\\t3p-node.exe");
    expect((spawned[0]!.options.env as Record<string, string>).ELECTRON_RUN_AS_NODE).toBe("1");
    expect((spawned[0]!.options.env as Record<string, string>).ELECTRON_NO_ASAR).toBe("1");
  });

  it("does nothing (and does not throw) without a node or a worker file", () => {
    const none = hookDeps({ exists: (p) => p.endsWith("repair-worker.cjs") });
    expect(spawnRepairWorker({ ...none.deps, env: { PATH: "" } })).toBe(false);
    const noWorker = hookDeps({ exists: () => false });
    expect(spawnRepairWorker(noWorker.deps)).toBe(false);
    const throwing = hookDeps({ spawnImpl: (() => { throw new Error("EACCES"); }) as never });
    expect(spawnRepairWorker(throwing.deps)).toBe(false);
  });

  it("chooseWorkerNode skips node.exe inside the install dir", () => {
    const pick = chooseWorkerNode({ env: { PATH: "C:\\App;D:\\node" }, binDir: "C:\\bin", installDir: "C:\\App", exists: () => true });
    expect(pick).toEqual({ exe: "D:\\node\\node.exe", electron: false });
  });
});

function fakeWorld(script: Array<{ state: LayoutState; fp: string | null }>, repairs: Array<"repaired" | "noop" | "busy">) {
  let t = 0;
  let step = 0;
  let alive = 3;
  const repairCalls: number[] = [];
  const deps: WorkerDeps = {
    log: nullLogger,
    pidAlive: () => alive-- > 0,
    layout: async () => {
      const s = script[Math.min(step, script.length - 1)]!;
      step++;
      return { state: s.state, fingerprint: s.fp };
    },
    repair: async () => {
      repairCalls.push(t);
      return repairs.shift() ?? "busy";
    },
    sleep: async (ms) => void (t += ms),
    now: () => t,
  };
  return { deps, repairCalls };
}

describe("repair worker loop", () => {
  const opts = { pid: 1, pollMs: 1000, settleMs: 3000, busyRetryMs: 5000, busyTimeoutMs: 20_000, updateTimeoutMs: 60_000, patchedSettleMs: 10_000 };

  it("waits for exit, for the new install to settle, then repairs", async () => {
    const world = fakeWorld(
      [
        { state: "patched", fp: "a" },
        { state: "broken", fp: null },
        { state: "stale", fp: "b" },
        { state: "stale", fp: "c" },
        { state: "stale", fp: "c" },
      ],
      ["repaired"],
    );
    expect(await runRepairLoop(world.deps, opts)).toBe("repaired");
    expect(world.repairCalls).toHaveLength(1);
  });

  it("retries while the restarted app holds the files", async () => {
    const world = fakeWorld([{ state: "stale", fp: "x" }], ["busy", "busy", "repaired"]);
    expect(await runRepairLoop(world.deps, opts)).toBe("repaired");
    expect(world.repairCalls).toHaveLength(3);
  });

  it("gives up after the busy timeout", async () => {
    const world = fakeWorld([{ state: "stale", fp: "x" }], []);
    expect(await runRepairLoop(world.deps, opts)).toBe("busy-timeout");
  });

  it("stops when the layout stays patched (cancelled update) or unpatched", async () => {
    expect(await runRepairLoop(fakeWorld([{ state: "patched", fp: "same" }], []).deps, opts)).toBe("already-patched");
    expect(await runRepairLoop(fakeWorld([{ state: "unpatched", fp: "same" }], []).deps, opts)).toBe("unpatched");
  });

  it("times out when the install never settles", async () => {
    let n = 0;
    const world = fakeWorld([], []);
    world.deps.layout = async () => ({ state: "stale", fingerprint: String(n++) });
    expect(await runRepairLoop(world.deps, opts)).toBe("timeout");
  });

  it("reports repair errors", async () => {
    const world = fakeWorld([{ state: "stale", fp: "x" }], []);
    world.deps.repair = async () => {
      throw new Error("fuses unsafe");
    };
    expect(await runRepairLoop(world.deps, opts)).toBe("error");
  });
});
