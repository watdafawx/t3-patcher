import { describe, expect, it } from "vitest";

import { decide, isUnknownThreadError, nextPingAt, pingsAfterActivity, threadFacts, type Rules, type Watch } from "../src/model.js";

const rules: Rules = { leadMs: 8 * 60_000, maxPings: 20, minTtlMs: 30 * 60_000 };
const now = 1_000_000_000;
const watch = (over: Partial<Watch> = {}): Watch => ({ pings: 0, until: null, lastPingAt: 0, ...over });
const state = (expiresAt: number | null, ttlMs: number | null = 3_600_000, lastRequestAt: number | null = null) => ({
  expiresAt,
  ttlMs,
  source: "reported" as const,
  lastRequestAt,
});

describe("decide", () => {
  it("pings inside the lead window", () => {
    expect(decide(watch(), state(now + 5 * 60_000), false, now, rules)).toEqual({ action: "ping" });
  });
  it("waits while the cache is fresh", () => {
    expect(decide(watch(), state(now + 30 * 60_000), false, now, rules).action).toBe("wait");
  });
  it("never wakes a cold cache", () => {
    expect(decide(watch(), state(now - 1), false, now, rules)).toMatchObject({ action: "wait", reason: "cache already expired" });
  });
  it("waits while a run is active", () => {
    expect(decide(watch(), state(now + 60_000), true, now, rules).action).toBe("wait");
  });
  it("skips short caches", () => {
    expect(decide(watch(), state(now + 60_000, 5 * 60_000), false, now, rules).action).toBe("wait");
  });
  it("waits without expiry info", () => {
    expect(decide(watch(), null, false, now, rules).action).toBe("wait");
    expect(decide(watch(), state(null), false, now, rules).action).toBe("wait");
  });
  it("stops at the ping cap and at the deadline", () => {
    expect(decide(watch({ pings: 20 }), state(now + 60_000), false, now, rules).action).toBe("stop");
    expect(decide(watch({ until: now - 1 }), state(now + 60_000), false, now, rules).action).toBe("stop");
  });
  it("does not ping twice in a minute", () => {
    expect(decide(watch({ lastPingAt: now - 30_000 }), state(now + 60_000), false, now, rules).action).toBe("wait");
  });
});

describe("activity", () => {
  it("resets pings when a foreign request arrived after our ping", () => {
    expect(pingsAfterActivity(watch({ pings: 3, lastPingAt: now - 600_000 }), state(now + 1, 3_600_000, now - 60_000))).toBe(0);
  });
  it("keeps pings when the last request was our own", () => {
    expect(pingsAfterActivity(watch({ pings: 3, lastPingAt: now - 10_000 }), state(now + 1, 3_600_000, now - 9_000))).toBe(3);
  });
});

describe("nextPingAt", () => {
  it("is expiry minus lead, never in the past", () => {
    expect(nextPingAt(state(now + 3_600_000), now, 480_000)).toBe(now + 3_600_000 - 480_000);
    expect(nextPingAt(state(now + 60_000), now, 480_000)).toBe(now);
    expect(nextPingAt(state(now - 1), now, 480_000)).toBeNull();
  });
});

describe("threadFacts", () => {
  const projection = (over: Record<string, unknown> = {}) => ({
    thread: { title: "Group sync", providerInstanceId: "claudeAgent", modelSelection: { model: "claude-sonnet-5-5" }, archivedAt: null, settledOverride: null },
    providerTurns: [{ status: "completed", startedAt: "2026-01-01T00:00:00.000Z" }],
    ...over,
  });

  it("reads title, provider and model", () => {
    expect(threadFacts(projection())).toMatchObject({ title: "Group sync", providerInstanceId: "claudeAgent", model: "claude-sonnet-5-5" });
  });

  it("reports archived threads and missing fields", () => {
    expect(threadFacts(projection({ thread: { archivedAt: "2026-01-01T00:00:00.000Z" } })).archived).toBe(true);
    expect(threadFacts(projection({ thread: { archivedAt: null } })).archived).toBe(false);
    expect(threadFacts(null)).toMatchObject({ title: null, providerInstanceId: null, model: null, settled: false, archived: false, activeTurn: false });
  });

  it("uses the newest turn to decide whether a run is active", () => {
    const turns = [
      { status: "running", startedAt: "2026-01-01T00:02:00.000Z" },
      { status: "completed", startedAt: "2026-01-01T00:01:00.000Z" },
    ];
    expect(threadFacts(projection({ providerTurns: turns })).activeTurn).toBe(true);
    expect(threadFacts(projection({ providerTurns: [{ status: "completed" }, { status: "failed" }] })).activeTurn).toBe(false);
    expect(threadFacts(projection({ providerTurns: [] })).activeTurn).toBe(false);
  });

  it("trusts the projection's settled flag over the override", () => {
    expect(threadFacts(projection({ settled: true })).settled).toBe(true);
    expect(threadFacts(projection({ thread: { settledOverride: "settled" } })).settled).toBe(true);
    expect(threadFacts(projection({ thread: { settledOverride: "active" } })).settled).toBe(false);
  });
});

describe("isUnknownThreadError", () => {
  it("tells a deleted thread apart from a dropped socket", () => {
    expect(isUnknownThreadError(new Error("unknown thread t1"))).toBe(true);
    expect(isUnknownThreadError("RpcError: thread not found")).toBe(true);
    expect(isUnknownThreadError(new Error("cannot call orchestration.getThreadProjection: client is reconnecting"))).toBe(false);
    expect(isUnknownThreadError(new Error("connection lost"))).toBe(false);
  });
});

describe("decide: settled threads", () => {
  it("never pings a settled thread, even inside the lead window", () => {
    expect(decide(watch(), state(now + 5 * 60_000), false, now, rules, true)).toEqual({ action: "settled", reason: "settled: not kept warm" });
  });
  it("settled wins over a reached time limit and keeps the watch (no stop)", () => {
    expect(decide(watch({ until: now - 1 }), state(now + 5 * 60_000), false, now, rules, true).action).toBe("settled");
  });
  it("pings again once un-settled", () => {
    expect(decide(watch(), state(now + 5 * 60_000), false, now, rules, false)).toEqual({ action: "ping" });
  });
  it("keepWarmSettled opts in", () => {
    expect(decide(watch(), state(now + 5 * 60_000), false, now, { ...rules, keepWarmSettled: true }, true)).toEqual({ action: "ping" });
  });
});
