import type { TimelineRecord } from "@t3p/api";
import { computeDurations } from "./durations.js";
import { GROUPS, isUnfiltered, type RecordFilter } from "./filter.js";

export interface ExportedRecord extends Omit<TimelineRecord, "raw" | "enrichment"> {
  durationMs: number | null;
  /** True when the duration is still growing (no end yet). */
  durationOpen: boolean;
  raw: unknown;
}

export interface TimelineExport {
  format: "t3p-session-inspector/1";
  exportedAt: string;
  threadId: string | null;
  /** True when a kind or text filter was applied, so `records` is a subset of `total`. */
  filtered: boolean;
  filter: { groups: string[]; text: string };
  total: number;
  count: number;
  records: ExportedRecord[];
}

/**
 * Shapes the JSON file. `all` is the full timeline (used for durations so a filtered export keeps
 * the right spans); `shown` is what goes into the file (the filtered list, or the same as `all`).
 */
export function buildExport(args: {
  threadId: string | null;
  all: readonly TimelineRecord[];
  shown: readonly TimelineRecord[];
  filter: RecordFilter;
  now: number;
}): TimelineExport {
  const durations = computeDurations(args.all, args.now);
  const records: ExportedRecord[] = args.shown.map((r) => {
    const { raw, enrichment: _enrichment, ...rest } = r;
    const d = durations.get(r.id);
    return { ...rest, durationMs: d ? Math.round(d.ms) : null, durationOpen: d?.open ?? false, raw };
  });
  return {
    format: "t3p-session-inspector/1",
    exportedAt: new Date(args.now).toISOString(),
    threadId: args.threadId,
    filtered: !isUnfiltered(args.filter),
    filter: {
      groups: GROUPS.filter((g) => args.filter.groups.has(g.id)).map((g) => g.id),
      text: args.filter.text,
    },
    total: args.all.length,
    count: records.length,
    records,
  };
}

/** JSON.stringify that survives circular references and bigints (replaced by markers). */
export function safeStringify(value: unknown, space: number | undefined = 2): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(
    value,
    (_k, v: unknown) => {
      if (typeof v === "bigint") return `${v.toString()}n`;
      if (v !== null && typeof v === "object") {
        if (seen.has(v)) return "[circular]";
        seen.add(v);
      }
      return v;
    },
    space,
  );
}

export function exportFileName(threadId: string | null, now: number): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const id = (threadId ?? "thread").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 12) || "thread";
  return `session-${id}-${stamp}.json`;
}
