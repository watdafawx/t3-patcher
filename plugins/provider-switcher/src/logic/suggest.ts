import { providerUsability, pickDefaultModel } from "./grouping.js";
import type { ModelView, ProviderView } from "./types.js";

/**
 * The "suggest a switch near a usage limit" rule, as pure functions: the worst window of the current
 * provider, which provider to suggest, and the one-time-per-crossing gate.
 */

export interface WorstWindow {
  windowId: string;
  label: string;
  /** 0..100 as the provider reports it. */
  percent: number;
  resetsAt?: string;
}

/** The provider's worst usage window (highest `usedPercent`), or `null` when it reports none. */
export function worstWindow(limits: ProviderView["usageLimits"]): WorstWindow | null {
  if (!limits || limits.unavailable || limits.windows.length === 0) return null;
  let worst: WorstWindow | null = null;
  for (const window of limits.windows) {
    if (typeof window.usedPercent !== "number" || Number.isNaN(window.usedPercent)) continue;
    if (worst === null || window.usedPercent > worst.percent) {
      worst = {
        windowId: window.id,
        label: window.label?.trim() || window.kind || window.id,
        percent: window.usedPercent,
        ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
      };
    }
  }
  return worst;
}

export interface Suggestion {
  providerInstanceId: string;
  label: string;
  /** Model the switch would select. */
  model: string;
  /** Worst window of the suggested provider, `null` when it reports none. */
  percent: number | null;
  /** Worst window of the current provider that triggered the rule. */
  currentPercent: number;
  currentWindowLabel: string;
}

export interface SuggestionInput {
  providers: readonly ProviderView[];
  currentInstanceId: string;
  /** Percent (0..100) at or above which the rule fires. */
  threshold: number;
}

/**
 * Picks the least-used usable provider other than the current one.
 *
 * "Least used" is the provider's own worst window. Providers that report no window cannot be
 * compared, so they rank after every measured provider (and before nothing): an unmeasured provider
 * is never preferred over a measured quieter one. Ties break by instance id so the answer is stable.
 */
export function chooseSuggestion(input: SuggestionInput): Suggestion | null {
  const current = input.providers.find((provider) => provider.instanceId === input.currentInstanceId);
  const currentWorst = worstWindow(current?.usageLimits);
  if (!current || !currentWorst || currentWorst.percent < input.threshold) return null;

  const candidates: Array<{ provider: ProviderView; percent: number | null; model: ModelView }> = [];
  for (const provider of input.providers) {
    if (provider.instanceId === input.currentInstanceId) continue;
    if (!providerUsability(provider).usable) continue;
    const model = pickDefaultModel(provider);
    if (!model) continue;
    candidates.push({ provider, percent: worstWindow(provider.usageLimits)?.percent ?? null, model });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const rank = (value: number | null): number => (value === null ? Number.POSITIVE_INFINITY : value);
    return rank(a.percent) - rank(b.percent) || (a.provider.instanceId < b.provider.instanceId ? -1 : 1);
  });
  const best = candidates[0];
  return {
    providerInstanceId: best.provider.instanceId,
    label: best.provider.displayName?.trim() || best.provider.instanceId,
    model: best.model.slug,
    percent: best.percent,
    currentPercent: currentWorst.percent,
    currentWindowLabel: currentWorst.label,
  };
}

/**
 * One suggestion per thread per crossing.
 *
 * A crossing is a transition from "below the threshold" to "at or above it". The first observation
 * of a thread/provider pair that is already above counts as a crossing (the plugin may start late);
 * afterwards the flag stays set until the provider drops below the threshold. Switching the thread
 * to another provider starts a fresh baseline for that thread.
 */
export interface SuggestionGate {
  check(threadId: string, providerInstanceId: string, percent: number, threshold: number): boolean;
  forget(threadId: string): void;
  clear(): void;
}

export function createSuggestionGate(): SuggestionGate {
  const seen = new Map<string, { providerInstanceId: string; above: boolean }>();
  return {
    check(threadId, providerInstanceId, percent, threshold) {
      const entry = seen.get(threadId);
      const above = percent >= threshold;
      if (!entry || entry.providerInstanceId !== providerInstanceId) {
        seen.set(threadId, { providerInstanceId, above });
        return above;
      }
      if (above && !entry.above) {
        entry.above = true;
        return true;
      }
      if (!above) entry.above = false;
      return false;
    },
    forget(threadId) {
      seen.delete(threadId);
    },
    clear() {
      seen.clear();
    },
  };
}
