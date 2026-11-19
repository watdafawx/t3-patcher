/**
 * Pure helpers for the provider-limits plugin: threshold classification, formatting,
 * worst-case selection and the per-provider view model.
 *
 * No DOM, no `t3` access, so everything here is unit tested directly.
 *
 * Percent scale: `usedPercent` is 0..100 (a percentage, not a 0..1 fraction). Verified
 * against `.upstream/packages/contracts/src/providerUsageLimits.ts` (v0.1.10, vendored as
 * `packages/contracts-vendor`): `ServerProviderUsageWindow.usedPercent` is
 * `Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 }))`.
 * Display code clamps it to 0..100 anyway, for forward compatibility with a server that
 * sends a stray value.
 */

import type { ProviderSnapshot, ProviderUsageLimits } from "@t3p/api";

/** One usage-limit window as the server reports it. */
export type LimitWindow = ProviderUsageLimits["windows"][number];

/** How a used percent compares with the two thresholds. */
export type LimitLevel = "ok" | "warn" | "critical";

export interface LimitThresholds {
  warnThreshold: number;
  criticalThreshold: number;
}

export const DEFAULT_THRESHOLDS: LimitThresholds = { warnThreshold: 80, criticalThreshold: 95 };

/** `ok` < `warn` < `critical`; used to detect rising crossings only. */
export const LEVEL_RANK: Record<LimitLevel, number> = { ok: 0, warn: 1, critical: 2 };

/** Classifies a 0..100 used percent. A critical threshold below the warn one still wins. */
export function classifyPercent(usedPercent: number, thresholds: LimitThresholds = DEFAULT_THRESHOLDS): LimitLevel {
  if (usedPercent >= thresholds.criticalThreshold) return "critical";
  if (usedPercent >= thresholds.warnThreshold) return "warn";
  return "ok";
}

/** Provider display label: configured name first, then the driver, then the stable instance id. */
export function providerLabel(provider: ProviderSnapshot): string {
  const displayName = provider.displayName?.trim();
  if (displayName) return displayName;
  return provider.driver || provider.instanceId;
}

/** The windows of one provider (never `undefined`). */
export function windowsOf(provider: ProviderSnapshot): readonly LimitWindow[] {
  return provider.usageLimits?.windows ?? [];
}

/** Epoch ms of an ISO timestamp, or `null` when absent or unparseable. */
export function parseIso(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** `42%` for a 0..100 value (rounded, clamped). `?%` for a non-number. */
export function formatPercent(usedPercent: number): string {
  if (!Number.isFinite(usedPercent)) return "?%";
  return `${Math.round(clampPercent(usedPercent))}%`;
}

/** Value for a CSS width, 0..100. */
export function barPercent(usedPercent: number): number {
  if (!Number.isFinite(usedPercent)) return 0;
  return clampPercent(usedPercent);
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/**
 * Live "time to reset" text.
 *
 * `null` target → `no reset time`; a target at or before `nowMs` → `reset overdue`
 * (that also covers a `resetsAt` that arrived in the past); otherwise `in 3h 12m`,
 * `in 4d 2h`, `in 12m` or `in <1m`.
 */
export function formatCountdown(targetMs: number | null, nowMs: number): string {
  if (targetMs === null) return "no reset time";
  const diff = targetMs - nowMs;
  if (diff <= 0) return "reset overdue";
  const totalMinutes = Math.floor(diff / 60_000);
  if (totalMinutes < 1) return "in <1m";
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `in ${days}d ${hours}h` : `in ${days}d`;
  if (hours > 0) return minutes > 0 ? `in ${hours}h ${minutes}m` : `in ${hours}h`;
  return `in ${minutes}m`;
}

/** `5h`, `7d`, `1h 30m`; empty when the server did not report a duration. */
export function formatWindowDuration(mins: number | null | undefined): string {
  if (mins === null || mins === undefined || !Number.isFinite(mins) || mins <= 0) return "";
  if (mins % 1440 === 0) return `${mins / 1440}d`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** `authenticated`, or `authenticated (you@example.com)` when the server names the account. */
export function formatAuth(auth: ProviderSnapshot["auth"]): string {
  const detail = [auth.label, auth.email, auth.type].map((value) => value?.trim()).find((value) => value);
  return detail ? `${auth.status} (${detail})` : auth.status;
}

/** `enabled · installed`, `disabled`, `not installed`, ... */
export function formatProviderFlags(provider: ProviderSnapshot): string {
  const flags: string[] = [provider.enabled ? "enabled" : "disabled"];
  if (!provider.installed) flags.push("not installed");
  if (provider.version) flags.push(`v${provider.version}`);
  return flags.join(" · ");
}

/** What a provider's `usageLimits` says, in one category. */
export type LimitsNote =
  | { kind: "ok" }
  | { kind: "no-data" }
  | { kind: "no-windows" }
  | { kind: "unavailable"; reason: string; message: string | null };

export function limitsNote(limits: ProviderUsageLimits | undefined): LimitsNote {
  if (!limits) return { kind: "no-data" };
  if (limits.unavailable) {
    return { kind: "unavailable", reason: limits.unavailable.reason, message: limits.unavailable.message ?? null };
  }
  if (limits.windows.length === 0) return { kind: "no-windows" };
  return { kind: "ok" };
}

/** Human text for a {@link LimitsNote}. `no limit data` is the exact text for a provider without limits. */
export function limitsNoteText(note: LimitsNote): string {
  switch (note.kind) {
    case "no-data":
      return "no limit data";
    case "no-windows":
      return "no windows reported";
    case "unavailable":
      return note.message
        ? `limits unavailable (${note.reason}): ${note.message}`
        : `limits unavailable (${note.reason})`;
    default:
      return "";
  }
}

/** `1 reset credit · next expires in 12d`, or `null` when the provider reports none. */
export function formatResetCredits(credits: ProviderUsageLimits["resetCredits"], nowMs: number): string | null {
  if (!credits) return null;
  const noun = credits.availableCount === 1 ? "reset credit" : "reset credits";
  const head = `${credits.availableCount} ${noun}`;
  const expiresAt = parseIso(credits.nextExpiresAt);
  if (expiresAt === null) return head;
  return `${head} · next expires ${formatCountdown(expiresAt, nowMs)}`;
}

/** One provider window, formatted for the panel. */
export interface LimitWindowView {
  id: string;
  label: string;
  kind: string;
  usedPercent: number;
  percentText: string;
  barPercent: number;
  level: LimitLevel;
  /** Live countdown, e.g. `in 3h 12m`. Recomputed on every tick. */
  resetCountdown: string;
  /** `5h window`; empty when the server reported no duration. */
  durationText: string;
}

/** One provider instance, formatted for the panel. */
export interface ProviderLimitsView {
  instanceId: string;
  label: string;
  status: string;
  authText: string;
  flags: string;
  note: LimitsNote;
  noteText: string;
  windows: LimitWindowView[];
  resetCreditsText: string | null;
}

/** Builds the panel view for every provider, keeping the server's order. */
export function buildProviderViews(
  providers: readonly ProviderSnapshot[],
  thresholds: LimitThresholds,
  nowMs: number,
): ProviderLimitsView[] {
  return providers.map((provider) => {
    const note = limitsNote(provider.usageLimits);
    return {
      instanceId: provider.instanceId,
      label: providerLabel(provider),
      status: provider.status,
      authText: formatAuth(provider.auth),
      flags: formatProviderFlags(provider),
      note,
      noteText: limitsNoteText(note),
      windows: windowsOf(provider).map((window) => {
        const duration = formatWindowDuration(window.windowDurationMins);
        return {
          id: window.id,
          label: window.label,
          kind: window.kind,
          usedPercent: window.usedPercent,
          percentText: formatPercent(window.usedPercent),
          barPercent: barPercent(window.usedPercent),
          level: classifyPercent(window.usedPercent, thresholds),
          resetCountdown: formatCountdown(parseIso(window.resetsAt), nowMs),
          durationText: duration ? `${duration} window` : "",
        };
      }),
      resetCreditsText: formatResetCredits(provider.usageLimits?.resetCredits, nowMs),
    };
  });
}

/** The highest usedPercent across every provider instance and window. */
export interface WorstLimit {
  instanceId: string;
  providerLabel: string;
  windowId: string;
  windowLabel: string;
  usedPercent: number;
  level: LimitLevel;
  resetsAtMs: number | null;
}

/**
 * Picks the worst window. Ties break by the earlier reset (a window with no `resetsAt`
 * sorts last), then by the lower instance id and window id, so the choice is stable
 * across ticks.
 */
export function pickWorst(
  providers: readonly ProviderSnapshot[],
  thresholds: LimitThresholds = DEFAULT_THRESHOLDS,
): WorstLimit | null {
  let best: WorstLimit | null = null;
  for (const provider of providers) {
    const label = providerLabel(provider);
    for (const window of windowsOf(provider)) {
      const candidate: WorstLimit = {
        instanceId: provider.instanceId,
        providerLabel: label,
        windowId: window.id,
        windowLabel: window.label,
        usedPercent: window.usedPercent,
        level: classifyPercent(window.usedPercent, thresholds),
        resetsAtMs: parseIso(window.resetsAt),
      };
      if (best === null || compareWorst(candidate, best) > 0) best = candidate;
    }
  }
  return best;
}

function compareWorst(a: WorstLimit, b: WorstLimit): number {
  if (a.usedPercent !== b.usedPercent) return a.usedPercent - b.usedPercent;
  const aReset = a.resetsAtMs ?? Number.POSITIVE_INFINITY;
  const bReset = b.resetsAtMs ?? Number.POSITIVE_INFINITY;
  if (aReset !== bReset) return bReset - aReset; // earlier reset is worse
  const byInstance = b.instanceId.localeCompare(a.instanceId); // lower id wins a tie
  if (byInstance !== 0) return byInstance;
  return b.windowId.localeCompare(a.windowId);
}

/** Chip text: provider label, worst percent and its live reset countdown. */
export function formatChipText(worst: WorstLimit | null, nowMs: number): string {
  if (!worst) return "Limits: no data";
  return `${worst.providerLabel} ${formatPercent(worst.usedPercent)} · ${formatCountdown(worst.resetsAtMs, nowMs)}`;
}
