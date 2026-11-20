import {
  describePermission,
  isHighRisk,
  isValidPluginId,
  parsePermissions,
  permissionNames,
  type RegistryAction,
  type RegistryEntry,
  registryInstallState,
} from "@t3p/api";
import {
  allowInsecureLocal,
  fetchRegistryIndex,
  findEntry,
  type FetchLike,
  type IndexResult,
  installedInfo,
  installFromRegistry,
  resolveRegistry,
  uninstallPlugin,
} from "t3-patcher/registry";

import type { Logger } from "../log.js";
import type { DialogGate } from "./dialog-gate.js";
import type { DialogLike, MessageBoxOptions } from "./grants.js";

/**
 * Install, update and uninstall from the registry on the Plugins page (WP-14A).
 *
 * Trust: the page only sends `{ action, id }` on a privileged channel that page scripts cannot reach
 * (preload, trusted clicks only; docs/security.md section 4.7). The entry (download URL, SHA-256,
 * permissions) always comes from the index the MAIN process fetched, never from the page. Nothing is
 * written before the user confirms a native, window-modal dialog whose default button is Cancel.
 * A fresh install is disabled with no permissions granted; nothing from the zip is executed.
 */

export const CANCEL_BUTTON = 0;
export const CONFIRM_BUTTON = 1;
export const REVIEW_BUTTON = 2;

export interface RegistryFlowDeps<W> {
  dialog: DialogLike<W>;
  getWindow(): W | null;
  gate: DialogGate;
  /** The user's home (T3P_HOME applied), as the CLI sees it. */
  homeDir: string;
  env: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  runtimeVersion: string;
  /** Re-reads the plugin's record after its folder or state entry changed. */
  refreshed(id: string): Promise<{ restartRequired: boolean }>;
  emit(payload: Record<string, unknown>): void;
  log: Logger;
  now?(): number;
  /** Minimum gap between two forced index refreshes. Default 5000 ms. */
  refreshIntervalMs?: number;
}

export type RegistryStatus = "installed" | "updated" | "uninstalled" | "cancelled" | "busy" | "nothing" | "unavailable" | "error";

export interface RegistryResult {
  status: RegistryStatus;
  action: RegistryAction;
  plugin: string;
  version?: string;
  /** The user picked "Install and review permissions". */
  review?: boolean;
  restartRequired?: boolean;
  error?: string;
}

/** What `t3p:registry:index` returns to the page. Read-only data; nothing here authorizes anything. */
export interface RegistryView {
  url: string | null;
  source: IndexResult["source"] | null;
  fetchedAt: string | null;
  /** Set when the network fetch failed (with or without a cached copy). */
  error: string | null;
  offline: boolean;
  plugins: RegistryEntry[];
  installed: Record<string, { version: string | null; devLink: boolean }>;
}

const SOURCE_NOTE = "This dialog comes from T3 Patcher, not from the plugin or the registry.";

function permissionLines(entry: RegistryEntry): { lines: string[]; high: string[] } {
  const set = parsePermissions(entry.permissions).set;
  const names = permissionNames(set);
  return { lines: names.length ? names.map((n) => `• ${describePermission(n, set)}`) : ["• none"], high: names.filter((n) => isHighRisk(n)) };
}

/** True for a plugin the Plugins page cannot switch: main-process code, patches or spawn (WP-3A). */
function isTrustedEntry(entry: RegistryEntry): boolean {
  const set = parsePermissions(entry.permissions).set;
  return set.main !== undefined || set.patches === true || set.spawn !== undefined;
}

/** How to turn the plugin on after installing it; the Plugins page switch does not exist for trusted plugins. */
function afterInstallHint(entry: RegistryEntry): string {
  return isTrustedEntry(entry)
    ? `It is installed disabled. Start it with \`t3p enable ${entry.id}\` (the Plugins page cannot switch main-process plugins), then grant its permissions there or with \`t3p grant ${entry.id} <permission>\`.`
    : `It is installed disabled. Enable it and grant permissions in Settings > Plugins, or with \`t3p enable ${entry.id}\` and \`t3p grant ${entry.id} <permission>\`.`;
}

/** The install or update dialog. Exported for tests and docs. */
export function installDialogOptions(entry: RegistryEntry, registryUrl: string, installed: string | null): MessageBoxOptions {
  const update = installed !== null;
  const { lines, high } = permissionLines(entry);
  const hasPermissions = entry.permissions.length > 0;
  return {
    type: "warning",
    title: update ? "T3 Patcher: update plugin" : "T3 Patcher: install plugin",
    message: update ? `Update "${entry.name}" from ${installed} to ${entry.version}?` : `Install "${entry.name}" ${entry.version}?`,
    detail: [
      `Plugin: ${entry.name} (${entry.id}) v${entry.version}${update ? `, installed: v${installed}` : ""}`,
      `Author: ${entry.author}`,
      `Homepage: ${entry.homepage}`,
      ...(entry.source ? [`Source: ${entry.source}`] : []),
      `Download: ${entry.download.url}`,
      `SHA-256: ${entry.download.sha256}`,
      `Registry: ${registryUrl}`,
      "",
      update ? "Declared permissions (your grants are kept; new ones are not granted):" : "Declared permissions (none are granted by installing):",
      ...lines,
      "",
      "This runs code on your PC with your user rights once you enable it. Install only plugins you trust as much as an installed program.",
      ...(high.length ? [`High risk: ${high.join(", ")}.`] : []),
      update ? "Its settings and stored data are kept." : afterInstallHint(entry),
      SOURCE_NOTE,
    ].join("\n"),
    buttons: ["Cancel", update ? "Update" : "Install", ...(hasPermissions ? [update ? "Update and review permissions" : "Install and review permissions"] : [])],
    defaultId: CANCEL_BUTTON,
    cancelId: CANCEL_BUTTON,
    noLink: true,
  };
}

export function uninstallDialogOptions(id: string, name: string, version: string | null): MessageBoxOptions {
  return {
    type: "warning",
    title: "T3 Patcher: uninstall plugin",
    message: `Uninstall "${name}"?`,
    detail: [`Plugin: ${name} (${id})${version ? ` v${version}` : ""}`, "", "Removes its folder and its enabled and permission entries. Its settings and stored data are kept.", SOURCE_NOTE].join("\n"),
    buttons: ["Cancel", "Uninstall"],
    defaultId: CANCEL_BUTTON,
    cancelId: CANCEL_BUTTON,
    noLink: true,
  };
}

export class RegistryFlow<W> {
  #last: IndexResult | null = null;
  #lastRefreshAt = Number.NEGATIVE_INFINITY;
  #inflight: Promise<IndexResult> | null = null;

  constructor(private readonly deps: RegistryFlowDeps<W>) {}

  #now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  async #load(refresh: boolean): Promise<IndexResult> {
    if (this.#inflight) return this.#inflight;
    if (this.#last && !refresh) return this.#last;
    const { homeDir, env } = this.deps;
    const run = (async () => {
      const registry = resolveRegistry({ homeDir, env });
      const res = await fetchRegistryIndex({ homeDir, env, registry, ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}) });
      for (const w of res.warnings) this.deps.log.warn(`registry: ${w}`);
      this.#last = res;
      return res;
    })();
    this.#inflight = run;
    try {
      return await run;
    } finally {
      this.#inflight = null;
    }
  }

  /** `t3p:registry:index`: the index plus what is installed. Never throws for network trouble. */
  async view(refresh = false): Promise<RegistryView> {
    const forced = refresh && this.#now() - this.#lastRefreshAt >= (this.deps.refreshIntervalMs ?? 5000);
    if (forced) this.#lastRefreshAt = this.#now();
    try {
      const res = await this.#load(forced || this.#last === null);
      const installed: RegistryView["installed"] = {};
      for (const entry of res.index.plugins) {
        const info = installedInfo(entry.id, this.deps.homeDir);
        if (info) installed[entry.id] = { version: info.version, devLink: info.devLink };
      }
      return { url: res.url, source: res.source, fetchedAt: res.fetchedAt, error: res.error ?? null, offline: res.source === "cache", plugins: res.index.plugins, installed };
    } catch (error) {
      const offline = (error as { offline?: boolean }).offline === true;
      this.deps.log.warn(`registry index: ${(error as Error).message}`);
      return { url: null, source: null, fetchedAt: null, error: (error as Error).message, offline, plugins: [], installed: {} };
    }
  }

  /** A trusted click on Install, Update or Uninstall. Shows the dialog; acts only on confirm. Never throws. */
  async request(action: RegistryAction, id: string): Promise<RegistryResult> {
    const log = this.deps.log;
    if (!isValidPluginId(id)) return this.#finish({ status: "error", action, plugin: String(id).slice(0, 64), error: "invalid plugin id" });
    if (!this.deps.gate.tryEnter()) {
      log.warn(`registry ${action} for ${id} ignored: a dialog is open or was just shown`);
      return this.#finish({ status: "busy", action, plugin: id });
    }
    let shown = false;
    let result: RegistryResult;
    try {
      result = await this.#run(action, id, () => {
        shown = true;
      });
    } catch (error) {
      log.warn(`registry ${action} for ${id} failed: ${(error as Error).message}`);
      result = { status: "error", action, plugin: id, error: (error as Error).message };
    } finally {
      this.deps.gate.leave(shown);
    }
    return this.#finish(result);
  }

  async #confirm(options: MessageBoxOptions, onShow: () => void): Promise<number | null> {
    const window = this.deps.getWindow();
    if (!window) return null;
    onShow();
    try {
      return (await this.deps.dialog.showMessageBox(window, options)).response;
    } catch (error) {
      this.deps.log.warn(`registry dialog failed: ${String(error)}`);
      return CANCEL_BUTTON;
    }
  }

  async #run(action: RegistryAction, id: string, onShow: () => void): Promise<RegistryResult> {
    const { homeDir, log } = this.deps;
    const info = installedInfo(id, homeDir);
    if (action === "uninstall") {
      if (!info) return { status: "nothing", action, plugin: id, error: `${id} is not installed` };
      if (info.devLink) return { status: "error", action, plugin: id, error: `${id} is a t3p dev link; remove it with t3p dev --unlink` };
      // Display name from the main-fetched index when known; otherwise the id (the folder's plugin.json is not used for dialog text).
      const entryName = (this.#last ? findEntry(this.#last.index, id)?.name : undefined) ?? id;
      const response = await this.#confirm(uninstallDialogOptions(id, entryName, info.version), onShow);
      if (response === null) return { status: "unavailable", action, plugin: id };
      if (response !== CONFIRM_BUTTON) return { status: "cancelled", action, plugin: id };
      const removed = uninstallPlugin({ homeDir, id });
      log.info(`uninstalled ${id}${removed.version ? ` ${removed.version}` : ""} (confirmed in the native dialog)`);
      const applied = await this.deps.refreshed(id);
      return { status: "uninstalled", action, plugin: id, ...(removed.version ? { version: removed.version } : {}), restartRequired: applied.restartRequired };
    }

    const res = await this.#load(false);
    const entry = findEntry(res.index, id);
    if (!entry) return { status: "error", action, plugin: id, error: `${id} is not in the registry` };
    if (info?.devLink) return { status: "error", action, plugin: id, error: `${id} is a t3p dev link; install and update do not touch it` };
    if (action === "install" && info) return { status: "nothing", action, plugin: id, error: `${id} is already installed` };
    if (action === "update") {
      if (!info) return { status: "nothing", action, plugin: id, error: `${id} is not installed` };
      if (registryInstallState(entry, info.version ?? "0.0.0-unknown") !== "update") return { status: "nothing", action, plugin: id, error: `${id} is up to date` };
    }
    const installed = info ? (info.version ?? "unknown") : null;
    const response = await this.#confirm(installDialogOptions(entry, res.url, installed), onShow);
    if (response === null) return { status: "unavailable", action, plugin: id };
    if (response !== CONFIRM_BUTTON && response !== REVIEW_BUTTON) return { status: "cancelled", action, plugin: id };
    const done = await installFromRegistry({
      homeDir,
      entry,
      registryUrl: res.url,
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      allowInsecureLocal: allowInsecureLocal(this.deps.env),
      mode: action,
      runtimeVersion: this.deps.runtimeVersion,
    });
    log.info(`${done.updated ? "updated" : "installed"} ${id} ${done.version} from ${res.url} (sha256 ${done.sha256}, confirmed in the native dialog)`);
    const applied = await this.deps.refreshed(id);
    return {
      status: done.updated ? "updated" : "installed",
      action,
      plugin: id,
      version: done.version,
      review: response === REVIEW_BUTTON,
      restartRequired: applied.restartRequired,
    };
  }

  #finish(result: RegistryResult): RegistryResult {
    try {
      this.deps.emit({ type: "plugin-registry-result", ...result });
    } catch {
      // the page just misses the live update
    }
    return result;
  }
}
