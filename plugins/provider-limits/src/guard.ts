/**
 * Turn guard decisions for provider-limits (WP-6C): before a turn starts on a provider that is
 * nearly out of quota, ask the user to switch to the fallback model, keep going, or cancel.
 *
 * Pure: no DOM, no `t3`. index.ts wires it to `t3.threads.beforeStart` and `t3.ui.modal`.
 */
import type { ProviderSnapshot, TurnStartContext, TurnStartDecision } from "@t3p/api";

import { providerLabel, windowsOf } from "./limits.js";

/** How long a thread remembers "switch" or "keep going". */
export const CHOICE_MEMORY_MS = 10 * 60 * 1000;
export const DEFAULT_GUARD_THRESHOLD = 5;

export interface GuardSettings {
  /** Ask when the remaining percent of the target provider's tightest window is below this. 0 = off. */
  thresholdPercent: number;
  /** `<providerInstanceId>:<model>`, or just `<model>` (same provider). Empty = no switch offered. */
  fallback: string;
}

export interface FallbackTarget {
  provider: string | null;
  model: string;
}

/** Parses `instanceId:model` (split at the first `:`) or a bare model. Null when empty or malformed. */
export function parseFallback(value: unknown): FallbackTarget | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  const colon = text.indexOf(":");
  if (colon < 0) return { provider: null, model: text };
  const provider = text.slice(0, colon).trim();
  const model = text.slice(colon + 1).trim();
  if (!model) return null;
  return { provider: provider || null, model };
}

export interface Remaining {
  /** 0..100, of the tightest window. */
  percent: number;
  windowLabel: string;
}

/** Remaining percent of a provider's tightest window, or null when it reports no windows. */
export function remainingOf(provider: ProviderSnapshot): Remaining | null {
  let worst: Remaining | null = null;
  for (const w of windowsOf(provider)) {
    const used = Number(w.usedPercent);
    if (!Number.isFinite(used)) continue;
    const percent = Math.max(0, Math.min(100, 100 - used));
    if (!worst || percent < worst.percent) worst = { percent, windowLabel: windowLabel(w) };
  }
  return worst;
}

function windowLabel(w: unknown): string {
  const o = w as { label?: unknown; kind?: unknown; windowDurationMins?: unknown };
  if (typeof o.label === "string" && o.label.trim()) return o.label.trim();
  if (typeof o.kind === "string" && o.kind.trim()) return o.kind.trim();
  if (typeof o.windowDurationMins === "number" && o.windowDurationMins > 0) {
    const m = o.windowDurationMins;
    return m % 1440 === 0 ? `${m / 1440}d` : m % 60 === 0 ? `${m / 60}h` : `${m}m`;
  }
  return "usage";
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
      /** Null when no usable fallback (empty setting, or the same target). */
      fallback: FallbackTarget | null;
      fallbackLabel: string | null;
      /** Remaining percent of the fallback provider, when known. */
      fallbackRemaining: Remaining | null;
    };

/** Decides whether a turn needs the user's answer. */
export function evaluateTurn(ctx: TurnStartContext, providers: readonly ProviderSnapshot[], settings: GuardSettings, memory: ChoiceMemory, now: number): GuardEvaluation {
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

  const parsed = parseFallback(settings.fallback);
  const fallback = parsed && !(parsed.model === ctx.model && (parsed.provider ?? ctx.provider) === ctx.provider) ? parsed : null;
  const remembered = memory.get(ctx.threadId, now);
  if (remembered === "keep") return { kind: "decided", decision: { action: "allow" }, why: "remembered-keep" };
  if (remembered === "switch" && fallback) return { kind: "decided", decision: switchDecision(fallback), why: "remembered-switch" };

  const fbProvider = fallback ? providers.find((p) => p.instanceId === (fallback.provider ?? ctx.provider)) : undefined;
  return {
    kind: "ask",
    providerLabel: providerLabel(target),
    remaining,
    fallback,
    fallbackLabel: fallback ? `${fbProvider ? providerLabel(fbProvider) : (fallback.provider ?? providerLabel(target))} ${fallback.model}` : null,
    fallbackRemaining: fbProvider ? remainingOf(fbProvider) : null,
  };
}

export function switchDecision(fallback: FallbackTarget): TurnStartDecision {
  return fallback.provider ? { action: "modify", provider: fallback.provider, model: fallback.model } : { action: "modify", model: fallback.model };
}

/** Modal buttons for an `ask` evaluation, and how each index maps to a choice. */
export function promptButtons(ask: Extract<GuardEvaluation, { kind: "ask" }>): { labels: string[]; choices: Array<GuardChoice | "cancel"> } {
  const labels: string[] = [];
  const choices: Array<GuardChoice | "cancel"> = [];
  if (ask.fallback && ask.fallbackLabel) {
    labels.push(`Switch to ${ask.fallbackLabel}`);
    choices.push("switch");
  }
  labels.push("Keep going", "Cancel");
  choices.push("keep", "cancel");
  return { labels, choices };
}

export function formatRemaining(r: Remaining): string {
  const pct = r.percent < 1 && r.percent > 0 ? r.percent.toFixed(1) : String(Math.round(r.percent));
  return `${pct}% left in the ${r.windowLabel} window`;
}

/** Modal body text. */
export function promptBody(ctx: TurnStartContext, ask: Extract<GuardEvaluation, { kind: "ask" }>): string {
  const what = ctx.kind === "delegate" ? "A delegated sub-session" : ctx.kind === "thread-create" ? "A new thread" : ctx.isSubagent ? "An agent's message" : "This message";
  const lines = [`${what} would run on ${ask.providerLabel}${ctx.model ? ` (${ctx.model})` : ""}, which has ${formatRemaining(ask.remaining)}.`];
  if (ask.fallbackLabel) lines.push(`Fallback: ${ask.fallbackLabel}${ask.fallbackRemaining ? `, ${formatRemaining(ask.fallbackRemaining)}` : ""}.`);
  if (ctx.textPreview) lines.push("", `"${ctx.textPreview.length > 120 ? `${ctx.textPreview.slice(0, 120)}...` : ctx.textPreview}"`);
  lines.push("", "Switch and Keep going are remembered for this thread for 10 minutes.");
  return lines.join("\n");
}

/** Turns the modal answer (button index, -1 = dismissed) into a decision, updating the memory. Dismissing counts as Cancel. */
export function resolveChoice(
  ctx: TurnStartContext,
  ask: Extract<GuardEvaluation, { kind: "ask" }>,
  index: number,
  memory: ChoiceMemory,
  now: number,
): TurnStartDecision {
  const { choices } = promptButtons(ask);
  const choice = index >= 0 && index < choices.length ? choices[index]! : "cancel";
  if (choice === "switch" && ask.fallback) {
    memory.set(ctx.threadId, "switch", now);
    return switchDecision(ask.fallback);
  }
  if (choice === "keep") {
    memory.set(ctx.threadId, "keep", now);
    return { action: "allow" };
  }
  return { action: "block", reason: `Cancelled: ${ask.providerLabel} has ${formatRemaining(ask.remaining)} (provider-limits guard).` };
}
