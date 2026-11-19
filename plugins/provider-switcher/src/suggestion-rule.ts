import type { T3Api, T3Disposable } from "@t3p/api";

import { chooseSuggestion, createSuggestionGate, worstWindow } from "./logic/suggest.js";
import { providerViews } from "./map.js";
import type { SwitchQueue } from "./queue.js";
import { focusedThreadSelection, performSwitch } from "./switch.js";

/**
 * Optional rule: when the focused thread's provider is at or past `limitThreshold` of its worst usage
 * window, offer to switch to the least-used usable provider.
 *
 * The API has no toast with an action button, so the offer is a modal with "Dismiss" and "Switch":
 * the alternative (a toast the user cannot act on) would not be actionable. The toast is used for
 * the outcome (`t3.ui.toast` in `performSwitch`). At most one prompt per thread per crossing, and at
 * most one prompt at a time.
 */
export function registerSuggestionRule(t3: T3Api, queue: SwitchQueue): T3Disposable {
  const gate = createSuggestionGate();
  let evaluating = false;
  let prompting = false;

  const evaluate = async (): Promise<void> => {
    if (evaluating) return;
    if (!t3.settings.get<boolean>("suggestOnLimit")) return;
    evaluating = true;
    try {
      const focused = await focusedThreadSelection(t3);
      if (!focused) return;
      const providers = providerViews(await t3.providers.list());
      const currentInstanceId = focused.selection.providerInstanceId;
      const current = providers.find((provider) => provider.instanceId === currentInstanceId);
      const threshold = clamp(t3.settings.get<number>("limitThreshold"), 1, 100);
      const worst = worstWindow(current?.usageLimits);
      if (!worst) {
        // Keep the gate honest: a provider below the threshold resets the crossing.
        gate.check(focused.threadId, currentInstanceId, 0, threshold);
        return;
      }
      if (!gate.check(focused.threadId, currentInstanceId, worst.percent, threshold)) return;
      if (prompting) return;

      const suggestion = chooseSuggestion({ providers, currentInstanceId, threshold });
      if (!suggestion) return;

      const currentLabel = current?.displayName?.trim() || currentInstanceId;
      prompting = true;
      try {
        const choice = await t3.ui.modal({
          title: "Usage limit reached",
          body: `${currentLabel} is at ${Math.round(worst.percent)}% of its ${worst.label} window. ${suggestion.label} is the least-used usable provider; switch this thread to it?`,
          buttons: ["Dismiss", "Switch"],
        });
        if (choice !== 1) return;
        await performSwitch(t3, queue, {
          threadId: focused.threadId,
          selection: { providerInstanceId: suggestion.providerInstanceId, model: suggestion.model },
          kind: "provider",
          providerLabel: suggestion.label,
          modelLabel: suggestion.model,
        });
      } finally {
        prompting = false;
      }
    } catch (error) {
      t3.log("warn", `usage-limit suggestion failed: ${String(error)}`);
    } finally {
      evaluating = false;
    }
  };

  const offs = [
    t3.providers.onChange(() => void evaluate()),
    t3.events.on("thread:focus", () => void evaluate()),
    t3.settings.onChange((change) => {
      if (change.key === "suggestOnLimit" || change.key === "limitThreshold") void evaluate();
    }),
  ];

  return {
    dispose() {
      for (const off of offs) {
        try {
          off();
        } catch {
          // listener already gone
        }
      }
      gate.clear();
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return max;
  return Math.min(max, Math.max(min, value));
}
