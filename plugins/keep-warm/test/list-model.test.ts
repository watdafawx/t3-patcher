import { describe, expect, it } from "vitest";

import { activeCount, buildRow, cacheKind, cacheLabel, decide, decoratorTip, formatCountdown, sortListRows, type Rules, type Watch } from "../src/model.js";

const rules: Rules = { leadMs: 8 * 60_000, maxPings: 20, minTtlMs: 30 * 60_000 };
const now = 1_000_000_000;
const watch = (over: Partial<Watch> = {}): Watch => ({ pings: 0, until: null, lastPingAt: 0, ...over });
const state = (expiresAt: number | null) => ({ expiresAt, ttlMs: 3_600_000, source: "reported" as const, lastRequestAt: null });

describe("list model", () => {
  const info = { title: "Fix login", projectName: "app", providerInstanceId: "claudeAgent", model: "opus" };
  const row = (over: { watch?: Partial<Watch>; expiresAt?: number | null; settled?: boolean; title?: string } = {}) =>
    buildRow(
      {
        threadId: over.title ?? "t",
        watch: watch(over.watch),
        info: { ...info, title: over.title ?? info.title },
        state: over.expiresAt === undefined ? state(now + 20 * 60_000) : over.expiresAt === null ? null : state(over.expiresAt),
        settled: over.settled ?? false,
        note: "",
      },
      now,
      rules,
    );

  it("classifies cache state", () => {
    expect(cacheKind(state(now + 20 * 60_000), now, rules.leadMs)).toBe("warm");
    expect(cacheKind(state(now + 5 * 60_000), now, rules.leadMs)).toBe("cooling");
    expect(cacheKind(state(now - 1), now, rules.leadMs)).toBe("cold");
    expect(cacheKind(null, now, rules.leadMs)).toBe("unknown");
  });

  it("formats countdowns", () => {
    expect(formatCountdown(0)).toBe("now");
    expect(formatCountdown(500)).toBe("1s");
    expect(formatCountdown(45_000)).toBe("45s");
    expect(formatCountdown(4 * 60_000)).toBe("4m");
    expect(formatCountdown(4 * 60_000 + 1)).toBe("5m");
    expect(formatCountdown(65 * 60_000)).toBe("1h 05m");
    expect(formatCountdown(2 * 3_600_000)).toBe("2h");
  });

  it("schedules the next ping only for active watches", () => {
    expect(row().nextPingAt).toBe(now + 12 * 60_000);
    expect(row({ watch: { paused: true } }).nextPingAt).toBeNull();
    expect(row({ settled: true }).nextPingAt).toBeNull();
    expect(row({ expiresAt: null }).nextPingAt).toBeNull();
    expect(row({ settled: true }).active).toBe(false);
  });

  it("sorts soonest ping first, then paused, then settled", () => {
    const rows = sortListRows([
      row({ title: "settled", settled: true }),
      row({ title: "late", expiresAt: now + 40 * 60_000 }),
      row({ title: "paused", watch: { paused: true } }),
      row({ title: "soon", expiresAt: now + 10 * 60_000 }),
      row({ title: "unknown", expiresAt: null }),
    ]);
    expect(rows.map((r) => r.title)).toEqual(["soon", "late", "unknown", "paused", "settled"]);
    expect(activeCount(rows)).toBe(3);
  });

  it("labels cache and tooltip", () => {
    expect(cacheLabel(row(), now)).toBe("warm · 20m left");
    expect(decoratorTip(row({ watch: { pings: 3 } }), now)).toBe("Kept warm: next ping in 12m · 3/20 pings");
    expect(decoratorTip(row({ watch: { paused: true, pings: 3 } }), now)).toBe("Keep-warm paused · 3/20 pings");
    expect(decoratorTip(row({ settled: true }), now)).toContain("settled");
  });

  it("a paused watch is never pinged", () => {
    expect(decide(watch({ paused: true }), state(now + 60_000), false, now, rules)).toEqual({ action: "wait", reason: "paused" });
  });
});
