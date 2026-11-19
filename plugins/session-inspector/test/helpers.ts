import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TimelineRecord } from "@t3p/api";
import { createTimeline } from "@t3p/timeline";

// Fixtures are reused from the timeline package by relative path (tests only).
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "timeline", "test", "fixtures");

export function fixtureRecords(name: string): TimelineRecord[] {
  const tl = createTimeline();
  const items = JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as unknown[];
  for (const item of items) tl.apply(item);
  return tl.records();
}

export function kinds(records: readonly TimelineRecord[]): string[] {
  return records.map((r) => r.kind);
}

export function byKind(records: readonly TimelineRecord[], kind: string): TimelineRecord {
  const r = records.find((x) => x.kind === kind);
  if (!r) throw new Error(`no ${kind} record`);
  return r;
}

/** Synthetic record for load tests. */
export function synth(i: number, over: Partial<TimelineRecord> = {}): TimelineRecord {
  const at = 1_795_000_000_000 + i * 1000;
  return {
    id: `item:synth-${i}`,
    threadId: "t-big",
    sequence: i,
    at,
    kind: "command",
    runId: null,
    provider: "codex",
    summary: `$ step ${i}`,
    status: "completed",
    cause: null,
    raw: { id: `synth-${i}`, startedAt: new Date(at).toISOString(), completedAt: new Date(at + 500).toISOString() },
    ...over,
  };
}
