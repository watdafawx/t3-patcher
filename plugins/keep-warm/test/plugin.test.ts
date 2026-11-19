import type { PluginModule, T3Api, ThreadSummary } from "@t3p/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import plugin from "../src/index.js";

const THREAD = "t1";
const summary = (over: Partial<ThreadSummary> = {}): ThreadSummary => ({
  threadId: THREAD, title: "T", projectId: null, providerInstanceId: "claudeAgent", model: "m", updatedAt: null, running: false, settled: false, raw: {}, ...over,
});

function setup(initialSettled: boolean, extra: Record<string, unknown> = {}) {
  const dispatched: unknown[] = [];
  const state = { settled: initialSettled, gone: false };
  const regs: string[] = [];
  const settings: Record<string, unknown> = { leadMinutes: 8, maxPings: 20, minCacheMinutes: 30, keepWarmSettled: false, ...extra };
  const stored: Record<string, unknown> = { watches: { [THREAD]: { pings: 0, until: null, lastPingAt: 0 } } };
  const t3 = {
    settings: { define: () => ({ dispose() {} }), get: (k: string) => settings[k], onChange: () => () => {} },
    storage: { get: async (k: string) => stored[k], set: async (k: string, v: unknown) => void (stored[k] = v) },
    threads: { list: async () => (state.gone ? [summary({ threadId: "other" })] : [summary({ settled: state.settled })]), dispatch: async (c: unknown) => void dispatched.push(c) },
    cache: { state: async () => ({ expiresAt: Date.now() + 5 * 60_000, ttlMs: 3_600_000, source: "reported", lastRequestAt: null }) },
    ui: { register: (r: { slot: string }) => (regs.push(r.slot), { dispose() {} }), toast: () => {} },
    events: { on: () => () => {} },
    log: () => {},
  } as unknown as T3Api;
  const stop = (plugin as PluginModule).start(t3) as () => void;
  return { dispatched, state, stored, stop, regs };
}

describe("keep-warm plugin", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_800_000_000_000 }));
  afterEach(() => vi.useRealTimers());

  it("does not ping a settled thread but keeps the stored watch", async () => {
    const { dispatched, stored, stop } = setup(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(dispatched).toHaveLength(0);
    expect(Object.keys(stored.watches as object)).toEqual([THREAD]);
    stop();
  });

  it("pings an unsettled thread", async () => {
    const { dispatched, stop } = setup(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(dispatched).toHaveLength(1);
    stop();
  });

  it("settling mid-countdown stops pings; un-settling resumes", async () => {
    const { dispatched, state, stop } = setup(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(dispatched).toHaveLength(0);
    state.settled = false;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(dispatched).toHaveLength(1);
    state.settled = true;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(dispatched).toHaveLength(1);
    stop();
  });

  it("drops the watch when the thread is gone from the list (archived or deleted)", async () => {
    const { stored, stop, state } = setup(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(Object.keys(stored.watches as object)).toEqual([THREAD]);
    state.gone = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stored.watches).toEqual({});
    stop();
  });

  it("registers the status bar list and the sidebar decorator slot", () => {
    const { regs, stop } = setup(false);
    expect(regs).toEqual(expect.arrayContaining(["statusBar", "threadListDecorator", "threadHeader"]));
    stop();
  });

  it("keepWarmSettled opts in", async () => {
    const { dispatched, stop } = setup(true, { keepWarmSettled: true });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(dispatched).toHaveLength(1);
    stop();
  });
});
