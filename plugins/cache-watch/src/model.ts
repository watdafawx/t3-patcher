import type { CacheState } from "@t3p/api";

/** One thread's row in the watch list. */
export interface Row {
  threadId: string;
  title: string;
  providerInstanceId: string | null;
  model?: string | null;
  /** Context-window tokens in use (`t3.usage.context`), or null when unknown. */
  usedTokens?: number | null;
  state: CacheState | null;
}

/** Overrides in minutes per provider instance id; 0 or absent = use the runtime's default. */
export type TtlOverrides = Readonly<Record<string, number>>;

/**
 * `t3.cache` has no setter for the assumed-TTL table (frozen API), so the plugin applies its own
 * override on top: only for `assumed` states with a known request time.
 */
export function applyOverride(state: CacheState | null, provider: string | null, overrides: TtlOverrides): CacheState | null {
  if (!state || state.source !== "assumed" || provider === null || state.lastRequestAt === null) return state;
  const minutes = overrides[provider];
  if (typeof minutes !== "number" || !(minutes > 0)) return state;
  const ttlMs = minutes * 60_000;
  return { ...state, ttlMs, expiresAt: state.lastRequestAt + ttlMs };
}

/** `4:07`, `1:02:03`, `expired`, or `?` when unknown. */
export function formatRemaining(state: CacheState | null, now: number): string {
  if (!state || state.expiresAt === null) return "?";
  const left = state.expiresAt - now;
  if (left <= 0) return "expired";
  const total = Math.ceil(left / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** Source label shown next to the countdown. */
export function sourceLabel(state: CacheState | null): string {
  if (!state) return "";
  return state.source === "reported" ? "reported" : state.source === "carried" ? "carried" : "estimate";
}

/** Live caches first by time left, then expired, then unknown. */
export function sortRows(rows: Row[], now: number): Row[] {
  const rank = (r: Row): number => {
    const at = r.state?.expiresAt;
    if (at === null || at === undefined) return Number.POSITIVE_INFINITY;
    return at > now ? at - now : Number.MAX_SAFE_INTEGER - 1;
  };
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title));
}

/** Cache prices in $ per 1M tokens. */
export interface CachePrices {
  readPerM: number;
  writePerM: number;
}

/** User overrides in $ per 1M tokens; 0 or absent = use the built-in table. */
export interface PriceOverrides {
  cacheReadPerM?: number;
  cacheWritePerM?: number;
}

/**
 * Built-in input prices ($/M tokens, approximate public list prices) by model family. Cache read is
 * 0.1x input (0.05x for Gemini 4 Neon); cache write (5 min) is 1.25x input for Claude, and plain input
 * for GPT/Codex and Gemini (no write surcharge). Estimates only: edit via the plugin settings.
 */
const FAMILIES: ReadonlyArray<{ match: RegExp; input: number; write: number; read?: number }> = [
  { match: /opus/i, input: 5, write: 1.25 },
  { match: /sonnet/i, input: 3, write: 1.25 },
  { match: /haiku/i, input: 1, write: 1.25 },
  { match: /gpt|codex/i, input: 1.25, write: 1 },
  { match: /gemini-4-neon|neon/i, input: 3, write: 1, read: 0.05 },
];

const positive = (n: number | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/** Prices for a model, or `null` when the family is unknown and no override covers both sides. */
export function pricesFor(model: string | null, overrides: PriceOverrides = {}): CachePrices | null {
  const family = model ? FAMILIES.find((f) => f.match.test(model)) : undefined;
  const readPerM = positive(overrides.cacheReadPerM) ? overrides.cacheReadPerM : family ? family.input * (family.read ?? 0.1) : undefined;
  const writePerM = positive(overrides.cacheWritePerM) ? overrides.cacheWritePerM : family ? family.input * family.write : undefined;
  return readPerM === undefined || writePerM === undefined ? null : { readPerM, writePerM };
}

/** Extra cost in $ of re-warming a cold cache: tokens re-written instead of read. `null` = unknown. */
export function rewarmCost(usedTokens: number | null, prices: CachePrices | null): number | null {
  if (prices === null || usedTokens === null || !Number.isFinite(usedTokens) || usedTokens < 0) return null;
  return (usedTokens / 1e6) * Math.max(0, prices.writePerM - prices.readPerM);
}

/** `~$0.42`, `~$12`, `<$0.01`. */
export function formatCost(cost: number): string {
  if (cost < 0.005) return "<$0.01";
  return cost < 10 ? `~$${cost.toFixed(2)}` : `~$${Math.round(cost)}`;
}

/** `~85k`, `~1.2M`, `~420`. */
export function formatTokens(tokens: number): string {
  if (tokens >= 1e6) return `~${(tokens / 1e6).toFixed(1)}M`;
  if (tokens >= 1000) return `~${Math.round(tokens / 1000)}k`;
  return `~${Math.round(tokens)}`;
}

/** Below this much context a cold start is cheap whatever you choose. */
export const CHEAP_CONTEXT_TOKENS = 50_000;

/** `~85k ctx · re-warm ~$0.40` (dollars only when the price is known); `""` without a context size. */
export function contextLabel(usedTokens: number | null, prices: CachePrices | null): string {
  if (usedTokens === null || usedTokens <= 0) return "";
  const cost = rewarmCost(usedTokens, prices);
  return cost === null ? `${formatTokens(usedTokens)} ctx` : `${formatTokens(usedTokens)} ctx · re-warm ${formatCost(cost)}`;
}

/** Keep-or-restart hint for the popover; `""` when nothing useful is known. */
export function verdictHint(state: CacheState | null, usedTokens: number | null, prices: CachePrices | null, now: number): string {
  if (!state || state.expiresAt === null) return "";
  if (state.expiresAt > now) return "warm: free";
  if (usedTokens === null) return "";
  if (usedTokens < CHEAP_CONTEXT_TOKENS) return "cheap either way";
  const cost = rewarmCost(usedTokens, prices);
  return cost === null ? "cold: new session starts fresh" : `cold: re-warm ${formatCost(cost)}, new session ~$0`;
}
