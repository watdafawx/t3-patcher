import type { TimelineRecord } from "@t3p/api";

function get(obj: unknown, ...path: string[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** Model a record itself names: a run's `modelSelection`, or a switch event's new `modelSelection`. */
function ownModel(r: TimelineRecord): string | null {
  switch (r.kind) {
    case "run.start":
    case "run.end":
      return str(get(r.raw, "modelSelection", "model"));
    case "provider-switch":
    case "model-switch":
      return str(get(r.raw, "payload", "modelSelection", "model"));
    default:
      return null;
  }
}

/**
 * Model per record id (records do not carry one). A record takes the model of its run when the
 * run is known, else the model last named earlier in time. `null` when nothing named one yet.
 * Pass records ordered by time.
 */
export function modelByRecord(records: readonly TimelineRecord[]): Map<string, string | null> {
  const runModel = new Map<string, string>();
  for (const r of records) {
    if ((r.kind === "run.start" || r.kind === "run.end") && r.runId) {
      const m = ownModel(r);
      if (m) runModel.set(r.runId, m);
    }
  }
  const out = new Map<string, string | null>();
  let last: string | null = null;
  for (const r of records) {
    const own = ownModel(r);
    if (own) last = own;
    out.set(r.id, (r.runId ? runModel.get(r.runId) : undefined) ?? own ?? last);
  }
  return out;
}
