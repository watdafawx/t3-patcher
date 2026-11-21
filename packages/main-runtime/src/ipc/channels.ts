import { GRANT_REQUEST_CHANNEL, isValidPluginId, PERMISSION_NAMES, type PermissionSet, REGISTRY_ACTIONS, REGISTRY_REQUEST_CHANNEL, type RegistryAction, TOGGLE_REQUEST_CHANNEL } from "@t3p/api";

import type { Logger } from "../log.js";
import type { NativeServices } from "../native/index.js";
import type { InternalsStatus } from "../internals/status.js";
import type { StorageStore } from "../storage/store.js";
import type { IpcRouter } from "./router.js";
import { s, type Validator } from "./schema.js";

export interface CoreChannelDeps {
  router: IpcRouter;
  log: Logger;
  version: string;
  appVersion: string | null;
  safe: boolean;
  /** Effective permissions of a loaded plugin, or null when it is not loaded. */
  permissionsFor(id: string): PermissionSet | null;
  nativeFor(id: string, perms: PermissionSet): Readonly<NativeServices>;
  pluginsList(): unknown | Promise<unknown>;
  patchReport(): unknown;
  /** Dev mode (T3P_DEV=1): the renderer enables hot reload. */
  dev?: boolean;
  /** Per-plugin storage (t3.storage and t3.settings). */
  storage?: StorageStore;
  /** Plugin manager: enable or disable, and the load order. Persisted in state.json. */
  setEnabled?(id: string, enabled: boolean): { status: string; restartRequired: boolean };
  /**
   * Grants (native dialog, privileged channel only) and revokes (no dialog). See plugins/grants.ts and
   * docs/security.md section 4.6.
   */
  grants?: { request(id: string, permissions: string[] | "*"): Promise<unknown>; revoke(id: string, permissions: string[]): Promise<unknown> };
  setLoadOrder?(order: string[]): string[];
  /**
   * Plugin registry (WP-14A): the index view (read-only, page channel) and install/update/uninstall
   * (native dialog, privileged channel only). See plugins/registry-flow.ts and docs/security.md section 4.7.
   */
  registry?: { view(refresh: boolean): Promise<unknown>; request(action: RegistryAction, id: string): Promise<unknown> };
  /** Trusted plugin enable/disable via native confirmation dialog (privileged channel only). */
  trustedToggle?: { request(id: string, enabled: boolean): Promise<unknown> };
  /** Check GitHub releases for a newer T3 Patcher version. */
  checkUpdate?(force: boolean): Promise<unknown>;
  /** Crash-loop guard: the renderer reports a plugin start outcome (`t3p:plugin-health`). */
  pluginHealth?(plugin: string, ok: boolean, error?: string): boolean;
  /** Tier 2 capture status (renderer reports, `internals-status.json`). */
  internals?: InternalsStatus;
  /** Plugin text patches from the renderer (`t3.patches.register`). Rejects when the plugin does not hold `patches`. */
  pluginPatches?: { register(plugin: string, batch: string, patches: unknown): number; unregister(plugin: string, batch: string): void };
}

const pluginId = s.string({ max: 64, pattern: /^[a-z0-9][a-z0-9.-]*$/ });
const path = s.string({ min: 1, max: 4096 });
const permissionName = s.literal<string>(...PERMISSION_NAMES);
const sqlParam = s.union(s.union(s.string({ max: 65_536 }), s.number()), s.union(s.boolean(), s.nullValue()));

export const schemas = {
  log: s.object({ level: s.literal("debug", "info", "warn", "error"), message: s.string({ max: 8000 }), plugin: s.optional(pluginId) }),
  fsRead: s.object({ plugin: pluginId, path, encoding: s.optional(s.literal("utf8", "base64")), offset: s.optional(s.int({ min: 0 })), maxBytes: s.optional(s.int({ min: 0 })) }),
  sqliteQuery: s.object({
    plugin: pluginId,
    path,
    sql: s.string({ min: 1, max: 20_000 }),
    params: s.optional(s.array(sqlParam, { max: 100 })),
    maxRows: s.optional(s.int({ min: 1 })),
    timeoutMs: s.optional(s.int({ min: 1 })),
  }),
  setEnabled: s.object({ id: pluginId, enabled: s.boolean() }),
  revoke: s.object({ id: pluginId, permissions: s.array(permissionName, { max: PERMISSION_NAMES.length }) }),
  registryIndex: s.object({ refresh: s.optional(s.boolean()) }),
  registryRequest: s.object({ action: s.literal<RegistryAction>(...REGISTRY_ACTIONS), id: pluginId }),
  grantRequest: s.object({ id: pluginId, permissions: s.union(s.literal("*"), s.array(permissionName, { max: PERMISSION_NAMES.length })) }),
  pluginHealth: s.object({ plugin: pluginId, ok: s.boolean(), error: s.optional(s.string({ max: 500 })) }),
  setLoadOrder: s.object({ order: s.array(pluginId, { max: 200 }) }),
  internalsReport: s.object({ name: s.string({ max: 64 }), state: s.string({ max: 16 }), detail: s.optional(s.string({ max: 500 })) }),
  patchesRegister: s.object({ plugin: pluginId, batch: s.string({ min: 1, max: 64, pattern: /^[A-Za-z0-9._-]+$/ }), patches: s.json({ maxBytes: 400_000 }) }),
  patchesUnregister: s.object({ plugin: pluginId, batch: s.string({ min: 1, max: 64, pattern: /^[A-Za-z0-9._-]+$/ }) }),
  storageRead: s.object({ plugin: pluginId }),
  storageWrite: s.object({
    plugin: pluginId,
    area: s.literal("kv", "settings"),
    op: s.literal("set", "delete", "clear"),
    key: s.optional(s.string({ min: 1, max: 256 })),
    value: s.optional(s.json({ maxBytes: 1_100_000 })),
  }),
  logTail: s.object({ plugin: pluginId, path, cursor: s.optional(s.int({ min: 0 })), maxBytes: s.optional(s.int({ min: 1 })) }),
  spawn: s.object({
    plugin: pluginId,
    exe: path,
    args: s.optional(s.array(s.string({ max: 8192 }), { max: 64 })),
    timeoutMs: s.optional(s.int({ min: 1 })),
    stdin: s.optional(s.string({ max: 1_000_000 })),
  }),
};

/**
 * Fixed `t3p:` channels. Native calls from the renderer name the plugin they act
 * for and get exactly that plugin's effective grants. All renderer code shares
 * one JS world, so this is attribution, not isolation: the renderer as a whole
 * can reach the union of what enabled plugins were granted (docs/security.md).
 */
export function registerCoreChannels(deps: CoreChannelDeps): void {
  const { router, log } = deps;
  const rendererLog = log.child("renderer");

  router.handle("t3p:ping", s.none(), () => ({ pong: true, version: deps.version, appVersion: deps.appVersion, safe: deps.safe, time: Date.now() }));
  router.handle("t3p:log", schemas.log, (p) => {
    const l = p.plugin ? rendererLog.child(p.plugin) : rendererLog;
    l[p.level](p.message);
    return true;
  });
  router.handle("t3p:plugins:list", s.none(), async () => ({
    version: deps.version,
    appVersion: deps.appVersion,
    safe: deps.safe,
    dev: deps.dev === true,
    plugins: await deps.pluginsList(),
    patches: deps.patchReport(),
  }));

  const { storage } = deps;
  const loaded = (plugin: string): void => {
    if (!isValidPluginId(plugin)) throw new Error("t3p: invalid plugin id");
    if (!deps.permissionsFor(plugin)) throw new Error(`t3p: plugin ${plugin} is not loaded`);
  };
  if (storage) {
    router.handle("t3p:storage:read", schemas.storageRead, (p) => {
      loaded(p.plugin);
      return storage.read(p.plugin);
    });
    router.handle("t3p:storage:write", schemas.storageWrite, (p) => {
      loaded(p.plugin);
      if (p.op === "clear") return storage.apply(p.plugin, { area: p.area, op: "clear" });
      if (p.key === undefined) throw new Error("t3p: storage key is required");
      if (p.op === "delete") return storage.apply(p.plugin, { area: p.area, op: "delete", key: p.key });
      if (p.value === undefined) throw new Error("t3p: storage value is required");
      return storage.apply(p.plugin, { area: p.area, op: "set", key: p.key, value: p.value });
    });
  }
  if (deps.setEnabled) {
    const setEnabled = deps.setEnabled;
    router.handle("t3p:plugins:set-enabled", schemas.setEnabled, (p) => setEnabled(p.id, p.enabled));
  }
  if (deps.grants) {
    const grants = deps.grants;
    router.handle("t3p:plugins:revoke", schemas.revoke, (p) => grants.revoke(p.id, p.permissions));
    // Privileged: not in the page bridge's allowlist. Only the preload's trusted-click listener sends it,
    // and it only opens the native dialog; the user's answer there is the authorization.
    router.handle(GRANT_REQUEST_CHANNEL, schemas.grantRequest, (p) => grants.request(p.id, p.permissions));
  }
  if (deps.registry) {
    const registry = deps.registry;
    router.handle("t3p:registry:index", schemas.registryIndex, (p) => registry.view(p.refresh === true));
    // Privileged, like the grant request: only the preload's trusted-click listener sends it. The page
    // names an action and an id; the entry itself comes from the index the main process fetched.
    router.handle(REGISTRY_REQUEST_CHANNEL, schemas.registryRequest, (p) => registry.request(p.action, p.id));
  }
  if (deps.trustedToggle) {
    const trustedToggle = deps.trustedToggle;
    router.handle(TOGGLE_REQUEST_CHANNEL, schemas.setEnabled, (p) => trustedToggle.request(p.id, p.enabled));
  }
  if (deps.checkUpdate) {
    const checkUpdate = deps.checkUpdate;
    router.handle("t3p:update:check", schemas.registryIndex, (p) => checkUpdate(p.refresh === true));
  }
  if (deps.setLoadOrder) {
    const setLoadOrder = deps.setLoadOrder;
    router.handle("t3p:plugins:set-load-order", schemas.setLoadOrder, (p) => ({ order: setLoadOrder(p.order) }));
  }

  if (deps.pluginHealth) {
    const pluginHealth = deps.pluginHealth;
    router.handle("t3p:plugin-health", schemas.pluginHealth, (p) => ({ disabled: pluginHealth(p.plugin, p.ok, p.error) }));
  }

  const { internals, pluginPatches } = deps;
  if (internals) {
    router.handle("t3p:internals:report", schemas.internalsReport, (p) => internals.report(p.name, p.state, p.detail));
  }
  if (pluginPatches) {
    router.handle("t3p:patches:register", schemas.patchesRegister, (p) => {
      loaded(p.plugin);
      const count = pluginPatches.register(p.plugin, p.batch, p.patches);
      log.info(`patches registered by ${p.plugin} (${p.batch}): ${count}`);
      return { registered: count };
    });
    router.handle("t3p:patches:unregister", schemas.patchesUnregister, (p) => {
      loaded(p.plugin);
      pluginPatches.unregister(p.plugin, p.batch);
      return true;
    });
  }

  const service = <K extends keyof NativeServices>(plugin: string, key: K, permission: string): NonNullable<NativeServices[K]> => {
    if (!isValidPluginId(plugin)) throw new Error("t3p: invalid plugin id");
    const perms = deps.permissionsFor(plugin);
    if (!perms) throw new Error(`t3p: plugin ${plugin} is not loaded`);
    const fn = deps.nativeFor(plugin, perms)[key];
    if (!fn) throw new Error(`t3p: ${permission} is not granted to ${plugin}`);
    return fn as NonNullable<NativeServices[K]>;
  };
  const strip = <T extends { plugin: string }>(p: T): Omit<T, "plugin"> => {
    const { plugin: _plugin, ...rest } = p;
    return rest;
  };

  const native = <T extends { plugin: string }>(channel: string, schema: Validator<T>, key: keyof NativeServices, permission: string): void => {
    router.handle(channel, schema, (p) => {
      const fn = service(p.plugin, key, permission) as (request: unknown) => unknown;
      log.info(`native ${permission} for ${p.plugin}`);
      return fn(strip(p));
    });
  };
  native("t3p:native:fs.read", schemas.fsRead, "fsRead", "fs.read");
  native("t3p:native:sqlite.query", schemas.sqliteQuery, "sqliteQuery", "sqlite.read");
  native("t3p:native:log.tail", schemas.logTail, "logTail", "log.tail");
  native("t3p:native:spawn", schemas.spawn, "spawn", "spawn");
}
