import { type FSWatcher, readdirSync, statSync, watch } from "node:fs";
import { basename, dirname, join } from "node:path";

import { isValidPluginId } from "@t3p/api";

import type { IpcRouter } from "../ipc/router.js";
import type { Logger } from "../log.js";

export interface DevWatchDeps {
  pluginsDir: string;
  router: IpcRouter;
  host: { reloadRecord(id: string): void | Promise<void>; rescan?(): Promise<string[]> };
  /** The runtime folder: a changed renderer.js makes the page reload itself (the copy from `pnpm dev:sync`). */
  runtimeDir?: string;
  /** state.json: changes to it (t3p enable/disable/grant, a new `t3p dev` link) trigger a rescan. */
  stateFile?: string;
  log: Logger;
  debounceMs?: number;
  /** Test seam. Defaults to node:fs.watch. */
  watchDir?: (dir: string, onChange: (file: string | null) => void) => { close(): void };
  listDirs?: (dir: string) => string[];
}

/** Plugin folder names. statSync follows junctions, so `t3p dev` links are watched too. */
export function listPluginDirs(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => {
      try {
        return statSync(join(dir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

/**
 * Dev mode only (T3P_DEV=1 or the `dev-mode` marker that `t3p dev` writes): watches
 * every plugin folder and tells the renderer `t3p:event {type:"plugin-files-changed",
 * plugin}` (debounced), after refreshing the plugin's manifest record. The renderer
 * runtime re-imports that plugin.
 * Returns a function that stops all watchers.
 */
export function watchPluginDirs(deps: DevWatchDeps): () => void {
  const { router, log } = deps;
  const debounce = deps.debounceMs ?? 150;
  const listDirs = deps.listDirs ?? listPluginDirs;
  const watchDir =
    deps.watchDir ??
    ((dir: string, onChange: (file: string | null) => void): { close(): void } => {
      const w: FSWatcher = watch(dir, { recursive: true }, (_event, file) => onChange(file ? String(file) : null));
      w.on("error", (error) => log.warn(`dev watch ${dir}: ${String(error)}`));
      return w;
    });
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const watchers: Array<{ close(): void }> = [];
  let ids: string[] = [];
  try {
    ids = listDirs(deps.pluginsDir).filter((id) => isValidPluginId(id));
  } catch {
    log.info(`dev watch: no plugins dir at ${deps.pluginsDir}`);
  }
  for (const id of ids) {
    try {
      watchers.push(
        watchDir(join(deps.pluginsDir, id), (file) => {
          if (file && /(^|[/\\])(node_modules|\.git)([/\\]|$)/.test(file)) return;
          const prev = timers.get(id);
          if (prev) clearTimeout(prev);
          timers.set(
            id,
            setTimeout(() => {
              timers.delete(id);
              const finish = (): void => {
                log.info(`plugin ${id}: files changed`);
                router.emit("t3p:event", { type: "plugin-files-changed", plugin: id });
              };
              try {
                const res = deps.host.reloadRecord(id);
                if (res && typeof (res as Promise<void>).then === "function") {
                  void (res as Promise<void>)
                    .catch((error: unknown) => {
                      log.warn(`dev watch ${id}: record refresh failed: ${String(error)}`);
                    })
                    .finally(finish);
                  return;
                }
              } catch (error) {
                log.warn(`dev watch ${id}: record refresh failed: ${String(error)}`);
              }
              finish();
            }, debounce),
          );
        }),
      );
    } catch (error) {
      log.warn(`dev watch ${id}: ${String(error)}`);
    }
  }
  // New plugin folders and state.json changes need no restart: rescan, then tell the renderer what changed.
  const rescan = deps.host.rescan?.bind(deps.host);
  if (rescan) {
    const watched = new Set(ids);
    let scanTimer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (): void => {
      if (scanTimer) clearTimeout(scanTimer);
      scanTimer = setTimeout(() => {
        scanTimer = undefined;
        void rescan()
          .then((changed) => {
            for (const id of changed) {
              log.info(`plugin ${id}: picked up without restart`);
              router.emit("t3p:event", { type: "plugin-files-changed", plugin: id });
            }
            try {
              for (const id of listDirs(deps.pluginsDir).filter((x) => isValidPluginId(x))) {
                if (watched.has(id)) continue;
                watched.add(id);
                watchers.push(
                  watchDir(join(deps.pluginsDir, id), (file) => {
                    if (file && /(^|[/\\])(node_modules|\.git)([/\\]|$)/.test(file)) return;
                    const prev = timers.get(id);
                    if (prev) clearTimeout(prev);
                    timers.set(
                      id,
                      setTimeout(() => {
                        timers.delete(id);
                        const finish = (): void => {
                          log.info(`plugin ${id}: files changed`);
                          router.emit("t3p:event", { type: "plugin-files-changed", plugin: id });
                        };
                        try {
                          const res = deps.host.reloadRecord(id);
                          if (res && typeof (res as Promise<void>).then === "function") {
                            void (res as Promise<void>)
                              .catch((error: unknown) => {
                                log.warn(`dev watch ${id}: record refresh failed: ${String(error)}`);
                              })
                              .finally(finish);
                            return;
                          }
                        } catch (error) {
                          log.warn(`dev watch ${id}: record refresh failed: ${String(error)}`);
                        }
                        finish();
                      }, debounce),
                    );
                  }),
                );
              }
            } catch (error) {
              log.warn(`dev watch: could not add new plugin folders: ${String(error)}`);
            }
          })
          .catch((error: unknown) => log.warn(`dev watch rescan failed: ${String(error)}`));
      }, Math.max(debounce, 300));
    };
    try {
      watchers.push(watchDir(deps.pluginsDir, () => schedule()));
    } catch (error) {
      log.warn(`dev watch ${deps.pluginsDir}: ${String(error)}`);
    }
    if (deps.stateFile) {
      const stateName = basename(deps.stateFile);
      try {
        watchers.push(watchDir(dirname(deps.stateFile), (file) => (file === null || file === stateName) && schedule()));
      } catch (error) {
        log.warn(`dev watch state file: ${String(error)}`);
      }
    }
    watchers.push({ close: () => scanTimer && clearTimeout(scanTimer) });
  }
  if (deps.runtimeDir) {
    let reloadTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      watchers.push(
        watchDir(deps.runtimeDir, (file) => {
          if (file !== null && file !== "renderer.js") return;
          if (reloadTimer) clearTimeout(reloadTimer);
          reloadTimer = setTimeout(() => {
            reloadTimer = undefined;
            log.info("runtime renderer.js changed: reloading the page");
            router.emit("t3p:event", { type: "runtime-renderer-changed" });
          }, Math.max(debounce, 400));
        }),
      );
      watchers.push({ close: () => reloadTimer && clearTimeout(reloadTimer) });
    } catch (error) {
      log.warn(`dev watch runtime dir: ${String(error)}`);
    }
  }
  log.info(`dev watch: ${watchers.length} watcher(s)`);
  return () => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    for (const w of watchers) w.close();
  };
}
