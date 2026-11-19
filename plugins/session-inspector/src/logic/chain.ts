import type { CauseRelation, TimelineRecord } from "@t3p/api";

export interface ChainHop {
  record: TimelineRecord;
  /** How the previous (more recent) hop relates to this one. The first hop (the record itself) has `null`. */
  relation: CauseRelation | null;
}

export interface CauseChain {
  hops: ChainHop[];
  /** `root`: ends at a record with no cause. `missing`: a cause points at a record not in the list. `cycle`: a loop was cut. `limit`: depth cap. */
  end: "root" | "missing" | "cycle" | "limit";
}

export const MAX_CHAIN = 64;

/**
 * Walk `cause` links from `recordId` up to the root. hops[0] is the record itself, the last hop is
 * the root cause. Never loops: a repeated id or `MAX_CHAIN` hops stops the walk.
 */
export function causeChain(byId: ReadonlyMap<string, TimelineRecord>, recordId: string): CauseChain {
  const hops: ChainHop[] = [];
  const seen = new Set<string>();
  let cur = byId.get(recordId);
  if (!cur) return { hops, end: "missing" };
  let relation: CauseRelation | null = null;
  for (;;) {
    if (seen.has(cur.id)) return { hops, end: "cycle" };
    seen.add(cur.id);
    hops.push({ record: cur, relation });
    if (hops.length >= MAX_CHAIN) return { hops, end: "limit" };
    if (!cur.cause) return { hops, end: "root" };
    const next = byId.get(cur.cause.recordId);
    if (!next) return { hops, end: "missing" };
    relation = cur.cause.relation;
    cur = next;
  }
}

export function indexById(records: readonly TimelineRecord[]): Map<string, TimelineRecord> {
  const m = new Map<string, TimelineRecord>();
  for (const r of records) m.set(r.id, r);
  return m;
}

const RELATION_TEXT: Record<CauseRelation, string> = {
  "in-run": "in run",
  "triggered-by": "triggered by",
  continues: "continues",
  ends: "ends",
  "child-of": "child of",
  "approval-for": "approval for",
  resolves: "resolves",
  "in-subagent": "in subagent",
  "spawned-by": "spawned by",
  "handoff-into": "handoff into",
  "delegated-by": "delegated by",
};

export function relationText(r: CauseRelation): string {
  return RELATION_TEXT[r] ?? r;
}
