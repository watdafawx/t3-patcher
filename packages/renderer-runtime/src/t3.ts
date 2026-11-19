import { T3_API_VERSION, type T3Api, type T3Dev, type T3LogLevel } from "@t3p/api";

import { createCacheApi } from "./cache.js";
import { createEventsApi } from "./events.js";
import { createNativeApi } from "./native.js";
import { createProvidersApi } from "./providers.js";
import { createRpcApi, type SharedRpc } from "./rpc.js";
import type { Scope } from "./scope.js";
import type { Shell } from "./shell.js";
import { stubs } from "./stubs.js";
import { createSettingsApi, createStorageApi, type PluginData, type SettingsAccess } from "./storage.js";
import type { GuardClient } from "./guard.js";
import { createThreadsApi } from "./threads.js";
import { createTimelineApi } from "./timeline.js";
import type { EventBus, NativeBridgeLike, PluginListEntry, RemoteLog } from "./types.js";
import { createUsageApi } from "./usage.js";

export interface T3Deps {
  entry: PluginListEntry;
  scope: Scope;
  data: PluginData;
  settings: SettingsAccess;
  systemBus: EventBus;
  pluginBus: EventBus;
  shared: SharedRpc;
  native: NativeBridgeLike | null;
  log: RemoteLog;
  /** Present in dev mode only. */
  dev: T3Dev | null;
  /** WP-3D: implements ui, commands, keybinds, patches, internals. Without it those stay stubs. */
  shell?: Shell | null;
  /** WP-6C turn guard (`t3.threads.beforeStart`). */
  guard?: GuardClient | null;
}

/**
 * Builds the frozen `t3` object of ONE plugin load. Everything registered through it goes into
 * `deps.scope`. To add a namespace implementation (WP-3B and later), replace the matching
 * `stubs.<name>()` call and keep the signature from `@t3p/api`.
 */
export function createT3(deps: T3Deps): T3Api {
  const { entry, scope } = deps;
  const effective = entry.effective ?? {};
  const rpcAllowed = effective.rpc === true;
  const t3: T3Api = {
    apiVersion: T3_API_VERSION,
    id: entry.id,
    plugin: Object.freeze({ id: entry.id, version: entry.version ?? "0.0.0", tier: (entry.tier === 2 || entry.tier === 3 ? entry.tier : 1) as 1 | 2 | 3 }),
    log: (level: T3LogLevel, message: string) => deps.log(level, String(message), entry.id),
    rpc: createRpcApi(entry.id, rpcAllowed, deps.shared, scope, deps.log),
    providers: createProvidersApi(entry.id, rpcAllowed, deps.shared, scope, deps.log),
    threads: createThreadsApi({ id: entry.id, allowed: rpcAllowed, shared: deps.shared, scope, log: deps.log, systemBus: deps.systemBus, guard: deps.guard ?? null, guardAllowed: effective.guard === true }),
    timeline: createTimelineApi({ id: entry.id, allowed: rpcAllowed, shared: deps.shared, scope, log: deps.log }),
    cache: createCacheApi({ id: entry.id, allowed: rpcAllowed, shared: deps.shared, scope, log: deps.log }),
    usage: createUsageApi({ id: entry.id, allowed: rpcAllowed, shared: deps.shared, scope, log: deps.log }),
    ui: stubs.ui(),
    commands: stubs.commands(),
    keybinds: stubs.keybinds(),
    patches: stubs.patches(),
    internals: stubs.internals(),
    storage: createStorageApi(deps.data, scope),
    settings: createSettingsApi(deps.data, deps.settings, scope),
    native: createNativeApi(entry.id, effective, deps.native, scope),
    events: createEventsApi(entry.id, deps.systemBus, deps.pluginBus, scope),
    ...(deps.dev ? { __dev: Object.freeze(deps.dev) } : {}),
  };
  return Object.freeze(deps.shell ? Object.assign(t3, deps.shell.namespaces(entry.id, scope, effective)) : t3);
}
