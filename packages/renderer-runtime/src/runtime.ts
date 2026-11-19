/**
 * Renderer bootstrap logic, kept free of globals so it can be unit tested.
 *
 * Installs `window.__t3p` and the plugin manager, and starts every enabled renderer plugin with
 * its own frozen `t3` object (`@t3p/api` `T3Api`). Layout:
 * - `manager.ts`   load order, start/stop/reload, enable/disable, error isolation
 * - `t3.ts`        builds one plugin's `t3` object
 * - `storage.ts`   `t3.storage` + `t3.settings`;  `rpc.ts` `t3.rpc`;  `native.ts` `t3.native`
 * - `events.ts`    `t3.events`;  `stubs.ts` namespaces other work packages implement
 */
import type { T3LogLevel } from "@t3p/api";

import { createEventBus } from "./events.js";
import { createGuardClient, isGuardRequest } from "./guard.js";
import { type ManagedPlugin, PluginManager, type PluginLoadResult } from "./manager.js";
import { SharedRpc, type SharedRpcDeps } from "./rpc.js";
import { Shell } from "./shell.js";
import { threadStore } from "./threads.js";
import type { DesktopBridgeLike, NativeBridgeLike } from "./types.js";

export const RENDERER_VERSION = "0.2.0";

export { createEventBus } from "./events.js";
export type { ManagedPlugin, PluginLoadResult } from "./manager.js";
export type { EventBus, Listener, NativeBridgeLike, PluginListEntry } from "./types.js";
export type LogLevel = T3LogLevel;

export interface BootstrapEnv {
  win: Record<string, unknown>;
  native: NativeBridgeLike | null;
  now(): number;
  importModule(url: string): Promise<Record<string, unknown>>;
  consoleError(...args: unknown[]): void;
  /** window.desktopBridge, for t3.rpc. */
  desktopBridge?: DesktopBridgeLike | null;
  /** Registers a page-unload callback (fires `app:unload`). */
  onUnload?(callback: () => void): void;
  /** Reloads the page (dev mode: the runtime's own renderer.js changed). Defaults to `location.reload()`. */
  reloadPage?(): void;
  /** Crash-loop guard: uncaught error / unhandled rejection feed (message, stack). Returns an unsubscribe. */
  watchErrors?(cb: (message: string, stack: string) => void): () => void;
  /** Test seams. */
  healthWindowMs?: number;
  timeoutMs?: number;
  finalizeAfterMs?: number;
  createRpcClient?: SharedRpcDeps["createClient"];
  rpcConnect?: SharedRpcDeps["connect"];
  fetch?: SharedRpcDeps["fetch"];
}

function mark(win: Record<string, unknown>, label: string, now: number): void {
  const order = (win.__t3p_order as unknown[][] | undefined) ?? [];
  order.push([label, now]);
  win.__t3p_order = order;
}

/** Installs window.__t3p and starts loading plugins. Returns the ready promise. */
export function bootstrap(env: BootstrapEnv): Promise<PluginLoadResult[]> {
  const { win, native } = env;
  mark(win, "t3p-renderer", env.now());
  if (win.__t3p) return (win.__t3p as { ready: Promise<PluginLoadResult[]> }).ready;

  const registry = (win.__t3p_plugins as Record<string, unknown> | undefined) ?? (Object.create(null) as Record<string, unknown>);
  win.__t3p_plugins = registry;

  const remoteLog = (level: T3LogLevel, message: string, plugin?: string): void => {
    if (!native) return;
    const payload = plugin ? { level, message: message.slice(0, 8000), plugin } : { level, message: message.slice(0, 8000) };
    native.invoke("t3p:log", payload).catch(() => undefined);
  };
  const onListenerError = (error: unknown): void => {
    env.consoleError("[t3p] event listener failed", error);
    remoteLog("error", `event listener failed: ${String(error)}`);
  };
  // `events` (window.__t3p.events) is the plugin bus: keys are `<plugin id>:<name>`, fed by renderer plugins and by main-side plugins.
  const pluginBus = createEventBus(onListenerError);
  const systemBus = createEventBus(onListenerError);
  const results: PluginLoadResult[] = [];
  const nativeApi = native
    ? Object.freeze({
        version: native.version,
        invoke: (channel: string, payload?: unknown) => native.invoke(channel, payload),
        on: (channel: string, cb: (payload: unknown) => void) => native.on(channel, cb),
        ping: () => native.invoke("t3p:ping"),
        plugins: () => native.invoke("t3p:plugins:list"),
      })
    : null;

  const shared = new SharedRpc({
    bridge: env.desktopBridge ?? null,
    log: remoteLog,
    ...(env.createRpcClient ? { createClient: env.createRpcClient } : {}),
    ...(env.rpcConnect ? { connect: env.rpcConnect } : {}),
    ...(env.fetch ? { fetch: env.fetch } : {}),
  });
  const shell = new Shell({ native, systemBus, log: remoteLog, consoleError: env.consoleError, ...(env.finalizeAfterMs !== undefined ? { finalizeAfterMs: env.finalizeAfterMs } : {}) });
  // `$self` of the first-party capture patches (main-runtime patches/captures.ts).
  registry["t3p.core"] = shell.core();
  // WP-6C turn guard. A page (re)load drops every registration the main process still holds.
  let managerRef: PluginManager | null = null;
  const guardClient = native
    ? createGuardClient({ native, log: remoteLog, order: () => managerRef?.loadOrder() ?? [], threads: () => threadStore(shared, remoteLog).list() })
    : null;
  if (native) native.invoke("t3p:guard:unregister", {}).catch(() => undefined);
  const manager = new PluginManager({
    shell,
    native,
    importModule: env.importModule,
    consoleError: env.consoleError,
    log: remoteLog,
    mark: (label) => mark(win, label, env.now()),
    systemBus,
    pluginBus,
    shared,
    registry,
    results,
    guard: guardClient,
    ...(env.timeoutMs !== undefined ? { timeoutMs: env.timeoutMs } : {}),
    ...(env.watchErrors ? { watchErrors: env.watchErrors } : {}),
    ...(env.healthWindowMs !== undefined ? { healthWindowMs: env.healthWindowMs } : {}),
  });
  managerRef = manager;

  shell.attach(manager.facade());
  shell.start(win);

  let resolveReady!: (value: PluginLoadResult[]) => void;
  const ready = new Promise<PluginLoadResult[]>((r) => (resolveReady = r));

  win.__t3p = Object.freeze({
    version: RENDERER_VERSION,
    ready,
    events: pluginBus,
    native: nativeApi,
    plugins: registry,
    loadResults: results,
    manager: manager.facade(),
    /** Diagnostics for the UI slots and tier 2 captures. */
    ui: Object.freeze({ mounted: () => shell.slots.mounted(), keybindMode: () => shell.keybinds.mode }),
    internals: Object.freeze({ status: () => shell.hub.status(), detail: () => shell.hub.detail(), get: (name: never) => shell.hub.get(name) }),
    /** Dev helpers (hot reload). Present only in dev mode, after the first plugin list arrived. */
    get dev() {
      return manager.devApi();
    },
  });

  if (native) {
    try {
      native.on("t3p:plugin-event", (payload) => {
        const p = payload as { plugin?: string; name?: string; payload?: unknown } | null;
        if (p && typeof p.plugin === "string" && typeof p.name === "string") pluginBus.emit(`${p.plugin}:${p.name}`, p.payload);
      });
      native.on("t3p:event", (payload) => {
        const p = payload as { type?: string; plugin?: string } | null;
        if (guardClient && isGuardRequest(payload)) {
          guardClient.handle(payload).catch((error: unknown) => env.consoleError("[t3p] turn guard failed", error));
          return;
        }
        if (p?.type === "runtime-renderer-changed" && manager.dev) {
          env.reloadPage?.();
          return;
        }
        if (p?.type === "plugin-permissions-changed" && typeof p.plugin === "string") {
          const id = p.plugin;
          const restart = (payload as { restartRequired?: unknown }).restartRequired === true;
          manager
            .permissionsChanged(id, restart)
            .then(() => {
              if (restart) {
                const name = manager.list().find((x) => x.id === id)?.name ?? id;
                shell.overlays.toast("t3p.core", { title: "Restart T3 Code", message: `Restart T3 for main-process permissions of ${name} to take effect.`, kind: "info", durationMs: 8000 });
              }
            })
            .catch((error: unknown) => env.consoleError(`[t3p] permission reload of ${id} failed`, error));
          return;
        }
        if (p?.type === "plugin-grant-result" && typeof p.plugin === "string") {
          const status = (payload as { status?: unknown }).status;
          if (status === "unavailable") shell.overlays.toast("t3p.core", { message: "The grant dialog could not open. Use: t3p grant " + p.plugin + " <permission>", kind: "warning" });
          manager.notify();
          return;
        }
        if (p?.type === "plugin-files-changed" && typeof p.plugin === "string" && manager.dev) {
          manager.reload(p.plugin).catch((error: unknown) => env.consoleError(`[t3p] hot reload of ${String(p.plugin)} failed`, error));
        }
      });
    } catch (error) {
      env.consoleError("[t3p] event subscription failed", error);
    }
  }
  env.onUnload?.(() => systemBus.emit("app:unload", {}));

  const load = async (): Promise<void> => {
    if (!native) return;
    try {
      await manager.refresh();
    } catch (error) {
      env.consoleError("[t3p] plugins:list failed", error);
      return;
    }
    // Crash-loop guard: tell the user about plugins the host disabled (kept until `t3p enable <id>`).
    for (const p of manager.list()) {
      if (p.disabledReason === "crash-loop") {
        shell.overlays.toast("t3p.core", {
          title: "Plugin disabled",
          message: `${p.name} was disabled after 3 failed starts. Re-enable with: t3p enable ${p.id}`,
          kind: "warning",
          durationMs: 0,
        });
      }
    }
    await manager.startAll();
  };

  load()
    .catch((error: unknown) => env.consoleError("[t3p] plugin loading failed", error))
    .finally(() => {
      mark(win, "t3p-ready", env.now());
      systemBus.emit("app:ready", { plugins: results.filter((r) => r.ok).map((r) => r.id) });
      resolveReady(results);
    });
  return ready;
}

export type { ManagedPlugin as ManagedPluginInfo };
