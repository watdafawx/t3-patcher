import type { CacheState } from "@t3p/api";

// ---------------------------------------------------------------------------------------------
// Prompt-cache rules (pure; no I/O, no clock except the `now` argument)
// ---------------------------------------------------------------------------------------------
//
// Input: a thread projection (`orchestration.getThreadProjection`). Each `providerTurns[]` entry may
// carry `tokenUsage` (contracts `OrchestrationV2ProviderTurnTokenUsage`, orchestrationV2.ts:231-242):
// `cachedInputTokens`, `inputTokens`, `promptCacheTtlMs`, `promptCacheExpiresAt`, `updatedAt`.
//
// Rules, evaluated on the LATEST provider turn (by request time, then ordinal):
//
//  1. reported: the turn's `promptCacheExpiresAt` parses -> use it. `ttlMs` = `promptCacheTtlMs`, else
//     `expiresAt - lastRequestAt` when positive, else null.
//  2. carried: no expiry reported, and the request was a FULL cache read (`cachedInputTokens > 0` and
//     `inputTokens` 0/absent or <= cachedInputTokens: nothing was written, so the provider reports no new TTL). Reuse the TTL
//     of the most recent EARLIER turn of the same provider that reported one, applied from this
//     (newer) request's time: `expiresAt = lastRequestAt + ttl`. Reads refresh the entry
//     (Anthropic: "refreshed for no additional cost each time the cached content is used").
//  3. assumed: everything else (no TTL ever reported, e.g. Codex/OpenAI) -> the per-provider default
//     table below, `expiresAt = lastRequestAt + defaultTtl`. Unknown provider -> `expiresAt` null.
//
// A cache does not survive a provider switch, so rule 2 only looks at earlier turns of the same
// provider (driver). `lastRequestAt` = `tokenUsage.updatedAt`, else turn `completedAt`, else `startedAt`.
//
// Clock skew: timestamps are server clock. A `lastRequestAt` more than `SKEW_TOLERANCE_MS` in the
// future of the local clock is clamped to `now` for the carried/assumed arithmetic (a skewed or
// wrong server clock must not give an hours-long countdown). `reported.expiresAt` is passed through
// untouched; the consumer compares it with its own clock.

/** Largest accepted lead of a request timestamp over the local clock. */
export const SKEW_TOLERANCE_MS = 60_000;

/**
 * Assumed cache TTL by provider driver, ms. ESTIMATES: used only when the provider reports no TTL.
 *
 * - `claudeAgent` 300000: Anthropic prompt caching, "By default, the cache has a 5-minute lifetime. The
 *   cache is refreshed for no additional cost each time the cached content is used." A 1-hour option
 *   exists (`ttl: "1h"`) but is never assumed. Source: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 *   (fetched 2026-11-19).
 * - `codex` 300000: OpenAI prompt caching, "Entries typically remain active for around 5 to 10 minutes
 *   of inactivity, up to one hour" (in-memory), extended `24h` "typically keeps entries available for
 *   around 30 minutes". The low end (5 min) is used so the countdown errs early. Source:
 *   https://developers.openai.com/api/docs/guides/prompt-caching (fetched 2026-11-19).
 *
 * - `opencode` 10800000 (3 h): the user's OpenCode runs mostly DeepSeek V4.1 Flash. DeepSeek caches on disk, on by
 *   default, and clears unused entries "usually within a few hours to a few days" (https://api-docs.deepseek.com/guides/kv_cache,
 *   fetched 2026-11-19); a secondary report says full-input caches last at least 72 h, with a short in-memory tier
 *   of minutes that only affects speed. The low end (3 h) is used so the countdown errs early. Models behind OpenCode
 *   with a 5 min cache (Anthropic, OpenAI) need the cache-watch OpenCode setting set to 5.
 * - `antigravity` 300000 (5 min): Gemini 4 Neon uses implicit caching only (explicit caching / custom TTL not
 *   supported; min 4,096-token prefix, 2,050-token delta rule, 95% read discount). Eviction is dynamic server-side,
 *   typically ~5 to 6 minutes of inactivity; the low end (5 min) is used so the countdown errs early.
 *
 * Other drivers have no entry: their state has `expiresAt: null`.
 */
export const DEFAULT_ASSUMED_TTL_MS: Readonly<Record<string, number>> = Object.freeze({
  claudeAgent: 300_000,
  codex: 300_000,
  opencode: 10_800_000,
  antigravity: 300_000,
});

interface UsageWire {
  inputTokens?: unknown;
  cachedInputTokens?: unknown;
  promptCacheTtlMs?: unknown;
  promptCacheExpiresAt?: unknown;
  updatedAt?: unknown;
}

interface TurnWire {
  providerThreadId?: unknown;
  ordinal?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
  tokenUsage?: UsageWire | null;
}

/** The slice of a thread projection the rules read. */
export interface CacheProjectionWire {
  thread?: { providerInstanceId?: unknown } | null;
  providerThreads?: Array<{ id?: unknown; driver?: unknown; providerInstanceId?: unknown }> | null;
  providerTurns?: TurnWire[] | null;
}

interface Resolved {
  at: number;
  ordinal: number;
  provider: string | null;
  usage: UsageWire | null;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

function time(v: unknown): number {
  return typeof v === "string" ? Date.parse(v) : Number.NaN;
}

function requestTime(turn: TurnWire): number {
  for (const v of [turn.tokenUsage?.updatedAt, turn.completedAt, turn.startedAt]) {
    const t = time(v);
    if (!Number.isNaN(t)) return t;
  }
  return Number.NaN;
}

function resolveTurns(projection: CacheProjectionWire): Resolved[] {
  const providers = new Map<string, string>();
  for (const pt of projection.providerThreads ?? []) {
    if (typeof pt?.id !== "string") continue;
    const name = typeof pt.driver === "string" ? pt.driver : typeof pt.providerInstanceId === "string" ? pt.providerInstanceId : null;
    if (name) providers.set(pt.id, name);
  }
  const fallback = typeof projection.thread?.providerInstanceId === "string" ? projection.thread.providerInstanceId : null;
  const out: Resolved[] = [];
  for (const turn of projection.providerTurns ?? []) {
    if (!turn || typeof turn !== "object") continue;
    const at = requestTime(turn);
    if (Number.isNaN(at)) continue;
    const ptId = typeof turn.providerThreadId === "string" ? turn.providerThreadId : "";
    out.push({ at, ordinal: num(turn.ordinal), provider: providers.get(ptId) ?? fallback, usage: turn.tokenUsage ?? null });
  }
  return out.sort((a, b) => a.at - b.at || a.ordinal - b.ordinal);
}

/** The TTL a turn reported, or null. */
function reportedTtl(r: Resolved): number | null {
  const usage = r.usage;
  if (!usage) return null;
  const direct = num(usage.promptCacheTtlMs);
  if (direct > 0) return direct;
  const expires = time(usage.promptCacheExpiresAt);
  if (!Number.isNaN(expires) && expires > r.at) return expires - r.at;
  return null;
}

/** True when the request read the cache and wrote nothing new. */
export function isFullCacheRead(usage: UsageWire | null | undefined): boolean {
  const cached = num(usage?.cachedInputTokens);
  const input = num(usage?.inputTokens);
  // T3 Code reports Claude `inputTokens` INCLUDING the cached part (live: input 52922, cached 44764),
  // other providers may report it excluding. Full read = nothing uncached: input 0/absent, or cached >= input.
  return cached > 0 && (input === 0 || cached >= input);
}

/**
 * Cache state of a thread, or `null` when it has no provider turn yet. `table` maps provider driver to
 * the assumed TTL (default: `DEFAULT_ASSUMED_TTL_MS`).
 */
export function computeCacheState(
  projection: CacheProjectionWire | null | undefined,
  now: number,
  table: Readonly<Record<string, number>> = DEFAULT_ASSUMED_TTL_MS,
): CacheState | null {
  if (!projection) return null;
  const turns = resolveTurns(projection);
  const latest = turns[turns.length - 1];
  if (!latest) return null;
  const lastRequestAt = latest.at;
  const usage = latest.usage;

  // 1. reported
  if (usage) {
    const expires = time(usage.promptCacheExpiresAt);
    if (!Number.isNaN(expires)) {
      return { expiresAt: expires, ttlMs: reportedTtl(latest), source: "reported", lastRequestAt };
    }
  }
  const base = lastRequestAt > now + SKEW_TOLERANCE_MS ? now : lastRequestAt;

  // 2. carried
  if (isFullCacheRead(usage)) {
    for (let i = turns.length - 2; i >= 0; i--) {
      const earlier = turns[i]!;
      if (earlier.provider !== latest.provider) continue;
      const ttl = reportedTtl(earlier);
      if (ttl !== null) return { expiresAt: base + ttl, ttlMs: ttl, source: "carried", lastRequestAt };
    }
  }

  // 3. assumed
  const ttl = latest.provider !== null ? table[latest.provider] : undefined;
  if (typeof ttl === "number" && ttl > 0) return { expiresAt: base + ttl, ttlMs: ttl, source: "assumed", lastRequestAt };
  return { expiresAt: null, ttlMs: null, source: "assumed", lastRequestAt };
}
