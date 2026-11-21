/**
 * T3 Patcher main runtime (dist/main.cjs). The shim requires it from
 * <home>/.t3-patcher/runtime/main.cjs before the original app. Everything here
 * is fail-open: a failing step is logged and skipped, the app always starts.
 *
 * Load-time order (WP-2 brief): safe mode + logger -> protocol wrap ->
 * (CSP: unchanged) -> preload registration on ready -> IPC router ->
 * plugin host -> native services (per plugin) -> updater hook.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { crashThreshold, INTERNALS_STATUS_FILE, type PermissionSet, type TurnStartHandler } from "@t3p/api";

import { registerGuardChannels } from "./guard/broker.js";
import { startTurnGuard } from "./guard/index.js";
import { registerCoreChannels } from "./ipc/channels.js";
import { InternalsStatus } from "./internals/status.js";
import { createIpcRouter, type IpcMainLike } from "./ipc/router.js";
import { classifyMainWindow, createSenderCheck, MainWindowTracker, preloadMatcher, type WebPrefsLike, type WindowLike } from "./ipc/sender.js";
import { createFileLogger, guard, type Logger } from "./log.js";
import { installEmbedReferer, type WebRequestLike } from "./embed/referer.js";
import { createNativeServices, type NativeServices } from "./native/index.js";
import { scrubEnv } from "./native/spawn.js";
import { type UtilityProcessLike, utilityProcessLauncher } from "./native/sqlite.js";
import { ChunkIndex } from "./patches/chunk-index.js";
import { builtinPatches, CORE_OWNER } from "./patches/builtin.js";
import { CAPTURES, capturePatches, disabledCaptures } from "./patches/captures.js";
import { parseWirePatches } from "./patches/wire.js";
import { PatchRegistry } from "./patches/registry.js";
import { PatchService } from "./patches/service.js";
import { resolvePaths } from "./paths.js";
import { DialogGate } from "./plugins/dialog-gate.js";
import { type DialogLike, GrantFlow } from "./plugins/grants.js";
import { PluginHost } from "./plugins/host.js";
import { RegistryFlow } from "./plugins/registry-flow.js";
import { TrustedToggleFlow } from "./plugins/trusted-toggle.js";
import { readStateForWrite, writeStateFile } from "./plugins/state-io.js";
import { watchPluginDirs } from "./plugins/dev-watch.js";
import { StorageStore } from "./storage/store.js";
import { serveVirtual } from "./protocol/virtual.js";
import { type Handler, installProtocolWrap } from "./protocol/wrap.js";
import { detectDevMode } from "./dev-mode.js";
import { detectDiagnostics } from "./diagnostics.js";
import { detectSafeMode } from "./safe-mode.js";
import { installUpdaterHook } from "./updater/hook.js";

export const RUNTIME_VERSION = "0.1.0";

interface BrowserWindowLike extends WindowLike {
  id: number;
  once(event: string, fn: () => void): void;
  webContents: WindowLike["webContents"] & { getLastWebPreferences?(): WebPrefsLike | null; send(channel: string, ...args: unknown[]): void };
}

interface ElectronLike {
  app: {
    getVersion(): string;
    getAppPath(): string;
    whenReady(): Promise<void>;
    on(event: "browser-window-created", fn: (event: unknown, window: BrowserWindowLike) => void): void;
  };
  protocol: { handle(scheme: string, handler: Handler): void };
  ipcMain: IpcMainLike;
  session: {
    defaultSession: {
      registerPreloadScript?(script: { type: "frame"; filePath: string; id?: string }): string;
      getPreloads?(): string[];
      setPreloads?(preloads: string[]): void;
      webRequest?: WebRequestLike;
    };
  };
  autoUpdater: { once(event: string, fn: () => void): unknown };
  dialog?: DialogLike<BrowserWindowLike>;
  utilityProcess?: UtilityProcessLike;
}

function findClientDir(resourcesPath: string, appPath: string): string | null {
  const candidates = [
    join(resourcesPath, "server.asar", "apps", "server", "dist", "client"),
    join(resourcesPath, "_app.asar", "apps", "server", "dist", "client"),
    join(appPath, "apps", "server", "dist", "client"),
  ];
  return candidates.find((dir) => existsSync(join(dir, "index.html"))) ?? null;
}

function expectedPreloads(resourcesPath: string, log: Logger): string[] {
  const original = join(resourcesPath, "_app.asar");
  const out = [join(original, "apps", "desktop", "dist-electron", "preload.cjs")];
  guard(
    log,
    "read _app.asar/package.json",
    () => {
      const pkg = JSON.parse(readFileSync(join(original, "package.json"), "utf8")) as { main?: string };
      if (typeof pkg.main === "string") out.unshift(join(original, dirname(pkg.main), "preload.cjs"));
    },
    undefined,
  );
  return [...new Set(out)];
}

function registerPreload(electron: ElectronLike, file: string, log: Logger): void {
  const ses = electron.session.defaultSession;
  if (!existsSync(file)) {
    log.warn(`preload missing at ${file}; window.__t3p_native will be absent`);
    return;
  }
  try {
    if (typeof ses.registerPreloadScript === "function") {
      const id = ses.registerPreloadScript({ type: "frame", filePath: file, id: "t3p-preload" });
      log.info(`preload registered (registerPreloadScript id=${id})`);
      return;
    }
  } catch (error) {
    log.warn(`registerPreloadScript failed (${String(error)}); trying setPreloads`);
  }
  try {
    const current = ses.getPreloads?.() ?? [];
    ses.setPreloads?.([...current.filter((p) => p !== file), file]);
    log.info("preload registered (setPreloads)");
  } catch (error) {
    log.error("preload registration failed", error);
  }
}

function boot(): void {
  const bootStart = performance.now();
  const paths = resolvePaths();
  const log = createFileLogger({ dir: paths.logs, file: "main.log", echo: process.env.T3P_LOG_ECHO === "1" });
  log.info(`runtime ${RUNTIME_VERSION} loading (pid ${process.pid}, uptime ${Math.round(process.uptime() * 1000)} ms)`);

  const safe = detectSafeMode({ env: process.env, argv: process.argv, markerPath: paths.safeMarker });
  if (safe.safe) {
    log.info(`safe mode (${safe.reason}): no plugins, no patches, no injection`);
    return;
  }
  const dev = detectDevMode({ env: process.env, markerPath: paths.devMarker });
  if (dev.dev) log.info(`dev mode (${dev.reason}): hot reload watcher on`);

  // Troubleshooting switches (marker files or T3P_NO_*): split the runtime without safe mode.
  const diagnostics = detectDiagnostics({ env: process.env, baseDir: paths.base });
  if (diagnostics.reasons.length > 0) {
    log.warn(`diagnostic toggles on (${diagnostics.reasons.join(", ")}): noInject=${diagnostics.noInject} noPlugins=${diagnostics.noPlugins} noGuard=${diagnostics.noGuard}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports -- electron is external, resolved by the Electron runtime
  const electron = require("electron") as ElectronLike;
  const { app } = electron;
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? dirname(app.getAppPath());
  const platform = process.platform === "win32" ? "win32" : "posix";
  const appVersion = guard(log, "app.getVersion", () => app.getVersion(), null);

  // Patches: built-ins now, plugin patches during plugin activation (awaited before the first chunk).
  const registry = new PatchRegistry();
  registry.register(CORE_OWNER, [...builtinPatches(process.env), ...capturePatches(process.env)]);
  const patchLog = log.child("patches");
  const clientDir = guard(log, "find client dir", () => findClientDir(resourcesPath, app.getAppPath()), null);
  if (!clientDir) log.warn("client asset dir not found; patches disabled");
  const index = clientDir ? new ChunkIndex(clientDir, join(paths.cache, "chunk-index.json"), patchLog) : null;
  const patches = new PatchService(registry, index, join(paths.cache, "patches"), patchLog);

  const internals = new InternalsStatus({
    file: join(paths.base, INTERNALS_STATUS_FILE),
    captures: CAPTURES,
    disabled: disabledCaptures(process.env),
    appVersion,
    patchReport: () => patches.report(),
    log: log.child("internals"),
  });
  guard(log, "internals status file", () => internals.writeInitial(), undefined);

  // Main window tracking + IPC router.
  const expected = expectedPreloads(resourcesPath, log);
  const isMainPreload = preloadMatcher(expected);
  const tracker = new MainWindowTracker<BrowserWindowLike>();
  guard(
    log,
    "browser-window-created hook",
    () =>
      app.on("browser-window-created", (_event, window) => {
        guard(
          log,
          "track window",
          () => {
            const prefs = (): WebPrefsLike | null => window.webContents.getLastWebPreferences?.() ?? null;
            tracker.watch(window, () => classifyMainWindow(prefs(), isMainPreload));
            const created = Math.round(process.uptime() * 1000);
            window.once("ready-to-show", () =>
              guard(
                log,
                "window ready-to-show",
                () => {
                  const at = Math.round(process.uptime() * 1000);
                  if (tracker.get() === window) log.info(`main window ${window.id} created at ${created} ms, ready-to-show at ${at} ms since process start`);
                  else log.info(`window ${window.id} is not the main window (web preferences ${JSON.stringify(prefs())})`);
                },
                undefined,
              ),
            );
          },
          undefined,
        );
      }),
    undefined,
  );
  const router = createIpcRouter({
    ipcMain: electron.ipcMain,
    checkSender: createSenderCheck(() => tracker.get()),
    getMainWindow: () => tracker.get(),
    log: log.child("ipc"),
  });

  // Turn guard: before the desktop main.cjs loads, which captures child_process.spawn once.
  const guardLog = log.child("guard");
  const turnGuard = diagnostics.noGuard
    ? null
    : guard(
        log,
        "turn guard",
        () => startTurnGuard({ env: process.env, hookPath: join(paths.runtime, "server-hook.mjs"), emit: (payload) => router.emit("t3p:event", payload), log: guardLog }),
        null,
      );

  const sqliteWorker = join(paths.runtime, "sqlite-worker.cjs");
  const sqliteLaunch =
    electron.utilityProcess && existsSync(sqliteWorker)
      ? utilityProcessLauncher(electron.utilityProcess, () => electron.app.whenReady(), sqliteWorker, scrubEnv(process.env, platform))
      : undefined;
  if (!sqliteLaunch) log.warn(`sqlite.read unavailable: no utilityProcess or ${sqliteWorker}`);
  const nativeFor = (perms: PermissionSet): Readonly<NativeServices> => createNativeServices(perms, { platform, home: paths.home, sqliteLaunch });
  const nativeCache = new Map<string, Readonly<NativeServices>>();
  const pluginPatchBatches = new Map<string, () => void>();
  const host = new PluginHost({
    pluginsDir: paths.plugins,
    stateFile: paths.state,
    appVersion,
    router,
    registry,
    nativeFor,
    log: log.child("plugins"),
    platform,
    dev: dev.dev,
    crashThreshold: crashThreshold(process.env),
    ...(turnGuard ? { addGuardHandler: (plugin: string, handler: TurnStartHandler, timeoutMs?: number) => turnGuard.broker.addMainHandler(plugin, handler, timeoutMs) } : {}),
  });
  if (turnGuard) guard(log, "guard IPC channels", () => registerGuardChannels(router, turnGuard.broker, (id) => host.permissionsFor(id), guardLog), undefined);

  // Grants from the Plugins page: native dialog parented to the main window, state.json only on confirm.
  const dialog = electron.dialog;
  // One T3 Patcher dialog at a time across grants and registry installs (shared cooldown).
  const dialogGate = new DialogGate();
  const grants = dialog
    ? new GrantFlow<BrowserWindowLike>({
        dialog,
        gate: dialogGate,
        getWindow: () => tracker.get(),
        target: (id) => host.grantTarget(id),
        readState: () => readStateForWrite(paths.state),
        writeState: (state) => writeStateFile(paths.state, state),
        applied: (id) => host.applyPermissionChange(id),
        emit: (payload) => void router.emit("t3p:event", payload),
        log: log.child("grants"),
      })
    : null;
  if (!grants) log.warn("electron.dialog missing: granting from the Plugins page is unavailable (use t3p grant)");
  // Registry installs from the Plugins page (WP-14A): native dialog, then the shared t3-patcher/registry lib.
  const registryFlow = dialog
    ? new RegistryFlow<BrowserWindowLike>({
        dialog,
        gate: dialogGate,
        getWindow: () => tracker.get(),
        homeDir: paths.home,
        env: process.env,
        runtimeVersion: RUNTIME_VERSION,
        refreshed: (id) => host.refreshInstalled(id),
        emit: (payload) => void router.emit("t3p:event", payload),
        log: log.child("registry"),
      })
    : null;

  const trustedToggleFlow = dialog
    ? new TrustedToggleFlow<BrowserWindowLike>({
        dialog,
        gate: dialogGate,
        getWindow: () => tracker.get(),
        target: (id) => host.grantTarget(id),
        readState: () => readStateForWrite(paths.state),
        writeState: (state) => writeStateFile(paths.state, state),
        clearHealth: (id) => host.clearHealthFor(id),
        applied: (id) => host.applyTrustedToggle(id),
        emit: (payload) => router.emit("t3p:event", payload),
        log: log.child("trusted-toggle"),
      })
    : null;

  guard(
    log,
    "core IPC channels",
    () =>
      registerCoreChannels({
        router,
        log: log.child("ipc"),
        version: RUNTIME_VERSION,
        appVersion,
        safe: false,
        permissionsFor: (id) => host.permissionsFor(id),
        nativeFor: (id, perms) => {
          let services = nativeCache.get(id);
          if (!services) {
            services = nativeFor(perms);
            nativeCache.set(id, services);
          }
          return services;
        },
        pluginsList: async () => {
          await pluginsReady;
          return host.list();
        },
        patchReport: () => patches.report(),
        dev: dev.dev,
        storage: new StorageStore(join(paths.base, "storage"), log.child("storage")),
        setEnabled: (id, enabled) => host.setEnabled(id, enabled),
        ...(grants ? { grants } : {}),
        ...(registryFlow ? { registry: registryFlow } : {}),
        ...(trustedToggleFlow ? { trustedToggle: trustedToggleFlow } : {}),
        setLoadOrder: (order) => host.setLoadOrder(order),
        pluginHealth: (plugin, ok, error) => host.reportHealth(plugin, ok, error),
        internals,
        pluginPatches: {
          register: (plugin, batch, wire) => {
            // Same rule as a main plugin's ctx.patches: the plugin must hold the `patches` permission (declared and granted).
            if (!host.permissionsFor(plugin)?.patches) throw new Error(`t3p: patches is not granted to ${plugin}`);
            const parsed = parseWirePatches(plugin, wire);
            const key = `${plugin} ${batch}`;
            pluginPatchBatches.get(key)?.();
            pluginPatchBatches.set(key, registry.register(plugin, parsed));
            return parsed.length;
          },
          unregister: (plugin, batch) => {
            const key = `${plugin} ${batch}`;
            pluginPatchBatches.get(key)?.();
            pluginPatchBatches.delete(key);
          },
        },
      }),
    undefined,
  );

  if (dev.dev) {
    guard(log, "dev watcher", () => watchPluginDirs({ pluginsDir: paths.plugins, stateFile: paths.state, runtimeDir: paths.runtime, router, host, log: log.child("dev") }), undefined);
  }
  // embed.youtube: Referer on the YouTube nocookie embed frame only, gated live on the permission.
  app.whenReady().then(
    () => {
      const webRequest = electron.session.defaultSession.webRequest;
      if (webRequest) guard(log, "embed.youtube referer hook", () => installEmbedReferer(webRequest, () => host.anyHolds("embed.youtube")), undefined);
    },
    (error: unknown) => log.error("embed hook whenReady failed", error),
  );
  const pluginsReady = diagnostics.noPlugins
    ? Promise.resolve()
    : host.loadAll({ safe: false }).catch((error: unknown) => log.error("plugin host failed", error));

  if (!diagnostics.noInject) {
    guard(
      log,
      "protocol wrap",
      () =>
        installProtocolWrap(electron.protocol, "t3code", {
          log: log.child("protocol"),
          injectHtml: true,
          ready: pluginsReady,
          hasPatchesFor: (name) => patches.hasPatchesFor(name),
          transform: (name, source) => patches.transform(name, source),
          virtual: (url, request) =>
            serveVirtual(url, request.method, { runtimeDir: paths.runtime, pluginDir: (id) => host.rendererDir(id), platform, log: log.child("protocol") }),
        }),
      undefined,
    );
  } else {
    log.warn("diagnostic no-inject: protocol wrap and renderer bootstrap are off");
  }

  app.whenReady().then(
    () => registerPreload(electron, join(paths.runtime, "preload.cjs"), log),
    (error: unknown) => log.error("whenReady failed", error),
  );

  installUpdaterHook({
    autoUpdater: electron.autoUpdater,
    log: log.child("updater"),
    env: process.env,
    installDir: dirname(process.execPath),
    binDir: paths.bin,
    workerFile: join(paths.runtime, "repair-worker.cjs"),
    home: paths.home,
    pid: process.pid,
  });

  log.info(`runtime boot took ${Math.round(performance.now() - bootStart)} ms`);
}

try {
  boot();
} catch (error) {
  try {
    createFileLogger({ dir: resolvePaths().logs, file: "main.log" }).error("runtime boot failed (fail-open)", error);
  } catch {
    // nothing left to do; the shim starts the app anyway
  }
}
