import { CAPTURES } from "@t3p/main-runtime/patch-catalog";
import { applyServerGuardPatch, applyServerMcpPatch, applyServerRelayPatch, SERVER_GUARD_FIND, SERVER_MCP_FIND, SERVER_RELAY_FIND } from "@t3p/main-runtime/server-patch-catalog";
import type { ChunkSet, Patch } from "@t3p/patch-engine";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Patch findings. Every first-party `find` must match exactly one chunk of the
 * client; zero means the patched code moved, more than one means the anchor is
 * no longer unique. Either way the patch would be disabled at runtime.
 */

export interface FindEntry {
  /** Patch owner, e.g. "t3p.core" or a plugin id. */
  owner: string;
  /** What the patch is for: capture name, or the label from a patch file. */
  label: string;
  /** Where the entry came from, for the report. */
  origin: string;
  patch: Patch;
}

export interface FindResult {
  owner: string;
  label: string;
  origin: string;
  find: string;
  hits: string[];
  status: "ok" | "no-match" | "ambiguous";
  /** Why a non-text patch did not apply (server guard). */
  detail?: string;
}

function describe(find: string | RegExp): string {
  return typeof find === "string" ? find : String(find);
}

function matches(source: string, find: string | RegExp): boolean {
  if (typeof find === "string") return source.includes(find);
  return new RegExp(find.source, find.flags).test(source);
}

export function scanFinds(chunks: ChunkSet, entries: readonly FindEntry[]): FindResult[] {
  return entries.map((entry) => {
    const hits: string[] = [];
    for (const [name, source] of chunks) {
      if (matches(source, entry.patch.find)) hits.push(name);
    }
    hits.sort();
    const status = hits.length === 1 ? "ok" : hits.length === 0 ? "no-match" : "ambiguous";
    return {
      owner: entry.owner,
      label: entry.label,
      origin: entry.origin,
      find: describe(entry.patch.find),
      hits,
      status,
    };
  });
}

export const CORE_CATALOG_ORIGIN = "packages/main-runtime/src/patches/captures.ts";
export const SERVER_GUARD_ORIGIN = "packages/main-runtime/src/guard/server-patch.ts";
export const SERVER_MCP_ORIGIN = "packages/main-runtime/src/guard/mcp-patch.ts";
export const SERVER_RELAY_ORIGIN = "packages/main-runtime/src/guard/relay-acp-patch.ts";
/**
 * The server-side ACP relay patch: `applyServerRelayPatch` must apply to exactly one server chunk.
 * Null when there is no server bundle to check.
 */
export function serverRelayFinding(chunks: ReadonlyMap<string, string> | undefined): FindResult | null {
  if (!chunks || chunks.size === 0) return null;
  const hits: string[] = [];
  const failures: string[] = [];
  for (const [name, source] of chunks) {
    if (!source.includes(SERVER_RELAY_FIND)) continue;
    const result = applyServerRelayPatch(source);
    if (result.ok) hits.push(name);
    else failures.push(`${name}: ${result.reason} (${result.detail})`);
  }
  hits.sort();
  const status = hits.length === 1 ? "ok" : hits.length === 0 ? "no-match" : "ambiguous";
  return {
    owner: "t3p.core",
    label: "serverRelay",
    origin: SERVER_RELAY_ORIGIN,
    find: SERVER_RELAY_FIND,
    hits,
    status,
    ...(failures.length > 0 ? { detail: failures.join("; ") } : {}),
  };
}


/**
 * The server-side turn guard patch (WP-6C): the runtime's own `applyServerGuardPatch` must apply to
 * exactly one server chunk. Null when there is no server bundle to check (dir or source targets).
 */
export function serverGuardFinding(chunks: ReadonlyMap<string, string> | undefined): FindResult | null {
  if (!chunks || chunks.size === 0) return null;
  const hits: string[] = [];
  const failures: string[] = [];
  for (const [name, source] of chunks) {
    if (!source.includes(SERVER_GUARD_FIND)) continue;
    const result = applyServerGuardPatch(source);
    if (result.ok) hits.push(name);
    else failures.push(`${name}: ${result.reason} (${result.detail})`);
  }
  hits.sort();
  const status = hits.length === 1 ? "ok" : hits.length === 0 ? "no-match" : "ambiguous";
  return {
    owner: "t3p.core",
    label: "serverGuard",
    origin: SERVER_GUARD_ORIGIN,
    find: SERVER_GUARD_FIND,
    hits,
    status,
    ...(failures.length > 0 ? { detail: failures.join("; ") } : {}),
  };
}

/**
 * The server-side MCP tools patch (`t3_provider_limits`): `applyServerMcpPatch` must apply to
 * exactly one server chunk. Null when there is no server bundle to check.
 */
export function serverMcpFinding(chunks: ReadonlyMap<string, string> | undefined): FindResult | null {
  if (!chunks || chunks.size === 0) return null;
  const hits: string[] = [];
  const failures: string[] = [];
  for (const [name, source] of chunks) {
    if (!source.includes(SERVER_MCP_FIND)) continue;
    const result = applyServerMcpPatch(source);
    if (result.ok) hits.push(name);
    else failures.push(`${name}: ${result.reason} (${result.detail})`);
  }
  hits.sort();
  const status = hits.length === 1 ? "ok" : hits.length === 0 ? "no-match" : "ambiguous";
  return {
    owner: "t3p.core",
    label: "serverMcpTools",
    origin: SERVER_MCP_ORIGIN,
    find: SERVER_MCP_FIND,
    hits,
    status,
    ...(failures.length > 0 ? { detail: failures.join("; ") } : {}),
  };
}

/**
 * The tier 2 capture patches, imported from the same module the runtime builds
 * into `main.cjs`, so the checker can never drift from the shipped patches.
 */
export function corePatchFinds(): FindEntry[] {
  return CAPTURES.flatMap((capture) =>
    capture.patches.map((patch, index) => ({
      owner: patch.plugin,
      label: capture.patches.length > 1 ? `${capture.name}[${index}]` : capture.name,
      origin: CORE_CATALOG_ORIGIN,
      patch,
    })),
  );
}

interface JsonFind {
  name?: string;
  label?: string;
  plugin?: string;
  owner?: string;
  find?: string;
  findRegex?: { source?: string; flags?: string };
}

function parseFind(value: unknown, index: number, file: string): { patch: Patch; label: string } {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${file}: patch ${index} must be an object`);
  }
  const raw = value as JsonFind;
  const label = raw.label ?? raw.name ?? `patch[${index}]`;
  if (raw.findRegex !== undefined) {
    if (typeof raw.findRegex.source !== "string") {
      throw new Error(`${file}: patch ${index} findRegex.source must be a string`);
    }
    const find = new RegExp(raw.findRegex.source, raw.findRegex.flags ?? "");
    return { patch: { plugin: raw.plugin ?? raw.owner ?? "patch-file", find, replacement: [] }, label };
  }
  if (typeof raw.find !== "string") {
    throw new Error(`${file}: patch ${index} needs a string "find" or a "findRegex"`);
  }
  return {
    patch: { plugin: raw.plugin ?? raw.owner ?? "patch-file", find: raw.find, replacement: [] },
    label,
  };
}

/**
 * Reads a find-only patch file: an array of
 * `{name?, plugin?, find | findRegex: {source, flags?}}`. Only the `find` is
 * used here; the patch engine's own `t3p-patch-test` runs the replacements.
 */
export function readPatchFile(file: string): FindEntry[] {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`${file}: expected a JSON array of patches`);
  return parsed.map((value, index) => {
    const { patch, label } = parseFind(value, index, file);
    return { owner: patch.plugin, label, origin: file, patch };
  });
}

/**
 * Optional per-plugin patch files: `plugins/<id>/patches.json` in the same
 * format as `--patch-file`. First-party plugins register their patches at
 * runtime today, so most have no such file.
 */
export function pluginPatchFinds(pluginsDir: string): FindEntry[] {
  if (!existsSync(pluginsDir)) return [];
  const entries: FindEntry[] = [];
  for (const name of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const file = join(pluginsDir, name.name, "patches.json");
    if (!existsSync(file)) continue;
    entries.push(...readPatchFile(file));
  }
  return entries;
}
