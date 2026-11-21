import { isValidPluginId, setEnabled as setStateEnabled, type PatcherStateJson } from "@t3p/api";

import type { Logger } from "../log.js";
import type { DialogGate } from "./dialog-gate.js";
import type { DialogLike, MessageBoxOptions } from "./grants.js";

export interface TrustedToggleTarget {
  id: string;
  name: string;
  version: string;
}

export interface TrustedToggleFlowDeps<W> {
  dialog: DialogLike<W>;
  getWindow(): W | null;
  gate: DialogGate;
  target(id: string): TrustedToggleTarget | null;
  readState(): PatcherStateJson;
  writeState(state: PatcherStateJson): void;
  clearHealth(id: string): void;
  applied(id: string, enabled: boolean): Promise<{ restartRequired: boolean }>;
  emit(payload: Record<string, unknown>): void;
  log: Logger;
}

export type TrustedToggleStatus = "toggled" | "cancelled" | "busy" | "nothing" | "unavailable";

export interface TrustedToggleResult {
  status: TrustedToggleStatus;
  plugin: string;
  enabled: boolean;
  restartRequired: boolean;
}

const CANCEL_BUTTON = 0;
const CONFIRM_BUTTON = 1;

export function trustedToggleDialogOptions(target: TrustedToggleTarget, enabled: boolean): MessageBoxOptions {
  return {
    type: "warning",
    title: enabled ? "T3 Patcher: enable plugin" : "T3 Patcher: disable plugin",
    message: enabled ? `Enable "${target.name}"?` : `Disable "${target.name}"?`,
    detail: [
      `Plugin: ${target.name} (${target.id}) v${target.version}`,
      "",
      enabled
        ? "This plugin runs trusted code (main process, patches, or spawn) with your user rights."
        : "Its main-process code and UI will be stopped.",
      "This dialog comes from T3 Patcher, not from the plugin.",
    ].join("\n"),
    buttons: ["Cancel", enabled ? "Enable" : "Disable"],
    defaultId: CANCEL_BUTTON,
    cancelId: CANCEL_BUTTON,
    noLink: true,
  };
}

export class TrustedToggleFlow<W> {
  constructor(private readonly deps: TrustedToggleFlowDeps<W>) {}

  async request(id: string, enabled: boolean): Promise<TrustedToggleResult> {
    const log = this.deps.log;
    if (!isValidPluginId(id)) return this.#finish({ status: "nothing", plugin: String(id).slice(0, 64), enabled, restartRequired: false });
    const target = this.deps.target(id);
    if (!target) return this.#finish({ status: "nothing", plugin: id, enabled, restartRequired: false });
    if (!this.deps.gate.tryEnter()) {
      log.warn(`trusted toggle for ${id} ignored: a dialog is open or was just shown`);
      return this.#finish({ status: "busy", plugin: id, enabled, restartRequired: false });
    }
    let shown = false;
    try {
      const window = this.deps.getWindow();
      if (!window) return this.#finish({ status: "unavailable", plugin: id, enabled, restartRequired: false });
      shown = true;
      const { response } = await this.deps.dialog.showMessageBox(window, trustedToggleDialogOptions(target, enabled));
      if (response !== CONFIRM_BUTTON) return this.#finish({ status: "cancelled", plugin: id, enabled, restartRequired: false });
      const state = this.deps.readState();
      setStateEnabled(state, id, enabled);
      this.deps.writeState(state);
      if (enabled) this.deps.clearHealth(id);
      log.info(`plugin ${id}: ${enabled ? "enabled" : "disabled"} (confirmed in the native dialog)`);
      const { restartRequired } = await this.deps.applied(id, enabled);
      return this.#finish({ status: "toggled", plugin: id, enabled, restartRequired });
    } catch (error) {
      log.warn(`trusted toggle for ${id} failed: ${String(error)}`);
      return this.#finish({ status: "cancelled", plugin: id, enabled, restartRequired: false });
    } finally {
      this.deps.gate.leave(shown);
    }
  }

  #finish(result: TrustedToggleResult): TrustedToggleResult {
    try {
      this.deps.emit({ type: "plugin-toggle-result", ...result });
    } catch {
      // page misses live update
    }
    return result;
  }
}
