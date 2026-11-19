import { describe, expect, it } from "vitest";
import type { TimelineRecord } from "@t3p/api";
import { causeChain, indexById, MAX_CHAIN } from "../src/logic/chain.js";
import { computeDurations, formatAge, formatDuration, isTerminalStatus } from "../src/logic/durations.js";
import { buildExport, exportFileName, safeStringify } from "../src/logic/export.js";
import { allGroups, defaultFilter, filterRecords, GROUPS, groupOf, isUnfiltered, KIND_LABEL } from "../src/logic/filter.js";
import { modelByRecord } from "../src/logic/models.js";
import { deriveActivity } from "../src/logic/nowdoing.js";
import { buildThreadHash, envFromRaw, parseThreadHash } from "../src/logic/route.js";
import { computeWindow, scrollTopFor } from "../src/logic/window.js";
import { FeedPool } from "../src/store.js";
import { byKind, fixtureRecords, kinds, synth } from "./helpers.js";

const approval = fixtureRecords("tool-approval.json");
const subagent = fixtureRecords("subagent.json");
const switches = fixtureRecords("provider-switch.json");
const errors = fixtureRecords("error.json");

describe("filter", () => {
  it("every kind has a label and a group", () => {
    for (const k of Object.keys(KIND_LABEL)) expect(GROUPS.map((g) => g.id)).toContain(groupOf(k as TimelineRecord["kind"]));
  });

  it("filters by kind group", () => {
    expect(kinds(filterRecords(approval, { groups: new Set(["tools" as const]), text: "" }))).toEqual(["command"]);
    expect(kinds(filterRecords(approval, { groups: new Set(["approvals" as const]), text: "" }))).toEqual(["approval.request", "approval.resolved"]);
    expect(kinds(filterRecords(switches, { groups: new Set(["switches" as const]), text: "" }))).toEqual(
      expect.arrayContaining(["provider-switch", "model-switch"]),
    );
    expect(kinds(filterRecords(subagent, { groups: new Set(["subagents" as const]), text: "" }))).toEqual(["subagent.start", "subagent.end"]);
    expect(kinds(filterRecords(approval, { groups: new Set(["runs" as const]), text: "" }))).toEqual(["run.start", "run.end"]);
    expect(kinds(filterRecords(approval, { groups: new Set(["messages" as const]), text: "" }))).toEqual(["message.user", "message.assistant"]);
    expect(kinds(filterRecords(errors, { groups: new Set(["errors" as const]), text: "" }))).toContain("error");
  });

  it("text filter is case-insensitive over summary, kind, provider, status", () => {
    const all = allGroups();
    const cmd = byKind(approval, "command");
    expect(filterRecords(approval, { groups: all, text: cmd.summary.slice(0, 6).toUpperCase() }).map((r) => r.id)).toContain(cmd.id);
    expect(kinds(filterRecords(approval, { groups: all, text: "approval.req" }))).toEqual(["approval.request"]);
    expect(filterRecords(approval, { groups: all, text: "zzz-nothing" })).toEqual([]);
  });

  it("default filter keeps everything and is reported unfiltered", () => {
    const f = defaultFilter();
    expect(isUnfiltered(f)).toBe(true);
    expect(filterRecords(approval, f)).toHaveLength(approval.length);
    expect(isUnfiltered({ ...f, text: "x" })).toBe(false);
    expect(isUnfiltered({ groups: new Set(["tools"]), text: "" })).toBe(false);
  });
});

describe("durations", () => {
  it("pairs run start/end and subagent start/end, puts the span on the start", () => {
    const d = computeDurations(approval, Date.now());
    expect(d.get(byKind(approval, "run.start").id)).toEqual({ ms: 12_800, open: false }); // 10:00:01.2 -> 10:00:14
    expect(d.has(byKind(approval, "run.end").id)).toBe(false);
    const sd = computeDurations(subagent, Date.now());
    expect(sd.get(byKind(subagent, "subagent.start").id)).toEqual({ ms: 7_500, open: false });
  });

  it("times a command from its item timestamps", () => {
    expect(computeDurations(approval, Date.now()).get(byKind(approval, "command").id)).toEqual({ ms: 2_000, open: false });
  });

  it("approval wait is request to resolution", () => {
    const d = computeDurations(approval, Date.now());
    const req = byKind(approval, "approval.request");
    const res = byKind(approval, "approval.resolved");
    expect(d.get(req.id)).toEqual({ ms: res.at - req.at, open: false });
  });

  it("an unresolved request and a running command are open and grow with now", () => {
    const req = byKind(approval, "approval.request");
    const alone = approval.filter((r) => r.kind !== "approval.resolved");
    expect(computeDurations(alone, req.at + 90_000).get(req.id)).toEqual({ ms: 90_000, open: true });
    const start = Date.parse("2026-11-19T10:00:03.000Z");
    const running: TimelineRecord = { ...synth(1), status: "running", raw: { startedAt: new Date(start).toISOString() } };
    expect(computeDurations([running], start + 4_000).get(running.id)).toEqual({ ms: 4_000, open: true });
  });

  it("ignores zero spans and unparseable stamps", () => {
    const zero = synth(1, { raw: { startedAt: "2026-11-19T10:00:00Z", completedAt: "2026-11-19T10:00:00Z" } });
    const bad = synth(2, { raw: { startedAt: "nope", completedAt: "nope" } });
    expect(computeDurations([zero, bad], Date.now()).size).toBe(0);
  });

  it("formats", () => {
    expect(formatDuration(450)).toBe("450 ms");
    expect(formatDuration(2_000)).toBe("2.0 s");
    expect(formatDuration(42_000)).toBe("42 s");
    expect(formatDuration(125_000)).toBe("2m 5s");
    expect(formatDuration(3_900_000)).toBe("1h 5m");
    expect(formatAge(1_000, 1_000)).toBe("just now");
    expect(formatAge(0, 5)).toBe("never");
    expect(formatAge(1, 61_001)).toBe("1m ago");
    expect(isTerminalStatus("Completed")).toBe(true);
    expect(isTerminalStatus("running")).toBe(false);
  });
});

describe("cause chain", () => {
  it("walks approval.resolved up to the user message", () => {
    const chain = causeChain(indexById(approval), byKind(approval, "approval.resolved").id);
    expect(chain.hops.map((h) => h.record.kind)).toEqual(["approval.resolved", "approval.request", "command", "run.start", "message.user"]);
    expect(chain.hops.map((h) => h.relation)).toEqual([null, "resolves", "approval-for", "in-run", "triggered-by"]);
    expect(chain.end).toBe("root");
  });

  it("walks a subagent child command through the subagent to the user message", () => {
    const child = subagent.filter((r) => r.kind === "command").at(-1)!;
    const chain = causeChain(indexById(subagent), child.id);
    expect(chain.hops.map((h) => h.relation).slice(0, 2)).toEqual([null, "in-subagent"]);
    expect(chain.hops.at(-1)!.record.kind).toBe("message.user");
  });

  it("stops at a missing cause, a cycle and the depth cap", () => {
    const a = synth(1, { cause: { recordId: "nope", relation: "in-run" } });
    expect(causeChain(indexById([a]), a.id)).toMatchObject({ end: "missing" });
    const x = synth(2, { id: "x", cause: { recordId: "y", relation: "child-of" } });
    const y = synth(3, { id: "y", cause: { recordId: "x", relation: "child-of" } });
    const cyc = causeChain(indexById([x, y]), "x");
    expect(cyc.end).toBe("cycle");
    expect(cyc.hops).toHaveLength(2);
    const long: TimelineRecord[] = [];
    for (let i = 0; i < MAX_CHAIN + 10; i++) long.push(synth(i, { id: `n${i}`, cause: { recordId: `n${i + 1}`, relation: "child-of" } }));
    const capped = causeChain(indexById(long), "n0");
    expect(capped.end).toBe("limit");
    expect(capped.hops).toHaveLength(MAX_CHAIN);
    expect(causeChain(indexById([]), "none")).toEqual({ hops: [], end: "missing" });
  });

  it("a root record is a one-hop chain", () => {
    expect(causeChain(indexById(approval), byKind(approval, "message.user").id)).toMatchObject({ end: "root", hops: [{ relation: null }] });
  });
});

describe("now doing", () => {
  it("empty and idle", () => {
    expect(deriveActivity([]).state).toBe("empty");
    const idle = deriveActivity(approval);
    expect(idle.state).toBe("idle");
    expect(idle.since).toBe(approval.at(-1)!.at);
  });

  it("waiting for approval while the request is unresolved", () => {
    const open = approval.filter((r) => r.kind !== "approval.resolved" && r.kind !== "run.end" && r.kind !== "message.assistant");
    const a = deriveActivity(open);
    expect(a.state).toBe("approval");
    expect(a.text).toMatch(/^Waiting for approval/);
    expect(a.recordId).toBe(byKind(approval, "approval.request").id);
  });

  it("running command inside an open run", () => {
    const cmd = byKind(approval, "command");
    const live: TimelineRecord[] = [{ ...byKind(approval, "run.start"), status: "running" }, { ...cmd, status: "running" }];
    const a = deriveActivity(live);
    expect(a.state).toBe("running");
    expect(a.text).toBe(`Running: ${cmd.summary}`);
  });

  it("streaming message and bare run", () => {
    const run: TimelineRecord = { ...byKind(approval, "run.start"), status: "running" };
    const msg: TimelineRecord = { ...byKind(approval, "message.assistant"), status: "streaming", raw: { streaming: true } };
    expect(deriveActivity([run, msg]).state).toBe("streaming");
    expect(deriveActivity([run]).state).toBe("run");
  });

  it("a finished run is idle even if an old tool row was left non-terminal", () => {
    const stale: TimelineRecord = { ...byKind(approval, "command"), status: "running" };
    expect(deriveActivity([...approval.filter((r) => r.kind !== "command"), stale]).state).toBe("idle");
  });
});

describe("models", () => {
  it("follows the run model, then the last named model", () => {
    const m = modelByRecord(switches);
    const runs = switches.filter((r) => r.kind === "run.start");
    expect(m.get(runs[0]!.id)).toBe("claude-opus-5-5");
    expect(m.get(runs.at(-1)!.id)).toBe("gpt-6.1-sol");
    expect(m.get(byKind(switches, "provider-switch").id)).toBe("gpt-6.1-sol");
  });
});

describe("export", () => {
  it("full export", () => {
    const e = buildExport({ threadId: "t1", all: approval, shown: approval, filter: defaultFilter(), now: Date.parse("2026-11-19T11:00:00Z") });
    expect(e).toMatchObject({ format: "t3p-session-inspector/1", threadId: "t1", filtered: false, total: approval.length, count: approval.length });
    expect(e.exportedAt).toBe("2026-11-19T11:00:00.000Z");
    const run = e.records.find((r) => r.kind === "run.start")!;
    expect(run.durationMs).toBe(12_800);
    expect(run.raw).toBeTruthy();
    expect(e.records.every((r) => !("enrichment" in r))).toBe(true);
  });

  it("filtered export keeps durations computed over the whole thread", () => {
    const filter = { groups: new Set(["runs" as const]), text: "" };
    const e = buildExport({ threadId: "t1", all: approval, shown: filterRecords(approval, filter), filter, now: 0 });
    expect(e).toMatchObject({ filtered: true, total: approval.length, count: 2, filter: { groups: ["runs"] } });
    expect(e.records[0]!.durationMs).toBe(12_800);
  });

  it("safeStringify handles cycles and bigint; file name is safe", () => {
    const o: Record<string, unknown> = { n: 10n };
    o.self = o;
    expect(JSON.parse(safeStringify(o))).toEqual({ n: "10n", self: "[circular]" });
    expect(exportFileName("a/b:c", Date.parse("2026-11-19T10:00:00Z"))).toBe("session-abc-2026-11-19T10-00-00-000Z.json");
    expect(exportFileName(null, 0)).toMatch(/^session-thread-/);
  });
});

describe("window", () => {
  it("renders only the visible rows plus overscan", () => {
    const w = computeWindow({ count: 10_000, rowHeight: 26, scrollTop: 26 * 5000, viewHeight: 400, overscan: 6 });
    expect(w.start).toBe(4994);
    expect(w.end).toBe(5000 + Math.ceil(400 / 26) + 6);
    expect(w.end - w.start).toBeLessThan(40);
    expect(w.totalHeight).toBe(260_000);
  });

  it("clamps at both ends and for an empty list", () => {
    expect(computeWindow({ count: 5, rowHeight: 26, scrollTop: 0, viewHeight: 400 })).toMatchObject({ start: 0, end: 5 });
    expect(computeWindow({ count: 0, rowHeight: 26, scrollTop: 0, viewHeight: 400 })).toEqual({ start: 0, end: 0, totalHeight: 0 });
    expect(computeWindow({ count: 100, rowHeight: 26, scrollTop: 1e9, viewHeight: 400 }).end).toBe(100);
    expect(scrollTopFor(0, 26, 400, 100)).toBe(0);
    expect(scrollTopFor(99, 26, 400, 100)).toBe(100 * 26 - 400);
  });
});

describe("route", () => {
  it("parses and builds the thread hash", () => {
    expect(parseThreadHash("#/env-1/thread-9")).toEqual({ environmentId: "env-1", threadId: "thread-9" });
    expect(parseThreadHash("#/env-1/thread-9/?x=1")).toEqual({ environmentId: "env-1", threadId: "thread-9" });
    expect(parseThreadHash("#/settings/plugins")).toBeNull();
    expect(parseThreadHash("#/env-1")).toBeNull();
    expect(parseThreadHash("")).toBeNull();
    expect(buildThreadHash("e 1", "t/2")).toBe("#/e%201/t%2F2");
    expect(parseThreadHash(buildThreadHash("e 1", "t/2"))).toEqual({ environmentId: "e 1", threadId: "t/2" });
    expect(envFromRaw({ environmentId: "x" })).toBe("x");
    expect(envFromRaw({})).toBeNull();
    expect(envFromRaw(null)).toBeNull();
  });
});

describe("feed pool", () => {
  function fake() {
    const subs = new Map<string, (r: TimelineRecord) => void>();
    const closed: string[] = [];
    return {
      subs,
      closed,
      subscribe: (id: string, cb: (r: TimelineRecord) => void) => {
        subs.set(id, cb);
        return () => {
          subs.delete(id);
          closed.push(id);
        };
      },
    };
  }

  it("caps concurrent subscriptions and drops the lowest priority", () => {
    const f = fake();
    const pool = new FeedPool(f.subscribe, 3);
    expect(pool.want(["a", "b", "c", "d", "e"])).toEqual(["d", "e"]);
    expect([...f.subs.keys()]).toEqual(["a", "b", "c"]);
    expect(pool.active).toBe(3);
    pool.want(["z", "a"]);
    expect([...f.subs.keys()].sort()).toEqual(["a", "z"]);
    expect(f.closed.sort()).toEqual(["b", "c"]);
    pool.dispose();
    expect(f.subs.size).toBe(0);
  });

  it("upserts by id, keeps time order and tracks the newest event", () => {
    const f = fake();
    const pool = new FeedPool(f.subscribe, 2);
    pool.want(["a"]);
    const push = f.subs.get("a")!;
    push(synth(2));
    push(synth(1));
    push({ ...synth(2), summary: "changed" });
    const feed = pool.get("a")!;
    expect(feed.records().map((r) => r.id)).toEqual(["item:synth-1", "item:synth-2"]);
    expect(feed.records()[1]!.summary).toBe("changed");
    expect(feed.lastEventAt).toBe(synth(2).at);
    pool.dispose();
  });
});
