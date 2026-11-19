/**
 * Turn guard decisions for provider-limits (WP-6C, reworked in WP-11A): before a turn starts on a
 * provider that is nearly out of quota, offer to switch to a healthy favorite model, keep going, or
 * cancel. Pure: no DOM, no `t3`. index.ts wires it to `t3.threads.beforeStart` and `t3.ui.toast`.
 */
import type { ProviderSnapshot, TurnStartContext, TurnStartDecision } from "@t3p/api";

import { formatCountdown, parseIso, providerLabel } from "./limits.js";
import { chooseFallback, type FallbackPick, type FallbackTarget, type FavoriteModel, formatPct, parseFallback, type Remaining, remainingOf, type SkippedCandidate } from "./model.js";

export { parseFallback, remainingOf };
export type { FallbackTarget, Remaining };

/** How long a thread remembers "switch" or "keep going". */
export const CHOICE_MEMORY_MS = 10 * 60 * 1000;
export const DEFAULT_GUARD_THRESHOLD = 5;

export interface GuardSettings {
  /** Ask when the remaining percent of the target provider's tightest window is below this. 0 = off. */
  thresholdPercent: number;
  /** Manual override, `<providerInstanceId>:<model>` or `<model>` (same provider). Tried first. Empty = none. */
  fallback: string;
  /** Use the user's favorite models (then provider defaults) as candidates. Default true. */
  useFavorites: boolean;
}

export type GuardChoice = "switch" | "keep";

/** Per-thread memory of the last "switch" / "keep going" answer. Cancel is never remembered. */
export class ChoiceMemory {
  readonly #items = new Map<string, { choice: GuardChoice; until: number }>();
  constructor(private readonly ttlMs: number = CHOICE_MEMORY_MS) {}

  get(threadId: string, now: number): GuardChoice | null {
    const item = this.#items.get(threadId);
    if (!item) return null;
    if (item.until <= now) {
      this.#items.delete(threadId);
      return null;
    }
    return item.choice;
  }

  set(threadId: string, choice: GuardChoice, now: number): void {
    if (!threadId) return;
    this.#items.set(threadId, { choice, until: now + this.ttlMs });
    if (this.#items.size > 500) {
      for (const [id, v] of this.#items) if (v.until <= now) this.#items.delete(id);
    }
  }

  clear(): void {
    this.#items.clear();
  }
}

export type GuardEvaluation =
  | { kind: "pass"; why: "off" | "system" | "unknown-provider" | "no-limits" | "enough-left" }
  | { kind: "decided"; decision: TurnStartDecision; why: "remembered-keep" | "remembered-switch" }
  | {
      kind: "ask";
      providerLabel: string;
      remaining: Remaining;
      /** Null when no candidate has headroom. */
      pick: FallbackPick | null;
      skipped: SkippedCandidate[];
      /** True when favorites were part of the candidate list (wording of the "none" message). */
      usedFavorites: boolean;
    };

/** Decides whether a turn needs the user's answer. `favorites` are the user's favorite models, in order. */
export function evaluateTurn(
  ctx: TurnStartContext,
  providers: readonly ProviderSnapshot[],
  settings: GuardSettings,
  memory: ChoiceMemory,
  now: number,
  favorites: readonly FavoriteModel[] = [],
): GuardEvaluation {
  const threshold = Number(settings.thresholdPercent);
  if (!Number.isFinite(threshold) || threshold <= 0) return { kind: "pass", why: "off" };
  // Server-driven continuations (restarts, compaction, delegated completion reports) run without asking.
  if (ctx.createdBy === "system") return { kind: "pass", why: "system" };
  if (!ctx.provider) return { kind: "pass", why: "unknown-provider" };
  const target = providers.find((p) => p.instanceId === ctx.provider);
  if (!target) return { kind: "pass", why: "unknown-provider" };
  const remaining = remainingOf(target);
  if (!remaining) return { kind: "pass", why: "no-limits" };
  if (remaining.percent >= threshold) return { kind: "pass", why: "enough-left" };

  const remembered = memory.get(ctx.threadId, now);
  if (remembered === "keep") return { kind: "decided", decision: { action: "allow" }, why: "remembered-keep" };
  const useFavorites = settings.useFavorites !== false;
  const { pick, skipped } = chooseFallback({
    request: { provider: ctx.provider, model: ctx.model },
    favorites: useFavorites ? favorites : [],
    limits: providers,
    threshold,
    override: parseFallback(settings.fallback),
  });
  if (remembered === "switch" && pick) return { kind: "decided", decision: switchDecision(pick), why: "remembered-switch" };
  return { kind: "ask", providerLabel: providerLabel(target), remaining, pick, skipped, usedFavorites: useFavorites && favorites.length > 0 };
}

export function switchDecision(fallback: { provider: string | null; model: string }): TurnStartDecision {
  return fallback.provider ? { action: "modify", provider: fallback.provider, model: fallback.model } : { action: "modify", model: fallback.model };
}

export type ToastChoice = GuardChoice | "cancel";

/** Toast buttons for an `ask` evaluation, and the choice each maps to. */
export function promptButtons(ask: Extract<GuardEvaluation, { kind: "ask" }>): { labels: string[]; choices: ToastChoice[] } {
  const labels: string[] = [];
  const choices: ToastChoice[] = [];
  if (ask.pick) {
    labels.push(`Switch to ${pickLabel(ask.pick)}`);
    choices.push("switch");
  }
  labels.push("Keep going", "Cancel");
  choices.push("keep", "cancel");
  return { labels, choices };
}

function pickLabel(pick: FallbackPick): string {
  return `${pick.providerLabel} ${pick.model}`;
}

export function formatRemaining(r: Remaining): string {
  return `${formatPct(r.percent)} left in the ${r.windowLabel} window`;
}

/** Toast title: `<Provider> is almost out (4% left)`. */
export function promptTitle(ask: Extract<GuardEvaluation, { kind: "ask" }>): string {
  return `${ask.providerLabel} is almost out (${formatPct(ask.remaining.percent)} left)`;
}

/** Toast message: reset time and the proposed switch, or why none is possible. */
export function promptBody(ctx: TurnStartContext, ask: Extract<GuardEvaluation, { kind: "ask" }>, now: number): string {
  const what = ctx.kind === "delegate" ? "A delegated sub-session" : ctx.kind === "thread-create" ? "A new thread" : ctx.isSubagent ? "An agent's message" : "This message";
  const resetMs = parseIso(ask.remaining.resetsAt);
  const reset = resetMs !== null ? ` Resets ${formatCountdown(resetMs, now)}.` : "";
  const lines = [`${what} would run on ${ask.providerLabel}${ctx.model ? ` (${ctx.model})` : ""}: ${formatRemaining(ask.remaining)}.${reset}`];
  if (ask.pick) {
    const left = ask.pick.remaining ? `${formatPct(ask.pick.remaining.percent)} left` : "limits unknown";
    const why = ask.pick.source === "override" ? "your fallback setting" : ask.pick.source === "favorite" ? `next favorite with ${left}` : `provider default with ${left}`;
    lines.push(`Switch to ${pickLabel(ask.pick)} (${why}).`);
  } else {
    const list = ask.skipped.map((s) => `${s.model} ${s.percent !== undefined ? formatPct(s.percent) : s.reason}`).join(", ");
    lines.push(`${ask.usedFavorites ? "No favorite has headroom" : "No other model has headroom"}${list ? `: ${list}` : ""}.`);
  }
  return lines.join(" ");
}

/**
 * Turns the toast answer (button index, -1 = toast closed) into a decision, updating the memory.
 * Closing the toast without a button counts as Keep going (WP-11A decision): a stray click must
 * never throw the user's message away, and Cancel stays an explicit button.
 */
export function resolveChoice(
  ctx: TurnStartContext,
  ask: Extract<GuardEvaluation, { kind: "ask" }>,
  index: number,
  memory: ChoiceMemory,
  now: number,
): TurnStartDecision {
  const { choices } = promptButtons(ask);
  const choice: ToastChoice = index >= 0 && index < choices.length ? choices[index]! : "keep";
  if (choice === "switch" && ask.pick) {
    memory.set(ctx.threadId, "switch", now);
    return switchDecision(ask.pick);
  }
  if (choice === "keep") {
    memory.set(ctx.threadId, "keep", now);
    return { action: "allow" };
  }
  return { action: "block", reason: `Cancelled: ${ask.providerLabel} has ${formatRemaining(ask.remaining)} (provider-limits guard).` };
}
