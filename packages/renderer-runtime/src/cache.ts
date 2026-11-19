import type { CacheState, T3Cache, Unsubscribe } from "@t3p/api";

import { computeCacheState, type CacheProjectionWire } from "./cache-rules.js";
import { requireRpc, type SharedRpc } from "./rpc.js";
import type { Scope } from "./scope.js";
import { threadStore } from "./threads.js";
import type { RemoteLog } from "./types.js";

/** Minimum gap between two projection fetches of one thread. */
const MIN_REFETCH_MS = 2_000;
/** A cached projection older than this is refetched even when the shell row did not change. */
const MAX_AGE_MS = 30_000;
/** `onExpiring` re-evaluates at least this often (an extension must be noticed). */
const POLL_MS = 15_000;

interface Entry {
  projection: CacheProjectionWire | null;
  fetchedAt: number;
  shellUpdatedAt: string | null;
  inflight: Promise<CacheProjectionWire | null> | null;
}

/**
 * Per-renderer projection cache shared by every plugin. It opens NO subscription of its own: it
 * reuses the shared shell thread stream (`threadStore`) to learn when a thread changed
 * (`updatedAt`) and refetches the projection with one `orchestration.getThreadProjection` call.
 */
export class CacheStore {
  readonly #entries = new Map<string, Entry>();

  constructor(
    private readonly shared: SharedRpc,
    private readonly log: RemoteLog,
    private readonly now: () => number = Date.now,
  ) {}

  async state(threadId: string): Promise<CacheState | null> {
    const projection = await this.#projection(threadId);
    return computeCacheState(projection, this.now());
  }

  async #projection(threadId: string): Promise<CacheProjectionWire | null> {
    let shellUpdatedAt: string | null = null;
    try {
      shellUpdatedAt = (await threadStore(this.shared, this.log).list()).find((t) => t.threadId === threadId)?.updatedAt ?? null;
    } catch (error) {
      this.log("warn", `cache: shell thread list unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    const now = this.now();
    let entry = this.#entries.get(threadId);
    if (!entry) {
      entry = { projection: null, fetchedAt: -Infinity, shellUpdatedAt: null, inflight: null };
      this.#entries.set(threadId, entry);
    }
    if (entry.inflight) return entry.inflight;
    const age = now - entry.fetchedAt;
    const changed = shellUpdatedAt !== entry.shellUpdatedAt;
    const stale = entry.fetchedAt === -Infinity || age > MAX_AGE_MS || (changed && age >= MIN_REFETCH_MS);
    if (!stale) return entry.projection;
    const target = entry;
    target.inflight = (async () => {
      try {
        const { client } = await this.shared.ready();
        target.projection = (await client.call("orchestration.getThreadProjection", { threadId })) as CacheProjectionWire;
      } catch (error) {
        // An unknown thread or a dropped socket: no data, no throw. The next call retries.
        this.log("debug", `cache: projection of ${threadId} unavailable: ${error instanceof Error ? error.message : String(error)}`);
        target.projection = null;
      } finally {
        target.fetchedAt = this.now();
        target.shellUpdatedAt = shellUpdatedAt;
        target.inflight = null;
      }
      return target.projection;
    })();
    return target.inflight;
  }
}

const stores = new WeakMap<SharedRpc, CacheStore>();

export function cacheStore(shared: SharedRpc, log: RemoteLog): CacheStore {
  let store = stores.get(shared);
  if (!store) {
    store = new CacheStore(shared, log);
    stores.set(shared, store);
  }
  return store;
}

export interface CacheDeps {
  id: string;
  allowed: boolean;
  shared: SharedRpc;
  scope: Scope;
  log: RemoteLog;
  /** Test seam. */
  store?: CacheStore;
  now?: () => number;
}

/**
 * `t3.cache` for one plugin. Needs the `rpc` permission. The assumed-TTL table is NOT settable here:
 * the frozen `T3Cache` type has no setter, so the table lives in `cache-rules.ts`; a plugin that
 * wants other estimates recomputes `lastRequestAt + ttl` itself for `source: "assumed"` states.
 */
export function createCacheApi(deps: CacheDeps): T3Cache {
  const { id, allowed, shared, scope, log } = deps;
  const store = deps.store ?? cacheStore(shared, log);
  const clock = deps.now ?? Date.now;
  const need = (threadId: string): void => {
    requireRpc(id, allowed);
    scope.assertAlive();
    if (typeof threadId !== "string" || threadId.length === 0) throw new TypeError("threadId must be a non-empty string");
  };
  return Object.freeze({
    async state(threadId: string): Promise<CacheState | null> {
      need(threadId);
      return store.state(threadId);
    },
    onExpiring(threadId: string, leadMs: number, callback: (state: CacheState) => void): Unsubscribe {
      need(threadId);
      if (typeof callback !== "function") throw new TypeError("callback must be a function");
      if (typeof leadMs !== "number" || !Number.isFinite(leadMs) || leadMs < 0) throw new TypeError("leadMs must be a number >= 0");
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      /** expiresAt values already announced: once per cache lifetime. */
      let fired: number | null = null;
      const schedule = (ms: number): void => {
        if (stopped) return;
        timer = setTimeout(() => void tick(), Math.max(250, Math.min(ms, POLL_MS)));
        (timer as unknown as { unref?(): void }).unref?.();
      };
      const tick = async (): Promise<void> => {
        if (stopped) return;
        let state: CacheState | null = null;
        try {
          state = await store.state(threadId);
        } catch (error) {
          log("debug", `cache: state failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (stopped) return;
        if (state && state.expiresAt !== null) {
          const left = state.expiresAt - clock();
          if (left <= 0) return schedule(POLL_MS); // already expired: wait for a new turn
          if (left <= leadMs) {
            if (fired !== state.expiresAt) {
              fired = state.expiresAt;
              try {
                callback(state);
              } catch (error) {
                log("warn", `cache: onExpiring callback threw: ${error instanceof Error ? error.message : String(error)}`);
              }
            }
            return schedule(POLL_MS);
          }
          return schedule(left - leadMs);
        }
        schedule(POLL_MS);
      };
      void tick();
      return scope.add(() => {
        stopped = true;
        if (timer) clearTimeout(timer);
      });
    },
  });
}
