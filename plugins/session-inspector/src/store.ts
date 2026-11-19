import type { TimelineRecord } from "@t3p/api";

/**
 * Most thread timelines subscribed at once. Each subscription replays the whole thread and then
 * streams, so this bounds memory and server load. The shown thread always gets a slot first.
 */
export const MAX_SUBSCRIPTIONS = 6;

export type SubscribeFn = (threadId: string, cb: (record: TimelineRecord) => void) => () => void;

/** Records of one thread, upserted by id, ordered by time (stable for equal times). */
export class ThreadFeed {
  private readonly map = new Map<string, TimelineRecord>();
  private cache: TimelineRecord[] | null = null;
  private latest = 0;
  private readonly listeners = new Set<() => void>();
  private unsub: (() => void) | null;

  constructor(
    readonly threadId: string,
    subscribe: SubscribeFn,
  ) {
    this.unsub = subscribe(threadId, (r) => this.push(r));
  }

  private push(r: TimelineRecord): void {
    this.map.set(r.id, r);
    this.cache = null;
    if (r.at > this.latest) this.latest = r.at;
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch {
        /* a bad listener must not break the stream */
      }
    }
  }

  records(): TimelineRecord[] {
    if (!this.cache) this.cache = [...this.map.values()].sort((a, b) => a.at - b.at);
    return this.cache;
  }

  get size(): number {
    return this.map.size;
  }

  /** Epoch ms of the newest record, 0 when none. */
  get lastEventAt(): number {
    return this.latest;
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  close(): void {
    this.unsub?.();
    this.unsub = null;
    this.listeners.clear();
  }
}

/** Keeps at most `cap` feeds open. `want()` lists thread ids by priority; the rest are closed. */
export class FeedPool {
  private readonly feeds = new Map<string, ThreadFeed>();
  private readonly listeners = new Set<() => void>();
  private disposed = false;

  constructor(
    private readonly subscribe: SubscribeFn,
    readonly cap: number = MAX_SUBSCRIPTIONS,
  ) {}

  /** Returns the ids that did not fit under the cap (not subscribed). */
  want(ids: readonly string[]): string[] {
    if (this.disposed) return [...ids];
    const keep = [...new Set(ids)].slice(0, this.cap);
    const dropped = [...new Set(ids)].slice(this.cap);
    let changed = false;
    for (const [id, feed] of this.feeds) {
      if (!keep.includes(id)) {
        feed.close();
        this.feeds.delete(id);
        changed = true;
      }
    }
    for (const id of keep) {
      if (!this.feeds.has(id)) {
        const feed = new ThreadFeed(id, this.subscribe);
        feed.onChange(() => this.emit());
        this.feeds.set(id, feed);
        changed = true;
      }
    }
    if (changed) this.emit();
    return dropped;
  }

  get(id: string): ThreadFeed | undefined {
    return this.feeds.get(id);
  }

  get active(): number {
    return this.feeds.size;
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch {
        /* ignore */
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const f of this.feeds.values()) f.close();
    this.feeds.clear();
    this.listeners.clear();
  }
}
