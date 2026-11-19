import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { delimiter, join } from "node:path";

import type { InstallInfo } from "./types.js";

/**
 * The repair worker (spawned by the runtime when an update starts) needs a
 * Node interpreter OUTSIDE the T3 Code install dir: anything running from the
 * install dir locks files and breaks the NSIS update. When there is no
 * node.exe on PATH, t3p copies the app's Electron exe to
 * <home>/.t3-patcher/bin/t3p-node.exe and runs it with ELECTRON_RUN_AS_NODE=1
 * (the RunAsNode fuse is on in T3 Code 0.1.10).
 *
 * Measured on rig (Electron 44.10.1): the exe plus icudtl.dat and
 * v8_context_snapshot.bin are enough to run as Node; ffmpeg.dll and
 * snapshot_blob.bin are not needed. About 257 MB.
 */
export const WORKER_NODE_EXE = "t3p-node.exe";
export const WORKER_NODE_DATA = ["icudtl.dat", "v8_context_snapshot.bin"] as const;

export type WorkerNodeResult = "system-node" | "copied" | "present" | "not-windows";

function isInside(dir: string, file: string): boolean {
  const d = dir.replace(/\//g, "\\").toLowerCase().replace(/\\+$/, "");
  const f = file.replace(/\//g, "\\").toLowerCase();
  return f === d || f.startsWith(`${d}\\`);
}

/** node.exe on PATH outside the install dir, the same lookup the runtime's updater hook does. */
export function findSystemNode(env: NodeJS.ProcessEnv, installDir: string, exists: (p: string) => boolean = existsSync): string | null {
  const pathVar = env.PATH ?? env.Path ?? "";
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir.replace(/^"|"$/g, ""), "node.exe");
    if (isInside(installDir, candidate)) continue;
    if (exists(candidate)) return candidate;
  }
  return null;
}

export interface WorkerNodeOpts {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Copy even when a system node exists. */
  force?: boolean;
  log?: (message: string) => void;
}

/** Makes sure the repair worker has an interpreter. Throws on copy failure (callers turn it into a warning). */
export function ensureWorkerNode(info: InstallInfo, homeDir: string, opts: WorkerNodeOpts = {}): WorkerNodeResult {
  if ((opts.platform ?? process.platform) !== "win32") return "not-windows";
  const env = opts.env ?? process.env;
  if (!opts.force) {
    const system = findSystemNode(env, info.installDir);
    if (system) return "system-node";
  }
  const bin = join(homeDir, ".t3-patcher", "bin");
  const target = join(bin, WORKER_NODE_EXE);
  if (!opts.force && existsSync(target) && WORKER_NODE_DATA.every((f) => existsSync(join(bin, f)))) return "present";
  const incoming = `${bin}.new`;
  rmSync(incoming, { recursive: true, force: true });
  mkdirSync(incoming, { recursive: true });
  copyFileSync(info.exePath, join(incoming, WORKER_NODE_EXE));
  for (const file of WORKER_NODE_DATA) copyFileSync(join(info.installDir, file), join(incoming, file));
  // A running copy (an earlier repair worker) cannot be replaced: keep it.
  try {
    rmSync(bin, { recursive: true, force: true });
  } catch {
    rmSync(incoming, { recursive: true, force: true });
    return "present";
  }
  renameSync(incoming, bin);
  opts.log?.(`copied ${info.exePath} -> ${target} (repair worker interpreter)`);
  return "copied";
}
