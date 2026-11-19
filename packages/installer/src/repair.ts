import { homedir } from "node:os";

import { install as installLayout } from "./install.js";
import { resolveInstall } from "./installs.js";
import { readManifest } from "./manifest.js";
import { status } from "./status.js";
import type { InstallResult, RepairOpts } from "./types.js";

/**
 * Re-applies the layout when an upstream update replaced it.
 *
 * Stale layouts are always repaired (even for a version outside
 * SUPPORTED_VERSIONS, since the user is repairing right after an update); the
 * fuses are still checked. `ifStale` turns repair into a no-op otherwise.
 */
export async function repair(opts: RepairOpts = {}): Promise<InstallResult | "noop"> {
  const home = opts.homeDir ?? homedir();
  const info = await resolveInstall(opts);
  const report = await status({ ...opts, homeDir: home, path: info.installDir });

  if (report.layout !== "stale") {
    if (opts.ifStale) return "noop";
    const result = await installLayout({ ...opts, homeDir: home, path: info.installDir });
    return result.status === "noop" ? "noop" : result;
  }

  // resolveInstall and installLayout both re-detect the exe name inside the dir,
  // so a channel switch (Beta -> Nightly) is picked up.
  return installLayout({
    ...opts,
    homeDir: home,
    path: info.installDir,
    allowUnsupportedVersion: true,
  });
}

export interface RecordedRepair {
  installDir: string;
  result?: InstallResult | "noop";
  error?: Error;
}

/**
 * Logon-task entry point: repairs every install recorded in the manifest that
 * is stale, without auto-detection (the registry can list other T3 Code
 * installs, or none after an NSIS update rewrote the keys). Returns null when
 * the manifest has no installs, so the caller can fall back to detection.
 */
export async function repairRecorded(opts: RepairOpts = {}): Promise<RecordedRepair[] | null> {
  const home = opts.homeDir ?? homedir();
  const dirs = Object.values(readManifest(home)?.installs ?? {}).map((e) => e.installDir);
  if (dirs.length === 0) return null;
  const out: RecordedRepair[] = [];
  for (const installDir of dirs) {
    try {
      out.push({ installDir, result: await repair({ ...opts, homeDir: home, path: installDir, skipRuntime: true }) });
    } catch (error) {
      out.push({ installDir, error: error as Error });
    }
  }
  return out;
}
