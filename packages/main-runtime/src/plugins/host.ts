import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve as resolvePath, sep } from "node:path";

import {
  apiCompatible,
  clearHealth,
  CRASH_LOOP_REASON,
  disableWithReason,
  emptyHealth,
  HEALTH_WINDOW_MS,
  parseHealth,
  recordOutcome,
  type HealthJson,
  effectivePermissions,
  T3_API_VERSION,
  isValidPluginId,
  matchesT3Version,
  PLUGIN_CHANNEL_NAME_RE,
  pluginChannel,
  type PermissionSet,
  type PluginManifest,
  type PermissionJson,
  permissionsToJson,
  pluginState,
  setEnabled as setStateEnabled,
  validateManifest,
  type BeforeStartOptions,
  type TurnStartHandler,
} from "@t3p/api";
import type { Patch } from "@t3p/patch-engine";

import type { IpcRouter } from "../ipc/router.js";
import { s } from "../ipc/schema.js";
import type { Logger } from "../log.js";
import type { NativeServices } from "../native/index.js";
import { type PathPlatform, resolveAllowedPath } from "../native/path-guard.js";
import type { PatchRegistry } from "../patches/registry.js";
import { readStateFile, writeStateFile } from "./state-io.js";

export type PluginStatus = "disabled" | "invalid" | "incompatible" | "active" | "failed" | "loaded";

export interface PluginRecord {
  id: string;
  dir: string;
  status: PluginStatus;
  manifest: PluginManifest | null;
  effective: PermissionSet;
  errors: string[];
  /** t3code://app/__t3p/plugins/<id>/<renderer>, when the renderer entry should load. */
  rendererUrl: string | null;
  mainLoaded: boolean;
  activateMs: number | null;
  /** The user changed something that only a restart applies (a main plugin was disabled). */
  restartRequired: boolean;
  /** Set when the crash-loop guard disabled the plugin (`crash-loop`). */
  disabledReason: string | null;
}

/** The object a main entry's activate(ctx) receives. Absent keys = permission not granted. */
export interface PluginContext {
  readonly id: string;
  readonly version: string;
  readonly log: Logger;
  readonly ipc: { handle(name: string, fn: (payload: unknown) => unknown): void };
  readonly events: { emit(name: string, payload?: unknown): boolean };
  readonly patches?: { register(patches: Patch[]): void };
  readonly native?: Readonly<NativeServices>;
  /** Turn-start guard (needs the `guard` permission). See `T3Threads.beforeStart`. */
  readonly threads?: { beforeStart(handler: TurnStartHandler, options?: BeforeStartOptions): { dispose(): void } };
}

export interface PluginHostDeps {
  pluginsDir: string;
  stateFile: string;
  appVersion: string | null;
  router: IpcRouter;
  registry: PatchRegistry;
  nativeFor(perms: PermissionSet): Readonly<NativeServices>;
  log: Logger;
  platform: PathPlatform;
  activateTimeoutMs?: number;
  /** Turn guard: main-process `beforeStart` handlers. Missing = `ctx.threads` is not offered. */
  addGuardHandler?(plugin: string, handler: TurnStartHandler, timeoutMs?: number): () => void;
  /** Test seam: loads a main entry file. Defaults to Node's require. */
  load?: (file: string) => unknown;
  /** health.json (crash-loop counters). Default: next to the state file. */
  healthFile?: string;
  /** Dev mode: failures are counted and logged, never auto-disabled. */
  dev?: boolean;
  /** Failures in a row before auto-disable. Default 3 (T3P_CRASH_LOOP_THRESHOLD). */
  crashThreshold?: number;
  /** Test seam for the clean-window timer. */
  healthWindowMs?: number;
}

const MAX_MANIFEST = 64 * 1024;
const MAX_PLUGINS = 200;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Discovers plugins in <home>/.t3-patcher/plugins/<id>/plugin.json, validates
 * them, and activates the main entries of enabled plugins that hold the "main"
 * grant. Each plugin is isolated by try/catch and an activate() timeout; a
 * failing plugin is unregistered (IPC handlers, patches) and marked failed,
 * and the others keep loading.
 */
export class PluginHost {
  readonly records = new Map<string, PluginRecord>();
  private readonly disposers = new Map<string, Array<() => void>>();
  /** Optional cleanup function returned by a main entry's activate(ctx). Presence enables hot-reload. */
  private readonly mainDisposers = new Map<string, () => unknown>();
  /** state.json `loadOrder`: these ids first, the rest sorted by id. */
  private loadOrder: string[] = [];

  constructor(private readonly deps: PluginHostDeps) {}

  /** Scans and activates. Never throws. */
  async loadAll(options: { safe: boolean }): Promise<void> {
    const log = this.deps.log;
    if (options.safe) {
      log.info("safe mode: plugins not loaded");
      return;
    }
    const state = readStateFile(this.deps.stateFile, log);
    this.loadOrder = state.loadOrder ?? [];
    let names: string[];
    try {
      names = readdirSync(this.deps.pluginsDir).slice(0, MAX_PLUGINS);
    } catch {
      log.info(`no plugins dir at ${this.deps.pluginsDir}`);
      return;
    }
    for (const name of this.ordered(names)) {
      try {
        await this.loadOne(name, state);
      } catch (error) {
        log.error(`plugin ${name}: unexpected host error`, error);
      }
    }
    const summary = [...this.records.values()].map((r) => `${r.id}=${r.status}`).join(", ");
    log.info(`plugins: ${summary || "none"}`);
  }

  /** `loadOrder` entries first (in that order), the others sorted by id. */
  ordered<T extends string>(ids: readonly T[]): T[] {
    const rank = new Map(this.loadOrder.map((id, i) => [id, i] as const));
    return [...ids].sort((a, b) => {
      const ra = rank.get(a);
      const rb = rank.get(b);
      if (ra !== undefined && rb !== undefined) return ra - rb;
      if (ra !== undefined) return -1;
      if (rb !== undefined) return 1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }

  private record(id: string, dir: string): PluginRecord {
    const rec: PluginRecord = { id, dir, status: "invalid", manifest: null, effective: {}, errors: [], rendererUrl: null, mainLoaded: false, activateMs: null, restartRequired: false, disabledReason: null };
    this.records.set(id, rec);
    return rec;
  }

  private async loadOne(name: string, state: ReturnType<typeof readStateFile>): Promise<void> {
    const log = this.deps.log;
    const dir = join(this.deps.pluginsDir, name);
    try {
      if (!statSync(dir).isDirectory()) return;
    } catch {
      return;
    }
    if (!isValidPluginId(name)) {
      log.warn(`plugins: skipping folder ${JSON.stringify(name)} (not a valid plugin id)`);
      return;
    }
    const rec = this.record(name, dir);
    let raw: unknown;
    try {
      const text = readFileSync(join(dir, "plugin.json"), "utf8");
      if (text.length > MAX_MANIFEST) throw new Error("plugin.json is too large");
      raw = JSON.parse(text);
    } catch (error) {
      rec.errors.push(`plugin.json: ${(error as Error).message}`);
      log.warn(`plugin ${name}: ${rec.errors.at(-1)}`);
      return;
    }
    const result = validateManifest(raw, name);
    for (const warning of result.warnings) log.warn(`plugin ${name}: ${warning}`);
    if (!result.ok) {
      rec.errors.push(...result.errors);
      log.warn(`plugin ${name}: invalid manifest: ${result.errors.join("; ")}`);
      return;
    }
    const manifest = result.manifest;
    rec.manifest = manifest;
    const ps = pluginState(state, name);
    // Declared ∩ granted, for disabled plugins too: the Plugins page derives its "granted" rows and
    // "needs N" badge from `list()`, and a disabled plugin with grants must not look ungranted.
    // Loaded plugins are the only ones served this set at runtime (permissionsFor/anyHolds check status).
    rec.effective = effectivePermissions(manifest.permissions, ps.granted, { caseInsensitive: this.deps.platform === "win32" });
    if (!ps.enabled) {
      rec.status = "disabled";
      rec.disabledReason = ps.disabledReason ?? null;
      return;
    }
    if (!apiCompatible(manifest.t3pApi, T3_API_VERSION)) {
      rec.status = "incompatible";
      rec.errors.push(`t3pApi ${manifest.t3pApi} is not supported by plugin API ${T3_API_VERSION}`);
      log.warn(`plugin ${name}: ${rec.errors.at(-1)}`);
      return;
    }
    if (!matchesT3Version(manifest.t3Versions, this.deps.appVersion)) {
      rec.status = "incompatible";
      rec.errors.push(`t3Versions ${manifest.t3Versions.join(", ")} does not match T3 Code ${this.deps.appVersion ?? "unknown"}`);
      log.warn(`plugin ${name}: ${rec.errors.at(-1)}`);
      return;
    }

    if (manifest.main) {
      if (!rec.effective.main) {
        rec.status = "failed";
        rec.errors.push('main entry present but the "main" permission is not granted');
        log.warn(`plugin ${name}: ${rec.errors.at(-1)}`);
        return;
      }
      const ok = await this.activateMain(rec, manifest);
      if (!ok) {
        this.reportHealth(rec.id, false, rec.errors.at(-1));
        return;
      }
      // A main-only plugin has no renderer to report; a clean window resets its counter.
      if (!manifest.renderer) this.scheduleCleanWindow(rec.id);
    }
    rec.status = manifest.main ? "active" : "loaded";
    if (manifest.renderer) rec.rendererUrl = `t3code://app/__t3p/plugins/${encodeURIComponent(name)}/${manifest.renderer.split("/").map(encodeURIComponent).join("/")}`;
  }

  private async activateMain(rec: PluginRecord, manifest: PluginManifest): Promise<boolean> {
    const log = this.deps.log.child(`plugin:${rec.id}`);
    const entry = resolveAllowedPath(join(rec.dir, ...manifest.main!.split("/")), [rec.dir], { platform: this.deps.platform, home: rec.dir });
    if (!entry.ok) return this.fail(rec, `main entry rejected: ${entry.reason}`);
    const started = performance.now();
    try {
      const load = this.deps.load ?? ((file: string) => createRequire(join(rec.dir, "plugin.json"))(file));
      const mod = load(entry.path) as { activate?: unknown; default?: { activate?: unknown } } | null;
      rec.mainLoaded = true;
      const activate = typeof mod?.activate === "function" ? mod.activate : typeof mod?.default?.activate === "function" ? mod.default.activate : null;
      if (!activate) return this.fail(rec, "main entry does not export activate(ctx)");
      const ctx = this.makeContext(rec, manifest, log);
      const returned = await withTimeout(
        Promise.resolve().then(() => (activate as (c: PluginContext) => unknown)(ctx)),
        this.deps.activateTimeoutMs ?? 5000,
        "activate()",
      );
      if (typeof returned === "function") this.mainDisposers.set(rec.id, returned as () => unknown);
      rec.activateMs = Math.round(performance.now() - started);
      log.info(`activated in ${rec.activateMs} ms`);
      return true;
    } catch (error) {
      log.error("activate failed", error);
      return this.fail(rec, `activate failed: ${(error as Error)?.message ?? String(error)}`);
    }
  }

  /** True when a plugin can be torn down and reloaded in-process without restarting the app. */
  private canHotUnload(rec: PluginRecord): boolean {
    return !rec.mainLoaded || this.mainDisposers.has(rec.id);
  }

  /** Evicts CommonJS require.cache entries inside a plugin's directory so the next require() loads fresh code. */
  private evictRequireCache(dir: string): void {
    try {
      const req = createRequire(join(dir, "plugin.json"));
      const cache = req.cache;
      if (!cache) return;
      const prefix = resolvePath(dir) + sep;
      const lowerPrefix = this.deps.platform === "win32" ? prefix.toLowerCase() : prefix;
      for (const key of Object.keys(cache)) {
        const cmp = this.deps.platform === "win32" ? key.toLowerCase() : key;
        if (cmp.startsWith(lowerPrefix)) delete cache[key];
      }
    } catch {
      // ignore if require.cache is unavailable
    }
  }

  /** Tears down a running main-process plugin: runs its returned disposer, unregisters IPC/patches/guards, and evicts require.cache. */
  private async deactivateMain(id: string): Promise<void> {
    const rec = this.records.get(id);
    const cleanup = this.mainDisposers.get(id);
    this.mainDisposers.delete(id);
    if (cleanup) {
      try {
        await withTimeout(Promise.resolve().then(() => cleanup()), this.deps.activateTimeoutMs ?? 5000, "deactivate()");
      } catch (error) {
        this.deps.log.warn(`plugin ${id}: deactivate failed: ${(error as Error)?.message ?? String(error)}`);
      }
    }
    for (const dispose of this.disposers.get(id) ?? []) {
      try {
        dispose();
      } catch {
        // keep disposing the rest
      }
    }
    this.disposers.delete(id);
    this.deps.registry.unregisterOwner(id);
    if (rec) this.evictRequireCache(rec.dir);
  }

  private fail(rec: PluginRecord, message: string): false {
    rec.status = "failed";
    rec.errors.push(message);
    rec.rendererUrl = null;
    this.deps.log.warn(`plugin ${rec.id}: ${message}`);
    for (const dispose of this.disposers.get(rec.id) ?? []) {
      try {
        dispose();
      } catch {
        // keep disposing the rest
      }
    }
    this.disposers.delete(rec.id);
    this.deps.registry.unregisterOwner(rec.id);
    return false;
  }

  private makeContext(rec: PluginRecord, manifest: PluginManifest, log: Logger): PluginContext {
    const disposers: Array<() => void> = [];
    this.disposers.set(rec.id, disposers);
    const router = this.deps.router;
    const ctx: Record<string, unknown> = {
      id: rec.id,
      version: manifest.version,
      log,
      ipc: Object.freeze({
        handle: (name: string, fn: (payload: unknown) => unknown): void => {
          if (typeof name !== "string" || !PLUGIN_CHANNEL_NAME_RE.test(name)) throw new Error(`invalid channel name ${JSON.stringify(name)}`);
          if (typeof fn !== "function") throw new Error("handler must be a function");
          if (rec.status === "failed") throw new Error("plugin is disabled");
          disposers.push(router.handle(pluginChannel(rec.id, name), s.json(), (payload) => fn(payload)));
        },
      }),
      events: Object.freeze({
        emit: (name: string, payload?: unknown): boolean =>
          typeof name === "string" && PLUGIN_CHANNEL_NAME_RE.test(name) && router.emit("t3p:plugin-event", { plugin: rec.id, name, payload }),
      }),
    };
    if (rec.effective.patches) {
      ctx.patches = Object.freeze({
        register: (patches: Patch[]): void => {
          if (!Array.isArray(patches)) throw new Error("patches must be an array");
          if (rec.status === "failed") throw new Error("plugin is disabled");
          disposers.push(this.deps.registry.register(rec.id, patches));
        },
      });
    }
    const addGuard = this.deps.addGuardHandler;
    if (rec.effective.guard && addGuard) {
      ctx.threads = Object.freeze({
        beforeStart: (handler: TurnStartHandler, options?: BeforeStartOptions): { dispose(): void } => {
          if (typeof handler !== "function") throw new Error("handler must be a function");
          if (rec.status === "failed") throw new Error("plugin is disabled");
          const remove = addGuard(rec.id, handler, options?.timeoutMs);
          disposers.push(remove);
          return { dispose: remove };
        },
      });
    }
    const native = this.deps.nativeFor(rec.effective);
    if (Object.keys(native).length > 0) ctx.native = native;
    return Object.freeze(ctx) as unknown as PluginContext;
  }

  /** Plugin dir for the file route: only plugins whose renderer may load. */
  rendererDir(id: string): string | null {
    const rec = this.records.get(id);
    return rec && rec.rendererUrl ? rec.dir : null;
  }

  /** Effective permissions of a plugin that is loaded and not failed (renderer native calls). */
  permissionsFor(id: string): PermissionSet | null {
    const rec = this.records.get(id);
    return rec && (rec.status === "active" || rec.status === "loaded") ? rec.effective : null;
  }

  /** True when any loaded, non-failed plugin holds the effective permission (declared, granted, enabled). Read live. */
  anyHolds(name: "embed.youtube"): boolean {
    for (const rec of this.records.values()) if ((rec.status === "active" || rec.status === "loaded") && rec.effective[name]) return true;
    return false;
  }

  list(): Array<Omit<PluginRecord, "dir" | "manifest"> & { name: string | null; version: string | null; tier: number | null; declared: PermissionJson[] }> {
    const byId = this.records;
    return this.ordered([...byId.keys()]).map((id) => byId.get(id)!).map((r) => ({
      id: r.id,
      name: r.manifest?.name ?? null,
      version: r.manifest?.version ?? null,
      tier: r.manifest?.tier ?? null,
      declared: r.manifest ? permissionsToJson(r.manifest.permissions) : [],
      restartRequired: r.restartRequired,
      disabledReason: r.disabledReason,
      status: r.status,
      effective: r.effective,
      errors: [...r.errors],
      rendererUrl: r.rendererUrl,
      mainLoaded: r.mainLoaded,
      activateMs: r.activateMs,
    }));
  }

  /** What the grant dialog needs to know about a plugin (valid manifest only). */
  grantTarget(id: string): { id: string; name: string; version: string; declared: PermissionSet; effective: PermissionSet; hasMain: boolean } | null {
    const rec = this.records.get(id);
    if (!rec || !rec.manifest) return null;
    // A disabled plugin has no effective set yet: compare against what state.json grants.
    const effective =
      rec.status === "active" || rec.status === "loaded"
        ? rec.effective
        : effectivePermissions(rec.manifest.permissions, pluginState(readStateFile(this.deps.stateFile, this.deps.log), id).granted, { caseInsensitive: this.deps.platform === "win32" });
    return { id, name: rec.manifest.name, version: rec.manifest.version, declared: rec.manifest.permissions, effective, hasMain: rec.manifest.main !== undefined || rec.mainLoaded };
  }

  /**
   * After a grant or revoke written to state.json: reload a renderer-only plugin's record now (its
   * effective permissions change live, native calls read them per call). A plugin with main code
   * hot-reloads if its activate(ctx) returned a disposer; otherwise it keeps its record until the
   * next start (`restartRequired`).
   */
  async applyPermissionChange(id: string): Promise<{ restartRequired: boolean }> {
    const rec = this.records.get(id);
    if (!rec) return { restartRequired: false };
    if (rec.mainLoaded && !this.canHotUnload(rec)) {
      rec.restartRequired = true;
      return { restartRequired: true };
    }
    if (rec.mainLoaded) await this.deactivateMain(id);
    const state = readStateFile(this.deps.stateFile, this.deps.log);
    this.records.delete(id);
    try {
      await this.loadOne(id, state);
    } catch (error) {
      this.deps.log.error(`plugin ${id}: reload after a permission change failed`, error);
    }
    return { restartRequired: false };
  }

  /**
   * Enable or disable a plugin on behalf of the renderer plugin manager, and persist it in state.json.
   * This never grants a native permission. Rules:
   * - A plugin with a `main` entry or the `patches` permission is trusted main-process code: the
   *   renderer cannot enable it (only `t3p enable` can). Disabling it is allowed and persists, but its
   *   main code keeps running until the next start (`restartRequired`).
   * - A renderer-only plugin is enabled or disabled live.
   * Grants go only through the native dialog (plugins/grants.ts), never through this call.
   */
  setEnabled(id: string, enabled: boolean): { status: PluginStatus; restartRequired: boolean } {
    if (!isValidPluginId(id)) throw new Error("t3p: invalid plugin id");
    const rec = this.records.get(id);
    if (!rec || !rec.manifest) throw new Error(`t3p: unknown or invalid plugin ${id}`);
    const manifest = rec.manifest;
    const trusted = manifest.main !== undefined || manifest.permissions.patches === true || manifest.permissions.spawn !== undefined;
    if (enabled && trusted) {
      throw new Error("t3p: this plugin runs in the main process or holds powerful permissions; enable it with `t3p enable` and `t3p grant`");
    }
    const state = readStateFile(this.deps.stateFile, this.deps.log);
    setStateEnabled(state, id, enabled);
    writeStateFile(this.deps.stateFile, state);
    if (enabled) this.clearHealthFor(id);
    this.deps.log.info(`plugin ${id}: ${enabled ? "enabled" : "disabled"} from the renderer`);
    if (trusted) {
      rec.restartRequired = true;
      return { status: rec.status, restartRequired: true };
    }
    this.reloadRecord(id, state);
    return { status: this.records.get(id)?.status ?? "invalid", restartRequired: false };
  }

  private get healthFile(): string {
    return this.deps.healthFile ?? join(dirname(this.deps.stateFile), "health.json");
  }

  private readHealth(): HealthJson {
    try {
      return parseHealth(JSON.parse(readFileSync(this.healthFile, "utf8")));
    } catch {
      return emptyHealth();
    }
  }

  private writeHealth(health: HealthJson): void {
    try {
      mkdirSync(dirname(this.healthFile), { recursive: true });
      const tmp = `${this.healthFile}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(health, null, 2)}
`, "utf8");
      renameSync(tmp, this.healthFile);
    } catch (error) {
      this.deps.log.warn(`health.json not written: ${String(error)}`);
    }
  }

  private scheduleCleanWindow(id: string): void {
    const timer = setTimeout(() => this.reportHealth(id, true), this.deps.healthWindowMs ?? HEALTH_WINDOW_MS);
    (timer as { unref?: () => void }).unref?.();
  }

  /**
   * Crash-loop guard. `ok: false` is a failed start (or an attributed uncaught error inside the health
   * window): it adds 1 to the plugin's counter in health.json. `ok: true` is a clean window: counter back to 0.
   * At the threshold the plugin is disabled in state.json with reason `crash-loop`, unless dev mode is on
   * (then it is counted and logged only). Returns whether the plugin was disabled.
   */
  reportHealth(id: string, ok: boolean, error?: string): boolean {
    if (!isValidPluginId(id) || !this.records.has(id)) return false;
    const health = this.readHealth();
    if (ok && !health.plugins[id]) return false;
    const threshold = this.deps.crashThreshold ?? 3;
    const outcome = recordOutcome(health, id, ok, threshold, error);
    this.writeHealth(health);
    if (ok) return false;
    this.deps.log.warn(`plugin ${id}: failed start ${outcome.failures}/${threshold}${error ? `: ${error}` : ""}`);
    if (!outcome.tripped) return false;
    if (this.deps.dev) {
      this.deps.log.warn(`plugin ${id}: crash-loop threshold reached, not disabled (dev mode)`);
      return false;
    }
    const state = readStateFile(this.deps.stateFile, this.deps.log);
    disableWithReason(state, id, CRASH_LOOP_REASON);
    writeStateFile(this.deps.stateFile, state);
    const rec = this.records.get(id)!;
    rec.status = "disabled";
    rec.disabledReason = CRASH_LOOP_REASON;
    rec.rendererUrl = null;
    this.deps.log.error(`plugin ${id}: disabled after ${outcome.failures} failed starts (crash-loop). Re-enable with: t3p enable ${id}`);
    return true;
  }

  /** `t3p enable` also does this from the CLI; exposed for the renderer manager's enable. */
  clearHealthFor(id: string): void {
    this.writeHealth(clearHealth(this.readHealth(), id));
  }

  /** Persists the renderer load order (plugin ids). Takes effect for the next `plugins:list` and the next start. */
  setLoadOrder(order: string[]): string[] {
    const clean = [...new Set(order.filter((id) => isValidPluginId(id)))].slice(0, MAX_PLUGINS);
    const state = readStateFile(this.deps.stateFile, this.deps.log);
    if (clean.length > 0) state.loadOrder = clean;
    else delete state.loadOrder;
    writeStateFile(this.deps.stateFile, state);
    this.loadOrder = clean;
    return clean;
  }

  /**
   * Dev mode: picks up plugin folders that appeared and state.json changes (enable, disable, grant) without
   * a restart. Returns the ids whose record changed. Main-process plugins that returned a disposer from
   * activate(ctx) are hot-reloaded only when their enabled/grant state actually changed.
   */
  async rescan(): Promise<string[]> {
    const state = readStateFile(this.deps.stateFile, this.deps.log);
    let names: string[];
    try {
      names = readdirSync(this.deps.pluginsDir).slice(0, MAX_PLUGINS);
    } catch {
      return [];
    }
    const sig = (r: PluginRecord | undefined): string => (r ? JSON.stringify([r.status, r.effective, r.rendererUrl, r.errors, r.manifest?.version ?? null]) : "none");
    const changed: string[] = [];
    // A folder that disappeared: forget the record (a main plugin without a disposer stays until restart).
    for (const [id, rec] of [...this.records]) {
      if (names.includes(id)) continue;
      if (rec.mainLoaded && !this.canHotUnload(rec)) continue;
      if (rec.mainLoaded) await this.deactivateMain(id);
      this.records.delete(id);
      changed.push(id);
    }
    for (const name of this.ordered(names)) {
      if (!isValidPluginId(name)) continue;
      const old = this.records.get(name);
      if (old && old.mainLoaded) {
        if (!this.canHotUnload(old)) continue;
        // Avoid tearing down a running main plugin when state.json changed for an unrelated plugin.
        const ps = pluginState(state, name);
        const nextEffective = old.manifest
          ? effectivePermissions(old.manifest.permissions, ps.granted, { caseInsensitive: this.deps.platform === "win32" })
          : {};
        if (ps.enabled && JSON.stringify(nextEffective) === JSON.stringify(old.effective)) continue;
        await this.deactivateMain(name);
      }
      const before = sig(old);
      this.records.delete(name);
      try {
        await this.loadOne(name, state);
      } catch (error) {
        this.deps.log.error(`plugin ${name}: rescan failed`, error);
      }
      if (sig(this.records.get(name)) !== before) changed.push(name);
    }
    return changed;
  }

  /**
   * After a registry install, update or uninstall (WP-14A): re-reads the plugin's folder and state.
   * Renderer-only plugins and main plugins that returned a disposer from activate(ctx) reload live
   * with no app restart. Main plugins without a disposer keep running until the next start (`restartRequired`).
   */
  async refreshInstalled(id: string): Promise<{ restartRequired: boolean }> {
    if (!isValidPluginId(id)) return { restartRequired: false };
    const old = this.records.get(id);
    const state = readStateFile(this.deps.stateFile, this.deps.log);
    if (old && old.mainLoaded && !this.canHotUnload(old)) {
      old.restartRequired = true;
      return { restartRequired: true };
    }
    if (old?.mainLoaded) await this.deactivateMain(id);
    this.records.delete(id);
    try {
      await this.loadOne(id, state);
    } catch (error) {
      this.deps.log.error(`plugin ${id}: refresh after a registry change failed`, error);
    }
    return { restartRequired: false };
  }

  /** Re-reads one plugin's manifest and state (after enable/disable or a dev file change). Hot-reloads main plugins that returned a disposer. */
  async reloadRecord(id: string, state = readStateFile(this.deps.stateFile, this.deps.log)): Promise<void> {
    const old = this.records.get(id);
    if (!old) return;
    if (old.mainLoaded && !this.canHotUnload(old)) return; // legacy main plugin without a disposer
    if (old.mainLoaded) await this.deactivateMain(id);
    this.records.delete(id);
    try {
      await this.loadOne(id, state);
    } catch (error: unknown) {
      this.deps.log.error(`plugin ${id}: reload failed`, error);
    }
  }
}
