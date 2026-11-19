import { isValidPluginId } from "./manifest.js";
import { parsePermissions, PERMISSION_NAMES, type PermissionJson, type PermissionSet, permissionsToJson } from "./permissions.js";

/**
 * The plugin registry ("master repo"): a curated JSON index of installable plugins (WP-14A).
 *
 * `registry/index.json` in this repo is the default registry. Each entry pins one release asset (a
 * zip with plugin.json + dist/) by URL, size and SHA-256. The installer (CLI and the Plugins page,
 * through the main process) downloads the zip, checks the hash BEFORE unpacking, checks that the
 * unpacked plugin.json matches the entry (id, version, permissions), and installs it disabled with
 * nothing granted. See docs/registry.md and docs/security.md section 4.7.
 *
 * Pure: no Node or DOM APIs, so the renderer page, the main process, the CLI and the CI validator all
 * use the same rules. Keep in sync with schema/registry.schema.json (api/test/registry.test.ts).
 */

export const REGISTRY_SCHEMA_VERSION = 1;
/** The registry the CLI and the app use unless T3P_REGISTRY_URL or `registryUrl` in ~/.t3-patcher/config.json say otherwise. */
export const DEFAULT_REGISTRY_URL = "https://raw.githubusercontent.com/watdafawx/t3-patcher/main/registry/index.json";
/** Caps (bytes). */
export const REGISTRY_MAX_INDEX_BYTES = 1024 * 1024;
export const REGISTRY_MAX_ZIP_BYTES = 25 * 1024 * 1024;
export const REGISTRY_MAX_UNPACKED_BYTES = 50 * 1024 * 1024;
export const REGISTRY_MAX_FILES = 500;
export const REGISTRY_MAX_PLUGINS = 500;

/** Release asset name of a plugin zip. */
export function registryAssetName(id: string, version: string): string {
  return `t3p-plugin-${id}-${version}.zip`;
}

export interface RegistryDownload {
  /** https URL of the zip (a GitHub release asset for first-party plugins). */
  url: string;
  /** Lowercase hex SHA-256 of the zip. The installer refuses anything else. */
  sha256: string;
  /** Exact zip size in bytes. */
  size: number;
}

export interface RegistryEntry {
  id: string;
  name: string;
  description: string;
  author: string;
  /** https page about the plugin (repo or folder). */
  homepage: string;
  version: string;
  /** Plugin API range the plugin needs, same syntax as `t3pApi` in plugin.json ("1", "1.x", "1.2"). */
  apiVersion: string;
  /** Exactly the permissions plugin.json declares. The installer rejects a zip whose plugin.json differs. */
  permissions: PermissionJson[];
  tags: string[];
  /** https URL of a square icon (PNG, SVG or JPEG). */
  icon?: string;
  /** https URLs of screenshots. */
  screenshots?: string[];
  download: RegistryDownload;
  /** Lowest T3 Patcher runtime version (semver) the plugin needs. */
  minRuntime?: string;
  /** SPDX license id (e.g. "MIT"). */
  license?: string;
  /** https URL of the plugin's source code, when it is not the homepage. */
  source?: string;
}

export interface RegistryIndex {
  schemaVersion: 1;
  plugins: RegistryEntry[];
}

export interface RegistryValidateOptions {
  /** Accept `http://127.0.0.1`, `http://localhost` and `http://[::1]` URLs (tests and local registries only). */
  allowInsecureLocal?: boolean;
}

export type RegistryResult = { ok: true; index: RegistryIndex; warnings: string[] } | { ok: false; errors: string[]; warnings: string[] };
export type RegistryEntryResult = { ok: true; entry: RegistryEntry; warnings: string[] } | { ok: false; errors: string[]; warnings: string[] };

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const API_RANGE_RE = /^\d+(\.(\d+|x))?$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const TAG_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
const LICENSE_RE = /^[A-Za-z0-9.+() -]{1,64}$/;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const ENTRY_KEYS = new Set(["id", "name", "description", "author", "homepage", "version", "apiVersion", "permissions", "tags", "icon", "screenshots", "download", "minRuntime", "license", "source"]);
const DOWNLOAD_KEYS = new Set(["url", "sha256", "size"]);
const INDEX_KEYS = new Set(["schemaVersion", "plugins", "$schema", "generated"]);

/** Strict semver 2.0 (no leading zeros, optional prerelease and build). */
export function isSemver(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && SEMVER_RE.test(value);
}

/**
 * Semver precedence: -1, 0 or 1. Build metadata is ignored; a prerelease sorts before its release;
 * prerelease identifiers compare numerically when both are numbers, else as ASCII. Invalid input throws.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = SEMVER_RE.exec(a);
  const pb = SEMVER_RE.exec(b);
  if (!pa || !pb) throw new Error(`not a semver version: ${pa ? b : a}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  const ra = pa[4];
  const rb = pb[4];
  if (ra === undefined && rb === undefined) return 0;
  if (ra === undefined) return 1;
  if (rb === undefined) return -1;
  const xa = ra.split(".");
  const xb = rb.split(".");
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    const ia = xa[i];
    const ib = xb[i];
    if (ia === undefined) return -1;
    if (ib === undefined) return 1;
    const na = /^\d+$/.test(ia);
    const nb = /^\d+$/.test(ib);
    if (na && nb) {
      const d = Number(ia) - Number(ib);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (na !== nb) return na ? -1 : 1;
    else if (ia !== ib) return ia < ib ? -1 : 1;
  }
  return 0;
}

/**
 * True for an https URL with a host and no credentials (and, with `allowInsecureLocal`, an http URL
 * on the loopback host). Everything the registry points at must pass this.
 */
export function isRegistryUrl(value: unknown, opts: RegistryValidateOptions = {}): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return false;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.username || u.password || !u.hostname) return false;
  if (u.protocol === "https:") return true;
  return opts.allowInsecureLocal === true && u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname);
}

/** Canonical JSON of a permission list (fixed name order, sorted scopes): two lists are equal when this is equal. */
export function canonicalPermissions(list: unknown): string | null {
  const parsed = parsePermissions(list ?? [], "permissions");
  if (parsed.errors.length > 0) return null;
  return canonicalSet(parsed.set);
}

function canonicalSet(set: PermissionSet): string {
  const out: Record<string, unknown> = {};
  for (const name of PERMISSION_NAMES) {
    const v = (set as Record<string, unknown>)[name];
    if (v === undefined) continue;
    if (v === true) out[name] = true;
    else if (name === "spawn") out[name] = [...(set.spawn?.allow ?? [])].sort();
    else out[name] = [...((v as { roots?: string[] }).roots ?? [])].sort();
  }
  return JSON.stringify(out);
}

/** True when both lists declare exactly the same permissions with the same scopes (order does not matter). */
export function permissionsEqual(a: unknown, b: unknown): boolean {
  const ca = canonicalPermissions(a);
  return ca !== null && ca === canonicalPermissions(b);
}

function str(m: Record<string, unknown>, key: string, max: number, errors: string[], where: string, required = true): string | undefined {
  const v = m[key];
  if (v === undefined && !required) return undefined;
  if (typeof v !== "string" || v.trim().length === 0 || v.length > max) {
    errors.push(`${where}.${key} must be a non-empty string of at most ${max} characters`);
    return undefined;
  }
  return v;
}

/** Validates one registry entry. `where` prefixes the messages (e.g. `plugins[3]`). */
export function validateRegistryEntry(raw: unknown, opts: RegistryValidateOptions = {}, where = "entry"): RegistryEntryResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, errors: [`${where} must be an object`], warnings };
  const m = raw as Record<string, unknown>;
  for (const key of Object.keys(m)) if (!ENTRY_KEYS.has(key)) warnings.push(`${where}: unknown key "${key}" ignored`);

  if (!isValidPluginId(m.id)) errors.push(`${where}.id must be a valid plugin id (lowercase [a-z0-9-] segments separated by dots, max 64)`);
  const name = str(m, "name", 80, errors, where);
  const description = str(m, "description", 512, errors, where);
  const author = str(m, "author", 100, errors, where);
  if (!isRegistryUrl(m.homepage, opts)) errors.push(`${where}.homepage must be an https URL`);
  if (!isSemver(m.version)) errors.push(`${where}.version must be a semver version like "1.0.0"`);
  if (typeof m.apiVersion !== "string" || !API_RANGE_RE.test(m.apiVersion)) errors.push(`${where}.apiVersion must look like "1", "1.x" or "1.2"`);

  let permissions: PermissionJson[] = [];
  if (!Array.isArray(m.permissions)) errors.push(`${where}.permissions must be an array (use [] for none)`);
  else if (m.permissions.length > 16) errors.push(`${where}.permissions has more than 16 entries`);
  else {
    const parsed = parsePermissions(m.permissions, `${where}.permissions`);
    if (parsed.errors.length > 0) errors.push(...parsed.errors);
    else if (parsed.set && permissionsToJson(parsed.set).length !== m.permissions.length) errors.push(`${where}.permissions lists a permission twice`);
    else permissions = permissionsToJson(parsed.set);
  }

  const tags: string[] = [];
  if (!Array.isArray(m.tags)) errors.push(`${where}.tags must be an array (use [] for none)`);
  else if (m.tags.length > 8) errors.push(`${where}.tags has more than 8 entries`);
  else {
    for (const t of m.tags) {
      if (typeof t !== "string" || !TAG_RE.test(t)) errors.push(`${where}.tags entry ${JSON.stringify(t)} must be lowercase [a-z0-9-], max 24 characters`);
      else if (tags.includes(t)) errors.push(`${where}.tags lists "${t}" twice`);
      else tags.push(t);
    }
  }

  if (m.icon !== undefined && !isRegistryUrl(m.icon, opts)) errors.push(`${where}.icon must be an https URL`);
  if (m.screenshots !== undefined) {
    if (!Array.isArray(m.screenshots) || m.screenshots.length > 6) errors.push(`${where}.screenshots must be an array of at most 6 https URLs`);
    else for (const s of m.screenshots) if (!isRegistryUrl(s, opts)) errors.push(`${where}.screenshots entry ${JSON.stringify(s)} must be an https URL`);
  }
  if (m.minRuntime !== undefined && !isSemver(m.minRuntime)) errors.push(`${where}.minRuntime must be a semver version`);
  if (m.license !== undefined && (typeof m.license !== "string" || !LICENSE_RE.test(m.license))) errors.push(`${where}.license must be an SPDX license id`);
  if (m.source !== undefined && !isRegistryUrl(m.source, opts)) errors.push(`${where}.source must be an https URL`);

  const d = m.download;
  if (!d || typeof d !== "object" || Array.isArray(d)) errors.push(`${where}.download must be an object { url, sha256, size }`);
  else {
    const dl = d as Record<string, unknown>;
    for (const key of Object.keys(dl)) if (!DOWNLOAD_KEYS.has(key)) warnings.push(`${where}.download: unknown key "${key}" ignored`);
    if (!isRegistryUrl(dl.url, opts)) errors.push(`${where}.download.url must be an https URL`);
    else if (!/\.zip$/i.test(new URL(dl.url as string).pathname)) errors.push(`${where}.download.url must point at a .zip file`);
    if (typeof dl.sha256 !== "string" || !SHA256_RE.test(dl.sha256)) errors.push(`${where}.download.sha256 must be 64 lowercase hex characters`);
    if (typeof dl.size !== "number" || !Number.isInteger(dl.size) || dl.size < 22 || dl.size > REGISTRY_MAX_ZIP_BYTES) errors.push(`${where}.download.size must be an integer byte count between 22 and ${REGISTRY_MAX_ZIP_BYTES}`);
  }

  if (errors.length > 0) return { ok: false, errors, warnings };
  const dl = d as RegistryDownload;
  const entry: RegistryEntry = {
    id: m.id as string,
    name: name!,
    description: description!,
    author: author!,
    homepage: m.homepage as string,
    version: m.version as string,
    apiVersion: m.apiVersion as string,
    permissions,
    tags,
    download: { url: dl.url, sha256: dl.sha256, size: dl.size },
  };
  if (typeof m.icon === "string") entry.icon = m.icon;
  if (Array.isArray(m.screenshots)) entry.screenshots = [...(m.screenshots as string[])];
  if (typeof m.minRuntime === "string") entry.minRuntime = m.minRuntime;
  if (typeof m.license === "string") entry.license = m.license;
  if (typeof m.source === "string") entry.source = m.source;
  return { ok: true, entry, warnings };
}

/** Validates a whole registry index: schema version, every entry, and unique ids. */
export function validateRegistry(raw: unknown, opts: RegistryValidateOptions = {}): RegistryResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, errors: ["registry index must be a JSON object"], warnings };
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) if (!INDEX_KEYS.has(key)) warnings.push(`unknown top-level key "${key}" ignored`);
  if (r.schemaVersion !== REGISTRY_SCHEMA_VERSION) errors.push(`schemaVersion must be ${REGISTRY_SCHEMA_VERSION}`);
  if (!Array.isArray(r.plugins)) return { ok: false, errors: [...errors, "plugins must be an array"], warnings };
  if (r.plugins.length > REGISTRY_MAX_PLUGINS) errors.push(`plugins has more than ${REGISTRY_MAX_PLUGINS} entries`);
  const plugins: RegistryEntry[] = [];
  const seen = new Set<string>();
  r.plugins.slice(0, REGISTRY_MAX_PLUGINS).forEach((item, i) => {
    const res = validateRegistryEntry(item, opts, `plugins[${i}]`);
    warnings.push(...res.warnings);
    if (!res.ok) {
      errors.push(...res.errors);
      return;
    }
    const key = res.entry.id.toLowerCase();
    if (seen.has(key)) errors.push(`plugins[${i}].id "${res.entry.id}" is listed twice`);
    seen.add(key);
    plugins.push(res.entry);
  });
  if (errors.length > 0) return { ok: false, errors, warnings };
  return { ok: true, index: { schemaVersion: 1, plugins }, warnings };
}

/** Case-insensitive text search over id, name, description, author and tags; `tags` must all be present. */
export function searchRegistry(entries: readonly RegistryEntry[], text: string, tags: readonly string[] = []): RegistryEntry[] {
  const q = text.trim().toLowerCase();
  return entries.filter((e) => {
    if (tags.some((t) => !e.tags.includes(t))) return false;
    if (!q) return true;
    return [e.id, e.name, e.description, e.author, ...e.tags].some((s) => s.toLowerCase().includes(q));
  });
}

/** "install" (not installed), "update" (registry is newer), or "installed" (same or newer locally). */
export type RegistryInstallState = "install" | "update" | "installed";

export function registryInstallState(entry: Pick<RegistryEntry, "version">, installedVersion: string | null | undefined): RegistryInstallState {
  if (!installedVersion) return "install";
  if (!isSemver(installedVersion)) return "update";
  return compareSemver(entry.version, installedVersion) > 0 ? "update" : "installed";
}
