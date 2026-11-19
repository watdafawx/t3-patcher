import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import {
  apiCompatible,
  clearHealth,
  compareSemver,
  emptyHealth,
  isValidPluginId,
  parseHealth,
  permissionsEqual,
  REGISTRY_MAX_ZIP_BYTES,
  type PatcherStateJson,
  type PluginInstallRecord,
  type RegistryEntry,
  T3_API_VERSION,
  validateManifest,
} from "@t3p/api";

import { isBusyError, T3pError } from "../errors.js";
import { healthPath, patcherBase, readState, writeState } from "../plugin-admin.js";
import { type FetchLike, getCapped, GITHUB_DOWNLOAD_HOSTS } from "./net.js";
import { readZip, ZipError } from "./zip.js";

/**
 * Install, update and uninstall of registry plugins: the one implementation both the CLI
 * (`t3p plugins install|update|uninstall`) and the app's main process (after its native confirm
 * dialog) call. Order, and why:
 *
 * 1. download (https, 25 MB cap, allowlisted redirects) and check the exact size and SHA-256 against
 *    the registry entry BEFORE anything is unpacked;
 * 2. unpack with the strict zip reader into a fresh staging folder under ~/.t3-patcher/staging;
 * 3. check plugin.json there: valid, same id, same version, exactly the declared permissions of the
 *    entry, entry files present;
 * 4. swap the folder into ~/.t3-patcher/plugins/<id> with renames (the old folder is kept until the
 *    new one is in place and state.json is written, and put back on any failure);
 * 5. state.json: a new install is disabled with nothing granted; an update keeps the user's
 *    enabled flag and grants (storage and settings live outside the plugin folder and are untouched).
 *
 * Nothing from the zip is executed: no install scripts, no require, no import.
 */

export const DOWNLOAD_TIMEOUT_MS = 120_000;

export class RegistryInstallError extends T3pError {
  constructor(message: string) {
    super(message);
    this.name = "RegistryInstallError";
  }
}

export function pluginsDirOf(homeDir?: string): string {
  return join(patcherBase(homeDir), "plugins");
}

function stagingRoot(homeDir?: string): string {
  return join(patcherBase(homeDir), "staging");
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Version of the plugin installed in ~/.t3-patcher/plugins/<id>, or null. */
export function installedVersion(id: string, homeDir?: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(pluginsDirOf(homeDir), id, "plugin.json"), "utf8")) as { version?: unknown };
    return typeof raw.version === "string" ? raw.version : null;
  } catch {
    return null;
  }
}

export interface InstalledInfo {
  id: string;
  version: string | null;
  /** A `t3p dev` link: never touched by install, update or uninstall. */
  devLink: boolean;
}

export function installedInfo(id: string, homeDir?: string): InstalledInfo | null {
  const dir = join(pluginsDirOf(homeDir), id);
  if (!existsSync(dir)) return null;
  return { id, version: installedVersion(id, homeDir), devLink: isLink(dir) };
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** rename with a few retries: on Windows a virus scanner or the indexer may hold a fresh folder for a moment. */
function renameRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      if (attempt >= 4 || !isBusyError(error)) throw error;
      sleepSync(150 * (attempt + 1));
    }
  }
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Downloads the entry's zip and checks size and SHA-256. Returns the verified bytes. */
export async function downloadVerified(entry: RegistryEntry, opts: { fetch?: FetchLike; registryUrl: string; allowInsecureLocal?: boolean; timeoutMs?: number }): Promise<Buffer> {
  const res = await getCapped(entry.download.url, {
    fetch: opts.fetch,
    maxBytes: Math.min(REGISTRY_MAX_ZIP_BYTES, entry.download.size),
    timeoutMs: opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS,
    headers: { accept: "application/octet-stream" },
    redirectHosts: [...GITHUB_DOWNLOAD_HOSTS, new URL(opts.registryUrl).hostname],
    allowInsecureLocal: opts.allowInsecureLocal,
    what: `plugin zip for ${entry.id}`,
  });
  if (res.body.length !== entry.download.size) throw new RegistryInstallError(`${entry.id}: download is ${res.body.length} bytes, the registry says ${entry.download.size}; refusing it`);
  const hash = sha256(res.body);
  if (hash !== entry.download.sha256) throw new RegistryInstallError(`${entry.id}: SHA-256 mismatch (got ${hash}, the registry pins ${entry.download.sha256}); refusing it`);
  return res.body;
}

/** Unpacks into `dir` (must not exist). Every path is re-checked to stay inside `dir`. */
function unpack(zip: Buffer, dir: string): number {
  let files;
  try {
    files = readZip(zip);
  } catch (error) {
    throw new RegistryInstallError(error instanceof ZipError ? error.message : `cannot read zip: ${(error as Error).message}`);
  }
  mkdirSync(dir, { recursive: false });
  const root = resolve(dir) + sep;
  for (const f of files) {
    const target = resolve(dir, ...f.name.split("/"));
    if (!target.startsWith(root)) throw new RegistryInstallError(`zip entry escapes the plugin folder: ${f.name}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.data, { flag: "wx" });
  }
  return files.length;
}

/** Checks the unpacked plugin against its registry entry. */
function verifyStaged(dir: string, entry: RegistryEntry): void {
  const file = join(dir, "plugin.json");
  if (!existsSync(file)) throw new RegistryInstallError(`${entry.id}: plugin.json must be at the root of the zip`);
  const text = readFileSync(file, "utf8");
  if (text.length > 64 * 1024) throw new RegistryInstallError(`${entry.id}: plugin.json is too large`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new RegistryInstallError(`${entry.id}: plugin.json is not valid JSON (${(error as Error).message})`);
  }
  const res = validateManifest(raw, entry.id);
  if (!res.ok) throw new RegistryInstallError(`${entry.id}: invalid plugin.json: ${res.errors.join("; ")}`);
  const m = res.manifest;
  if (m.version !== entry.version) throw new RegistryInstallError(`${entry.id}: plugin.json says version ${m.version}, the registry says ${entry.version}; refusing it`);
  if (!permissionsEqual((raw as { permissions?: unknown }).permissions ?? [], entry.permissions)) {
    throw new RegistryInstallError(`${entry.id}: plugin.json declares different permissions than the registry entry; refusing it`);
  }
  for (const key of ["main", "renderer"] as const) {
    const rel = m[key];
    if (rel && !statSafe(join(dir, ...rel.split("/")))) throw new RegistryInstallError(`${entry.id}: ${key} entry ${rel} is missing from the zip`);
  }
}

function statSafe(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export interface InstallFromRegistryOptions {
  homeDir?: string;
  entry: RegistryEntry;
  /** The index URL the entry came from (recorded in state.json; its host may serve redirects). */
  registryUrl: string;
  fetch?: FetchLike;
  allowInsecureLocal?: boolean;
  /** "install" refuses when the plugin folder exists; "update" refuses when it does not. Default: either. */
  mode?: "install" | "update";
  /** Allow installing the same or an older version over an installed one. */
  allowDowngrade?: boolean;
  /** Runtime version, for the entry's `minRuntime` (skipped when unknown). */
  runtimeVersion?: string;
  now?: () => Date;
  timeoutMs?: number;
  /** Test seam: called after the old folder moved away and the new one moved in, before state.json is written. */
  beforeStateWrite?: () => void;
}

export interface InstallFromRegistryResult {
  id: string;
  version: string;
  previousVersion: string | null;
  updated: boolean;
  dir: string;
  sha256: string;
  files: number;
}

/** See the module comment. Throws a {@link T3pError} with a user-facing message on any refusal; the plugins folder is left as it was. */
export async function installFromRegistry(opts: InstallFromRegistryOptions): Promise<InstallFromRegistryResult> {
  const { entry } = opts;
  if (!isValidPluginId(entry.id)) throw new RegistryInstallError(`invalid plugin id ${JSON.stringify(entry.id)}`);
  if (!apiCompatible(entry.apiVersion, T3_API_VERSION)) throw new RegistryInstallError(`${entry.id} needs plugin API ${entry.apiVersion}; this T3 Patcher has ${T3_API_VERSION}. Update T3 Patcher first.`);
  if (entry.minRuntime && opts.runtimeVersion && compareSemverSafe(entry.minRuntime, opts.runtimeVersion) > 0) {
    throw new RegistryInstallError(`${entry.id} needs T3 Patcher runtime ${entry.minRuntime} or newer (installed: ${opts.runtimeVersion}). Run t3p install to update it.`);
  }
  const pluginsDir = pluginsDirOf(opts.homeDir);
  const target = join(pluginsDir, entry.id);
  const before = installedInfo(entry.id, opts.homeDir);
  if (before?.devLink) throw new RegistryInstallError(`${entry.id} is a \`t3p dev\` link to a folder on your PC; remove it with \`t3p dev --unlink ${entry.id}\` first`);
  if (opts.mode === "install" && before) throw new RegistryInstallError(`${entry.id} is already installed (${before.version ?? "unknown version"}); use update`);
  if (opts.mode === "update" && !before) throw new RegistryInstallError(`${entry.id} is not installed; use install`);
  if (before?.version && !opts.allowDowngrade && compareSemverSafe(entry.version, before.version) <= 0) {
    throw new RegistryInstallError(`${entry.id} ${before.version} is installed; the registry has ${entry.version}, nothing to update`);
  }
  // A broken state.json fails here, before anything is downloaded.
  readState(opts.homeDir);

  const zip = await downloadVerified(entry, opts);
  const hash = entry.download.sha256;

  const staging = stagingRoot(opts.homeDir);
  mkdirSync(staging, { recursive: true });
  mkdirSync(pluginsDir, { recursive: true });
  const token = `${entry.id}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const staged = join(staging, token);
  const backup = join(staging, `${token}.old`);
  let files = 0;
  try {
    files = unpack(zip, staged);
    verifyStaged(staged, entry);
  } catch (error) {
    rmSync(staged, { recursive: true, force: true });
    throw error;
  }

  // Swap: old folder aside, new folder in. Any failure until state.json is written puts the old one back.
  let movedOld = false;
  let movedNew = false;
  try {
    if (before) {
      renameRetry(target, backup);
      movedOld = true;
    }
    renameRetry(staged, target);
    movedNew = true;
    opts.beforeStateWrite?.();
    const state = readState(opts.homeDir);
    const record: PluginInstallRecord = { source: "registry", registry: opts.registryUrl, version: entry.version, sha256: hash, at: (opts.now ?? (() => new Date()))().toISOString() };
    applyInstallState(state, entry.id, record, before !== null);
    writeState(state, opts.homeDir);
  } catch (error) {
    try {
      if (movedNew) renameRetry(target, staged);
      if (movedOld) renameRetry(backup, target);
    } catch (rollbackError) {
      throw new RegistryInstallError(`${entry.id}: install failed (${(error as Error).message}) and the rollback failed too (${(rollbackError as Error).message}). The previous version is in ${backup}.`);
    } finally {
      rmSync(staged, { recursive: true, force: true });
    }
    if (isBusyError(error)) throw new RegistryInstallError(`${entry.id}: the plugin folder is in use (${(error as NodeJS.ErrnoException).code}); close T3 Code or try again`);
    throw error;
  }
  rmSync(backup, { recursive: true, force: true });
  return { id: entry.id, version: entry.version, previousVersion: before?.version ?? null, updated: before !== null, dir: target, sha256: hash, files };
}

function compareSemverSafe(a: string, b: string): number {
  try {
    return compareSemver(a, b);
  } catch {
    return a === b ? 0 : 1;
  }
}

/**
 * New install: disabled, nothing granted (an old entry, e.g. left from a removed plugin, is replaced
 * so no stale grant survives). Update: the user's enabled flag and grants stay; only the record changes.
 */
export function applyInstallState(state: PatcherStateJson, id: string, record: PluginInstallRecord, update: boolean): PatcherStateJson {
  const existing = Object.prototype.hasOwnProperty.call(state.plugins, id) ? state.plugins[id] : undefined;
  if (update && existing) existing.install = record;
  else state.plugins[id] = { enabled: false, granted: [], install: record };
  return state;
}

export interface UninstallResult {
  id: string;
  version: string | null;
  /** Plugin storage and settings (~/.t3-patcher/storage/<id>.json) are kept for a reinstall. */
  storageKept: boolean;
}

/** Removes ~/.t3-patcher/plugins/<id> and its state.json entry. Refuses `t3p dev` links. */
export function uninstallPlugin(opts: { homeDir?: string; id: string }): UninstallResult {
  const { id } = opts;
  if (!isValidPluginId(id)) throw new RegistryInstallError(`invalid plugin id ${JSON.stringify(id)}`);
  const info = installedInfo(id, opts.homeDir);
  const state = readState(opts.homeDir);
  const inState = Object.prototype.hasOwnProperty.call(state.plugins, id);
  if (!info && !inState) throw new RegistryInstallError(`${id} is not installed`);
  if (info?.devLink) throw new RegistryInstallError(`${id} is a \`t3p dev\` link; remove it with \`t3p dev --unlink ${id}\``);
  if (info) {
    const staging = stagingRoot(opts.homeDir);
    mkdirSync(staging, { recursive: true });
    const trash = join(staging, `${id}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}.removed`);
    try {
      renameRetry(join(pluginsDirOf(opts.homeDir), id), trash);
    } catch (error) {
      if (isBusyError(error)) throw new RegistryInstallError(`${id}: the plugin folder is in use (${(error as NodeJS.ErrnoException).code}); close T3 Code or try again`);
      throw error;
    }
    rmSync(trash, { recursive: true, force: true });
  }
  delete state.plugins[id];
  if (state.loadOrder) {
    state.loadOrder = state.loadOrder.filter((x) => x !== id);
    if (state.loadOrder.length === 0) delete state.loadOrder;
  }
  writeState(state, opts.homeDir);
  try {
    const file = healthPath(opts.homeDir);
    if (existsSync(file)) {
      let health;
      try {
        health = parseHealth(JSON.parse(readFileSync(file, "utf8")));
      } catch {
        health = emptyHealth();
      }
      if (health.plugins[id]) writeFileSync(file, `${JSON.stringify(clearHealth(health, id), null, 2)}\n`);
    }
  } catch {
    // a stale crash counter is harmless
  }
  return { id, version: info?.version ?? null, storageKept: existsSync(join(patcherBase(opts.homeDir), "storage", `${id}.json`)) };
}
