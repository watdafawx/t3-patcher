import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

import { REPO, type Log } from "./release.js";

/** Shallow clone of one tag, used when the release assets cannot be fetched. */
export function cloneTag(tag: string, dest: string, log: Log): string {
  if (existsSync(dest)) {
    log.info(`using existing source clone: ${dest}`);
    return dest;
  }
  mkdirSync(dest, { recursive: true });
  const result = spawnSync(
    "git",
    ["clone", "--depth", "1", "--branch", tag, `https://github.com/${REPO}`, dest],
    { encoding: "utf8", timeout: 900_000 },
  );
  if (result.error) throw new Error(`git clone failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`git clone ${tag} failed (exit ${result.status}): ${(result.stderr ?? "").trim().split("\n").slice(-3).join(" ")}`);
  }
  return dest;
}

/** Commit a checkout points at, for the report. */
export function headCommit(dir: string): string | undefined {
  const result = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  const sha = result.stdout.trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
}
