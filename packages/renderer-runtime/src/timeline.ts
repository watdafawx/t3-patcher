import type { T3Timeline, TimelineRecord, Unsubscribe } from "@t3p/api";
import { type RpcClient, watchThread } from "@t3p/rpc-client";
import { createTimeline, type Timeline } from "@t3p/timeline";

import { requireRpc, type SharedRpc } from "./rpc.js";
import type { Scope } from "./scope.js";
import type { RemoteLog } from "./types.js";

/** Threads kept live at once, shared by all plugins. The least recently used one is dropped. */
const MAX_LIVE_THREADS = 12;
/** `list()` waits at most this long for the first snapshot. */
const SNAPSHOT_WAIT_MS = 10_000;

interface Entry {
  timeline: Timeline;
  ready: Promise<void>;
  cancel(): void;
}

/** One normalizer + one `orchestration.subscribeThread` per thread, shared by every plugin. */
export class TimelineStore {
  readonly #entries = new Map<string, Entry>();

  constructor(
    private readonly shared: SharedRpc,
    private readonly log: RemoteLog,
  ) {}

  entry(threadId: string): Entry {
    const existing = this.#entries.get(threadId);
    if (existing) {
      this.#entries.delete(threadId);
      this.#entries.set(threadId, existing);
      return existing;
    }
    const timeline = createTimeline();
    let cancelled = false;
    let inner: { cancel(): void } | null = null;
    let release: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
      setTimeout(resolve, SNAPSHOT_WAIT_MS);
    });
    void this.shared.ready().then(
      ({ client }) => {
        if (cancelled) return;
        inner = watchThread(
          client as unknown as RpcClient,
          threadId,
          (item) => {
            timeline.applySnapshot(item);
            release();
          },
          (item) => timeline.applyEvent(item),
          { onError: (error) => this.log("warn", `timeline: stream for ${threadId} ended: ${error.message}`) },
        );
        if (cancelled) inner.cancel();
      },
      (error: unknown) => {
        this.log("warn", `timeline: could not subscribe to ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
        release();
      },
    );
    const entry: Entry = {
      timeline,
      ready,
      cancel: () => {
        cancelled = true;
        inner?.cancel();
        release();
      },
    };
    this.#entries.set(threadId, entry);
    if (this.#entries.size > MAX_LIVE_THREADS) {
      const oldest = this.#entries.keys().next().value as string;
      this.#entries.get(oldest)?.cancel();
      this.#entries.delete(oldest);
    }
    return entry;
  }
}

const stores = new WeakMap<SharedRpc, TimelineStore>();

export function timelineStore(shared: SharedRpc, log: RemoteLog): TimelineStore {
  let store = stores.get(shared);
  if (!store) {
    store = new TimelineStore(shared, log);
    stores.set(shared, store);
  }
  return store;
}

export interface TimelineDeps {
  id: string;
  allowed: boolean;
  shared: SharedRpc;
  scope: Scope;
  log: RemoteLog;
}

/** `t3.timeline` for one plugin. Needs the `rpc` permission. */
export function createTimelineApi(deps: TimelineDeps): T3Timeline {
  const { id, allowed, shared, scope, log } = deps;
  const store = timelineStore(shared, log);
  const check = (threadId: string): void => {
    requireRpc(id, allowed);
    scope.assertAlive();
    if (typeof threadId !== "string" || threadId.length === 0) throw new TypeError("threadId must be a non-empty string");
  };
  return Object.freeze({
    async list(threadId: string): Promise<TimelineRecord[]> {
      check(threadId);
      const entry = store.entry(threadId);
      await entry.ready;
      return entry.timeline.records();
    },
    subscribe(threadId: string, callback: (record: TimelineRecord) => void): Unsubscribe {
      check(threadId);
      if (typeof callback !== "function") throw new TypeError("callback must be a function");
      const entry = store.entry(threadId);
      let off: (() => void) | null = null;
      let stopped = false;
      void entry.ready.then(() => {
        if (stopped) return;
        for (const record of entry.timeline.records()) callback(record);
        off = entry.timeline.subscribe((change) => {
          for (const record of [...change.added, ...change.updated]) callback(record);
        });
      });
      const stop = scope.add(() => {
        stopped = true;
        off?.();
      });
      return stop;
    },
  });
}
