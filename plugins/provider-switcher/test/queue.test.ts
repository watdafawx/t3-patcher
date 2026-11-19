import { describe, expect, it } from "vitest";

import { createQueueState, queueReduce, type QueueEffect, type QueueEvent, type QueueState } from "../src/logic/queue.js";

/** Applies events in order and returns the last state plus every effect, like the controller does. */
function drive(events: QueueEvent[]): { state: QueueState; effects: QueueEffect[] } {
  let state = createQueueState();
  const effects: QueueEffect[] = [];
  for (const event of events) {
    const reduction = queueReduce(state, event);
    state = reduction.state;
    effects.push(...reduction.effects);
  }
  return { state, effects };
}

const selection = { providerInstanceId: "codex", model: "gpt-6.1-sol" };
const queued = (threadId = "t1"): QueueEvent => ({ type: "request", threadId, selection, kind: "provider" });

describe("queue-until-idle", () => {
  it("busy, then idle: retries once and clears on success", () => {
    const { state, effects } = drive([
      queued(),
      { type: "idle", threadId: "t1" },
      { type: "retry-result", attempt: 1, outcome: "ok" },
    ]);
    expect(effects).toEqual([
      { type: "retry", pending: expect.objectContaining({ threadId: "t1", attempts: 1, inFlight: true }) },
      { type: "cleared", reason: "ok", pending: expect.objectContaining({ threadId: "t1" }) },
    ]);
    expect(state.pending).toBeNull();
  });

  it("does not retry while a second idle arrives during the retry", () => {
    const { effects } = drive([queued(), { type: "idle", threadId: "t1" }, { type: "idle", threadId: "t1" }]);
    expect(effects.filter((effect) => effect.type === "retry")).toHaveLength(1);
    expect(effects).toHaveLength(1);
  });

  it("only reacts to an idle signal of its own thread", () => {
    const { state, effects } = drive([queued("t1"), { type: "idle", threadId: "t2" }]);
    expect(effects).toEqual([]);
    expect(state.pending?.threadId).toBe("t1");
  });

  it("cancelling clears the queue and a later idle does nothing", () => {
    const { state, effects } = drive([queued(), { type: "cancel" }, { type: "idle", threadId: "t1" }]);
    expect(effects).toEqual([{ type: "cleared", reason: "cancelled", pending: expect.objectContaining({ threadId: "t1" }) }]);
    expect(state.pending).toBeNull();
  });

  it("cancelling an empty queue is a no-op", () => {
    const { state, effects } = drive([{ type: "cancel" }]);
    expect(effects).toEqual([]);
    expect(state.pending).toBeNull();
  });

  it("drops the queue when the focused thread changes", () => {
    const { state, effects } = drive([queued("t1"), { type: "thread-changed", threadId: "t2" }]);
    expect(effects).toEqual([{ type: "cleared", reason: "thread-changed", pending: expect.objectContaining({ threadId: "t1" }) }]);
    expect(state.pending).toBeNull();
  });

  it("keeps the queue when the same thread is focused again, and when focus is null", () => {
    const same = drive([queued("t1"), { type: "thread-changed", threadId: "t1" }]);
    expect(same.effects).toEqual([]);
    const none = drive([queued("t1"), { type: "thread-changed", threadId: null }]);
    expect(none.effects).toEqual([{ type: "cleared", reason: "thread-changed", pending: expect.objectContaining({ threadId: "t1" }) }]);
  });

  it("a second request replaces the first", () => {
    const second = { providerInstanceId: "claudeAgent", model: "claude-opus-5-5" };
    const { state, effects } = drive([
      queued("t1"),
      { type: "idle", threadId: "t1" },
      { type: "request", threadId: "t2", selection: second, kind: "provider" },
      { type: "idle", threadId: "t1" },
      { type: "retry-result", attempt: 1, outcome: "ok" },
    ]);
    expect(state.pending).toEqual(
      expect.objectContaining({ threadId: "t2", selection: second, attempts: 0, inFlight: false, attempt: 2 }),
    );
    expect(effects.filter((effect) => effect.type === "retry")).toHaveLength(1);
    expect(effects.some((effect) => effect.type === "given-up")).toBe(false);
  });

  it("a retry that is busy again gives up instead of looping", () => {
    const { state, effects } = drive([
      queued(),
      { type: "idle", threadId: "t1" },
      { type: "retry-result", attempt: 1, outcome: "busy", message: "run active" },
      { type: "idle", threadId: "t1" },
    ]);
    expect(state.pending).toBeNull();
    expect(effects.filter((effect) => effect.type === "retry")).toHaveLength(1);
    const giveUp = effects.find((effect) => effect.type === "given-up");
    expect(giveUp).toEqual({
      type: "given-up",
      pending: expect.objectContaining({ threadId: "t1", attempts: 1 }),
      message: expect.stringContaining("the thread kept running"),
    });
  });

  it("ignores a retry result that belongs to a replaced request", () => {
    const replacement = { providerInstanceId: "claudeAgent", model: "claude-sonnet-5-5" };
    const { state, effects } = drive([
      queued("t1"),
      { type: "idle", threadId: "t1" },
      { type: "request", threadId: "t1", selection: replacement, kind: "provider" },
      { type: "retry-result", attempt: 1, outcome: "ok" },
    ]);
    expect(state.pending).toEqual(expect.objectContaining({ selection: replacement, attempt: 2 }));
    expect(effects.some((effect) => effect.type === "cleared")).toBe(false);
  });

  it("reports unavailable and error retries with the server message", () => {
    const unavailable = drive([
      queued(),
      { type: "idle", threadId: "t1" },
      { type: "retry-result", attempt: 1, outcome: "unavailable", message: "codex is not installed" },
    ]);
    expect(unavailable.effects.at(-1)).toEqual(
      expect.objectContaining({ type: "given-up", message: expect.stringContaining("codex is not installed") }),
    );
    const error = drive([
      queued(),
      { type: "idle", threadId: "t1" },
      { type: "retry-result", attempt: 1, outcome: "error" },
    ]);
    expect(error.effects.at(-1)).toEqual(
      expect.objectContaining({ type: "given-up", message: expect.stringContaining("refused the switch") }),
    );
  });
});
