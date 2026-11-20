import { describe, expect, it } from "vitest";

import { computeCacheState, DEFAULT_ASSUMED_TTL_MS, SKEW_TOLERANCE_MS, type CacheProjectionWire } from "../src/cache-rules.js";

const T0 = Date.parse("2026-11-19T10:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

const turn = (providerThreadId: string, at: number, usage: Record<string, unknown> | null, ordinal = 1) => ({
  providerThreadId,
  ordinal,
  startedAt: iso(at - 1000),
  completedAt: iso(at),
  ...(usage ? { tokenUsage: { updatedAt: iso(at), ...usage } } : {}),
});

const threads = [
  { id: "pt-claude", driver: "claudeAgent", providerInstanceId: "claudeAgent" },
  { id: "pt-codex", driver: "codex", providerInstanceId: "codex" },
  { id: "pt-agy", driver: "antigravity", providerInstanceId: "antigravity" },
];
const proj = (turns: unknown[], provider = "claudeAgent"): CacheProjectionWire => ({
  thread: { providerInstanceId: provider },
  providerThreads: threads,
  providerTurns: turns as CacheProjectionWire["providerTurns"],
});

describe("computeCacheState", () => {
  it("no turns / no projection -> null", () => {
    expect(computeCacheState(null, T0)).toBeNull();
    expect(computeCacheState(proj([]), T0)).toBeNull();
  });

  it("reported: uses promptCacheExpiresAt and promptCacheTtlMs", () => {
    const p = proj([turn("pt-claude", T0, { inputTokens: 10, cachedInputTokens: 5, promptCacheTtlMs: 300_000, promptCacheExpiresAt: iso(T0 + 300_000) })]);
    expect(computeCacheState(p, T0 + 1000)).toEqual({ expiresAt: T0 + 300_000, ttlMs: 300_000, source: "reported", lastRequestAt: T0 });
  });

  it("reported without ttl field: ttl derived from expiry - request", () => {
    const p = proj([turn("pt-claude", T0, { inputTokens: 1, promptCacheExpiresAt: iso(T0 + 3_600_000) })]);
    expect(computeCacheState(p, T0)).toMatchObject({ source: "reported", ttlMs: 3_600_000, expiresAt: T0 + 3_600_000 });
  });

  it("carried: full cache read reuses the last reported ttl from the newer request time", () => {
    const p = proj([
      turn("pt-claude", T0, { inputTokens: 100, promptCacheTtlMs: 3_600_000, promptCacheExpiresAt: iso(T0 + 3_600_000) }, 1),
      turn("pt-claude", T0 + 120_000, { inputTokens: 0, cachedInputTokens: 5000 }, 2),
    ]);
    expect(computeCacheState(p, T0 + 121_000)).toEqual({
      expiresAt: T0 + 120_000 + 3_600_000,
      ttlMs: 3_600_000,
      source: "carried",
      lastRequestAt: T0 + 120_000,
    });
  });

  it("carried skips turns that never reported a ttl and picks the most recent reported one", () => {
    const p = proj([
      turn("pt-claude", T0, { inputTokens: 9, promptCacheTtlMs: 300_000, promptCacheExpiresAt: iso(T0 + 300_000) }, 1),
      turn("pt-claude", T0 + 60_000, { cachedInputTokens: 10 }, 2),
      turn("pt-claude", T0 + 120_000, { cachedInputTokens: 10 }, 3),
    ]);
    expect(computeCacheState(p, T0 + 130_000)).toMatchObject({ source: "carried", ttlMs: 300_000, expiresAt: T0 + 120_000 + 300_000 });
  });

  it("carried: inputTokens that includes the cached part (cached >= input) is still a full read", () => {
    const p = proj([
      turn("pt-claude", T0, { inputTokens: 100, promptCacheTtlMs: 3_600_000, promptCacheExpiresAt: iso(T0 + 3_600_000) }, 1),
      turn("pt-claude", T0 + 60_000, { inputTokens: 5000, cachedInputTokens: 5000 }, 2),
    ]);
    expect(computeCacheState(p, T0 + 61_000)).toMatchObject({ source: "carried", expiresAt: T0 + 60_000 + 3_600_000 });
  });

  it("full cache read with no earlier reported ttl falls back to assumed", () => {
    const p = proj([turn("pt-claude", T0, { cachedInputTokens: 10 })]);
    expect(computeCacheState(p, T0)).toEqual({ expiresAt: T0 + 300_000, ttlMs: 300_000, source: "assumed", lastRequestAt: T0 });
  });

  it("partial read (new input tokens, no ttl) is assumed, not carried", () => {
    const p = proj([
      turn("pt-claude", T0, { inputTokens: 5, promptCacheTtlMs: 3_600_000, promptCacheExpiresAt: iso(T0 + 3_600_000) }, 1),
      turn("pt-claude", T0 + 1000, { inputTokens: 50, cachedInputTokens: 10 }, 2),
    ]);
    expect(computeCacheState(p, T0 + 2000)).toMatchObject({ source: "assumed", ttlMs: DEFAULT_ASSUMED_TTL_MS.claudeAgent });
  });

  it("assumed: codex turn without ttl uses the provider table; custom table wins", () => {
    const p = proj([turn("pt-codex", T0, { inputTokens: 3, cachedInputTokens: 2 })], "codex");
    expect(computeCacheState(p, T0)).toEqual({ expiresAt: T0 + 300_000, ttlMs: 300_000, source: "assumed", lastRequestAt: T0 });
    expect(computeCacheState(p, T0, { codex: 600_000 })).toMatchObject({ ttlMs: 600_000, expiresAt: T0 + 600_000 });
  });

  it("assumed: antigravity turn without ttl uses the 5-minute default", () => {
    const p = proj([turn("pt-agy", T0, { inputTokens: 5000, cachedInputTokens: 4096 })], "antigravity");
    expect(computeCacheState(p, T0)).toEqual({ expiresAt: T0 + 300_000, ttlMs: 300_000, source: "assumed", lastRequestAt: T0 });
  });

  it("unknown provider: assumed with null expiry", () => {
    const p: CacheProjectionWire = { thread: { providerInstanceId: "mystery" }, providerThreads: [], providerTurns: [turn("x", T0, { inputTokens: 1 })] };
    expect(computeCacheState(p, T0)).toEqual({ expiresAt: null, ttlMs: null, source: "assumed", lastRequestAt: T0 });
  });

  it("turn without tokenUsage still gives an assumed state from its time", () => {
    expect(computeCacheState(proj([turn("pt-claude", T0, null)]), T0)).toMatchObject({ source: "assumed", lastRequestAt: T0 });
  });

  it("expired cache is reported as is (expiresAt in the past)", () => {
    const p = proj([turn("pt-claude", T0, { inputTokens: 1, promptCacheTtlMs: 300_000, promptCacheExpiresAt: iso(T0 + 300_000) })]);
    expect(computeCacheState(p, T0 + 900_000)!.expiresAt).toBeLessThan(T0 + 900_000);
  });

  it("clock skew: a request far in the local future is clamped to now for carried/assumed", () => {
    const future = T0 + SKEW_TOLERANCE_MS + 3_600_000;
    const p = proj([turn("pt-codex", future, { inputTokens: 1 })], "codex");
    expect(computeCacheState(p, T0, { codex: 300_000 })).toMatchObject({ expiresAt: T0 + 300_000, lastRequestAt: future });
    const near = proj([turn("pt-codex", T0 + 10_000, { inputTokens: 1 })], "codex");
    expect(computeCacheState(near, T0, { codex: 300_000 })!.expiresAt).toBe(T0 + 310_000);
  });

  it("provider switch: carried never borrows a ttl from another provider's turn", () => {
    const p = proj([
      turn("pt-claude", T0, { inputTokens: 5, promptCacheTtlMs: 3_600_000, promptCacheExpiresAt: iso(T0 + 3_600_000) }, 1),
      turn("pt-codex", T0 + 60_000, { cachedInputTokens: 50 }, 2),
    ]);
    expect(computeCacheState(p, T0 + 61_000)).toMatchObject({ source: "assumed", ttlMs: DEFAULT_ASSUMED_TTL_MS.codex, expiresAt: T0 + 60_000 + 300_000 });
  });

  it("provider switch back: latest claude turn reported wins over older codex turns", () => {
    const p = proj([
      turn("pt-codex", T0, { inputTokens: 1 }, 1),
      turn("pt-claude", T0 + 60_000, { inputTokens: 2, promptCacheTtlMs: 300_000, promptCacheExpiresAt: iso(T0 + 360_000) }, 2),
    ]);
    expect(computeCacheState(p, T0 + 61_000)).toMatchObject({ source: "reported", expiresAt: T0 + 360_000 });
  });

  it("orders turns by request time, not array order", () => {
    const p = proj([
      turn("pt-claude", T0 + 60_000, { inputTokens: 1, promptCacheTtlMs: 300_000, promptCacheExpiresAt: iso(T0 + 360_000) }, 2),
      turn("pt-claude", T0, { inputTokens: 1, promptCacheTtlMs: 300_000, promptCacheExpiresAt: iso(T0 + 300_000) }, 1),
    ]);
    expect(computeCacheState(p, T0)!.expiresAt).toBe(T0 + 360_000);
  });
});
