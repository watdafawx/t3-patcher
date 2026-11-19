import type { CacheState } from "@t3p/api";

export interface Watch {
  /** Pings sent since the user last did something in the thread. */
  pings: number;
  /** Epoch ms after which keep-warm stops by itself, or null. */
  until: number | null;
  /** Epoch ms of our last ping, or 0. */
  lastPingAt: number;
}

export interface Rules {
  leadMs: number;
  maxPings: number;
  /** Caches shorter than this are not worth pinging (a ping costs more than it saves). */
  minTtlMs: number;
}

export type Decision =
  | { action: "ping" }
  | { action: "wait"; reason: string }
  | { action: "stop"; reason: string };

/** A request this long after our last ping means the user (or a run) did something. */
export const ACTIVITY_GRACE_MS = 90_000;
/** Never ping twice within this window: the cache state needs time to catch up. */
export const MIN_PING_GAP_MS = 60_000;

/** Pings reset to zero when the thread had a request that was not ours. */
export function pingsAfterActivity(watch: Watch, state: CacheState | null): number {
  if (state?.lastRequestAt != null && watch.lastPingAt > 0 && state.lastRequestAt > watch.lastPingAt + ACTIVITY_GRACE_MS) return 0;
  return watch.pings;
}

/** What to do for one watched thread right now. Never wakes a cache that is already cold. */
export function decide(watch: Watch, state: CacheState | null, running: boolean, now: number, rules: Rules): Decision {
  if (watch.until !== null && now >= watch.until) return { action: "stop", reason: "reached the time you set" };
  if (watch.pings >= rules.maxPings) return { action: "stop", reason: `${rules.maxPings} pings in a row; sending your next message is cheaper now` };
  if (!state || state.expiresAt === null) return { action: "wait", reason: "no cache expiry known yet" };
  if (state.ttlMs !== null && state.ttlMs < rules.minTtlMs) return { action: "wait", reason: "cache lifetime is too short to be worth pinging" };
  if (state.expiresAt <= now) return { action: "wait", reason: "cache already expired" };
  if (running) return { action: "wait", reason: "a run is active; it refreshes the cache itself" };
  if (now - watch.lastPingAt < MIN_PING_GAP_MS) return { action: "wait", reason: "just pinged" };
  if (state.expiresAt - now <= rules.leadMs) return { action: "ping" };
  return { action: "wait", reason: "cache still fresh" };
}

/** "next ping 14:07" style helper: when the next ping is due, or null. */
export function nextPingAt(state: CacheState | null, now: number, leadMs: number): number | null {
  if (!state || state.expiresAt === null || state.expiresAt <= now) return null;
  return Math.max(now, state.expiresAt - leadMs);
}
