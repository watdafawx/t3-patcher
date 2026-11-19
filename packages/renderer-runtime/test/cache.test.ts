import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { T3PermissionError, type CacheState } from "@t3p/api";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CacheStore, createCacheApi } from "../src/cache.js";
import { computeCacheState, type CacheProjectionWire } from "../src/cache-rules.js";
import type { SharedRpc } from "../src/rpc.js";
import { Scope } from "../src/scope.js";

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/cache-projection-claude.json", import.meta.url)), "utf8")) as CacheProjectionWire;
const at = (s: string): number => Date.parse(s);

function fakeShared(projection: unknown, shellThreads: Array<{ id: string; updatedAt: string }> = [{ id: "th-1", updatedAt: "2026-11-19T10:09:00.000Z" }]) {
  const stats = { calls: 0, shellSubs: 0, projection };
  const client = {
    call: async (method: string, payload: unknown) => {
      stats.calls++;
      if (method !== "orchestration.getThreadProjection") throw new Error(`unexpected ${method}`);
      if ((payload as { threadId: string }).threadId === "unknown") throw new Error("thread not found");
      return stats.projection;
    },
    subscribe: (method: string, _p: unknown, onItem: (i: unknown) => void) => {
      if (method === "orchestration.subscribeShell") stats.shellSubs++;
      queueMicrotask(() => onItem({ kind: "snapshot", snapshot: { threads: shellThreads } }));
      return { cancel: () => undefined, done: new Promise<void>(() => undefined) };
    },
  };
  return { stats, shared: { ready: async () => ({ client, base: "" }) } as unknown as SharedRpc };
}

afterEach(() => vi.useRealTimers());

describe("countdown math against a recorded-shape thread projection", () => {
  it("fixture: last request is a full cache read -> carried 1h from the NEWEST request, countdown ticks down", () => {
    const state = computeCacheState(fixture, at("2026-11-19T10:09:00.000Z"))!;
    expect(state.source).toBe("carried");
    expect(state.ttlMs).toBe(3_600_000);
    expect(state.lastRequestAt).toBe(at("2026-11-19T10:08:30.000Z"));
    expect(state.expiresAt).toBe(at("2026-11-19T11:08:30.000Z"));
    // remaining time at three moments: 59:30, 30:00, 0
    expect(state.expiresAt! - at("2026-11-19T10:09:00.000Z")).toBe(59 * 60_000 + 30_000);
    expect(state.expiresAt! - at("2026-11-19T10:38:30.000Z")).toBe(30 * 60_000);
    expect(state.expiresAt! - at("2026-11-19T11:08:30.000Z")).toBe(0);
  });
});

describe("t3.cache", () => {
  const make = (fake: ReturnType<typeof fakeShared>, now: () => number, allowed = true) => {
    const scope = new Scope();
    const store = new CacheStore(fake.shared, () => undefined, now);
    return { scope, api: createCacheApi({ id: "p", allowed, shared: fake.shared, scope, log: () => undefined, store, now }) };
  };

  it("needs rpc", () => {
    const { api } = make(fakeShared(fixture), Date.now, false);
    expect(() => api.onExpiring("th-1", 1, () => undefined)).toThrow(T3PermissionError);
  });

  it("state for an unknown thread resolves null without throwing", async () => {
    const fake = fakeShared(fixture);
    const { api } = make(fake, Date.now);
    await expect(api.state("unknown")).resolves.toBeNull();
  });

  it("state of a known thread; second call reuses the projection (one fetch, one shell subscription)", async () => {
    const fake = fakeShared(fixture);
    const now = at("2026-11-19T10:09:00.000Z");
    const { api } = make(fake, () => now);
    const a = await api.state("th-1");
    const b = await api.state("th-1");
    expect(a).toEqual(b);
    expect(a?.source).toBe("carried");
    expect(fake.stats.calls).toBe(1);
    expect(fake.stats.shellSubs).toBe(1);
  });

  it("onExpiring fires once when the lead is reached, not again for the same expiry, and stops on dispose", async () => {
    vi.useFakeTimers();
    const fake = fakeShared({ ...fixture, providerTurns: [fixture.providerTurns![0]] });
    // reported expiry: 11:00:20
    let now = at("2026-11-19T10:58:00.000Z");
    vi.setSystemTime(now);
    const { api, scope } = make(fake, () => Date.now());
    const seen: CacheState[] = [];
    api.onExpiring("th-1", 60_000, (s) => seen.push(s));
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toHaveLength(0); // 2m20s left
    now = at("2026-11-19T10:59:30.000Z");
    vi.setSystemTime(now);
    await vi.advanceTimersByTimeAsync(40_000); // polls until inside the 60 s lead
    expect(seen).toHaveLength(1);
    expect(seen[0]?.source).toBe("reported");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(seen).toHaveLength(1);
    scope.disposeAll(() => undefined);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("onExpiring does not fire for an already expired cache", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at("2026-11-19T12:00:00.000Z"));
    const fake = fakeShared({ ...fixture, providerTurns: [fixture.providerTurns![0]] });
    const { api, scope } = make(fake, () => Date.now());
    const seen: CacheState[] = [];
    api.onExpiring("th-1", 60_000, (s) => seen.push(s));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(seen).toHaveLength(0);
    scope.disposeAll(() => undefined);
  });
});
