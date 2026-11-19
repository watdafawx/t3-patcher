/**
 * Plugin permissions.
 *
 * In plugin.json and state.json a permission is written as either a bare name
 * (`"main"`, `"patches"`) or a one-key object carrying its scope
 * (`{"fs.read": {"roots": ["~/.t3/caches"]}}`, `{"spawn": {"allow": ["C:/Tools/x.exe"]}}`).
 *
 * The manifest declares what a plugin asks for; state.json records what the
 * user granted. A plugin only ever receives the intersection of both
 * (see {@link effectivePermissions}).
 */

export const PERMISSION_NAMES = ["main", "patches", "rpc", "fs.read", "sqlite.read", "log.tail", "spawn", "guard", "embed.youtube"] as const;
export type PermissionName = (typeof PERMISSION_NAMES)[number];

/** Permissions that are scoped to filesystem roots. */
export const ROOT_PERMISSIONS = ["fs.read", "sqlite.read", "log.tail"] as const;
export type RootPermissionName = (typeof ROOT_PERMISSIONS)[number];

export interface RootsScope {
  /** Absolute paths, or paths starting with `~/` (the user's home). */
  roots: string[];
}

export interface SpawnScope {
  /** Absolute paths of executables the plugin may start. */
  allow: string[];
}

/** Normalized permission set: one entry per granted/declared permission. */
export interface PermissionSet {
  main?: true;
  patches?: true;
  /** `t3.rpc`: renderer plugins may call the T3 server (consent signal, not a boundary: docs/security.md section 3). */
  rpc?: true;
  /** `t3.threads.beforeStart`: hold, block or redirect turn starts (WP-6C). */
  guard?: true;
  /** Main process sets a Referer on requests to https://www.youtube-nocookie.com/embed/* (one host, nothing else). */
  "embed.youtube"?: true;
  "fs.read"?: RootsScope;
  "sqlite.read"?: RootsScope;
  "log.tail"?: RootsScope;
  spawn?: SpawnScope;
}

/** The JSON form of one permission entry. */
export type PermissionJson =
  | "main"
  | "patches"
  | "rpc"
  | "guard"
  | "embed.youtube"
  | { "fs.read": RootsScope }
  | { "sqlite.read": RootsScope }
  | { "log.tail": RootsScope }
  | { spawn: SpawnScope };

export function isPermissionName(value: unknown): value is PermissionName {
  return typeof value === "string" && (PERMISSION_NAMES as readonly string[]).includes(value);
}

export function isRootPermission(name: string): name is RootPermissionName {
  return (ROOT_PERMISSIONS as readonly string[]).includes(name);
}

const MAX_SCOPE_ENTRIES = 32;
const MAX_PATH_LENGTH = 1024;

/** A scope path must be absolute (drive letter or leading slash) or start with `~/`. No NUL, no UNC/device paths. */
export function isValidScopePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_LENGTH) return false;
  if (value.includes("\0")) return false;
  const p = value.replace(/\\/g, "/");
  if (p.startsWith("//")) return false; // UNC or \\?\ / \\.\ device namespace
  if (p === "~" || p.startsWith("~/")) return true;
  if (/^[A-Za-z]:\//.test(p)) return true;
  if (p.startsWith("/")) return true;
  return false;
}

function parseStringList(value: unknown, key: string, errors: string[], where: string): string[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${where}: expected an object with "${key}"`);
    return null;
  }
  const list = (value as Record<string, unknown>)[key];
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_SCOPE_ENTRIES) {
    errors.push(`${where}: "${key}" must be a non-empty array of at most ${MAX_SCOPE_ENTRIES} paths`);
    return null;
  }
  const out: string[] = [];
  for (const item of list) {
    if (!isValidScopePath(item)) {
      errors.push(`${where}: invalid path ${JSON.stringify(item)} (absolute or ~/..., no UNC/device paths)`);
      return null;
    }
    out.push(item);
  }
  return out;
}

/**
 * Parses a `permissions` array (manifest or state). Unknown or malformed
 * entries are reported in `errors` and left out of the result.
 */
export function parsePermissions(value: unknown, where = "permissions"): { set: PermissionSet; errors: string[] } {
  const errors: string[] = [];
  const set: PermissionSet = {};
  if (value === undefined) return { set, errors };
  if (!Array.isArray(value)) {
    errors.push(`${where}: expected an array`);
    return { set, errors };
  }
  value.forEach((entry, index) => {
    const at = `${where}[${index}]`;
    if (entry === "main" || entry === "patches" || entry === "rpc" || entry === "guard" || entry === "embed.youtube") {
      set[entry as "main" | "patches" | "rpc" | "guard" | "embed.youtube"] = true;
      return;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${at}: unknown permission ${JSON.stringify(entry)}`);
      return;
    }
    const keys = Object.keys(entry);
    if (keys.length !== 1) {
      errors.push(`${at}: a scoped permission is an object with exactly one key`);
      return;
    }
    const name = keys[0]!;
    const scope = (entry as Record<string, unknown>)[name];
    if (isRootPermission(name)) {
      const roots = parseStringList(scope, "roots", errors, `${at}.${name}`);
      if (roots) set[name] = { roots: mergeUnique(set[name]?.roots ?? [], roots) };
      return;
    }
    if (name === "spawn") {
      const allow = parseStringList(scope, "allow", errors, `${at}.spawn`);
      if (allow) set.spawn = { allow: mergeUnique(set.spawn?.allow ?? [], allow) };
      return;
    }
    errors.push(`${at}: unknown permission "${name}"`);
  });
  return { set, errors };
}

function mergeUnique(a: string[], b: string[]): string[] {
  const out = [...a];
  for (const item of b) if (!out.includes(item)) out.push(item);
  return out;
}

/** Back to the JSON array form (stable order). */
export function permissionsToJson(set: PermissionSet): PermissionJson[] {
  const out: PermissionJson[] = [];
  if (set.main) out.push("main");
  if (set.patches) out.push("patches");
  if (set.rpc) out.push("rpc");
  if (set.guard) out.push("guard");
  if (set["embed.youtube"]) out.push("embed.youtube");
  for (const name of ROOT_PERMISSIONS) {
    const scope = set[name];
    if (scope) out.push({ [name]: { roots: [...scope.roots] } } as PermissionJson);
  }
  if (set.spawn) out.push({ spawn: { allow: [...set.spawn.allow] } });
  return out;
}

/** Normalizes a scope path for comparison: forward slashes, no trailing slash, optional case folding. */
export function normalizeScopePath(p: string, caseInsensitive: boolean): string {
  let out = p.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (out.length > 1 && out.endsWith("/") && !/^[A-Za-z]:\/$/.test(out)) out = out.slice(0, -1);
  return caseInsensitive ? out.toLowerCase() : out;
}

/** True when `inner` equals `outer` or lies below it (lexical comparison on normalized paths). */
export function scopeContains(outer: string, inner: string, caseInsensitive: boolean): boolean {
  const o = normalizeScopePath(outer, caseInsensitive);
  const i = normalizeScopePath(inner, caseInsensitive);
  if (i.split("/").includes("..") || o.split("/").includes("..")) return false;
  if (o === i) return true;
  const prefix = o.endsWith("/") ? o : `${o}/`;
  return i.startsWith(prefix);
}

/**
 * The permissions a plugin actually receives: granted AND declared.
 * Scoped permissions keep only granted entries that lie inside a declared
 * entry (roots) or equal one (spawn executables).
 */
export function effectivePermissions(
  declared: PermissionSet,
  granted: PermissionSet,
  options: { caseInsensitive?: boolean } = {},
): PermissionSet {
  const ci = options.caseInsensitive ?? true;
  const out: PermissionSet = {};
  if (declared.main && granted.main) out.main = true;
  if (declared.patches && granted.patches) out.patches = true;
  if (declared.rpc && granted.rpc) out.rpc = true;
  if (declared.guard && granted.guard) out.guard = true;
  if (declared["embed.youtube"] && granted["embed.youtube"]) out["embed.youtube"] = true;
  for (const name of ROOT_PERMISSIONS) {
    const d = declared[name];
    const g = granted[name];
    if (!d || !g) continue;
    const roots = g.roots.filter((root) => d.roots.some((outer) => scopeContains(outer, root, ci)));
    if (roots.length > 0) out[name] = { roots };
  }
  if (declared.spawn && granted.spawn) {
    const d = declared.spawn.allow.map((p) => normalizeScopePath(p, ci));
    const allow = granted.spawn.allow.filter((p) => d.includes(normalizeScopePath(p, ci)));
    if (allow.length > 0) out.spawn = { allow };
  }
  return out;
}
