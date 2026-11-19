/**
 * Fallback model choice for the turn guard (WP-11A). Pure: no DOM, no `t3`.
 *
 * Candidates are the manual override (when set), then the user's favorite models in their order,
 * then one default model per other provider. Each candidate is judged by ITS provider's tightest
 * limit window. The first healthy known-good candidate wins; candidates whose limits are unknown
 * are allowed but only after every known-good one.
 */
import type { ProviderSnapshot } from "@t3p/api";

import { providerLabel, windowsOf } from "./limits.js";

export interface Remaining {
  /** 0..100, of the tightest window. */
  percent: number;
  windowLabel: string;
  /** ISO reset time of that window, when reported. */
  resetsAt: string | null;
}

/** Remaining percent of a provider's tightest window (session and weekly alike), or null when it reports none. */
export function remainingOf(provider: ProviderSnapshot): Remaining | null {
  let worst: Remaining | null = null;
  for (const w of windowsOf(provider)) {
    const used = Number(w.usedPercent);
    if (!Number.isFinite(used)) continue;
    const percent = Math.max(0, Math.min(100, 100 - used));
    if (!worst || percent < worst.percent) worst = { percent, windowLabel: windowLabel(w), resetsAt: typeof w.resetsAt === "string" ? w.resetsAt : null };
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

export interface FavoriteModel {
  provider: string;
  model: string;
}

/** Reads `server.getConfig().settings.favorites` (null = unmigrated, treated as none). Malformed rows are dropped. */
export function parseFavorites(value: unknown): FavoriteModel[] {
  if (!Array.isArray(value)) return [];
  const out: FavoriteModel[] = [];
  for (const row of value) {
    const o = row as { provider?: unknown; model?: unknown } | null;
    if (o && typeof o.provider === "string" && typeof o.model === "string" && o.provider && o.model) out.push({ provider: o.provider, model: o.model });
  }
  return out;
}

export type CandidateSource = "override" | "favorite" | "provider";

export interface FallbackPick {
  provider: string;
  model: string;
  providerLabel: string;
  source: CandidateSource;
  /** Null when the provider reports no limit data. */
  remaining: Remaining | null;
}

export interface SkippedCandidate {
  provider: string;
  model: string;
  source: CandidateSource;
  reason: string;
  /** Remaining percent, when the skip was for low quota. */
  percent?: number;
}

export interface ChooseFallbackInput {
  /** The turn being guarded. */
  request: { provider: string; model: string | null };
  favorites: readonly FavoriteModel[];
  /** Provider snapshots (auth, status, models, usage limits). */
  limits: readonly ProviderSnapshot[];
  /** A candidate needs at least this percent left. */
  threshold: number;
  /** Manual `guardFallback` override, tried first. */
  override?: FallbackTarget | null;
}

export interface ChooseFallbackResult {
  pick: FallbackPick | null;
  skipped: SkippedCandidate[];
}

interface Candidate {
  provider: string;
  model: string;
  source: CandidateSource;
}

function unusable(p: ProviderSnapshot): string | null {
  if (p.enabled === false) return "disabled";
  if (p.installed === false) return "not installed";
  if (p.status === "disabled") return "disabled";
  if (p.status === "error") return "provider error";
  if (p.auth?.status === "unauthenticated") return "not signed in";
  return null;
}

/** Picks the fallback model for a guarded turn. Never throws. */
export function chooseFallback(input: ChooseFallbackInput): ChooseFallbackResult {
  const { request, favorites, limits, threshold, override } = input;
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const add = (provider: string | null, model: string | null | undefined, source: CandidateSource): void => {
    if (!provider || !model) return;
    const key = `${provider}\u0000${model}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ provider, model, source });
  };
  seen.add(`${request.provider}\u0000${request.model ?? ""}`);
  if (override) add(override.provider ?? request.provider, override.model, "override");
  for (const f of favorites) add(f.provider, f.model, "favorite");
  // Provider-level order: the default (else first) model of every provider not yet represented.
  const represented = new Set(candidates.map((c) => c.provider));
  for (const p of limits) {
    if (represented.has(p.instanceId) || p.instanceId === request.provider) continue;
    const model = p.models.find((m) => m.isDefault) ?? p.models[0];
    if (model) {
      add(p.instanceId, model.slug, "provider");
      represented.add(p.instanceId);
    }
  }

  const skipped: SkippedCandidate[] = [];
  const known: FallbackPick[] = [];
  const unknown: FallbackPick[] = [];
  for (const c of candidates) {
    const p = limits.find((x) => x.instanceId === c.provider);
    const base = { provider: c.provider, model: c.model, source: c.source };
    if (!p) {
      skipped.push({ ...base, reason: "provider unavailable" });
      continue;
    }
    const bad = unusable(p);
    if (bad) {
      skipped.push({ ...base, reason: bad });
      continue;
    }
    if (p.models.length > 0 && !p.models.some((m) => m.slug === c.model)) {
      skipped.push({ ...base, reason: "model not offered" });
      continue;
    }
    const remaining = remainingOf(p);
    if (remaining && remaining.percent < threshold) {
      skipped.push({ ...base, reason: `${formatPct(remaining.percent)} left`, percent: remaining.percent });
      continue;
    }
    (remaining ? known : unknown).push({ ...base, providerLabel: providerLabel(p), remaining });
  }
  return { pick: known[0] ?? unknown[0] ?? null, skipped };
}

export function formatPct(percent: number): string {
  return `${percent < 1 && percent > 0 ? percent.toFixed(1) : String(Math.round(percent))}%`;
}
