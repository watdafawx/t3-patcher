import {
  describePermission,
  grantDeclared,
  isHighRisk,
  isValidPluginId,
  missingPermissionNames,
  type PatcherStateJson,
  type PermissionSet,
  permissionNames,
  revokeNames,
} from "@t3p/api";

import type { Logger } from "../log.js";
import { DialogGate } from "./dialog-gate.js";

/**
 * Grant and revoke from the Plugins settings page (WP-12B).
 *
 * Trust: the renderer page is NOT trusted to authorize a grant (plugins run in the same JS world).
 * A grant request only ever opens a native, window-modal confirmation dialog owned by the main
 * process; state.json changes only when the user presses "Grant" there. The request itself arrives on
 * a privileged channel that page scripts cannot send (docs/security.md section 4.6). Revoking only
 * removes power, so it needs no dialog.
 */

export interface MessageBoxOptions {
  type: "warning";
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  noLink: boolean;
}

export interface DialogLike<W> {
  showMessageBox(window: W, options: MessageBoxOptions): Promise<{ response: number }>;
}

export interface GrantTarget {
  id: string;
  name: string;
  version: string;
  declared: PermissionSet;
  effective: PermissionSet;
  /** Plugin has a main entry: its permissions only change for main code after a restart. */
  hasMain: boolean;
}

export interface GrantFlowDeps<W> {
  dialog: DialogLike<W>;
  /** Parent window for the dialog. No window = no dialog = no grant. */
  getWindow(): W | null;
  target(id: string): GrantTarget | null;
  readState(): PatcherStateJson;
  writeState(state: PatcherStateJson): void;
  /** Re-reads the plugin's record after state.json changed. Returns whether a restart is needed. */
  applied(id: string, names: string[]): Promise<{ restartRequired: boolean }>;
  /** Tells the page (t3p:event). */
  emit(payload: Record<string, unknown>): void;
  log: Logger;
  now?(): number;
  /** Minimum gap between two dialogs; requests inside it are ignored. Default 1500 ms. */
  cooldownMs?: number;
  /** Shared with the registry flow so only one T3 Patcher dialog is ever open. Default: a private gate. */
  gate?: DialogGate;
}

export type GrantStatus = "granted" | "revoked" | "cancelled" | "busy" | "nothing" | "unavailable";

export interface GrantResult {
  status: GrantStatus;
  plugin: string;
  /** Names granted (status granted) or revoked (status revoked). */
  changed: string[];
  restartRequired: boolean;
}

/** Permissions that, once changed, only take effect after a restart (main-process code or chunk patches). */
const RESTART_PERMISSIONS = new Set(["main", "patches"]);

export const GRANT_BUTTON = 1;
export const CANCEL_BUTTON = 0;

/** The dialog text. Exported for tests and the docs screenshot. */
export function grantDialogOptions(target: GrantTarget, names: string[]): MessageBoxOptions {
  const high = names.filter((n) => isHighRisk(n));
  const lines = names.map((n) => `• ${describePermission(n, target.declared)}`);
  return {
    type: "warning",
    title: "T3 Patcher: grant permissions",
    message: `Allow "${target.name}" to use ${names.length === 1 ? `this permission` : `these ${names.length} permissions`}?`,
    detail: [
      `Plugin: ${target.name} (${target.id}) v${target.version}`,
      "",
      ...lines,
      "",
      high.length > 0 ? `High risk: ${high.join(", ")}. Only grant these to plugins you trust as much as an installed program.` : "Only grant permissions to plugins you trust.",
      "This dialog comes from T3 Patcher, not from the plugin. You can revoke later in Settings > Plugins or with `t3p revoke`.",
    ].join("\n"),
    buttons: ["Cancel", names.length === 1 ? `Grant ${names[0]}` : `Grant ${names.length} permissions`],
    defaultId: CANCEL_BUTTON,
    cancelId: CANCEL_BUTTON,
    noLink: true,
  };
}

export class GrantFlow<W> {
  readonly #gate: DialogGate;

  constructor(private readonly deps: GrantFlowDeps<W>) {
    this.#gate = deps.gate ?? new DialogGate({ ...(deps.now ? { now: deps.now } : {}), ...(deps.cooldownMs !== undefined ? { cooldownMs: deps.cooldownMs } : {}) });
  }

  get dialogOpen(): boolean {
    return this.#gate.open;
  }

  /**
   * Shows the native dialog for `requested` ("*" = every declared permission not yet granted) and,
   * only on "Grant", writes state.json. One dialog at a time; repeats while one is open, or within
   * the cooldown after the last one, are ignored (`busy`). Never throws for a user decision.
   */
  async request(id: string, requested: string[] | "*"): Promise<GrantResult> {
    const result = (status: GrantStatus, changed: string[] = [], restartRequired = false): GrantResult => ({ status, plugin: id, changed, restartRequired });
    const log = this.deps.log;
    if (!isValidPluginId(id)) throw new Error("t3p: invalid plugin id");
    if (!this.#gate.tryEnter()) {
      log.warn(`grant request for ${id} ignored: a dialog is open or was just shown`);
      return result("busy");
    }
    let shown = false;
    try {
      const out = await this.#ask(id, requested, () => {
        shown = true;
      });
      return out;
    } finally {
      this.#gate.leave(shown);
    }
  }

  async #ask(id: string, requested: string[] | "*", onShow: () => void): Promise<GrantResult> {
    const result = (status: GrantStatus, changed: string[] = [], restartRequired = false): GrantResult => ({ status, plugin: id, changed, restartRequired });
    const log = this.deps.log;
    const target = this.deps.target(id);
    if (!target) throw new Error(`t3p: unknown or invalid plugin ${id}`);
    const missing = missingPermissionNames(target.declared, target.effective);
    let names: string[];
    if (requested === "*") names = missing;
    else {
      const undeclared = requested.filter((n) => !permissionNames(target.declared).includes(n as never));
      if (undeclared.length > 0) throw new Error(`t3p: ${id} does not declare ${undeclared.join(", ")}`);
      names = requested.filter((n) => (missing as string[]).includes(n));
    }
    if (names.length === 0) return this.#finish(result("nothing"));
    this.deps.readState(); // a broken state.json fails here, before the user is asked anything
    const window = this.deps.getWindow();
    if (!window) {
      log.warn(`grant request for ${id}: no main window to parent the dialog`);
      return this.#finish(result("unavailable"));
    }

    let response: number;
    onShow();
    try {
      log.info(`grant dialog for ${id}: ${names.join(", ")}`);
      response = (await this.deps.dialog.showMessageBox(window, grantDialogOptions(target, names))).response;
    } catch (error) {
      log.warn(`grant dialog for ${id} failed: ${String(error)}`);
      response = CANCEL_BUTTON;
    }
    if (response !== GRANT_BUTTON) {
      log.info(`grant for ${id} cancelled by the user`);
      return this.#finish(result("cancelled"));
    }
    // Re-read right before writing so CLI edits made while the dialog was open are kept.
    const state = this.deps.readState();
    grantDeclared(state, id, target.declared, names);
    this.deps.writeState(state);
    log.info(`granted ${names.join(", ")} to ${id} (confirmed in the native dialog)`);
    const applied = await this.deps.applied(id, names);
    const restart = applied.restartRequired || target.hasMain || names.some((n) => RESTART_PERMISSIONS.has(n));
    return this.#finish(result("granted", names, restart));
  }

  /** Revokes without a dialog (it only removes power). */
  async revoke(id: string, names: string[]): Promise<GrantResult> {
    if (!isValidPluginId(id)) throw new Error("t3p: invalid plugin id");
    const target = this.deps.target(id);
    if (!target) throw new Error(`t3p: unknown or invalid plugin ${id}`);
    const state = this.deps.readState();
    revokeNames(state, id, names);
    this.deps.writeState(state);
    this.deps.log.info(`revoked ${names.join(", ")} from ${id}`);
    const applied = await this.deps.applied(id, names);
    const restart = applied.restartRequired || target.hasMain || names.some((n) => RESTART_PERMISSIONS.has(n));
    return this.#finish({ status: "revoked", plugin: id, changed: names, restartRequired: restart });
  }

  #finish(result: GrantResult): GrantResult {
    try {
      const changed = result.status === "granted" || result.status === "revoked";
      this.deps.emit(
        changed
          ? { type: "plugin-permissions-changed", plugin: result.plugin, status: result.status, permissions: result.changed, restartRequired: result.restartRequired }
          : { type: "plugin-grant-result", plugin: result.plugin, status: result.status },
      );
    } catch {
      // the page just misses the live update
    }
    return result;
  }
}
