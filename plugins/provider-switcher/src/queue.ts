import type { ModelSelection, SwitchResult, ThreadStreamItem, Unsubscribe } from "@t3p/api";

import {
  createQueueState,
  queueReduce,
  type PendingSwitch,
  type QueueEffect,
  type QueueEvent,
  type QueueState,
} from "./logic/queue.js";
import { applyDomainEvent, applyProjection, createRunTracker, isIdle } from "./logic/runs.js";
import type { RunEventLike } from "./logic/runs.js";
import type { Selection, SwitchKind } from "./logic/types.js";
import { projectionView } from "./map.js";

/** What the queue needs from `t3`. Narrowed so a test can pass a fake. */
export interface SwitchQueueThreads {
  subscribe(threadId: string, callback: (item: ThreadStreamItem) => void): Unsubscribe;
  setModel(threadId: string, selection: ModelSelection): Promise<SwitchResult>;
  switchProvider(threadId: string, selection: ModelSelection): Promise<SwitchResult>;
}

export interface SwitchQueueDeps {
  threads: SwitchQueueThreads;
  /** Every effect of the state machine, for toasts and logs. */
  onEffect(effect: QueueEffect): void;
  log?(level: "debug" | "info" | "warn" | "error", message: string): void;
}

export interface QueueRequest {
  threadId: string;
  selection: Selection;
  kind: SwitchKind;
}

/**
 * Runs the queue-until-idle state machine against `t3.threads`: one thread subscription while a
 * switch waits, one retry when the thread goes idle, and no retry loop.
 */
export class SwitchQueue {
  #state: QueueState = createQueueState();
  #watcher: { threadId: string; cancel: Unsubscribe } | null = null;
  #listeners = new Set<() => void>();
  #disposed = false;

  constructor(private readonly deps: SwitchQueueDeps) {}

  /** The queued switch, or `null`. */
  get pending(): PendingSwitch | null {
    return this.#state.pending;
  }

  /** Fires whenever the pending switch appears, changes or disappears. */
  subscribe(callback: () => void): Unsubscribe {
    this.#listeners.add(callback);
    return () => {
      this.#listeners.delete(callback);
    };
  }

  /** Queues a switch (replacing a queued one) and watches its thread for an idle moment. */
  request(request: QueueRequest): void {
    if (this.#disposed) return;
    this.#dispatch({ type: "request", threadId: request.threadId, selection: request.selection, kind: request.kind });
    this.#watch(request.threadId);
  }

  cancel(): void {
    this.#dispatch({ type: "cancel" });
  }

  /** The focused thread changed: a switch queued for another thread is dropped. */
  setFocusedThread(threadId: string | null): void {
    this.#dispatch({ type: "thread-changed", threadId });
  }

  dispose(): void {
    this.#disposed = true;
    this.#stopWatcher();
    this.#state = createQueueState();
    this.#listeners.clear();
  }

  #dispatch(event: QueueEvent): void {
    const reduction = queueReduce(this.#state, event);
    const changed = reduction.state !== this.#state;
    this.#state = reduction.state;
    if (changed) this.#notify();
    for (const effect of reduction.effects) {
      if (effect.type === "retry") void this.#retry(effect.pending);
      this.deps.onEffect(effect);
    }
    if (!this.#state.pending) this.#stopWatcher();
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        // a broken listener must not break the queue
      }
    }
  }

  #watch(threadId: string): void {
    if (this.#watcher?.threadId === threadId) return;
    this.#stopWatcher();
    let tracker = createRunTracker();
    let cancel: Unsubscribe;
    try {
      cancel = this.deps.threads.subscribe(threadId, (item) => {
        if (this.#disposed) return;
        if (item.kind === "snapshot") tracker = applyProjection(tracker, projectionView(item.projection));
        else if (item.kind === "event") {
          // The wire event union is deep; the tracker only reads `type` and `payload.{id,status}`.
          tracker = applyDomainEvent(tracker, item.event as unknown as RunEventLike);
        } else return;
        if (isIdle(tracker)) this.#dispatch({ type: "idle", threadId });
      });
    } catch (error) {
      const pending = this.#state.pending;
      this.deps.log?.("warn", `cannot watch thread ${threadId}: ${String(error)}`);
      if (pending) {
        this.#dispatch({ type: "cancel" });
        this.deps.onEffect({
          type: "given-up",
          pending,
          message: `The switch could not be watched for the run to end: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }
    this.#watcher = { threadId, cancel };
    this.deps.log?.("debug", `watching thread ${threadId} for an idle moment`);
  }

  #stopWatcher(): void {
    const watcher = this.#watcher;
    this.#watcher = null;
    if (!watcher) return;
    try {
      watcher.cancel();
    } catch {
      // cancelling twice is allowed; a throw here is not worth surfacing
    }
  }

  async #retry(pending: PendingSwitch): Promise<void> {
    let outcome: "ok" | "busy" | "unavailable" | "error";
    let message: string | undefined;
    const selection: ModelSelection = { providerInstanceId: pending.selection.providerInstanceId, model: pending.selection.model };
    try {
      const result =
        pending.kind === "model"
          ? await this.deps.threads.setModel(pending.threadId, selection)
          : await this.deps.threads.switchProvider(pending.threadId, selection);
      outcome = result.status;
      message = result.status === "ok" ? undefined : result.message;
    } catch (error) {
      outcome = "error";
      message = error instanceof Error ? error.message : String(error);
    }
    if (this.#disposed) return;
    this.deps.log?.("debug", `retry of ${pending.selection.providerInstanceId}/${pending.selection.model}: ${outcome}`);
    this.#dispatch({ type: "retry-result", attempt: pending.attempt, outcome, ...(message === undefined ? {} : { message }) });
  }
}
