import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

import type { Logger } from "../log.js";

export interface EmitterLike {
  once(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface NodeChoice {
  exe: string;
  /** true when exe is an Electron copy that needs ELECTRON_RUN_AS_NODE=1. */
  electron: boolean;
}

function isInside(dir: string, file: string): boolean {
  const d = dir.replace(/\//g, "\\").toLowerCase().replace(/\\+$/, "");
  const f = file.replace(/\//g, "\\").toLowerCase();
  return f === d || f.startsWith(`${d}\\`);
}

/**
 * Picks the interpreter for the repair worker. It must live OUTSIDE the T3 Code
 * install dir: a running exe in there would lock files and break the NSIS
 * update. Order: system node.exe on PATH, then the Electron copy t3p puts in
 * <home>/.t3-patcher/bin (run with ELECTRON_RUN_AS_NODE=1).
 */
export function chooseWorkerNode(opts: { env: NodeJS.ProcessEnv; binDir: string; installDir: string; exists?: (p: string) => boolean }): NodeChoice | null {
  const exists = opts.exists ?? existsSync;
  const pathVar = opts.env.PATH ?? opts.env.Path ?? "";
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir.replace(/^"|"$/g, ""), "node.exe");
    if (isInside(opts.installDir, candidate)) continue;
    if (exists(candidate)) return { exe: candidate, electron: false };
  }
  const copy = join(opts.binDir, "t3p-node.exe");
  if (exists(copy)) return { exe: copy, electron: true };
  return null;
}

export interface UpdaterHookDeps {
  autoUpdater: EmitterLike;
  log: Logger;
  env: NodeJS.ProcessEnv;
  installDir: string;
  binDir: string;
  workerFile: string;
  /** Patcher home root (T3P_HOME or the OS home), passed to the worker. */
  home: string;
  pid: number;
  spawnImpl?: typeof nodeSpawn;
  exists?: (p: string) => boolean;
}

/** Starts the detached repair worker. Returns true when it was spawned. Never throws. */
export function spawnRepairWorker(deps: UpdaterHookDeps): boolean {
  const log = deps.log;
  try {
    const exists = deps.exists ?? existsSync;
    if (!exists(deps.workerFile)) {
      log.warn(`repair worker missing at ${deps.workerFile}; run "t3p repair" after the update`);
      return false;
    }
    const node = chooseWorkerNode({ env: deps.env, binDir: deps.binDir, installDir: deps.installDir, exists });
    if (!node) {
      log.warn('no node.exe on PATH and no Electron copy in bin; run "t3p repair" after the update');
      return false;
    }
    const env: NodeJS.ProcessEnv = { ...deps.env, T3P_HOME: deps.home };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    delete env.ELECTRON_NO_ASAR;
    if (node.electron) {
      env.ELECTRON_RUN_AS_NODE = "1";
      env.ELECTRON_NO_ASAR = "1"; // the worker reads app.asar as a plain file
    }
    const args = [deps.workerFile, "--install-dir", deps.installDir, "--pid", String(deps.pid)];
    const child = (deps.spawnImpl ?? nodeSpawn)(node.exe, args, { detached: true, stdio: "ignore", windowsHide: true, env, cwd: deps.home });
    child.on?.("error", (error: Error) => log.error("repair worker failed to start", error));
    child.unref?.();
    log.info(`repair worker spawned: ${node.exe} ${args.join(" ")}`);
    return true;
  } catch (error) {
    log.error("repair worker spawn failed", error);
    return false;
  }
}

/**
 * electron-updater's NsisUpdater starts the installer, then emits
 * `before-quit-for-update` on Electron's autoUpdater and quits the app. That
 * is the last moment the runtime runs before NSIS replaces the install dir
 * (and with it our app.asar), so the repair worker is started there.
 */
export function installUpdaterHook(deps: UpdaterHookDeps): void {
  try {
    deps.autoUpdater.once("before-quit-for-update", () => {
      deps.log.info("before-quit-for-update: an update is being installed");
      spawnRepairWorker(deps);
    });
  } catch (error) {
    deps.log.error("updater hook not installed", error);
  }
}
