import { isValidPluginId } from "./manifest.js";
import {
  isRootPermission,
  parsePermissions,
  permissionsToJson,
  type PermissionJson,
  type PermissionSet,
} from "./permissions.js";

/**
 * <home>/.t3-patcher/state.json: what the user enabled and granted.
 *
 * ```json
 * { "version": 1,
 *   "plugins": {
 *     "test-plugin": { "enabled": true, "granted": ["main", {"fs.read": {"roots": ["~/.t3/caches"]}}] } } }
 * ```
 *
 * A plugin folder without an entry here is disabled and has no grants.
 */
export interface PluginStateJson {
  enabled: boolean;
  granted: PermissionJson[];
  /** Why the plugin is disabled when the host did it (`crash-loop`). Cleared by `t3p enable`. Optional: older files lack it. */
  disabledReason?: string;
}

export interface PatcherStateJson {
  version: 1;
  plugins: Record<string, PluginStateJson>;
  /**
   * Optional renderer load order (plugin ids). Plugins listed here load first, in this order;
   * the rest follow sorted by id. Written by the plugin manager (`t3p:plugins:set-load-order`).
   */
  loadOrder?: string[];
}

export interface PluginState {
  enabled: boolean;
  granted: PermissionSet;
  disabledReason?: string;
}

export function emptyState(): PatcherStateJson {
  return { version: 1, plugins: {} };
}

/** Tolerant parse: anything malformed becomes "disabled, nothing granted" (fail closed). */
export function parseState(raw: unknown): { state: PatcherStateJson; errors: string[] } {
  const errors: string[] = [];
  const state = emptyState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) errors.push("state.json is not an object");
    return { state, errors };
  }
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) errors.push("state.json version is not 1");
  if (Array.isArray(r.loadOrder)) {
    const order = r.loadOrder.filter((id): id is string => isValidPluginId(id));
    if (order.length > 0) state.loadOrder = [...new Set(order)].slice(0, 200);
  }
  const plugins = r.plugins;
  if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) return { state, errors };
  for (const [id, value] of Object.entries(plugins as Record<string, unknown>)) {
    if (!isValidPluginId(id)) {
      errors.push(`state.json: invalid plugin id ${JSON.stringify(id)}`);
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const perms = parsePermissions(v.granted ?? [], `plugins.${id}.granted`);
    errors.push(...perms.errors);
    const entry: PluginStateJson = { enabled: v.enabled === true, granted: permissionsToJson(perms.set) };
    if (typeof v.disabledReason === "string" && v.enabled !== true) entry.disabledReason = v.disabledReason.slice(0, 64);
    state.plugins[id] = entry;
  }
  return { state, errors };
}

export function pluginState(state: PatcherStateJson, id: string): PluginState {
  const entry = Object.prototype.hasOwnProperty.call(state.plugins, id) ? state.plugins[id] : undefined;
  if (!entry) return { enabled: false, granted: {} };
  const out: PluginState = { enabled: entry.enabled === true, granted: parsePermissions(entry.granted).set };
  if (entry.disabledReason && !out.enabled) out.disabledReason = entry.disabledReason;
  return out;
}

function entryFor(state: PatcherStateJson, id: string): PluginStateJson {
  if (!isValidPluginId(id)) throw new Error(`invalid plugin id ${JSON.stringify(id)}`);
  const existing = Object.prototype.hasOwnProperty.call(state.plugins, id) ? state.plugins[id] : undefined;
  if (existing) return existing;
  const created: PluginStateJson = { enabled: false, granted: [] };
  state.plugins[id] = created;
  return created;
}

export function setEnabled(state: PatcherStateJson, id: string, enabled: boolean): PatcherStateJson {
  const entry = entryFor(state, id);
  entry.enabled = enabled;
  // Enabling clears the host's reason; a user disable also drops a stale one.
  delete entry.disabledReason;
  return state;
}

/** The crash-loop guard disables a plugin and records why. */
export function disableWithReason(state: PatcherStateJson, id: string, reason: string): PatcherStateJson {
  const entry = entryFor(state, id);
  entry.enabled = false;
  entry.disabledReason = reason;
  return state;
}

/**
 * Adds a grant. `scope` is the root list (fs.read, sqlite.read, log.tail) or
 * executable list (spawn); merged with what was granted before.
 */
export function grantPermission(state: PatcherStateJson, id: string, name: string, scope: string[] = []): PatcherStateJson {
  const entry = entryFor(state, id);
  let json: PermissionJson;
  if (name === "main" || name === "patches" || name === "rpc" || name === "guard") json = name;
  else if (isRootPermission(name)) json = { [name]: { roots: scope } } as PermissionJson;
  else if (name === "spawn") json = { spawn: { allow: scope } };
  else throw new Error(`unknown permission "${name}"`);
  const parsed = parsePermissions([...entry.granted, json], "grant");
  if (parsed.errors.length > 0) throw new Error(parsed.errors.join("; "));
  entry.granted = permissionsToJson(parsed.set);
  return state;
}

export function revokePermission(state: PatcherStateJson, id: string, name: string): PatcherStateJson {
  const entry = entryFor(state, id);
  const set = parsePermissions(entry.granted).set;
  delete (set as Record<string, unknown>)[name];
  entry.granted = permissionsToJson(set);
  return state;
}
