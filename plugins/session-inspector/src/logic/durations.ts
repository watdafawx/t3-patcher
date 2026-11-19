import type { TimelineRecord } from "@t3p/api";

export interface Duration {
  ms: number;
  /** True when the end is not known yet: `ms` is "so far" and grows with `now`. */
  open: boolean;
}

const TERMINAL = new Set([
  "completed",
  "complete",
  "done",
  "success",
  "succeeded",
  "failed",
  "error",
  "errored",
  "cancelled",
  "canceled",
  "interrupted",
  "rolled_back",
  "resolved",
  "declined",
  "accepted",
  "denied",
  "expired",
  "skipped",
  "stopped",
]);

export function isTerminalStatus(status: string | null): boolean {
  return status !== null && TERMINAL.has(status.toLowerCase());
}

function field(raw: unknown, key: string): unknown {
  return raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>)[key] : undefined;
}

function toMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (Number.isFinite(t) && t > 0) return t;
  }
  return null;
}

/**
 * How long each record took, keyed by record id. Only records that have a span get an entry.
 *
 * - `run.start` / `subagent.start`: to the paired `*.end` record (relation `ends`), else open.
 * - `approval.request` / `input.request`: to the record that `resolves` it (time spent waiting), else open.
 * - turn items (`command`, `tool`, `file-change`, `search`, messages, ...): `raw.startedAt` to
 *   `raw.completedAt`; open while the status is not terminal and there is no `completedAt`.
 * Zero-length spans are dropped. End records (`run.end`, ...) get no entry: the span sits on the start.
 */
export function computeDurations(records: readonly TimelineRecord[], now: number): Map<string, Duration> {
  const closedBy = new Map<string, TimelineRecord>(); // start/request id -> end/resolution record
  for (const r of records) {
    if (r.cause && (r.cause.relation === "ends" || r.cause.relation === "resolves")) closedBy.set(r.cause.recordId, r);
  }

  const out = new Map<string, Duration>();
  const put = (id: string, from: number, to: number | null): void => {
    if (!(from > 0)) return;
    if (to === null) out.set(id, { ms: Math.max(0, now - from), open: true });
    else if (to > from) out.set(id, { ms: to - from, open: false });
  };

  for (const r of records) {
    if (r.kind === "run.end" || r.kind === "subagent.end" || r.kind === "approval.resolved" || r.kind === "input.resolved") continue;
    if (r.kind === "run.start" || r.kind === "subagent.start") {
      const end = closedBy.get(r.id);
      put(r.id, toMs(field(r.raw, "startedAt")) ?? r.at, end ? end.at : null);
      continue;
    }
    if (r.kind === "approval.request" || r.kind === "input.request") {
      const end = closedBy.get(r.id);
      put(r.id, r.at, end ? end.at : null);
      continue;
    }
    const start = toMs(field(r.raw, "startedAt"));
    if (start === null) continue;
    const end = toMs(field(r.raw, "completedAt"));
    if (end !== null) put(r.id, start, end);
    else if (r.status !== null && !isTerminalStatus(r.status)) put(r.id, start, null);
  }
  return out;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)} s`;
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s - m * 60)}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m - h * 60}m`;
}

/** "5s ago", "3m ago", "2h ago", "4d ago"; "never" for 0 or unknown. */
export function formatAge(at: number | null, now: number): string {
  if (at === null || !(at > 0)) return "never";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function formatClock(at: number): string {
  if (!(at > 0)) return "--:--:--";
  const d = new Date(at);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
