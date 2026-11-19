import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createTimeline, enrichFromProviderLog, type TimelineChange, type TimelineRecord } from "../src/index.js";

const load = (name: string): Array<Record<string, unknown>> =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as Array<Record<string, unknown>>;

function run(name: string): ReturnType<typeof createTimeline> {
  const tl = createTimeline();
  for (const item of load(name)) tl.apply(item);
  return tl;
}

const byKind = (recs: TimelineRecord[], kind: string): TimelineRecord[] => recs.filter((r) => r.kind === kind);
const one = (recs: TimelineRecord[], kind: string): TimelineRecord => {
  const hits = byKind(recs, kind);
  expect(hits, `exactly one ${kind}`).toHaveLength(1);
  return hits[0]!;
};
const causeOf = (r: TimelineRecord): string | null => (r.cause ? `${r.cause.relation}->${r.cause.recordId}` : null);

describe("tool call with approval", () => {
  const recs = run("tool-approval.json").records();

  it("emits the expected kinds in time order", () => {
    expect(recs.map((r) => r.kind)).toEqual([
      "run.start",
      "message.user",
      "command",
      "approval.request",
      "approval.resolved",
      "message.assistant",
      "run.end",
    ]);
    for (let i = 1; i < recs.length; i++) expect(recs[i]!.at).toBeGreaterThanOrEqual(recs[i - 1]!.at);
  });

  it("links approval -> tool call -> run -> user message", () => {
    const start = one(recs, "run.start");
    const user = one(recs, "message.user");
    const cmd = one(recs, "command");
    const req = one(recs, "approval.request");
    const res = one(recs, "approval.resolved");
    expect(start.cause).toEqual({ recordId: user.id, relation: "triggered-by" });
    expect(user.cause).toBeNull(); // the user message triggers the run; no cycle
    expect(cmd.cause).toEqual({ recordId: start.id, relation: "in-run" });
    expect(req.cause).toEqual({ recordId: cmd.id, relation: "approval-for" });
    expect(res.cause).toEqual({ recordId: req.id, relation: "resolves" });
    expect(one(recs, "run.end").cause).toEqual({ recordId: start.id, relation: "ends" });
    expect(one(recs, "message.assistant").cause?.relation).toBe("in-run");
  });

  it("keeps raw untouched, epoch-ms at, provider and summary", () => {
    const cmd = one(recs, "command");
    expect((cmd.raw as { input: string }).input).toBe("pnpm test --filter api");
    expect(cmd.at).toBe(Date.parse("2026-11-19T10:00:03.000Z"));
    expect(cmd.provider).toBe("claudeAgent");
    expect(cmd.summary).toBe("$ pnpm test --filter api");
    expect(cmd.status).toBe("completed"); // updated in place by the later turn-item event
    expect(one(recs, "approval.resolved").summary).toContain("accept");
    expect(one(recs, "run.start").runId).toBe(cmd.runId);
  });

  it("links correctly whatever the arrival order (approval item and request before the tool node)", () => {
    const items = load("tool-approval.json");
    // move the tool node + tool item to the end: everything that points at them arrives first
    const late = items.filter((i) => {
      const e = i.event as { type: string; payload: { id?: string } };
      return (e.type === "node.updated" && e.payload.id?.includes("toolu_01")) || (e.type === "turn-item.updated" && e.payload.id?.includes("toolu_01"));
    });
    const rest = items.filter((i) => !late.includes(i));
    const tl = createTimeline();
    for (const i of [...rest, ...late]) tl.apply(i);
    const r = tl.records();
    expect(causeOf(one(r, "approval.request"))).toBe(`approval-for->${one(r, "command").id}`);
    expect(causeOf(one(r, "approval.resolved"))).toBe(`resolves->${one(r, "approval.request").id}`);
  });

  it("matches the same links when everything arrives as one snapshot", () => {
    const items = load("tool-approval.json");
    const events = items.map((i) => (i as { event: { type: string; payload: Record<string, unknown> } }).event);
    // fold the event stream into a projection (last write wins per id)
    const latest = <T extends { id: unknown }>(type: string): T[] => {
      const m = new Map<unknown, T>();
      for (const e of events) if (e.type === type) m.set(e.payload.id, e.payload as unknown as T);
      return [...m.values()];
    };
    const tl = createTimeline();
    tl.applySnapshot({
      kind: "snapshot",
      snapshotSequence: 500,
      projection: {
        thread: { providerInstanceId: "claudeAgent", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" } },
        runs: latest("run.updated").concat(latest("run.created").filter((r) => !latest("run.updated").some((u) => u.id === r.id))),
        nodes: latest("node.updated"),
        runtimeRequests: latest("runtime-request.updated"),
        turnItems: latest("turn-item.updated"),
        subagents: [],
        contextHandoffs: [],
      },
    });
    const fromEvents = run("tool-approval.json").records();
    const fromSnapshot = tl.records();
    expect(fromSnapshot.map((r) => [r.id, r.kind, causeOf(r)])).toEqual(fromEvents.map((r) => [r.id, r.kind, causeOf(r)]));
  });
});

describe("provider switch", () => {
  const tl = run("provider-switch.json");
  const recs = tl.records();

  it("records model switch, provider switch and the new run on the new provider", () => {
    expect(one(recs, "model-switch").summary).toBe("Model claude-opus-5-5 → claude-sonnet-5-5");
    const sw = one(recs, "provider-switch");
    expect(sw.summary).toBe("Provider switch claudeAgent → codex (gpt-6.1-sol)");
    expect(sw.provider).toBe("codex");
    expect(sw.cause).toBeNull();
    const starts = byKind(recs, "run.start");
    expect(starts.map((r) => r.provider)).toEqual(["claudeAgent", "codex"]);
    const codexItems = recs.filter((r) => r.runId?.endsWith(":ordinal:2") && r.kind.startsWith("message"));
    expect(codexItems.length).toBe(2);
    for (const r of codexItems) expect(r.provider).toBe("codex");
  });

  it("links the handoff into the target run, the new user message triggers that run", () => {
    const run2 = byKind(recs, "run.start")[1]!;
    const handoff = one(recs, "handoff");
    expect(handoff.summary).toBe("Handoff claudeAgent → codex (full_thread_summary)");
    expect(handoff.cause).toEqual({ recordId: run2.id, relation: "handoff-into" });
    const u2 = recs.find((r) => r.kind === "message.user" && r.runId === run2.runId)!;
    expect(run2.cause).toEqual({ recordId: u2.id, relation: "triggered-by" });
  });

  it("snapshot items are normalised too (earlier run, in order, before the switch)", () => {
    const first = recs[0]!;
    expect(first.kind).toBe("run.start");
    const idx = (k: string) => recs.findIndex((r) => r.kind === k);
    expect(idx("message.user")).toBeLessThan(idx("model-switch"));
    expect(idx("model-switch")).toBeLessThan(idx("provider-switch"));
    expect(idx("provider-switch")).toBeLessThan(idx("handoff"));
  });

  it("a no-op provider switch does not record anything", () => {
    const before = tl.records().length;
    tl.applyEvent({
      kind: "event",
      sequence: 999,
      event: { id: "e-noop", threadId: "t", providerInstanceId: "codex", occurredAt: "2026-11-19T10:05:00.000Z", type: "thread.provider-switched", payload: { providerInstanceId: "codex", modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } } },
    });
    expect(tl.records().length).toBe(before);
  });
});

describe("compaction", () => {
  const recs = run("compaction.json").records();
  it("records the compaction with token counts and a child-of link to the /compact message", () => {
    const c = one(recs, "compaction");
    expect(c.summary).toBe("Context compacted (182000 → 14000 tokens)");
    expect(c.cause).toEqual({ recordId: one(recs, "message.user").id, relation: "child-of" });
    expect(c.status).toBe("completed");
  });
});

describe("error", () => {
  const recs = run("error.json").records();
  it("records the provider failure in its run, then the failed run end", () => {
    const e = one(recs, "error");
    expect(e.summary).toBe("Error [usage_limit]: You hit the 5 hour usage limit. (retry 2/3)");
    expect(e.provider).toBe("codex");
    expect(e.cause).toEqual({ recordId: one(recs, "run.start").id, relation: "in-run" });
    const end = one(recs, "run.end");
    expect(end.status).toBe("failed");
    expect(recs.indexOf(e)).toBeLessThan(recs.indexOf(end));
  });
});

describe("subagent run", () => {
  const recs = run("subagent.json").records();
  it("links start to the spawning tool call, inner items to the subagent, end to start", () => {
    const task = recs.find((r) => r.kind === "tool")!;
    expect(task.summary).toBe("Tool Task");
    const start = one(recs, "subagent.start");
    const end = one(recs, "subagent.end");
    const inner = one(recs, "command");
    expect(start.cause).toEqual({ recordId: task.id, relation: "spawned-by" });
    expect(inner.cause).toEqual({ recordId: start.id, relation: "in-subagent" });
    expect(end.cause).toEqual({ recordId: start.id, relation: "ends" });
    expect(task.cause).toEqual({ recordId: one(recs, "run.start").id, relation: "in-run" });
    expect(start.summary).toBe("Subagent started: Scan repo");
    expect(end.summary).toBe("Subagent completed: Found 3 TODOs in 2 files.");
    // the subagent turn item is folded into the subagent records, not duplicated
    expect(recs.filter((r) => r.kind.startsWith("subagent"))).toHaveLength(2);
  });
});

describe("real captured frames (WP-0D failed run)", () => {
  const tl = run("real-failed-run.json");
  const recs = tl.records();
  it("normalises a real stream without unknowns", () => {
    expect(byKind(recs, "unknown")).toHaveLength(0);
    const kinds = new Set(recs.map((r) => r.kind));
    for (const k of ["model-switch", "provider-switch", "run.start", "message.user", "message.assistant", "error", "run.end"]) expect(kinds.has(k as never)).toBe(true);
    expect(byKind(recs, "provider-switch").map((r) => r.provider)).toEqual(["codex", "claudeAgent"]);
    const err = one(recs, "error");
    expect(err.cause?.relation).toBe("in-run");
    expect(err.summary).toContain("provider_error");
  });
});

describe("robustness", () => {
  it("is idempotent on duplicate sequences and duplicate snapshots", () => {
    const tl = createTimeline();
    const items = load("provider-switch.json");
    for (const i of items) tl.apply(i);
    const first = tl.records();
    const seen: TimelineChange[] = [];
    tl.subscribe((c) => seen.push(c));
    for (const i of items) tl.apply(i); // replay everything
    expect(seen).toHaveLength(0);
    expect(tl.records()).toEqual(first);
  });

  it("ignores events already covered by the snapshot sequence", () => {
    const tl = createTimeline();
    tl.applySnapshot({ kind: "snapshot", snapshotSequence: 50, projection: { thread: {}, runs: [], turnItems: [] } });
    tl.applyEvent({ kind: "event", sequence: 40, event: { id: "e", type: "something.new", payload: {} } });
    expect(tl.records()).toHaveLength(0);
  });

  it("emits `unknown` (keeping raw) for unknown event types, item types and stream kinds, and never throws", () => {
    const tl = createTimeline();
    const evt = { id: "ev-x", threadId: "t", runId: "r1", providerInstanceId: "claudeAgent", occurredAt: "2026-11-19T10:00:00.000Z", type: "futuristic.thing", payload: { a: 1 } };
    tl.applyEvent({ kind: "event", sequence: 1, event: evt });
    const itemRaw = { id: "ti-1", threadId: "t", runId: null, nodeId: null, type: "hologram", status: "completed", updatedAt: "2026-11-19T10:00:01.000Z" };
    tl.applyEvent({ kind: "event", sequence: 2, event: { id: "ev-y", threadId: "t", providerInstanceId: "codex", occurredAt: "2026-11-19T10:00:01.000Z", type: "turn-item.updated", payload: itemRaw } });
    expect(() => {
      tl.apply({ kind: "mystery", sequence: 3 });
      tl.apply(null);
      tl.apply("garbage");
      tl.applyEvent({ kind: "event", sequence: 4, event: { type: "turn-item.updated", payload: null } });
      tl.applyEvent({ kind: "event", sequence: 5, event: 7 });
      tl.applySnapshot({ kind: "snapshot", snapshotSequence: 9, projection: null });
      tl.applySnapshot(undefined);
    }).not.toThrow();
    const recs = tl.records();
    expect(recs.every((r) => r.kind === "unknown")).toBe(true);
    expect(recs.find((r) => r.id === "unknown:event:ev-x")!.raw).toBe(evt);
    expect(recs.find((r) => r.id === "item:ti-1")!.raw).toBe(itemRaw);
    expect(recs.find((r) => r.id === "item:ti-1")!.summary).toBe("Unrecognised item type hologram");
    expect(recs.find((r) => r.id === "item:ti-1")!.provider).toBe("codex");
  });

  it("subscribe reports added then updated records, and reset", () => {
    const tl = createTimeline();
    const seen: TimelineChange[] = [];
    const off = tl.subscribe((c) => seen.push(c));
    const items = load("tool-approval.json");
    for (const i of items.slice(0, 2)) tl.apply(i);
    expect(seen[0]!.added.map((r) => r.kind)).toEqual(["run.start"]);
    expect(seen[1]!.added.map((r) => r.kind)).toEqual(["message.user"]);
    // the user message arriving links run.start -> it: reported as an update of run.start
    expect(seen[1]!.updated.map((r) => r.kind)).toEqual(["run.start"]);
    expect(seen[1]!.updated[0]!.cause?.relation).toBe("triggered-by");
    off();
    tl.apply(items[2]!);
    expect(seen).toHaveLength(2);
    const seen2: TimelineChange[] = [];
    tl.subscribe((c) => seen2.push(c));
    tl.reset();
    expect(tl.records()).toEqual([]);
    expect(seen2).toEqual([{ added: [], updated: [], reset: true }]);
    // usable again after reset, same sequences accepted
    for (const i of items) tl.apply(i);
    expect(tl.records()).toHaveLength(7);
  });

  it("a throwing subscriber does not break the normalizer", () => {
    const tl = createTimeline();
    tl.subscribe(() => {
      throw new Error("boom");
    });
    expect(() => tl.apply(load("compaction.json")[0])).not.toThrow();
    expect(tl.records()).toHaveLength(1);
  });
});

describe("enrichFromProviderLog", () => {
  const recs = run("tool-approval.json").records();
  const log = readFileSync(new URL("./fixtures/provider-events.jsonl", import.meta.url), "utf8");

  it("attaches frames whose id-like values match the record's native ids", () => {
    const out = enrichFromProviderLog(recs, log);
    const cmd = out.find((r) => r.kind === "command")!;
    expect(cmd.enrichment?.matchedBy).toEqual(["toolu_01ABCdefGHIjklMNOpqr"]);
    expect(cmd.enrichment?.frames.map((f) => f.stream)).toEqual(["native", "native"]);
    expect(cmd.enrichment?.frames[0]?.at).toBe(Date.parse("2026-11-19T10:00:03.000Z"));
    // the request's nativeRequestRef points at the same tool_use id
    expect(out.find((r) => r.kind === "approval.resolved")?.enrichment?.frames).toHaveLength(2);
  });

  it("leaves unmatched records identical, never mutates input, skips bad lines, is idempotent", () => {
    const out = enrichFromProviderLog(recs, log);
    const user = recs.find((r) => r.kind === "message.user")!;
    expect(out.find((r) => r.id === user.id)).toBe(user);
    expect(recs.every((r) => r.enrichment === undefined)).toBe(true);
    expect(enrichFromProviderLog(out, log)).toEqual(out);
    expect(enrichFromProviderLog(recs, "")).toEqual(recs);
    expect(enrichFromProviderLog(recs, "not json\n[x] NTIVE: {\n\u0000\n")).toEqual(recs);
  });
});
