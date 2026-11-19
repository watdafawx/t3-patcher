import { realpathSync } from "node:fs";
import { posix, win32 } from "node:path";

/**
 * Path containment for native services (fs.read, sqlite.read, log.tail) and the
 * plugin file route. Two stages, both must pass:
 *
 * 1. Lexical (pure, tested with path.win32 semantics): rejects NUL/control
 *    chars, UNC and device namespaces (\\server, \\?\, \\.\, \??\), drive-relative
 *    paths, `.`/`..` segments, NTFS alternate data streams (`:`), trailing dots
 *    and spaces, reserved device names (CON, NUL, COM1, ...), wildcard chars,
 *    then checks the normalized path is inside a root (case-insensitive on Windows).
 * 2. Real path: realpath (follows symlinks, junctions and other reparse points,
 *    expands 8.3 short names) of the target and of each root, containment again.
 *
 * Not covered (see docs/security.md): hard links inside a root, and a race where
 * something with the user's rights swaps a path component between check and open.
 */

export type PathPlatform = "win32" | "posix";

export interface PathPolicy {
  platform: PathPlatform;
  /** Home directory used to expand a leading `~`. */
  home: string;
}

export type PathCheck = { ok: true; path: string } | { ok: false; reason: string };

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)( *\..*)?$/i;
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const WIN_BAD_CHARS = /[<>"|?*\u0000-\u001f]/;
const MAX_PATH = 4096;

function pathApi(platform: PathPlatform): typeof win32 {
  return platform === "win32" ? win32 : posix;
}

/** Expands a leading `~` or `~/` / `~\` to the home directory. */
export function expandHome(p: string, policy: PathPolicy): string {
  if (p === "~") return policy.home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return pathApi(policy.platform).join(policy.home, p.slice(2));
  return p;
}

/** Stage 1 for one path: syntax rules plus normalization. Does not touch the disk. */
export function lexicalNormalize(input: unknown, policy: PathPolicy): PathCheck {
  if (typeof input !== "string") return { ok: false, reason: "path must be a string" };
  if (input.length === 0 || input.length > MAX_PATH) return { ok: false, reason: "path length out of range" };
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f]/.test(input)) return { ok: false, reason: "control character in path" };
  const expanded = expandHome(input, policy);

  if (policy.platform === "posix") {
    if (!expanded.startsWith("/")) return { ok: false, reason: "path must be absolute" };
    const segments = expanded.split("/").filter((s) => s !== "");
    if (segments.some((s) => s === "." || s === "..")) return { ok: false, reason: "'.' or '..' segment" };
    return { ok: true, path: posix.normalize(expanded) };
  }

  const p = expanded.replace(/\//g, "\\");
  if (p.startsWith("\\\\") || p.startsWith("\\??\\")) return { ok: false, reason: "UNC or device namespace path" };
  if (!/^[A-Za-z]:\\/.test(p)) return { ok: false, reason: "path must be absolute with a drive letter (C:\\...)" };
  const segments = p.slice(3).split("\\").filter((s) => s !== "");
  for (const segment of segments) {
    if (segment === "." || segment === "..") return { ok: false, reason: "'.' or '..' segment" };
    if (segment.includes(":")) return { ok: false, reason: "':' in a path segment (alternate data stream)" };
    if (/[. ]$/.test(segment)) return { ok: false, reason: "segment ends with a dot or space" };
    if (WIN_RESERVED.test(segment)) return { ok: false, reason: `reserved device name "${segment}"` };
    if (WIN_BAD_CHARS.test(segment)) return { ok: false, reason: "invalid character in path" };
  }
  return { ok: true, path: win32.normalize(`${p.slice(0, 2).toUpperCase()}\\${segments.join("\\")}`) };
}

/** True when `candidate` equals `root` or is below it. Both must already be normalized. */
export function isWithin(root: string, candidate: string, platform: PathPlatform): boolean {
  const sep = platform === "win32" ? "\\" : "/";
  const r = platform === "win32" ? root.toLowerCase() : root;
  const c = platform === "win32" ? candidate.toLowerCase() : candidate;
  if (r === c) return true;
  const prefix = r.endsWith(sep) ? r : r + sep;
  return c.startsWith(prefix);
}

/** Stage 1 for a request against a root list. Returns the normalized path and the matching root. */
export function lexicalCheck(input: unknown, roots: readonly string[], policy: PathPolicy): PathCheck & { root?: string } {
  const target = lexicalNormalize(input, policy);
  if (!target.ok) return target;
  for (const rawRoot of roots) {
    const root = lexicalNormalize(rawRoot, policy);
    if (root.ok && isWithin(root.path, target.path, policy.platform)) return { ok: true, path: target.path, root: root.path };
  }
  return { ok: false, reason: "path is outside every granted root" };
}

export interface ResolveOptions extends PathPolicy {
  /** Injectable for tests; defaults to fs.realpathSync.native. */
  realpath?: (p: string) => string;
}

/**
 * Both stages. Returns the real (canonical) path to open. Fails closed: a
 * missing file, an unreadable root or any error is a rejection.
 */
export function resolveAllowedPath(input: unknown, roots: readonly string[], options: ResolveOptions): PathCheck {
  const lexical = lexicalCheck(input, roots, options);
  if (!lexical.ok) return lexical;
  const realpath = options.realpath ?? ((p: string) => realpathSync.native(p));
  let real: string;
  try {
    real = realpath(lexical.path);
  } catch {
    return { ok: false, reason: "path does not exist or cannot be resolved" };
  }
  for (const rawRoot of roots) {
    const root = lexicalNormalize(rawRoot, options);
    if (!root.ok) continue;
    let realRoot: string;
    try {
      realRoot = realpath(root.path);
    } catch {
      continue;
    }
    if (isWithin(stripLongPrefix(realRoot), stripLongPrefix(real), options.platform)) return { ok: true, path: real };
  }
  return { ok: false, reason: "resolved path escapes the granted roots (link or junction)" };
}

function stripLongPrefix(p: string): string {
  return p.startsWith("\\\\?\\") && /^[A-Za-z]:/.test(p.slice(4)) ? p.slice(4) : p;
}

/**
 * Decodes the segments of a URL path below a fixed prefix for the plugin file
 * route. Each decoded segment must be a plain file name (no separators, no `.`
 * or `..`, no `:`, no trailing dot/space, no reserved names).
 */
export function decodeUrlSegments(rest: string): string[] | null {
  if (rest.length === 0 || rest.length > 512) return null;
  const out: string[] = [];
  for (const raw of rest.split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (segment === "" || segment === "." || segment === "..") return null;
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
    if (/[\\/:\u0000-\u001f<>"|?*]/.test(segment)) return null;
    if (/[. ]$/.test(segment) || WIN_RESERVED.test(segment)) return null;
    out.push(segment);
  }
  return out;
}
