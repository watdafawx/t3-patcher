import { parsePermissions, type PermissionSet } from "./permissions.js";

/** plugin.json as written by a plugin author. */
export interface PluginManifestJson {
  id: string;
  name?: string;
  description?: string;
  author?: string;
  version: string;
  /** Highest API stability tier the plugin uses: 1 stable, 2 internals, 3 raw patches. */
  tier: 1 | 2 | 3;
  permissions?: unknown[];
  /** T3 Code versions the plugin supports: exact ("0.1.10"), wildcard ("0.1.x"), or "*". */
  t3Versions: string[];
  /** API version the plugin was written for: "1" or "1.2" (needs at least that minor of the same major). Omitted means "1". */
  t3pApi?: string;
  /** Main-process entry, relative to the plugin folder (needs the "main" permission). */
  main?: string;
  /** Renderer entry (ES module), relative to the plugin folder. */
  renderer?: string;
}

/** A validated manifest with normalized permissions. */
export interface PluginManifest {
  id: string;
  name: string;
  description?: string;
  author?: string;
  version: string;
  tier: 1 | 2 | 3;
  permissions: PermissionSet;
  t3Versions: string[];
  t3pApi: string;
  main?: string;
  renderer?: string;
}

export type ManifestResult =
  | { ok: true; manifest: PluginManifest; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

const KNOWN_KEYS = new Set([
  "id",
  "name",
  "description",
  "author",
  "version",
  "tier",
  "permissions",
  "t3Versions",
  "t3pApi",
  "main",
  "renderer",
  "$schema",
]);

const ID_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const T3_VERSION_RE = /^(\*|(\d+|x)\.(\d+|x)\.(\d+|x)(?:-[0-9A-Za-z.-]+)?)$/;
const API_RANGE_RE = /^\d+(\.(\d+|x))?$/;

/**
 * True when a plugin written for API range `range` ("1", "1.x", "1.2") can run on API `current`
 * ("1.0"): same major, and the plugin's minor is not newer than the runtime's. Omitted range = "1".
 */
export function apiCompatible(range: string | undefined, current: string): boolean {
  const want = (range ?? "1").split(".");
  const have = current.split(".");
  if (Number(want[0]) !== Number(have[0])) return false;
  if (want[1] === undefined || want[1] === "x") return true;
  return Number(want[1]) <= Number(have[1] ?? 0);
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** True for a plugin id that is safe as a folder name and as an IPC namespace segment. */
export function isValidPluginId(id: unknown): id is string {
  return typeof id === "string" && id.length <= 64 && ID_RE.test(id) && !WINDOWS_RESERVED.test(id);
}

/**
 * A plugin-relative entry path: forward slashes only, no absolute paths, no
 * `..`/`.` segments, no drive letters or colons, JavaScript extension.
 */
export function isValidEntryPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) return false;
  if (value.includes("\\") || value.includes(":") || value.includes("\0") || value.startsWith("/")) return false;
  const segments = value.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return false;
    if (/[. ]$/.test(segment)) return false; // Windows strips trailing dots and spaces
    if (WINDOWS_RESERVED.test(segment)) return false;
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
    if (/[<>"|?*\u0000-\u001f]/.test(segment)) return false;
  }
  return /\.(c|m)?js$/.test(value);
}

/** Validates plugin.json. `folderName`, when given, must equal the id. */
export function validateManifest(raw: unknown, folderName?: string): ManifestResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["plugin.json must be a JSON object"], warnings };
  }
  const m = raw as Record<string, unknown>;
  for (const key of Object.keys(m)) if (!KNOWN_KEYS.has(key)) warnings.push(`unknown key "${key}" ignored`);

  if (!isValidPluginId(m.id)) errors.push('"id" must be lowercase [a-z0-9-] segments separated by dots, max 64 chars');
  else if (folderName !== undefined && folderName !== m.id) errors.push(`"id" (${m.id}) must equal the folder name (${folderName})`);

  if (typeof m.version !== "string" || !VERSION_RE.test(m.version)) errors.push('"version" must be a semver string like "1.0.0"');
  if (m.tier !== 1 && m.tier !== 2 && m.tier !== 3) errors.push('"tier" must be 1, 2 or 3');
  for (const key of ["name", "description", "author"] as const) {
    if (m[key] !== undefined && (typeof m[key] !== "string" || (m[key] as string).length > 512)) {
      errors.push(`"${key}" must be a string`);
    }
  }

  if (!Array.isArray(m.t3Versions) || m.t3Versions.length === 0) {
    errors.push('"t3Versions" must be a non-empty array, e.g. ["0.1.x"]');
  } else {
    for (const v of m.t3Versions) {
      if (typeof v !== "string" || !T3_VERSION_RE.test(v)) errors.push(`"t3Versions" entry ${JSON.stringify(v)} is not a version pattern`);
    }
  }

  if (m.t3pApi !== undefined && (typeof m.t3pApi !== "string" || !API_RANGE_RE.test(m.t3pApi))) errors.push('"t3pApi" must look like "1", "1.x" or "1.2"');

  if (m.permissions !== undefined && !Array.isArray(m.permissions)) errors.push('"permissions" must be an array');
  const perms = parsePermissions(m.permissions ?? [], "permissions");
  errors.push(...perms.errors);

  for (const key of ["main", "renderer"] as const) {
    if (m[key] !== undefined && !isValidEntryPath(m[key])) {
      errors.push(`"${key}" must be a relative .js/.cjs/.mjs path inside the plugin folder (forward slashes, no "..")`);
    }
  }
  if (m.main !== undefined && !perms.set.main) errors.push('a plugin with a "main" entry must declare the "main" permission');
  if (m.main === undefined && m.renderer === undefined) warnings.push("plugin has neither a main nor a renderer entry");

  if (errors.length > 0) return { ok: false, errors, warnings };
  const manifest: PluginManifest = {
    id: m.id as string,
    name: (m.name as string | undefined) ?? (m.id as string),
    version: m.version as string,
    tier: m.tier as 1 | 2 | 3,
    permissions: perms.set,
    t3Versions: [...(m.t3Versions as string[])],
    t3pApi: (m.t3pApi as string | undefined) ?? "1",
  };
  if (typeof m.description === "string") manifest.description = m.description;
  if (typeof m.author === "string") manifest.author = m.author;
  if (typeof m.main === "string") manifest.main = m.main;
  if (typeof m.renderer === "string") manifest.renderer = m.renderer;
  return { ok: true, manifest, warnings };
}

/** True when `version` (e.g. "0.1.10" or "0.1.11-nightly.2026") matches one of the patterns. */
export function matchesT3Version(patterns: readonly string[], version: string | null): boolean {
  if (patterns.includes("*")) return true;
  if (!version) return false;
  const [base, pre] = splitPre(version);
  const parts = base.split(".");
  return patterns.some((pattern) => {
    const [pBase, pPre] = splitPre(pattern);
    const pParts = pBase.split(".");
    if (pParts.length !== 3 || parts.length !== 3) return false;
    for (let i = 0; i < 3; i++) if (pParts[i] !== "x" && pParts[i] !== parts[i]) return false;
    // An explicit prerelease in the pattern must match exactly; otherwise any prerelease of the base matches.
    return pPre === null || pPre === pre;
  });
}

function splitPre(v: string): [string, string | null] {
  const i = v.indexOf("-");
  return i < 0 ? [v, null] : [v.slice(0, i), v.slice(i + 1)];
}
