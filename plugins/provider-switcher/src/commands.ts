import type { T3Api, T3Disposable } from "@t3p/api";

import { parseFavourites } from "./logic/favourites.js";
import { switchKindFor } from "./logic/grouping.js";
import type { Selection } from "./logic/types.js";
import { providerViews } from "./map.js";
import type { SwitchQueue } from "./queue.js";
import { focusedThreadSelection, performSwitch } from "./switch.js";
import { openSwitchMenu } from "./ui/open-menu.js";

/**
 * Command palette entries: the two menu commands and one command per favourite model.
 *
 * Favourites are re-registered when the setting changes; ids are positional (`favourite-0`, ...), so
 * a palette entry keeps its place while the text only gains lines at the end.
 */
export function registerCommands(t3: T3Api, queue: SwitchQueue): T3Disposable {
  const disposables: T3Disposable[] = [];
  disposables.push(
    t3.commands.register({
      id: "switch-model",
      title: "Switch model…",
      description: "Change the focused thread's model, keeping its provider",
      keywords: ["model", "switch", "provider", "thread"],
      run: () => openFromPalette(t3, queue, "Switch model"),
    }),
  );
  disposables.push(
    t3.commands.register({
      id: "switch-provider",
      title: "Switch provider…",
      description: "Move the focused thread to another provider",
      keywords: ["provider", "switch", "model", "thread"],
      run: () => openFromPalette(t3, queue, "Switch provider"),
    }),
  );

  let favouriteDisposables: T3Disposable[] = [];
  let favouriteGeneration = 0;
  let disposed = false;

  const clearFavourites = (): void => {
    for (const disposable of favouriteDisposables) {
      try {
        disposable.dispose();
      } catch {
        // registration already gone
      }
    }
    favouriteDisposables = [];
  };

  const rebuildFavourites = async (): Promise<void> => {
    const generation = ++favouriteGeneration;
    clearFavourites();
    const favourites = parseFavourites(t3.settings.get<string>("favourites"));
    if (favourites.length === 0) return;

    let views: ReturnType<typeof providerViews> = [];
    try {
      views = providerViews(await t3.providers.list());
    } catch (error) {
      t3.log("debug", `favourites: provider list unavailable, using ids: ${String(error)}`);
    }
    if (generation !== favouriteGeneration || disposed) return;

    favourites.forEach((favourite, index) => {
      const provider = views.find((candidate) => candidate.instanceId === favourite.providerInstanceId);
      const providerLabel = provider?.displayName?.trim() || favourite.providerInstanceId;
      const modelLabel = provider?.models.find((model) => model.slug === favourite.model)?.name?.trim() || favourite.model;
      favouriteDisposables.push(
        t3.commands.register({
          id: `favourite-${index}`,
          title: `Switch to ${modelLabel}`,
          description: `${providerLabel} · ${favourite.model}`,
          keywords: ["favourite", "switch", favourite.providerInstanceId, favourite.model],
          run: () => switchToFavourite(t3, queue, favourite, providerLabel, modelLabel),
        }),
      );
    });
  };

  const offSettings = t3.settings.onChange((change) => {
    if (change.key === "favourites") void rebuildFavourites();
  });
  void rebuildFavourites();

  return {
    dispose() {
      disposed = true;
      favouriteGeneration += 1;
      offSettings();
      clearFavourites();
      for (const disposable of disposables) {
        try {
          disposable.dispose();
        } catch {
          // registration already gone
        }
      }
    },
  };
}

function openFromPalette(t3: T3Api, queue: SwitchQueue, title: string): void {
  const threadId = t3.threads.current();
  if (!threadId) {
    t3.ui.toast({ title: "Provider switcher", message: "Open a thread first.", kind: "info" });
    return;
  }
  void openSwitchMenu(t3, queue, { threadId, title, anchor: null });
}

async function switchToFavourite(
  t3: T3Api,
  queue: SwitchQueue,
  selection: Selection,
  providerLabel: string,
  modelLabel: string,
): Promise<void> {
  let focused: Awaited<ReturnType<typeof focusedThreadSelection>>;
  try {
    focused = await focusedThreadSelection(t3);
  } catch (error) {
    t3.ui.toast({
      title: "Favourite not applied",
      message: error instanceof Error ? error.message : String(error),
      kind: "warning",
    });
    return;
  }
  if (!focused) {
    t3.ui.toast({ title: "Provider switcher", message: "Open a thread first.", kind: "info" });
    return;
  }
  void performSwitch(t3, queue, {
    threadId: focused.threadId,
    selection,
    kind: switchKindFor(focused.selection.providerInstanceId, selection),
    providerLabel,
    modelLabel,
  });
}
