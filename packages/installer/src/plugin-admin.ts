import { clearHealth, emptyHealth, emptyState, grantPermission, HEALTH_FILE, type HealthJson, parseHealth, parseState, type PatcherStateJson, pluginState, revokePermission, setEnabled, validateManifest } from "@t3p/api";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { T3pError } from "./errors.js";

/**
 * Plugin state commands: `t3p grant|revoke|enable|disable|plugins|safe`.
 * They only edit <home>/.t3-patcher/state.json (and the safe-mode marker); the
 * runtime reads them at the next app start. Granting is the user's consent:
 * the runtime applies only what is both declared in plugin.json and granted.
 */

export function patcherBase(homeDir?: string): string {
  return join(homeDir ?? (process.env.T3P_HOME || homedir()), ".t3-patcher");
}

export function healthPath(homeDir?: string): string {
  return join(patcherBase(homeDir), HEALTH_FILE);
}

/** Crash-loop counters (health.json). Missing or broken = no failures. */
export function readHealth(homeDir?: string): HealthJson {
  try {
    return parseHealth(JSON.parse(readFileSync(healthPath(homeDir), "utf8")));
  } catch {
    return emptyHealth();
  }
}

function writeHealth(health: HealthJson, homeDir?: string): void {
  const file = healthPath(homeDir);
  mkdirSync(patcherBase(homeDir), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(health, null, 2)}
`);
  renameSync(tmp, file);
}

export function statePath(homeDir?: string): string {
  return join(patcherBase(homeDir), "state.json");
}

/** Reads state.json. A broken file is an error here (unlike the runtime, which fails closed): never overwrite what we cannot read. */
export function readState(homeDir?: string): PatcherStateJson {
  const file = statePath(homeDir);
  if (!existsSync(file)) return emptyState();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new T3pError(`${file} is not valid JSON (${(error as Error).message}); fix or delete it first.`);
  }
  const { state, errors } = parseState(raw);
  if (errors.length > 0) throw new T3pError(`${file} is invalid: ${errors.join("; ")}`);
  return state;
}

export function writeState(state: PatcherStateJson, homeDir?: string): string {
  const file = statePath(homeDir);
  mkdirSync(patcherBase(homeDir), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, file);
  return file;
}

function requireId(id: string | undefined): string {
  if (!id) throw new T3pError("missing plugin id");
  return id;
}

export interface GrantOpts {
  homeDir?: string;
  id?: string;
  permission?: string;
  /** --root (fs.read, sqlite.read, log.tail) or --allow (spawn) values. */
  scope?: string[];
}

export function grant(opts: GrantOpts): PatcherStateJson {
  const id = requireId(opts.id);
  if (!opts.permission) throw new T3pError("missing permission name");
  const state = readState(opts.homeDir);
  try {
    grantPermission(state, id, opts.permission, opts.scope ?? []);
  } catch (error) {
    throw new T3pError((error as Error).message);
  }
  writeState(state, opts.homeDir);
  return state;
}

export function revoke(opts: GrantOpts): PatcherStateJson {
  const id = requireId(opts.id);
  if (!opts.permission) throw new T3pError("missing permission name");
  const state = readState(opts.homeDir);
  revokePermission(state, id, opts.permission);
  writeState(state, opts.homeDir);
  return state;
}

export function enable(opts: { homeDir?: string; id?: string; enabled: boolean }): PatcherStateJson {
  const id = requireId(opts.id);
  const state = readState(opts.homeDir);
  setEnabled(state, id, opts.enabled);
  writeState(state, opts.homeDir);
  // `t3p enable` is the way out of a crash-loop disable: it clears the reason (setEnabled) and the failure counter.
  if (opts.enabled && readHealth(opts.homeDir).plugins[id]) writeHealth(clearHealth(readHealth(opts.homeDir), id), opts.homeDir);
  return state;
}

export interface PluginListing {
  id: string;
  valid: boolean;
  enabled: boolean;
  version?: string;
  declared?: unknown;
  granted: unknown;
  errors: string[];
  /** Set when the crash-loop guard disabled the plugin (`crash-loop`). */
  disabledReason?: string;
  /** Failed starts in a row recorded in health.json. */
  failures?: number;
}

/** Lists plugin folders with their manifest status and state. */
export function listPlugins(homeDir?: string): PluginListing[] {
  const dir = join(patcherBase(homeDir), "plugins");
  const state = existsSync(statePath(homeDir)) ? readState(homeDir) : emptyState();
  if (!existsSync(dir)) return [];
  const health = readHealth(homeDir);
  const out: PluginListing[] = [];
  for (const name of readdirSync(dir).sort((a, b) => a.localeCompare(b))) {
    try {
      // statSync follows junctions: a `t3p dev` link is listed like a normal folder.
      if (!statSync(join(dir, name)).isDirectory()) continue;
    } catch {
      continue;
    }
    const ps = pluginState(state, name);
    const listing: PluginListing = { id: name, valid: false, enabled: ps.enabled, granted: ps.granted, errors: [] };
    try {
      const result = validateManifest(JSON.parse(readFileSync(join(dir, name, "plugin.json"), "utf8")), name);
      if (result.ok) {
        listing.valid = true;
        listing.version = result.manifest.version;
        listing.declared = result.manifest.permissions;
      } else listing.errors = result.errors;
    } catch (error) {
      listing.errors = [(error as Error).message];
    }
    if (ps.disabledReason) listing.disabledReason = ps.disabledReason;
    const failures = health.plugins[name]?.failures;
    if (failures) listing.failures = failures;
    out.push(listing);
  }
  return out;
}

/** `t3p safe`: the next app start runs without plugins and patches (the marker is consumed). `--off` removes a pending marker. */
export function safeMode(opts: { homeDir?: string; off?: boolean }): { marker: string; pending: boolean } {
  const marker = join(patcherBase(opts.homeDir), "safe-mode");
  if (opts.off) {
    rmSync(marker, { force: true });
    return { marker, pending: false };
  }
  mkdirSync(patcherBase(opts.homeDir), { recursive: true });
  writeFileSync(marker, `requested ${new Date().toISOString()}\n`);
  return { marker, pending: true };
}
