import type { JsonValue, PermissionJson, PermissionSet, PluginCleanup, PluginModule, RegistryEntry, SettingSchema, SettingValue, T3Api, T3Dev } from "@t3p/api";

import { Scope } from "./scope.js";
import type { SharedRpc } from "./rpc.js";
import { createT3 } from "./t3.js";
import { PluginData, SettingsAccess } from "./storage.js";
import type { EventBus, NativeBridgeLike, PluginListEntry, PluginsListResponse, RemoteLog } from "./types.js";

export type PluginRuntimeStatus = "inactive" | "pending" | "started" | "failed" | "stopped";

/** What the plugin manager (settings page, devtools) sees of one plugin. */
export interface ManagedPlugin {
  id: string;
  name: string;
  version: string | null;
  tier: number | null;
  /** Status the main process reports: disabled, invalid, incompatible, active, failed, loaded. */
  hostStatus: string;
  /** Status of the renderer entry in this page. */
  status: PluginRuntimeStatus;
  error: string | null;
  hasRenderer: boolean;
  declared: PermissionJson[];
  effective: PermissionSet;
  /** A main plugin was disabled: its main code runs until the next start. */
  restartRequired: boolean;
  /** `crash-loop` when the crash-loop guard disabled it (re-enable with `t3p enable <id>`). */
  disabledReason: string | null;
}

export interface PluginLoadResult {
  id: string;
  ok: boolean;
  error?: string;
}

export interface ManagerDeps {
  native: NativeBridgeLike | null;
  importModule(url: string): Promise<Record<string, unknown>>;
  consoleError(...args: unknown[]): void;
  log: RemoteLog;
  mark(label: string): void;
  systemBus: EventBus;
  pluginBus: EventBus;
  shared: SharedRpc;
  /** window.__t3p_plugins: module registry that `$self` patches point at. */
  registry: Record<string, unknown>;
  results: PluginLoadResult[];
  /** start() and import time limit. Default 5000. */
  timeoutMs?: number;
  /** WP-3D shell (ui, commands, keybinds, patches, internals). */
  shell?: import("./shell.js").Shell;
  /**
   * Crash-loop guard: subscribes to uncaught errors and unhandled rejections on the page. The callback gets
   * the error text and stack; the manager attributes it to a plugin by the plugin's file URL in the stack.
   */
  watchErrors?(cb: (message: string, stack: string) => void): () => void;
  /** Clean window after a start before the counter resets. Default 10000. */
  healthWindowMs?: number;
  /** WP-6C turn guard client. */
  guard?: import("./guard.js").GuardClient | null;
}

interface PluginRuntime {
  status: PluginRuntimeStatus;
  error: string | null;
  scope: Scope | null;
  hooks: Hooks | null;
  cleanup: PluginCleanup | null;
  loads: number;
  healthStop?: (() => void) | null;
}

interface Hooks {
  owner: object;
  start: ((t3: T3Api) => unknown) | null;
  stop: (() => unknown) | null;
}

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

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function resolveHooks(mod: Record<string, unknown>): Hooks {
  const def = (typeof mod.default === "object" && mod.default !== null ? mod.default : null) as Partial<PluginModule> | null;
  const named = typeof mod.start === "function";
  const start = (named ? mod.start : def?.start) as Hooks["start"];
  const stop = (typeof mod.stop === "function" ? mod.stop : def?.stop) as Hooks["stop"];
  const owner = named || typeof mod.stop === "function" ? mod : (def ?? mod);
  return { owner, start: typeof start === "function" ? start : null, stop: typeof stop === "function" ? stop : null };
}

function bust(url: string, n: number): string {
  return n === 0 ? url : `${url}${url.includes("?") ? "&" : "?"}t3pv=${n}`;
}

/**
 * The renderer plugin manager. One instance per page.
 *
 * - Loads renderer entries in the order `t3p:plugins:list` returns (state.json `loadOrder`, then id).
 * - A plugin that throws, or whose import or `start()` takes longer than 5 s, is `failed`; the
 *   others are unaffected and everything it registered is disposed.
 * - `stop`, `disable` and `reload` dispose everything the plugin registered through `t3`.
 * - Plugin data (storage, settings) survives reloads.
 */
export class PluginManager {
  readonly #entries = new Map<string, PluginListEntry>();
  readonly #runtime = new Map<string, PluginRuntime>();
  readonly #data = new Map<string, PluginData>();
  readonly #settings = new Map<string, SettingsAccess>();
  readonly #changeListeners = new Set<() => void>();
  readonly #registryListeners = new Set<(result: RegistryResultEvent) => void>();
  #dev = false;
  #order: string[] = [];

  constructor(private readonly deps: ManagerDeps) {}

  get dev(): boolean {
    return this.#dev;
  }

  get #timeout(): number {
    return this.deps.timeoutMs ?? 5000;
  }

  onChange(callback: () => void): () => void {
    this.#changeListeners.add(callback);
    return () => void this.#changeListeners.delete(callback);
  }

  #changed(): void {
    for (const fn of [...this.#changeListeners]) {
      try {
        fn();
      } catch (error) {
        this.deps.consoleError("[t3p] manager listener failed", error);
      }
    }
  }

  /** Fetches `t3p:plugins:list`. Without the bridge there are no plugins. */
  async refresh(): Promise<void> {
    const native = this.deps.native;
    if (!native) return;
    const list = (await native.invoke("t3p:plugins:list")) as PluginsListResponse;
    this.#dev = list.dev === true;
    this.#order = (list.plugins ?? []).map((p) => p.id);
    this.#entries.clear();
    for (const entry of list.plugins ?? []) this.#entries.set(entry.id, entry);
    this.#changed();
  }

  /** Plugin ids in load order (the last plugin list). */
  loadOrder(): readonly string[] {
    return this.#order;
  }

  /** Starts every renderer entry once, in list order. Never rejects. */
  async startAll(): Promise<void> {
    for (const id of this.#order) {
      try {
        await this.start(id);
      } catch (error) {
        this.deps.consoleError(`[t3p] unexpected error starting ${id}`, error);
      }
    }
  }

  #rt(id: string): PluginRuntime {
    let rt = this.#runtime.get(id);
    if (!rt) {
      rt = { status: "inactive", error: null, scope: null, hooks: null, cleanup: null, loads: 0 };
      this.#runtime.set(id, rt);
    }
    return rt;
  }

  dataFor(id: string): PluginData {
    let data = this.#data.get(id);
    if (!data) {
      data = new PluginData(id, this.deps.native, this.deps.log);
      this.#data.set(id, data);
    }
    return data;
  }

  /** The settings of one plugin (the settings page reads and writes through this). */
  settingsFor(id: string): SettingsAccess {
    let access = this.#settings.get(id);
    if (!access) {
      access = new SettingsAccess(this.dataFor(id));
      this.#settings.set(id, access);
    }
    return access;
  }

  #record(result: PluginLoadResult): void {
    const results = this.deps.results;
    const at = results.findIndex((r) => r.id === result.id);
    if (at >= 0) results.splice(at, 1);
    results.push(result);
  }

  /** Imports and starts one plugin. No-op when it has no renderer entry or already runs. */
  async start(id: string): Promise<void> {
    const entry = this.#entries.get(id);
    const rt = this.#rt(id);
    if (!entry?.rendererUrl) {
      rt.status = "inactive";
      this.#changed();
      return;
    }
    if (rt.status === "started" || rt.status === "pending") return;
    const scope = new Scope();
    rt.scope = scope;
    rt.status = "pending";
    rt.error = null;
    rt.cleanup = null;
    rt.hooks = null;
    this.#changed();
    const data = this.dataFor(id);
    try {
      await data.load();
      const mod = await withTimeout(this.deps.importModule(bust(entry.rendererUrl, rt.loads++)), this.#timeout, "import");
      this.deps.registry[id] = mod;
      const hooks = resolveHooks(mod);
      rt.hooks = hooks;
      if (hooks.start) {
        const t3 = createT3({
          entry,
          scope,
          data,
          settings: this.settingsFor(id),
          systemBus: this.deps.systemBus,
          pluginBus: this.deps.pluginBus,
          shared: this.deps.shared,
          native: this.deps.native,
          log: this.deps.log,
          dev: this.#dev ? this.#devApi() : null,
          shell: this.deps.shell ?? null,
          guard: this.deps.guard ?? null,
        });
        const out = await withTimeout(Promise.resolve().then(() => hooks.start!.call(hooks.owner, t3)), this.#timeout, "start()");
        if (typeof out === "function" || (out && typeof (out as { dispose?: unknown }).dispose === "function")) rt.cleanup = out as PluginCleanup;
      }
      rt.status = "started";
      this.#watchHealth(id);
      this.#record({ id, ok: true });
      this.deps.mark(`plugin:${id}`);
      this.deps.systemBus.emit("plugin:started", { id });
    } catch (error) {
      const message = describe(error);
      rt.status = "failed";
      rt.error = message;
      scope.disposeAll((e) => this.deps.consoleError(`[t3p] dispose after failure of ${id}`, e));
      this.#record({ id, ok: false, error: message });
      this.#reportHealth(id, false, message);
      this.deps.consoleError(`[t3p] renderer plugin ${id} failed`, error);
      this.deps.log("error", `renderer entry failed: ${message}`, id);
      this.deps.systemBus.emit("plugin:failed", { id, error: message });
    }
    this.#changed();
  }

  #reportHealth(id: string, ok: boolean, error?: string): void {
    const native = this.deps.native;
    if (!native) return;
    const payload = error === undefined ? { plugin: id, ok } : { plugin: id, ok, error: error.slice(0, 500) };
    native.invoke("t3p:plugin-health", payload).catch(() => undefined);
  }

  /**
   * Crash-loop guard window: for `healthWindowMs` after start(), an uncaught error whose stack names this
   * plugin's file URL counts as a failed start; a quiet window reports ok (counter reset). Errors with no
   * plugin frame in the stack (a minified chunk, a callback queued by app code) cannot be attributed and are ignored.
   */
  #watchHealth(id: string): void {
    const watch = this.deps.watchErrors;
    const rt = this.#rt(id);
    rt.healthStop?.();
    const needle = `/__t3p/plugins/${encodeURIComponent(id)}/`;
    let done = false;
    let stopWatch: (() => void) | null = null;
    const finish = (ok: boolean, error?: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stopWatch?.();
      rt.healthStop = null;
      this.#reportHealth(id, ok, error);
    };
    const timer = setTimeout(() => finish(true), this.deps.healthWindowMs ?? 10_000);
    (timer as { unref?: () => void }).unref?.();
    stopWatch = watch ? watch((message, stack) => (stack.includes(needle) ? finish(false, `uncaught: ${message}`) : undefined)) : null;
    rt.healthStop = () => {
      done = true;
      clearTimeout(timer);
      stopWatch?.();
    };
  }

  /** Runs the plugin's cleanup and `stop()`, then disposes everything it registered. */
  async stop(id: string): Promise<void> {
    const rt = this.#runtime.get(id);
    if (!rt || !rt.scope) return;
    rt.healthStop?.();
    const wasStarted = rt.status === "started";
    const onError = (what: string) => (e: unknown) => {
      this.deps.consoleError(`[t3p] ${id}: ${what} failed`, e);
      this.deps.log("warn", `${what} failed: ${describe(e)}`, id);
    };
    if (wasStarted) {
      const cleanup = rt.cleanup;
      if (cleanup) {
        await withTimeout(Promise.resolve().then(() => (typeof cleanup === "function" ? cleanup() : cleanup.dispose())), this.#timeout, "cleanup").catch(onError("cleanup"));
      }
      const stop = rt.hooks?.stop;
      if (stop) await withTimeout(Promise.resolve().then(() => stop.call(rt.hooks!.owner)), this.#timeout, "stop()").catch(onError("stop()"));
    }
    rt.scope.disposeAll(onError("dispose"));
    rt.scope = null;
    rt.cleanup = null;
    rt.hooks = null;
    rt.status = "stopped";
    if (wasStarted) this.deps.systemBus.emit("plugin:stopped", { id });
    this.#changed();
  }

  /** Stop, re-read the list, re-import the files (cache-busted) and start again. */
  async reload(id: string): Promise<void> {
    await this.stop(id);
    await this.refresh();
    if (!this.#entries.has(id)) {
      // The plugin folder is gone (dev mode): forget it.
      delete this.deps.registry[id];
      this.#runtime.delete(id);
      this.#data.delete(id);
      this.#changed();
      return;
    }
    const rt = this.#rt(id);
    if (rt.status === "stopped" || rt.status === "failed") rt.status = "inactive";
    await this.start(id);
  }

  /** Enables a plugin (persisted in state.json by the main process) and starts it. Throws the main process' refusal. Never grants. */
  async enable(id: string): Promise<ManagedPlugin | null> {
    const native = this.deps.native;
    if (!native) throw new Error("plugin manager: window.__t3p_native is not available");
    await native.invoke("t3p:plugins:set-enabled", { id, enabled: true });
    await this.refresh();
    const rt = this.#rt(id);
    if (rt.status === "stopped" || rt.status === "failed") rt.status = "inactive";
    await this.start(id);
    return this.list().find((p) => p.id === id) ?? null;
  }

  /** Stops a plugin and persists "disabled". */
  async disable(id: string): Promise<{ restartRequired: boolean }> {
    const native = this.deps.native;
    if (!native) throw new Error("plugin manager: window.__t3p_native is not available");
    await this.stop(id);
    const answer = (await native.invoke("t3p:plugins:set-enabled", { id, enabled: false })) as { restartRequired?: boolean };
    await this.refresh();
    const rt = this.#rt(id);
    rt.status = "inactive";
    this.#changed();
    return { restartRequired: answer.restartRequired === true };
  }

  /**
   * Revokes permissions (no dialog: it only removes power). The main process writes state.json and
   * pushes `plugin-permissions-changed`, which reloads the plugin here (see `permissionsChanged`).
   * There is deliberately no `grant`: granting needs a trusted click on a Grant button, which the
   * preload turns into a native dialog (docs/security.md section 4.6).
   */
  async revoke(id: string, permissions: string[]): Promise<{ restartRequired: boolean }> {
    const native = this.deps.native;
    if (!native) throw new Error("plugin manager: window.__t3p_native is not available");
    const answer = (await native.invoke("t3p:plugins:revoke", { id, permissions })) as { restartRequired?: boolean } | null;
    return { restartRequired: answer?.restartRequired === true };
  }

  /**
   * The main process changed a plugin's grants (`t3p:event plugin-permissions-changed`): re-read the
   * list and, unless a restart is needed, restart the plugin's renderer module so it gets a `t3` built
   * from the new permissions.
   */
  async permissionsChanged(id: string, restartRequired: boolean): Promise<void> {
    if (restartRequired || !this.#entries.has(id)) {
      await this.refresh();
      return;
    }
    const rt = this.#runtime.get(id);
    if (rt && (rt.status === "started" || rt.status === "failed" || rt.status === "pending")) await this.reload(id);
    else await this.refresh();
  }

  /**
   * The registry index and what is installed (`t3p:registry:index`, read-only). Install, update and
   * uninstall are never sent from here: the Browse tab's buttons go through the preload (trusted
   * clicks only) and a native dialog in the main process.
   */
  async registry(refresh = false): Promise<RegistryView> {
    const native = this.deps.native;
    if (!native) throw new Error("plugin manager: window.__t3p_native is not available");
    return (await native.invoke("t3p:registry:index", { refresh })) as RegistryView;
  }

  /** The main process finished a registry request (`t3p:event plugin-registry-result`): sync the list, then tell listeners. */
  async registryResult(result: RegistryResultEvent): Promise<void> {
    const id = result.plugin;
    const running = (): boolean => {
      const st = this.#runtime.get(id)?.status;
      return st === "started" || st === "failed" || st === "pending";
    };
    try {
      if (result.status === "uninstalled" && this.#runtime.has(id)) await this.reload(id); // stops it and forgets the removed folder
      else if (result.status === "updated" && !result.restartRequired && running()) await this.reload(id);
      else await this.refresh();
    } finally {
      for (const fn of [...this.#registryListeners]) {
        try {
          fn(result);
        } catch (error) {
          this.deps.consoleError("[t3p] registry listener failed", error);
        }
      }
    }
  }

  onRegistryResult(callback: (result: RegistryResultEvent) => void): () => void {
    this.#registryListeners.add(callback);
    return () => void this.#registryListeners.delete(callback);
  }

  /** Tells change listeners to redraw (a grant dialog closed without a change). */
  notify(): void {
    this.#changed();
  }

  /** Persists the load order (ids first, in that order). It applies from the next page load. */
  async setLoadOrder(order: string[]): Promise<string[]> {
    const native = this.deps.native;
    if (!native) throw new Error("plugin manager: window.__t3p_native is not available");
    const answer = (await native.invoke("t3p:plugins:set-load-order", { order })) as { order: string[] };
    await this.refresh();
    return answer.order;
  }

  list(): ManagedPlugin[] {
    return this.#order.map((id) => {
      const e = this.#entries.get(id)!;
      const rt = this.#runtime.get(id);
      return {
        id,
        name: e.name ?? id,
        version: e.version ?? null,
        tier: e.tier ?? null,
        hostStatus: e.status,
        status: rt?.status ?? "inactive",
        error: rt?.error ?? (e.errors && e.errors.length > 0 ? e.errors[0]! : null),
        hasRenderer: e.rendererUrl !== null || rt?.status === "started",
        declared: e.declared ?? [],
        effective: e.effective ?? {},
        restartRequired: e.restartRequired === true,
        disabledReason: e.disabledReason ?? null,
      };
    });
  }

  /** Settings schemas of a running plugin. */
  schemas(id: string): SettingSchema[] {
    return this.settingsFor(id).schemas();
  }

  #devApi(): T3Dev {
    return { reload: (pluginId: string) => this.reload(pluginId) };
  }

  /** Dev helpers for `window.__t3p.dev`, or null outside dev mode. */
  devApi(): T3Dev | null {
    return this.#dev ? this.#devApi() : null;
  }

  /** Frozen facade for `window.__t3p.manager` (settings page, devtools). */
  facade(): Readonly<{
    list(): ManagedPlugin[];
    enable(id: string): Promise<ManagedPlugin | null>;
    disable(id: string): Promise<{ restartRequired: boolean }>;
    revoke(id: string, permissions: string[]): Promise<{ restartRequired: boolean }>;
    reload(id: string): Promise<void>;
    setLoadOrder(order: string[]): Promise<string[]>;
    schemas(id: string): SettingSchema[];
    getSetting(id: string, key: string): SettingValue;
    setSetting(id: string, key: string, value: SettingValue): Promise<void>;
    resetSetting(id: string, key: string): Promise<void>;
    onChange(callback: () => void): () => void;
    registry(refresh?: boolean): Promise<RegistryView>;
    onRegistryResult(callback: (result: RegistryResultEvent) => void): () => void;
  }> {
    return Object.freeze({
      list: () => this.list(),
      enable: (id: string) => this.enable(id),
      disable: (id: string) => this.disable(id),
      revoke: (id: string, permissions: string[]) => this.revoke(id, permissions),
      reload: (id: string) => this.reload(id),
      setLoadOrder: (order: string[]) => this.setLoadOrder(order),
      schemas: (id: string) => this.schemas(id),
      getSetting: (id: string, key: string) => this.settingsFor(id).get(key),
      setSetting: (id: string, key: string, value: SettingValue) => this.settingsFor(id).set(key, value),
      resetSetting: (id: string, key: string) => this.settingsFor(id).reset(key),
      onChange: (callback: () => void) => this.onChange(callback),
      registry: (refresh?: boolean) => this.registry(refresh === true),
      onRegistryResult: (callback: (result: RegistryResultEvent) => void) => this.onRegistryResult(callback),
    });
  }
}

/** What `t3p:registry:index` returns (see main-runtime plugins/registry-flow.ts). */
export interface RegistryView {
  url: string | null;
  source: "network" | "not-modified" | "cache" | null;
  fetchedAt: string | null;
  error: string | null;
  offline: boolean;
  plugins: RegistryEntry[];
  installed: Record<string, { version: string | null; devLink: boolean }>;
}

/** `t3p:event` of type plugin-registry-result. */
export interface RegistryResultEvent {
  type?: "plugin-registry-result";
  status: "installed" | "updated" | "uninstalled" | "cancelled" | "busy" | "nothing" | "unavailable" | "error";
  action: "install" | "update" | "uninstall";
  plugin: string;
  version?: string;
  review?: boolean;
  restartRequired?: boolean;
  error?: string;
}

export type { JsonValue };
