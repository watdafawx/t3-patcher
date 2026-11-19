import type { PluginModule, T3Api, T3Disposable } from "@t3p/api";

import { registerCommands } from "./commands.js";
import { describeSelection, type QueueEffect } from "./logic/queue.js";
import { SwitchQueue, type SwitchQueueThreads } from "./queue.js";
import { SETTINGS } from "./settings.js";
import { registerSuggestionRule } from "./suggestion-rule.js";
import { registerThreadHeader } from "./ui/header.js";

/**
 * provider-switcher: the focused thread's model in the thread header, a menu to change model or
 * provider, palette commands, a switch-when-idle queue and an optional usage-limit suggestion.
 *
 * Everything here goes through the public `t3` API (tier 1). Registrations are disposed by the
 * runtime; the queue's own stream and listeners are disposed by the cleanup returned here.
 */

/** Queue outcomes that deserve a toast; the silent ones only repaint the header. */
function onQueueEffect(t3: T3Api, effect: QueueEffect): void {
  if (effect.type === "retry") return;
  if (effect.type === "cleared") {
    if (effect.reason !== "ok") return;
    t3.ui.toast({
      title: "Switch applied",
      message: `${describeSelection(effect.pending.selection)} is now selected.`,
      kind: "success",
    });
    return;
  }
  t3.ui.toast({ title: "Switch not applied", message: effect.message, kind: "warning", durationMs: 8000 });
}

export async function start(t3: T3Api): Promise<() => void> {
  const schemas = t3.settings.define(SETTINGS);

  const threads: SwitchQueueThreads = {
    subscribe: (threadId, callback) => t3.threads.subscribe(threadId, callback),
    setModel: (threadId, selection) => t3.threads.setModel(threadId, selection),
    switchProvider: (threadId, selection) => t3.threads.switchProvider(threadId, selection),
  };
  const queue = new SwitchQueue({
    threads,
    onEffect: (effect) => onQueueEffect(t3, effect),
    log: (level, message) => t3.log(level, message),
  });

  const disposables: T3Disposable[] = [];
  disposables.push({ dispose: t3.events.on("thread:focus", ({ threadId }) => queue.setFocusedThread(threadId)) });
  disposables.push(registerThreadHeader(t3, { queue }));
  disposables.push(registerCommands(t3, queue));
  disposables.push(registerSuggestionRule(t3, queue));

  t3.log("info", `provider-switcher ready (t3 API ${t3.apiVersion}, tier ${t3.plugin.tier})`);

  return () => {
    for (const disposable of disposables) {
      try {
        disposable.dispose();
      } catch {
        // a registration that already went away must not block the rest
      }
    }
    queue.dispose();
    schemas.dispose();
  };
}

const plugin: PluginModule = {
  start,
};

export default plugin;
