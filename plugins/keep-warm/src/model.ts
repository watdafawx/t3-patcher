import type { CacheState } from "@t3p/api";

export interface Watch {
  /** Pings sent since the user last did something in the thread. */
  pings: number;
  /** Epoch ms after which keep-warm stops by itself, or null. */
  until: number | null;
  /** Epoch ms of our last ping, or 0. */
  lastPingAt: number;
  /** Set by "Pause" in the list: the watch stays stored but is never pinged until resumed. */
  paused?: boolean;
}

export interface Rules {
  leadMs: number;
  maxPings: number;
  /** Caches shorter than this are not worth pinging (a ping costs more than it saves). */
  minTtlMs: number;
  /** Power users: keep settled threads warm too. Default false. */
  keepWarmSettled?: boolean;
}

export type Decision =
  | { action: "ping" }
  | { action: "wait"; reason: string }
  | { action: "stop"; reason: string }
  /** The thread is settled: no ping, but the watch stays stored and resumes on un-settle. */
  | { action: "settled"; reason: string };

export const SETTLED_REASON = "settled: not kept warm";

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
export function decide(watch: Watch, state: CacheState | null, running: boolean, now: number, rules: Rules, settled = false): Decision {
  if (settled && !rules.keepWarmSettled) return { action: "settled", reason: SETTLED_REASON };
  if (watch.paused) return { action: "wait", reason: "paused" };
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

// ---------------------------------------------------------------------------------------------
// Thread facts from the projection
// ---------------------------------------------------------------------------------------------

/**
 * The per-thread facts the plugin needs, read from `orchestration.getThreadProjection`.
 * The shell thread list is NOT a reliable source for these: in current T3 builds it can miss
 * threads entirely (only some projects' threads are streamed), so a watch must never be judged
 * gone, settled or idle from a list that simply does not mention it.
 */
export interface ThreadFacts {
  title: string | null;
  providerInstanceId: string | null;
  model: string | null;
  /** The thread is in T3's Settled section. */
  settled: boolean;
  /** The thread is archived: its watch is dropped. */
  archived: boolean;
  /** The newest provider turn has not finished: a run is active. */
  activeTurn: boolean;
}

const TERMINAL_TURN_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "rolled_back", "stopped"]);

interface ProjectionWire {
  settled?: unknown;
  thread?: {
    title?: unknown;
    providerInstanceId?: unknown;
    modelSelection?: { model?: unknown } | null;
    archivedAt?: unknown;
    settledOverride?: unknown;
  } | null;
  providerTurns?: Array<{ status?: unknown; startedAt?: unknown; completedAt?: unknown }> | null;
}

function newestTurn(turns: ProjectionWire["providerTurns"]): { status?: unknown; at: number } | null {
  let newest: { status?: unknown; at: number } | null = null;
  for (const turn of turns ?? []) {
    if (!turn || typeof turn !== "object") continue;
    const at = Date.parse(String(turn.completedAt ?? turn.startedAt ?? ""));
    const time = Number.isNaN(at) ? 0 : at;
    if (!newest || time >= newest.at) newest = { status: turn.status, at: time };
  }
  return newest;
}

/** Reads the facts above out of one projection (the wire shape of `t3.threads.projection`). */
export function threadFacts(projection: unknown): ThreadFacts {
  const wire = (projection ?? {}) as ProjectionWire;
  const thread = wire.thread ?? {};
  const title = typeof thread.title === "string" && thread.title.length > 0 ? thread.title : null;
  const providerInstanceId = typeof thread.providerInstanceId === "string" ? thread.providerInstanceId : null;
  const model = typeof thread.modelSelection?.model === "string" ? thread.modelSelection.model : null;
  const settled = wire.settled === true || thread.settledOverride === "settled";
  const newest = newestTurn(wire.providerTurns);
  const status = newest?.status;
  const activeTurn = typeof status === "string" && status.length > 0 && !TERMINAL_TURN_STATUSES.has(status);
  return { title, providerInstanceId, model, settled, archived: thread.archivedAt != null, activeTurn };
}

/** True for a projection error that means the thread is not there any more (not a dropped socket). */
export function isUnknownThreadError(error: unknown): boolean {
  return /unknown thread|not found|no such thread/i.test(String(error));
}

// ---------------------------------------------------------------------------------------------
// List model (status bar popover and sidebar icon)
// ---------------------------------------------------------------------------------------------

export type CacheKind = "warm" | "cooling" | "cold" | "unknown";

export interface ThreadInfo {
  title: string;
  projectName: string | null;
  providerInstanceId: string | null;
  model: string | null;
}

export interface ListRow {
  threadId: string;
  title: string;
  project: string | null;
  provider: string | null;
  model: string | null;
  cache: CacheKind;
  /** Epoch ms the cache expires, or null. */
  expiresAt: number | null;
  /** Epoch ms of the next ping, or null (nothing scheduled: paused, settled, cold, unknown). */
  nextPingAt: number | null;
  pings: number;
  maxPings: number;
  paused: boolean;
  settled: boolean;
  /** True while the watch is really being kept warm (not paused, not settled). */
  active: boolean;
  note: string;
}

export function cacheKind(state: CacheState | null, now: number, leadMs: number): CacheKind {
  if (!state || state.expiresAt === null) return "unknown";
  const left = state.expiresAt - now;
  return left <= 0 ? "cold" : left <= leadMs ? "cooling" : "warm";
}

export interface RowInput {
  threadId: string;
  watch: Watch;
  info: ThreadInfo | null;
  state: CacheState | null;
  settled: boolean;
  note: string;
}

export function buildRow(input: RowInput, now: number, rules: Rules): ListRow {
  const { watch, state, info, settled } = input;
  const paused = watch.paused === true;
  const active = !paused && !settled;
  const kind = cacheKind(state, now, rules.leadMs);
  const next = active && state ? nextPingAt(state, now, rules.leadMs) : null;
  return {
    threadId: input.threadId,
    title: info?.title || input.threadId,
    project: info?.projectName ?? null,
    provider: info?.providerInstanceId ?? null,
    model: info?.model ?? null,
    cache: kind,
    expiresAt: state?.expiresAt ?? null,
    nextPingAt: next,
    pings: watch.pings,
    maxPings: rules.maxPings,
    paused,
    settled,
    active,
    note: input.note,
  };
}

/** Soonest ping first; active before paused before settled; then by title. */
export function sortListRows(rows: ListRow[]): ListRow[] {
  const rank = (r: ListRow): number => (r.active ? 0 : r.paused ? 1 : 2);
  return [...rows].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const an = a.nextPingAt ?? Number.POSITIVE_INFINITY;
    const bn = b.nextPingAt ?? Number.POSITIVE_INFINITY;
    if (an !== bn) return an - bn;
    return a.title.localeCompare(b.title) || a.threadId.localeCompare(b.threadId);
  });
}

/** "45s", "4m", "1h 05m", "now". Rounds up so a countdown never shows 0 before it fires. */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return "now";
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${h}h` : `${h}h ${String(rest).padStart(2, "0")}m`;
}

export function activeCount(rows: ListRow[]): number {
  return rows.reduce((n, r) => n + (r.active ? 1 : 0), 0);
}

export function cacheLabel(row: ListRow, now: number): string {
  if (row.cache === "unknown") return "cache unknown";
  if (row.expiresAt === null) return row.cache;
  return row.cache === "cold" ? "cold" : `${row.cache} · ${formatCountdown(row.expiresAt - now)} left`;
}

/** Tooltip of the sidebar icon: "Kept warm: next ping in 4m · 3/20 pings". */
export function decoratorTip(row: ListRow, now: number): string {
  const pings = `${row.pings}/${row.maxPings} pings`;
  if (row.settled) return `Keep-warm paused: thread is settled · ${pings}`;
  if (row.paused) return `Keep-warm paused · ${pings}`;
  if (row.nextPingAt !== null) return `Kept warm: next ping in ${formatCountdown(row.nextPingAt - now)} · ${pings}`;
  if (row.cache === "cold") return `Kept warm: cache is cold, waiting · ${pings}`;
  return `Kept warm: waiting for the cache · ${pings}`;
}
