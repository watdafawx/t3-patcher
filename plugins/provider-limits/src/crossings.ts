/**
 * Threshold-crossing detection for the "warn/critical" toast.
 *
 * Rule: a toast fires once when a window *rises* into warn or critical and is not repeated
 * while it stays there (or moves to a lower level). The first snapshot only seeds the state,
 * so reloading the plugin does not replay alerts for limits that were already high.
 *
 * Pure: no DOM, no timers, no `t3` access.
 */

import type { ProviderSnapshot } from "@t3p/api";

import {
  classifyPercent,
  LEVEL_RANK,
  providerLabel,
  windowsOf,
  type LimitLevel,
  type LimitThresholds,
} from "./limits.js";

/** Last seen level per window key (`instanceId` + NUL + window id). */
export type CrossingState = Record<string, LimitLevel>;

export interface CrossingEvent {
  key: string;
  instanceId: string;
  windowId: string;
  providerLabel: string;
  windowLabel: string;
  from: LimitLevel;
  /** The new level; always `warn` or `critical`. */
  to: LimitLevel;
  usedPercent: number;
}

export interface CrossingResult {
  events: CrossingEvent[];
  state: CrossingState;
}

/** Stable key for one window of one provider instance. */
export function windowKey(instanceId: string, windowId: string): string {
  return `${instanceId}\u0000${windowId}`;
}

/**
 * Compares the current provider list with the previous state.
 *
 * - `previous === null`: first observation, no events, state seeded.
 * - A level rise (`ok → warn`, `warn → critical`, `ok → critical`) emits one event.
 * - Staying at the same level, or dropping, emits nothing; the state still follows the data.
 * - Windows that disappeared are forgotten, so they can alert again if they return.
 */
export function detectCrossings(
  previous: CrossingState | null,
  providers: readonly ProviderSnapshot[],
  thresholds: LimitThresholds,
): CrossingResult {
  const state: CrossingState = {};
  const events: CrossingEvent[] = [];
  for (const provider of providers) {
    const label = providerLabel(provider);
    for (const window of windowsOf(provider)) {
      const key = windowKey(provider.instanceId, window.id);
      const to = classifyPercent(window.usedPercent, thresholds);
      state[key] = to;
      if (previous === null) continue;
      const from = previous[key] ?? "ok";
      if (LEVEL_RANK[to] > LEVEL_RANK[from]) {
        events.push({
          key,
          instanceId: provider.instanceId,
          windowId: window.id,
          providerLabel: label,
          windowLabel: window.label,
          from,
          to,
          usedPercent: window.usedPercent,
        });
      }
    }
  }
  return { events, state };
}
