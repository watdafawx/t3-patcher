import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { WORKER_NODE_EXE, findSystemNode } from "./worker-node.js";

/**
 * Second repair trigger: a per-user logon scheduled task that runs
 * `t3p repair --if-stale`. It covers a manual installer run (or an update that
 * happened while the app was closed), where the runtime's updater hook never
 * fired.
 *
 * Files (all outside the T3 Code install dir, so an NSIS install cannot wipe them):
 *   <home>/.t3-patcher/t3p.cjs           copy of the standalone installer bundle
 *   <home>/.t3-patcher/repair-logon.cmd  wrapper the task runs (sets T3P_HOME, picks the interpreter)
 *   <home>/.t3-patcher/logs/logon-repair.log
 */
export const DEFAULT_TASK_NAME = "t3-patcher-repair";

export interface LogonTaskOpts {
  homeDir: string;
  /** The running standalone bundle (process.argv[1]); must be a .cjs file. */
  selfPath?: string;
  installDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Defaults to env T3P_TASK_NAME, then DEFAULT_TASK_NAME. */
  taskName?: string;
  /** Test seam. Returns the exit status. */
  schtasks?: (args: string[]) => { status: number | null; stderr: string };
  log?: (message: string) => void;
}

export type LogonTaskResult = "registered" | "skipped-not-windows" | "skipped-not-bundle" | "skipped-no-interpreter" | "failed" | "removed" | "absent";

function runSchtasks(args: string[]): { status: number | null; stderr: string } {
  const r = spawnSync("schtasks.exe", args, { encoding: "utf8", windowsHide: true });
  return { status: r.status, stderr: `${r.stderr ?? ""}${r.stdout ?? ""}`.trim() };
}

export function taskNameFor(opts: { env?: NodeJS.ProcessEnv; taskName?: string }): string {
  return opts.taskName ?? opts.env?.T3P_TASK_NAME ?? process.env.T3P_TASK_NAME ?? DEFAULT_TASK_NAME;
}

/** The wrapper script text. Exported for tests. */
export function buildWrapper(opts: { home: string; bundle: string; logFile: string; node: { exe: string; electron: boolean }; hasHomeOverride: boolean }): string {
  const lines = ["@echo off"];
  if (opts.hasHomeOverride) lines.push(`set "T3P_HOME=${opts.home}"`);
  if (opts.node.electron) {
    lines.push('set "ELECTRON_RUN_AS_NODE=1"', 'set "ELECTRON_NO_ASAR=1"');
  }
  lines.push(`"${opts.node.exe}" "${opts.bundle}" repair --if-stale --json >> "${opts.logFile}" 2>&1`);
  return `${lines.join("\r\n")}\r\n`;
}

export function ensureLogonTask(opts: LogonTaskOpts): LogonTaskResult {
  const log = opts.log ?? (() => {});
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return "skipped-not-windows";
  const self = opts.selfPath ?? process.argv[1];
  if (!self || !/\.cjs$/i.test(self) || !existsSync(self)) {
    log("logon task skipped: not running from the standalone t3p.cjs bundle");
    return "skipped-not-bundle";
  }
  const env = opts.env ?? process.env;
  const root = join(opts.homeDir, ".t3-patcher");
  const binDir = join(root, "bin");
  const system = findSystemNode(env, opts.installDir ?? "");
  const copy = join(binDir, WORKER_NODE_EXE);
  const node = system ? { exe: system, electron: false } : existsSync(copy) ? { exe: copy, electron: true } : null;
  if (!node) {
    log("logon task skipped: no node.exe on PATH and no worker interpreter copy");
    return "skipped-no-interpreter";
  }
  mkdirSync(join(root, "logs"), { recursive: true });
  const bundle = join(root, "t3p.cjs");
  copyFileSync(self, bundle);
  const wrapper = join(root, "repair-logon.cmd");
  writeFileSync(
    wrapper,
    buildWrapper({ home: opts.homeDir, bundle, logFile: join(root, "logs", "logon-repair.log"), node, hasHomeOverride: Boolean(env.T3P_HOME) }),
  );
  const name = taskNameFor(opts);
  const r = (opts.schtasks ?? runSchtasks)(["/Create", "/TN", name, "/SC", "ONLOGON", "/RL", "LIMITED", "/F", "/TR", `"${wrapper}"`]);
  if (r.status !== 0) {
    log(`logon task registration failed: ${r.stderr}`);
    return "failed";
  }
  log(`logon task ${name} registered -> ${wrapper}`);
  return "registered";
}

export function removeLogonTask(opts: LogonTaskOpts): LogonTaskResult {
  if ((opts.platform ?? process.platform) !== "win32") return "skipped-not-windows";
  const name = taskNameFor(opts);
  const r = (opts.schtasks ?? runSchtasks)(["/Delete", "/TN", name, "/F"]);
  const root = join(opts.homeDir, ".t3-patcher");
  for (const f of ["t3p.cjs", "repair-logon.cmd"]) rmSync(join(root, f), { force: true });
  return r.status === 0 ? "removed" : "absent";
}
