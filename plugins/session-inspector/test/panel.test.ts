// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadSummary, TimelineRecord } from "@t3p/api";
import { mountInspector, type Inspector, type InspectorApi } from "../src/ui/panel.js";
import { byKind, fixtureRecords, synth } from "./helpers.js";

const approval = fixtureRecords("tool-approval.json");
const THREAD = "7d0f2c1e-5b1a-4c63-9d0e-3a2f1b9c8e11";

function summary(id: string, over: Partial<ThreadSummary> = {}): ThreadSummary {
  return { threadId: id, title: `Thread ${id}`, projectId: "p", providerInstanceId: "codex", model: "gpt-6.1-sol", updatedAt: "2026-11-19T10:00:00.000Z", running: false, raw: {}, ...over };
}

function fakeApi(opts: { records?: Record<string, TimelineRecord[]>; current?: string | null; threads?: ThreadSummary[] } = {}) {
  const records = opts.records ?? {};
  const subs = new Map<string, Set<(r: TimelineRecord) => void>>();
  const unsubscribed: string[] = [];
  const focus = new Set<(p: { threadId: string | null }) => void>();
  let current = opts.current ?? null;
  let threads = opts.threads ?? [];
  const api: InspectorApi = {
    threads: { list: async () => threads, current: () => current },
    timeline: {
      subscribe(id, cb) {
        for (const r of records[id] ?? []) cb(r);
        let set = subs.get(id);
        if (!set) subs.set(id, (set = new Set()));
        set.add(cb);
        return () => {
          set!.delete(cb);
          unsubscribed.push(id);
        };
      },
    },
    events: {
      on(_name, cb) {
        focus.add(cb);
        return () => focus.delete(cb);
      },
    },
    ui: { themeVars: () => ({ "--foreground": "#eee" }) },
    log: () => undefined,
  };
  return {
    api,
    subs,
    unsubscribed,
    focus: (id: string | null) => {
      current = id;
      for (const f of [...focus]) f({ threadId: id });
    },
    emit: (id: string, r: TimelineRecord) => {
      for (const cb of [...(subs.get(id) ?? [])]) cb(r);
    },
    setThreads: (t: ThreadSummary[]) => {
      threads = t;
    },
    focusListeners: focus,
  };
}

let mounted: Inspector | null = null;
function mount(fake: ReturnType<typeof fakeApi>, extra: Partial<Parameters<typeof mountInspector>[1]> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  mounted = mountInspector(host, { api: fake.api, renderDelayMs: 0, listPollMs: 60_000, ...extra });
  return { host, insp: mounted };
}

const q = <T extends Element = HTMLElement>(host: Element, sel: string): T => host.querySelector<T>(sel)!;
const qa = (host: Element, sel: string): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(sel)];
const rows = (host: Element): HTMLElement[] => qa(host, ".si-row");
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

afterEach(() => {
  mounted?.dispose();
  mounted = null;
  document.body.innerHTML = "";
});

describe("timeline tab", () => {
  it("renders the fixture thread: rows, columns, count, idle now-line", () => {
    const fake = fakeApi({ records: { [THREAD]: approval }, current: THREAD });
    const { host } = mount(fake);
    const list = rows(host);
    expect(list).toHaveLength(approval.length);
    expect(list.map((r) => r.dataset.kind)).toEqual(approval.map((r) => r.kind));
    expect(q(host, "[data-role=count]").textContent).toBe(`${approval.length} records`);
    expect(q(host, "[data-role=now]").dataset.state).toBe("idle");
    const run = list.find((r) => r.dataset.kind === "run.start")!;
    expect(run.querySelector(".si-c-dur")!.textContent).toBe("13 s");
    expect(run.querySelector(".si-c-prov")!.textContent).toContain("claudeAgent");
    expect(run.querySelector(".si-c-prov")!.textContent).toContain("claude-opus-5-5");
    expect(list.find((r) => r.dataset.kind === "command")!.querySelector(".si-c-dur")!.textContent).toBe("2.0 s");
  });

  it("expands a cause chain on click and each hop scrolls to its record", () => {
    const fake = fakeApi({ records: { [THREAD]: approval }, current: THREAD });
    const { host, insp } = mount(fake);
    const resolved = byKind(approval, "approval.resolved");
    rows(host).find((r) => r.dataset.id === resolved.id)!.click();
    insp.flush();
    const hops = qa(host, "[data-role=chain] .si-hop");
    expect(hops.map((h) => h.querySelector(".si-hop-rel")!.textContent)).toEqual(["this record", "↑ resolves", "↑ approval for", "↑ in run", "↑ triggered by"]);
    expect(hops.at(-1)!.textContent).toContain("You:");
    expect(rows(host).find((r) => r.dataset.id === resolved.id)!.getAttribute("aria-selected")).toBe("true");

    hops[2]!.click(); // the command
    expect(rows(host).find((r) => r.getAttribute("aria-selected") === "true")!.dataset.kind).toBe("command");
    const rel = qa(host, "[data-role=chain] .si-hop").map((h) => h.querySelector(".si-hop-rel")!.textContent);
    expect(rel).toEqual(["this record", "↑ in run", "↑ triggered by"]);
  });

  it("a chain hop hidden by the filter resets the filter and selects it", () => {
    const fake = fakeApi({ records: { [THREAD]: approval }, current: THREAD });
    const { host, insp } = mount(fake);
    const resolved = byKind(approval, "approval.resolved");
    // Show approvals only, select the resolution, then jump to the (hidden) user message.
    for (const chip of qa(host, ".si-chip")) if (chip.dataset.group !== "approvals") chip.click();
    insp.flush();
    expect(rows(host).map((r) => r.dataset.kind)).toEqual(["approval.request", "approval.resolved"]);
    rows(host).find((r) => r.dataset.id === resolved.id)!.click();
    insp.flush();
    qa(host, "[data-role=chain] .si-hop").at(-1)!.click();
    expect(rows(host)).toHaveLength(approval.length);
    expect(rows(host).find((r) => r.getAttribute("aria-selected") === "true")!.dataset.kind).toBe("message.user");
  });

  it("filters by kind group and by text", () => {
    const fake = fakeApi({ records: { [THREAD]: approval }, current: THREAD });
    const { host, insp } = mount(fake);
    const chip = (g: string): HTMLElement => qa(host, ".si-chip").find((c) => c.dataset.group === g)!;
    chip("runs").click();
    chip("messages").click();
    insp.flush();
    expect(rows(host).map((r) => r.dataset.kind)).toEqual(["command", "approval.request", "approval.resolved"]);
    expect(chip("runs").getAttribute("aria-pressed")).toBe("false");
    expect(q(host, "[data-role=count]").textContent).toBe(`3 of ${approval.length}`);

    const input = q<HTMLInputElement>(host, "[data-role=text-filter]");
    input.value = "approval resolved";
    input.dispatchEvent(new Event("input"));
    insp.flush();
    expect(rows(host).map((r) => r.dataset.kind)).toEqual(["approval.resolved"]);

    input.value = "no such text";
    input.dispatchEvent(new Event("input"));
    insp.flush();
    expect(rows(host)).toHaveLength(0);
    expect(q(host, "[data-role=empty]").hidden).toBe(false);
    expect(q(host, "[data-role=empty]").textContent).toBe("No records match the filter.");
  });

  it("shows the raw event JSON in a collapsible", () => {
    const fake = fakeApi({ records: { [THREAD]: approval }, current: THREAD });
    const { host, insp } = mount(fake);
    const cmd = byKind(approval, "command");
    rows(host).find((r) => r.dataset.id === cmd.id)!.click();
    insp.flush();
    const details = q<HTMLDetailsElement>(host, "[data-role=raw]");
    expect(details.open).toBe(false);
    expect(details.querySelector("pre")).toBeNull();
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    const text = details.querySelector("pre")!.textContent!;
    expect(JSON.parse(text)).toMatchObject({ type: "command_execution", id: expect.any(String) });
  });

  it("exports the full and the filtered timeline as JSON via the download hook", () => {
    const fake = fakeApi({ records: { [THREAD]: approval }, current: THREAD });
    const download = vi.fn();
    const { host, insp } = mount(fake, { download, now: () => Date.parse("2026-11-19T11:00:00Z") });
    q(host, "[data-role=export]").click();
    const [name, text] = download.mock.calls[0] as [string, string];
    expect(name).toMatch(/^session-7d0f2c1e-5b1-.*\.json$/);
    const full = JSON.parse(text);
    expect(full).toMatchObject({ threadId: THREAD, filtered: false, total: approval.length, count: approval.length });

    qa(host, ".si-chip").forEach((c) => {
      if (c.dataset.group !== "tools") c.click();
    });
    insp.flush();
    q(host, "[data-role=export]").click();
    const filtered = JSON.parse((download.mock.calls[1] as [string, string])[1]);
    expect(filtered).toMatchObject({ filtered: true, total: approval.length, count: 1, filter: { groups: ["tools"] } });
    expect(filtered.records[0]).toMatchObject({ kind: "command", durationMs: 2000 });
  });

  it("windows a 5000-record thread: only a few rows exist in the DOM", () => {
    const big = Array.from({ length: 5000 }, (_, i) => synth(i));
    const fake = fakeApi({ records: { big }, current: "big" });
    const { host, insp } = mount(fake);
    expect(q(host, "[data-role=count]").textContent).toBe("5000 records");
    expect(rows(host).length).toBeGreaterThan(0);
    expect(rows(host).length).toBeLessThan(60);
    expect(q(host, ".si-spacer").style.height).toBe(`${5000 * 26}px`);
    // Following the tail: the last row is rendered.
    expect(rows(host).at(-1)!.dataset.id).toBe("item:synth-4999");
    // Scroll to the top: the window follows.
    const list = q(host, "[data-role=list]");
    list.scrollTop = 0;
    list.dispatchEvent(new Event("scroll"));
    insp.flush();
    expect(rows(host)[0]!.dataset.id).toBe("item:synth-0");
    expect(rows(host).length).toBeLessThan(60);
  });

  it("live record updates the now-line and appends a row; running time grows", async () => {
    const fake = fakeApi({ records: { [THREAD]: [] }, current: THREAD });
    let t = Date.parse("2026-11-19T10:00:10Z");
    const { host, insp } = mount(fake, { now: () => t });
    expect(q(host, "[data-role=now]").dataset.state).toBe("empty");
    const run = { ...byKind(approval, "run.start"), status: "running" };
    const cmd = { ...byKind(approval, "command"), status: "running", at: Date.parse("2026-11-19T10:00:05Z"), raw: { startedAt: "2026-11-19T10:00:05.000Z" } };
    fake.emit(THREAD, run);
    fake.emit(THREAD, cmd);
    await tick();
    insp.flush();
    const now = q(host, "[data-role=now]");
    expect(now.dataset.state).toBe("running");
    expect(now.textContent).toContain(`Running: ${cmd.summary}`);
    expect(now.textContent).toContain("5.0 s");
    t += 5000;
    insp.flush();
    expect(q(host, "[data-role=now]").textContent).toContain("10 s");
    const durCell = rows(host).find((r) => r.dataset.id === cmd.id)!.querySelector<HTMLElement>(".si-c-dur")!;
    expect(durCell.dataset.open).toBe("1");
    // The approval arrives while the command still runs: now-line switches to waiting.
    fake.emit(THREAD, { ...byKind(approval, "approval.request") });
    await tick();
    insp.flush();
    expect(q(host, "[data-role=now]").dataset.state).toBe("approval");
  });

  it("follows thread:focus: subscribes the new thread, drops the old one, resets filters", () => {
    const fake = fakeApi({ records: { [THREAD]: approval, other: [synth(1)] }, current: THREAD });
    const { host, insp } = mount(fake);
    qa(host, ".si-chip")[0]!.click();
    insp.flush();
    expect(rows(host)).toHaveLength(approval.length - 2);
    fake.focus("other");
    insp.flush();
    expect(fake.unsubscribed).toEqual([THREAD]);
    expect(rows(host).map((r) => r.dataset.id)).toEqual(["item:synth-1"]);
    expect(qa(host, ".si-chip").every((c) => c.getAttribute("aria-pressed") === "true")).toBe(true);
    fake.focus(null);
    insp.flush();
    expect(q(host, "[data-role=empty]").textContent).toBe("Open a thread to inspect it.");
    expect(q(host, "[data-role=now]").textContent).toContain("No thread selected");
  });
});

describe("all sessions tab", () => {
  it("empty state: no threads, no errors", async () => {
    const fake = fakeApi({ current: null, threads: [] });
    const { host, insp } = mount(fake);
    insp.showTab("sessions");
    await tick();
    insp.flush();
    const empty = q(host, "[data-role=sessions-empty]");
    expect(empty.hidden).toBe(false);
    expect(empty.textContent).toBe("No active threads. Start or open a thread and it shows up here.");
    expect(q(host, "[data-role=sessions-foot]").textContent).toBe("0 active threads · 0/6 timelines tracked");
    expect(q<HTMLButtonElement>(host, "[data-tab=sessions]").getAttribute("aria-selected")).toBe("true");
    expect(q(host, "[data-view=timeline]").hidden).toBe(true);
  });

  it("reports a list failure instead of throwing", async () => {
    const fake = fakeApi();
    fake.api.threads.list = async () => {
      throw new Error("rpc not connected");
    };
    const { host, insp } = mount(fake);
    insp.showTab("sessions");
    await tick();
    insp.flush();
    expect(q(host, "[data-role=sessions-empty]").textContent).toBe("Could not read the thread list: rpc not connected");
  });

  it("lists active threads with activity, provider/model, age; hides archived; click navigates", async () => {
    const runningRecs = [
      { ...byKind(approval, "run.start"), status: "running" },
      { ...byKind(approval, "command"), status: "running" },
    ];
    const fake = fakeApi({
      records: { a: runningRecs, b: approval },
      current: "b",
      threads: [
        summary("a", { running: true, providerInstanceId: "claudeAgent", model: "claude-opus-5-5" }),
        summary("b", { running: false }),
        summary("c", { running: false, raw: { archivedAt: "2026-11-01T00:00:00Z" } }),
        summary("d", { running: false, raw: { environmentId: "env-from-row" } }),
      ],
    });
    const navigate = vi.fn();
    window.location.hash = "#/env-live/b";
    const { host, insp } = mount(fake, { navigate, now: () => Date.parse("2026-11-19T10:05:00Z") });
    insp.showTab("sessions");
    await tick();
    insp.flush();
    const list = qa(host, ".si-ses");
    expect(list.map((r) => r.dataset.threadId)).toEqual(["a", "b", "d"]);
    const a = list[0]!;
    expect(a.querySelector(".si-ses-act")!.textContent).toMatch(/^Running: \$/);
    expect(a.textContent).toContain("claudeAgent · claude-opus-5-5");
    expect(list[1]!.dataset.current).toBe("1");
    expect(list[1]!.querySelector(".si-ses-act")!.textContent).toBe("Idle");
    expect(list[2]!.querySelector(".si-ses-act")!.textContent).toBe("Idle"); // not tracked: not running
    expect(q(host, "[data-role=sessions-foot]").textContent).toBe("3 active threads · 2/6 timelines tracked");

    a.click();
    expect(navigate).toHaveBeenLastCalledWith("#/env-live/a");
    list[2]!.click();
    expect(navigate).toHaveBeenLastCalledWith("#/env-from-row/d");
    window.location.hash = "";
  });

  it("subscribes only the shown thread and running threads, capped", async () => {
    const threads = Array.from({ length: 10 }, (_, i) => summary(`t${i}`, { running: true }));
    const fake = fakeApi({ current: "t7", threads, records: {} });
    const { host, insp } = mount(fake, { maxSubscriptions: 4 });
    expect([...fake.subs.keys()]).toEqual(["t7"]); // timeline tab: only the shown thread
    insp.showTab("sessions");
    await tick();
    insp.flush();
    expect([...fake.subs.keys()].sort()).toEqual(["t0", "t1", "t2", "t7"]);
    const acts = qa(host, ".si-ses").map((r) => r.querySelector(".si-ses-act")!.textContent);
    expect(acts.filter((t) => t!.includes("not tracked"))).toHaveLength(6); // 10 rows, 4 tracked
    expect(q(host, "[data-role=sessions-foot]").textContent).toBe("10 active threads · 4/4 timelines tracked");
    // Back to the timeline tab: the extra subscriptions are released.
    insp.showTab("timeline");
    expect([...fake.subs.keys()].filter((k) => fake.subs.get(k)!.size > 0)).toEqual(["t7"]);
  });

  it("marks running threads that did not fit under the cap", async () => {
    const threads = Array.from({ length: 4 }, (_, i) => summary(`t${i}`, { running: true }));
    const fake = fakeApi({ current: null, threads });
    const { host, insp } = mount(fake, { maxSubscriptions: 2 });
    insp.showTab("sessions");
    await tick();
    insp.flush();
    const acts = qa(host, ".si-ses").map((r) => r.querySelector(".si-ses-act")!.textContent!);
    expect(acts.filter((t) => t.startsWith("Running (not tracked"))).toHaveLength(2);
  });

  it("windows a long thread list", async () => {
    const threads = Array.from({ length: 800 }, (_, i) => summary(`t${i}`));
    const fake = fakeApi({ threads });
    const { host, insp } = mount(fake);
    insp.showTab("sessions");
    await tick();
    insp.flush();
    expect(qa(host, ".si-ses").length).toBeLessThan(40);
    expect(q(host, "[data-role=sessions-foot]").textContent).toContain("800 active threads");
  });

  it("tells the user when the environment id is unknown", async () => {
    const fake = fakeApi({ threads: [summary("a")] });
    const navigate = vi.fn();
    window.location.hash = "#/settings/general";
    const { host, insp } = mount(fake, { navigate });
    insp.showTab("sessions");
    await tick();
    insp.flush();
    qa(host, ".si-ses")[0]!.click();
    expect(navigate).not.toHaveBeenCalled();
    expect(q(host, "[data-role=sessions-foot]").textContent).toContain("environment id is unknown");
    window.location.hash = "";
  });
});

describe("lifecycle", () => {
  it("dispose removes the DOM, unsubscribes everything and stops timers", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeApi({ records: { [THREAD]: approval }, current: THREAD, threads: [summary("a", { running: true })] });
      const list = vi.spyOn(fake.api.threads, "list");
      const { host, insp } = mount(fake, { listPollMs: 100 });
      insp.showTab("sessions");
      await vi.advanceTimersByTimeAsync(10);
      const calls = list.mock.calls.length;
      insp.dispose();
      mounted = null;
      expect(host.querySelector(".t3p-si")).toBeNull();
      expect(fake.focusListeners.size).toBe(0);
      expect([...fake.subs.values()].every((s) => s.size === 0)).toBe(true);
      expect(fake.unsubscribed.sort()).toEqual(["7d0f2c1e-5b1a-4c63-9d0e-3a2f1b9c8e11", "a"].sort());
      await vi.advanceTimersByTimeAsync(5000);
      expect(list.mock.calls.length).toBe(calls);
      expect(vi.getTimerCount()).toBe(0);
      insp.dispose(); // idempotent
    } finally {
      vi.useRealTimers();
    }
  });

  it("references the app theme variables live (no stale copies) and survives a theme change", () => {
    const fake = fakeApi({ current: null });
    let cb: () => void = () => undefined;
    let fg = "#eee";
    fake.api.ui.themeVars = () => ({ "--foreground": fg });
    const { host } = mount(fake, {
      onThemeChange: (c) => {
        cb = c;
        return () => undefined;
      },
    });
    const root = q(host, ".t3p-si");
    expect(root.style.getPropertyValue("--si-fg")).toBe("var(--foreground, inherit)");
    expect(root.style.getPropertyValue("--si-border")).toContain("var(--border");
    fg = "#111";
    cb();
    expect(root.style.getPropertyValue("--si-fg")).toBe("var(--foreground, inherit)");
  });

  it("never injects record text as HTML", () => {
    const evil = synth(1, { summary: "<img src=x onerror=alert(1)>" });
    const fake = fakeApi({ records: { evil: [evil] }, current: "evil" });
    const { host } = mount(fake);
    expect(host.querySelector("img")).toBeNull();
    expect(rows(host)[0]!.querySelector(".si-c-sum")!.textContent).toBe("<img src=x onerror=alert(1)>");
  });
});
