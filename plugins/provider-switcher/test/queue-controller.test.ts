import type { ModelSelection, SwitchResult, ThreadStreamItem } from "@t3p/api";
import { describe, expect, it } from "vitest";

import type { QueueEffect } from "../src/logic/queue.js";
import { SwitchQueue, type SwitchQueueThreads } from "../src/queue.js";

/** A fake `t3.threads` whose thread stream a test drives by hand. */
function fakeThreads(results: SwitchResult[]) {
  const emit: Array<(item: ThreadStreamItem) => void> = [];
  const calls: Array<{ call: "setModel" | "switchProvider"; threadId: string; selection: ModelSelection }> = [];
  const cancelled: string[] = [];
  const subscribed: string[] = [];
  const next = (): SwitchResult => results.shift() ?? { status: "error", message: "no fake result left" };
  const threads: SwitchQueueThreads = {
    subscribe(threadId, callback) {
      subscribed.push(threadId);
      emit.push(callback);
      return () => cancelled.push(threadId);
    },
    async setModel(threadId, selection) {
      calls.push({ call: "setModel", threadId, selection });
      return next();
    },
    async switchProvider(threadId, selection) {
      calls.push({ call: "switchProvider", threadId, selection });
      return next();
    },
  };
  return {
    threads,
    calls,
    cancelled,
    get subscribed() {
      return subscribed;
    },
    emitRun(threadId: string, id: string, status: string): void {
      for (const callback of emit) {
        callback({
          kind: "event",
          sequence: 1,
          event: { type: "run.updated", payload: { id, status, threadId } },
        } as unknown as ThreadStreamItem);
      }
    },
    emitSnapshotIdle(): void {
      for (const callback of emit) {
        callback({ kind: "snapshot", snapshotSequence: 1, projection: { runs: [] } } as unknown as ThreadStreamItem);
      }
    },
  };
}

const request = {
  threadId: "t1",
  selection: { providerInstanceId: "codex", model: "gpt-6.1-sol" },
  kind: "provider" as const,
};

/** Lets the queue's awaited retry settle. */
const settle = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

describe("SwitchQueue", () => {
  it("watches the thread once and retries when the run ends", async () => {
    const fake = fakeThreads([{ status: "ok", result: { sequence: 2 } }]);
    const effects: QueueEffect[] = [];
    const queue = new SwitchQueue({ threads: fake.threads, onEffect: (effect) => effects.push(effect) });

    queue.request(request);
    expect(queue.pending).toEqual(expect.objectContaining({ threadId: "t1", attempts: 0, inFlight: false }));
    expect(fake.subscribed).toEqual(["t1"]);

    fake.emitRun("t1", "r1", "running");
    expect(fake.calls).toEqual([]);

    fake.emitRun("t1", "r1", "completed");
    await settle();

    expect(fake.calls).toEqual([{ call: "switchProvider", threadId: "t1", selection: request.selection }]);
    expect(queue.pending).toBeNull();
    expect(effects.map((effect) => effect.type)).toEqual(["retry", "cleared"]);
    queue.dispose();
  });

  it("gives up with one toast when the retry hits another run, and never retries again", async () => {
    const fake = fakeThreads([{ status: "busy", message: "a run is active" }]);
    const effects: QueueEffect[] = [];
    const queue = new SwitchQueue({ threads: fake.threads, onEffect: (effect) => effects.push(effect) });

    queue.request(request);
    fake.emitSnapshotIdle();
    await settle();

    expect(fake.calls).toHaveLength(1);
    expect(queue.pending).toBeNull();
    const giveUp = effects.find((effect) => effect.type === "given-up");
    expect(giveUp).toEqual(expect.objectContaining({ type: "given-up", message: expect.stringContaining("the thread kept running") }));

    fake.emitSnapshotIdle();
    fake.emitRun("t1", "r2", "completed");
    await settle();
    expect(fake.calls).toHaveLength(1);
    expect(fake.subscribed).toEqual(["t1"]);
    queue.dispose();
  });

  it("cancelling stops the watcher and nothing is retried", async () => {
    const fake = fakeThreads([{ status: "ok", result: { sequence: 3 } }]);
    const effects: QueueEffect[] = [];
    const queue = new SwitchQueue({ threads: fake.threads, onEffect: (effect) => effects.push(effect) });

    queue.request(request);
    queue.cancel();
    expect(fake.cancelled).toEqual(["t1"]);

    fake.emitSnapshotIdle();
    await settle();
    expect(fake.calls).toEqual([]);
    expect(effects.map((effect) => effect.type)).toEqual(["cleared"]);
    queue.dispose();
  });

  it("a second request replaces the first and watches the new thread", async () => {
    const fake = fakeThreads([{ status: "ok", result: { sequence: 4 } }]);
    const effects: QueueEffect[] = [];
    const queue = new SwitchQueue({ threads: fake.threads, onEffect: (effect) => effects.push(effect) });

    queue.request(request);
    queue.request({ threadId: "t2", selection: { providerInstanceId: "claudeAgent", model: "opus" }, kind: "model" });
    expect(fake.subscribed).toEqual(["t1", "t2"]);
    expect(queue.pending?.threadId).toBe("t2");

    fake.emitSnapshotIdle();
    await settle();
    expect(fake.calls).toEqual([
      { call: "setModel", threadId: "t2", selection: { providerInstanceId: "claudeAgent", model: "opus" } },
    ]);
    queue.dispose();
  });

  it("drops the queue when the focused thread changes", async () => {
    const fake = fakeThreads([]);
    const effects: QueueEffect[] = [];
    const queue = new SwitchQueue({ threads: fake.threads, onEffect: (effect) => effects.push(effect) });

    queue.request(request);
    queue.setFocusedThread("t2");
    expect(queue.pending).toBeNull();
    expect(effects).toEqual([expect.objectContaining({ type: "cleared", reason: "thread-changed" })]);
    queue.dispose();
  });

  it("notifies subscribers when the pending switch appears and disappears", async () => {
    const fake = fakeThreads([{ status: "ok", result: { sequence: 5 } }]);
    const queue = new SwitchQueue({ threads: fake.threads, onEffect: () => undefined });
    let paints = 0;
    const off = queue.subscribe(() => {
      paints += 1;
    });

    queue.request(request);
    expect(paints).toBe(1);
    fake.emitSnapshotIdle();
    await settle();
    // appear, retry in flight, cleared
    expect(paints).toBe(3);
    off();
    queue.request(request);
    expect(paints).toBe(3);
    queue.dispose();
  });
});
