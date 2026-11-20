/**
 * Self-update for the single-file t3p.exe.
 *
 * `t3p update` asks the GitHub API for the latest release of this repository, compares its tag with
 * the running version, downloads `t3p.exe` and its published `t3p.exe.sha256`, verifies the hash and
 * swaps the running executable. Nothing runs automatically: an update only happens when the user
 * types the command (or the UI calls it), so a compromised release still needs a human to accept it.
 *
 * Running from npm/source (not a Node SEA) cannot swap itself; the command then prints the npx/npm
 * path instead.
 *
 * Security rules, enforced here:
 * - one repository, hard-coded; no user-supplied URL and no redirect off the hosts GitHub uses;
 * - https only, size capped, timeouted (shared registry client);
 * - the executable must hash to the SHA-256 from the same release's `t3p.exe.sha256`, or nothing is
 *   written. That does not defend against a compromised release, and the docs say so.
 */
import { createHash } from "node:crypto";
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

import { T3pError } from "./errors.js";
import { readManifest } from "./manifest.js";
import { isSingleFileExe } from "./runtime-pack.js";
import { GITHUB_DOWNLOAD_HOSTS, getCapped, type FetchLike } from "./registry/net.js";

/** The only repository an update may come from. */
export const UPDATE_REPO = "watdafawx/t3-patcher";
export const UPDATE_ASSET = "t3p.exe";
export const UPDATE_CHECKSUM_ASSET = "t3p.exe.sha256";

const API_MAX_BYTES = 1024 * 1024;
const EXE_MAX_BYTES = 200 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

export interface UpdateOptions {
  currentVersion: string;
  repo?: string;
  fetch?: FetchLike;
  /** The executable to replace; default: the running one. */
  exePath?: string;
  /** Only report what is available. */
  check?: boolean;
  /** Default: `isSingleFileExe()`. False for npm/source runs. */
  singleFile?: boolean;
  homeDir?: string;
  /** Test seam: after a successful swap. */
  afterSwap?: (exePath: string) => void;
  /** Test seam: start the repair of an existing patched install with the new binary. */
  spawnRepair?: (exePath: string) => void;
}

export interface UpdateResult {
  status: "current" | "available" | "updated" | "unsupported" | "error";
  current: string;
  /** Version of the latest release, null when the check failed. */
  latest: string | null;
  /** Where the running copy came from. */
  source: "exe" | "npm";
  asset?: string;
  message: string;
}

/** -1 / 0 / 1 for semver-ish versions; a prerelease sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): { parts: number[]; pre: string | null } => {
    const [core, pre = null] = v.replace(/^v/i, "").split("-", 2);
    return { parts: (core ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** `sha256sum` format: "<hex>  t3p.exe" (the file name is ignored). */
export function parseChecksum(text: string): string | null {
  const match = /^\s*([a-f0-9]{64})\b/i.exec(text);
  return match ? match[1]!.toLowerCase() : null;
}

interface ReleaseInfo {
  version: string;
  exeUrl: string;
  shaUrl: string;
}

async function latestRelease(repo: string, doFetch: FetchLike | undefined): Promise<ReleaseInfo> {
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const res = await getCapped(url, {
    ...(doFetch ? { fetch: doFetch } : {}),
    maxBytes: API_MAX_BYTES,
    timeoutMs: TIMEOUT_MS,
    redirectHosts: ["api.github.com", "github.com", ...GITHUB_DOWNLOAD_HOSTS],
    headers: { accept: "application/vnd.github+json" },
    what: "update check",
  });
  let body: unknown;
  try {
    body = JSON.parse(res.body.toString("utf8"));
  } catch {
    throw new T3pError("update check: the release list is not JSON");
  }
  const release = body as { tag_name?: unknown; assets?: Array<{ name?: unknown; browser_download_url?: unknown }> };
  const tag = typeof release.tag_name === "string" ? release.tag_name : "";
  if (!/^v?\d+\.\d+\.\d+/.test(tag)) throw new T3pError(`update check: unexpected release tag ${JSON.stringify(tag)}`);
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const find = (name: string): string | null => {
    const hit = assets.find((a) => a && a.name === name && typeof a.browser_download_url === "string");
    return hit ? (hit.browser_download_url as string) : null;
  };
  const exeUrl = find(UPDATE_ASSET);
  const shaUrl = find(UPDATE_CHECKSUM_ASSET);
  if (!exeUrl || !shaUrl) throw new T3pError(`update check: release ${tag} has no ${UPDATE_ASSET} / ${UPDATE_CHECKSUM_ASSET}`);
  return { version: tag.replace(/^v/i, ""), exeUrl, shaUrl };
}

function download(url: string, doFetch: FetchLike | undefined, what: string, maxBytes: number): Promise<Buffer> {
  return getCapped(url, {
    ...(doFetch ? { fetch: doFetch } : {}),
    maxBytes,
    timeoutMs: TIMEOUT_MS,
    redirectHosts: ["github.com", ...GITHUB_DOWNLOAD_HOSTS],
    what,
  }).then((res) => res.body);
}

/** Replaces `exePath` with `bytes`. Windows allows renaming a running exe; the old one is removed later. */
function swapInPlace(exePath: string, bytes: Buffer): void {
  const staged = `${exePath}.new`;
  const previous = `${exePath}.old`;
  writeFileSync(staged, bytes, { mode: 0o755 });
  try {
    rmSync(previous, { force: true });
  } catch {
    // still running from a previous update; the OS will drop it after this process exits
  }
  renameSync(exePath, previous);
  try {
    renameSync(staged, exePath);
  } catch (error) {
    renameSync(previous, exePath);
    rmSync(staged, { force: true });
    throw new T3pError(`update: could not replace ${exePath} (${(error as Error).message}); nothing changed`);
  }
  try {
    rmSync(previous, { force: true });
  } catch {
    // locked by this very process on Windows; t3p.exe.old is cleaned up by the next update
  }
}

function defaultSpawnRepair(exePath: string): void {
  try {
    const child = spawn(exePath, ["repair", "--if-stale"], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // best effort: the logon task repairs on the next start anyway
  }
}

/**
 * Checks for, and unless `check` is set downloads and installs, the latest t3p.exe.
 * Never throws for "no update" or "not an exe"; network and checksum failures throw.
 */
export async function selfUpdate(opts: UpdateOptions): Promise<UpdateResult> {
  const repo = opts.repo ?? UPDATE_REPO;
  const singleFile = opts.singleFile ?? isSingleFileExe();
  const current = opts.currentVersion;
  const result = (status: UpdateResult["status"], latest: string | null, message: string, asset?: string): UpdateResult => ({
    status,
    current,
    latest,
    source: singleFile ? "exe" : "npm",
    ...(asset ? { asset } : {}),
    message,
  });

  if (!singleFile) {
    return result("unsupported", null, "This copy runs from npm or source: update with `npm i -g t3-patcher@latest` or `npx t3-patcher@latest`.");
  }
  if (!/^\d+\.\d+\.\d+/.test(current)) {
    return result("error", null, `Cannot compare the running version ${JSON.stringify(current)}; install a released t3p.exe.`);
  }

  const release = await latestRelease(repo, opts.fetch);
  const cmp = compareVersions(release.version, current);
  if (cmp <= 0) return result("current", release.version, `t3p ${current} is the latest release.`);
  if (opts.check) return result("available", release.version, `t3p ${release.version} is available (you have ${current}).`);

  const exePath = opts.exePath ?? process.execPath;
  if (!existsSync(exePath)) throw new T3pError(`update: ${exePath} does not exist`);
  const [exe, sums] = await Promise.all([
    download(release.exeUrl, opts.fetch, `${UPDATE_ASSET} ${release.version}`, EXE_MAX_BYTES),
    download(release.shaUrl, opts.fetch, `${UPDATE_CHECKSUM_ASSET} ${release.version}`, 4096),
  ]);
  const expected = parseChecksum(sums.toString("utf8"));
  if (!expected) throw new T3pError(`update: ${UPDATE_CHECKSUM_ASSET} for ${release.version} has no SHA-256`);
  const actual = sha256(exe);
  if (actual !== expected) {
    throw new T3pError(`update: SHA-256 mismatch for ${UPDATE_ASSET} ${release.version} (expected ${expected}, got ${actual}); nothing was written`);
  }
  if (exe.length < 1024 * 1024) throw new T3pError(`update: ${UPDATE_ASSET} ${release.version} is only ${exe.length} bytes; refusing`);

  swapInPlace(exePath, exe);
  if (opts.afterSwap) opts.afterSwap(exePath);
  else if (Object.keys(readManifest(opts.homeDir ?? homedir())?.installs ?? {}).length > 0) {
    (opts.spawnRepair ?? defaultSpawnRepair)(exePath);
  }
  return result("updated", release.version, `Updated t3p ${current} -> ${release.version}. Restart T3 Code if it is open; an open app re-applies the runtime on its next start.`, UPDATE_ASSET);
}

/** `t3p.exe.old` left behind by a swap of the running binary; call once at startup. */
export function cleanupPreviousExe(exePath = process.execPath): void {
  try {
    rmSync(`${exePath}.old`, { force: true });
  } catch {
    // still the running image; the next start removes it
  }
}

/** Path of the executable being updated (exported for tests and callers). */
export function currentExePath(): string {
  return process.execPath;
}

/** `t3p update` output, for the CLI. */
export function formatUpdate(result: UpdateResult): string {
  return result.message;
}
