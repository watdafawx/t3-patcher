import type { T3Api } from "@t3p/api";

import { buildModelGroups, switchKindFor } from "../logic/grouping.js";
import { providerViews, projectionView } from "../map.js";
import type { SwitchQueue } from "../queue.js";
import { performSwitch } from "../switch.js";
import { openModelMenu, type OpenMenu } from "./menu.js";

export type { OpenMenu };

export interface OpenSwitchMenuOptions {
  threadId: string;
  /** Panel heading: "Switch model" or "Switch provider". */
  title: string;
  /** Button the panel opens under; `null` centres it (command palette). */
  anchor: HTMLElement | null;
  /** Checked after the awaits: a header that went away must not leave a floating menu. */
  shouldCancel?(): boolean;
}

/**
 * Opens the model/provider menu for one thread: providers and the current projection are read
 * fresh, so the list and the "current" mark are never stale. A pick calls `setModel` (same provider)
 * or `switchProvider` (another provider) through the shared result handler.
 */
export async function openSwitchMenu(t3: T3Api, queue: SwitchQueue, options: OpenSwitchMenuOptions): Promise<OpenMenu | null> {
  let providers;
  let projection;
  try {
    [providers, projection] = await Promise.all([t3.providers.list(), t3.threads.projection(options.threadId)]);
  } catch (error) {
    t3.log("warn", `cannot open the model menu for ${options.threadId}: ${String(error)}`);
    t3.ui.toast({
      title: "Model list unavailable",
      message: error instanceof Error ? error.message : String(error),
      kind: "warning",
    });
    return null;
  }
  if (options.shouldCancel?.()) return null;

  const views = providerViews(providers);
  const selection = projectionView(projection).modelSelection;
  const groups = buildModelGroups(views, selection);
  if (groups.every((group) => group.models.length === 0)) {
    t3.ui.toast({ title: "No models", message: "No provider reports a text model.", kind: "warning" });
    return null;
  }

  return openModelMenu({
    title: options.title,
    groups,
    anchor: options.anchor,
    onPick: (pick) => {
      const kind = switchKindFor(selection?.providerInstanceId ?? null, {
        providerInstanceId: pick.providerInstanceId,
        model: pick.model,
      });
      void performSwitch(t3, queue, {
        threadId: options.threadId,
        selection: { providerInstanceId: pick.providerInstanceId, model: pick.model },
        kind,
        providerLabel: pick.providerLabel,
        modelLabel: pick.modelLabel,
      });
    },
  });
}
