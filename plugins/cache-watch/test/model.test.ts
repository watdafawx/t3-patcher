import type { CacheState } from "@t3p/api";
import { describe, expect, it } from "vitest";

import { applyOverride, contextLabel, formatCost, formatRemaining, formatTokens, pricesFor, rewarmCost, sortRows, sourceLabel, verdictHint, type Row } from "../src/model.js";

const st = (expiresAt: number | null, source: CacheState["source"] = "reported", lastRequestAt: number | null = 0): CacheState => ({ expiresAt, ttlMs: null, source, lastRequestAt });

describe("model", () => {
  it("formats remaining time", () => {
    expect(formatRemaining(st(4 * 60_000 + 7000), 0)).toBe("4:07");
    expect(formatRemaining(st(3_723_000), 0)).toBe("1:02:03");
    expect(formatRemaining(st(1000), 5000)).toBe("expired");
    expect(formatRemaining(st(null), 0)).toBe("?");
    expect(formatRemaining(null, 0)).toBe("?");
  });
  it("labels sources", () => {
    expect(sourceLabel(st(1, "reported"))).toBe("reported");
    expect(sourceLabel(st(1, "carried"))).toBe("carried");
    expect(sourceLabel(st(1, "assumed"))).toBe("estimate");
  });
  it("overrides only assumed states", () => {
    expect(applyOverride(st(300_000, "assumed", 1000), "codex", { codex: 10 })).toMatchObject({ expiresAt: 601_000, ttlMs: 600_000 });
    expect(applyOverride(st(300_000, "reported", 1000), "codex", { codex: 10 })!.expiresAt).toBe(300_000);
    expect(applyOverride(st(300_000, "assumed", 1000), "codex", { codex: 0 })!.expiresAt).toBe(300_000);
    expect(applyOverride(null, "codex", { codex: 10 })).toBeNull();
  });
  it("sorts by time to expiry: live, expired, unknown", () => {
    const row = (id: string, s: CacheState | null): Row => ({ threadId: id, title: id, providerInstanceId: null, state: s });
    const out = sortRows([row("none", null), row("old", st(100)), row("late", st(9000)), row("soon", st(2000))], 1000);
    expect(out.map((r) => r.threadId)).toEqual(["soon", "late", "old", "none"]);
  });
  it("prices by model family, overrides win, unknown is null", () => {
    expect(pricesFor("claude-opus-4-1")).toEqual({ readPerM: 0.5, writePerM: 6.25 });
    expect(pricesFor("claude-sonnet-5-5")?.writePerM).toBeCloseTo(3.75);
    expect(pricesFor("claude-haiku-5-5")?.readPerM).toBeCloseTo(0.1);
    expect(pricesFor("gpt-6.1-sol")?.writePerM).toBeCloseTo(1.25);
    expect(pricesFor("mystery-model")).toBeNull();
    expect(pricesFor(null)).toBeNull();
    expect(pricesFor("mystery-model", { cacheReadPerM: 1, cacheWritePerM: 2 })).toEqual({ readPerM: 1, writePerM: 2 });
    expect(pricesFor("mystery-model", { cacheReadPerM: 1 })).toBeNull();
    expect(pricesFor("claude-sonnet-5-5", { cacheWritePerM: 10 })?.writePerM).toBe(10);
    expect(pricesFor("claude-sonnet-5-5", { cacheReadPerM: 0, cacheWritePerM: 0 })?.writePerM).toBeCloseTo(3.75);
  });
  it("rewarmCost = used/1M x (write - read)", () => {
    expect(rewarmCost(1_000_000, { readPerM: 0.3, writePerM: 3.75 })).toBeCloseTo(3.45);
    expect(rewarmCost(100_000, { readPerM: 0.3, writePerM: 3.75 })).toBeCloseTo(0.345);
    expect(rewarmCost(0, { readPerM: 1, writePerM: 2 })).toBe(0);
    expect(rewarmCost(5000, null)).toBeNull();
    expect(rewarmCost(null, { readPerM: 1, writePerM: 2 })).toBeNull();
    expect(rewarmCost(1e6, { readPerM: 5, writePerM: 2 })).toBe(0);
  });
  it("formats tokens, cost and the context label", () => {
    expect(formatTokens(85_400)).toBe("~85k");
    expect(formatTokens(1_250_000)).toBe("~1.3M");
    expect(formatTokens(420)).toBe("~420");
    expect(formatCost(0.351)).toBe("~$0.35");
    expect(formatCost(0.001)).toBe("<$0.01");
    expect(formatCost(12.4)).toBe("~$12");
    const p = { readPerM: 0.3, writePerM: 3.75 };
    expect(contextLabel(200_000, p)).toBe("~200k ctx · re-warm ~$0.69");
    expect(contextLabel(100_000, null)).toBe("~100k ctx");
    expect(contextLabel(null, p)).toBe("");
  });
  it("verdict hint: warm, cold, cheap", () => {
    const p = { readPerM: 0.3, writePerM: 3.75 };
    expect(verdictHint(st(10_000), 200_000, p, 0)).toBe("warm: free");
    expect(verdictHint(st(1000), 200_000, p, 5000)).toBe("cold: re-warm ~$0.69, new session ~$0");
    expect(verdictHint(st(1000), 49_999, p, 5000)).toBe("cheap either way");
    expect(verdictHint(st(1000), 100_000, null, 5000)).toBe("cold: new session starts fresh");
    expect(verdictHint(st(1000), null, p, 5000)).toBe("");
    expect(verdictHint(null, 100_000, p, 0)).toBe("");
  });
});
