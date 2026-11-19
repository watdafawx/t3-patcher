import type { ThreadSummary, TimelineRecord, Unsubscribe } from "@t3p/api";
import { causeChain, indexById, relationText } from "../logic/chain.js";
import { computeDurations, formatAge, formatClock, formatDuration, type Duration } from "../logic/durations.js";
import { buildExport, exportFileName, safeStringify } from "../logic/export.js";
import {
  defaultFilter,
  filterRecords,
  GROUPS,
  groupOf,
  KIND_LABEL,
  type KindGroup,
  type RecordFilter,
} from "../logic/filter.js";
import { modelByRecord } from "../logic/models.js";
import { deriveActivity, type Activity } from "../logic/nowdoing.js";
import { buildThreadHash, envFromRaw, parseThreadHash } from "../logic/route.js";
import { computeWindow, scrollTopFor } from "../logic/window.js";
import { FeedPool, MAX_SUBSCRIPTIONS, type SubscribeFn, type ThreadFeed } from "../store.js";
import { clear, downloadText, h } from "./dom.js";
import { CSS, THEME_MAP } from "./styles.js";

/** The slice of `T3Api` the panel uses (a test seam; the plugin passes the real `t3`). */
export interface InspectorApi {
  threads: { list(): Promise<ThreadSummary[]>; current(): string | null };
  timeline: { subscribe(threadId: string, cb: (record: TimelineRecord) => void): Unsubscribe };
  events: { on(name: "thread:focus", cb: (p: { threadId: string | null }) => void): Unsubscribe };
  ui: { themeVars(): Record<string, string> };
  log(level: "debug" | "info" | "warn" | "error", message: string): void;
}

export interface InspectorOptions {
  api: InspectorApi;
  /** Theme change hook of the slot context. */
  onThemeChange?: (cb: () => void) => Unsubscribe;
  download?: (fileName: string, text: string) => void;
  /** Navigate to a hash route such as `#/env/thread`. Default: assign `location.hash`. */
  navigate?: (hash: string) => void;
  /** Reads the current `location.hash`. */
  readHash?: () => string;
  now?: () => number;
  maxSubscriptions?: number;
  /** Poll interval of the thread list while the all-sessions tab is open. Default 5000. */
  listPollMs?: number;
  /** Render debounce. Default 60. */
  renderDelayMs?: number;
}

export interface Inspector {
  /** Render now (tests, and the 1 s tick). */
  flush(): void;
  /** Switch tab. */
  showTab(tab: "timeline" | "sessions"): void;
  dispose(): void;
}

export const ROW_HEIGHT = 26;
export const SESSION_ROW_HEIGHT = 50;
const TICK_MS = 1000;
const RAW_LIMIT = 200_000;

interface Derived {
  records: TimelineRecord[];
  byId: Map<string, TimelineRecord>;
  models: Map<string, string | null>;
}

export function mountInspector(host: HTMLElement, opts: InspectorOptions): Inspector {
  const api = opts.api;
  const now = opts.now ?? Date.now;
  const download = opts.download ?? ((n: string, t: string) => downloadText(n, t));
  const navigate =
    opts.navigate ??
    ((hash: string) => {
      window.location.hash = hash;
    });
  const readHash = opts.readHash ?? (() => window.location.hash);
  const renderDelay = opts.renderDelayMs ?? 60;
  const cleanups: Array<() => void> = [];
  let disposed = false;

  // ---- state ----
  const subscribe: SubscribeFn = (id, cb) => api.timeline.subscribe(id, cb);
  const pool = new FeedPool(subscribe, opts.maxSubscriptions ?? MAX_SUBSCRIPTIONS);
  let tab: "timeline" | "sessions" = "timeline";
  let threadId: string | null = api.threads.current();
  let lastEnv: string | null = parseThreadHash(readHash())?.environmentId ?? null;
  let filter: RecordFilter = defaultFilter();
  let selectedId: string | null = null;
  let follow = true;
  let threads: ThreadSummary[] = [];
  let listError: string | null = null;
  let listLoaded = false;
  let rawOpen = false;
  let derivedFor: TimelineRecord[] | null = null;
  let derived: Derived = { records: [], byId: new Map(), models: new Map() };
  let filteredFor: { records: TimelineRecord[]; filter: RecordFilter; out: TimelineRecord[] } | null = null;
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  let totalHeightPx = 0;

  // ---- DOM ----
  const root = h("div", { class: "t3p-si", data: { t3pSessionInspector: "1" } });
  const style = h("style", { text: CSS });
  const tabTimeline = h("button", { class: "si-tab", text: "Timeline", attrs: { role: "tab", "data-tab": "timeline" }, on: { click: () => showTab("timeline") } });
  const tabSessions = h("button", { class: "si-tab", text: "All sessions", attrs: { role: "tab", "data-tab": "sessions" }, on: { click: () => showTab("sessions") } });
  const tabs = h("div", { class: "si-tabs", attrs: { role: "tablist" } }, tabTimeline, tabSessions);

  const nowDot = h("span", { class: "si-dot" });
  const nowText = h("span", { class: "si-text", text: "No thread selected" });
  const nowSince = h("span", { class: "si-since" });
  const nowLine = h("div", { class: "si-now", data: { state: "empty" }, attrs: { "data-role": "now" } }, nowDot, nowText, nowSince);
  nowLine.addEventListener("click", () => {
    const a = currentActivity;
    if (a?.recordId) jumpTo(a.recordId);
  });

  const chips = new Map<KindGroup, HTMLButtonElement>();
  const chipBar = h("div", { class: "si-bar", attrs: { "data-role": "filters" } });
  for (const g of GROUPS) {
    const chip = h("button", {
      class: "si-chip",
      text: g.label,
      attrs: { "aria-pressed": "true", "data-group": g.id },
      on: {
        click: () => {
          const next = new Set(filter.groups);
          if (next.has(g.id)) next.delete(g.id);
          else next.add(g.id);
          filter = { ...filter, groups: next };
          scheduleRender();
        },
      },
    });
    chips.set(g.id, chip);
    chipBar.append(chip);
  }
  const textInput = h("input", {
    class: "si-text-filter",
    attrs: { type: "search", placeholder: "Filter text", "aria-label": "Filter text", "data-role": "text-filter" },
    on: {
      input: () => {
        filter = { ...filter, text: textInput.value };
        scheduleRender();
      },
    },
  });
  const exportBtn = h("button", { class: "si-btn", text: "Export JSON", attrs: { "data-role": "export" }, on: { click: () => doExport() } });
  const resetBtn = h("button", {
    class: "si-btn",
    text: "Reset",
    title: "Show everything",
    on: {
      click: () => {
        resetFilter();
        scheduleRender();
      },
    },
  });
  const countEl = h("span", { class: "si-count", attrs: { "data-role": "count" } });
  const toolbar = h("div", { class: "si-bar" }, textInput, resetBtn, exportBtn, countEl);

  const spacer = h("div", { class: "si-spacer" });
  const listEl = h("div", { class: "si-list", attrs: { "data-role": "list", role: "listbox" } }, spacer);
  listEl.addEventListener("scroll", () => {
    follow = listEl.scrollTop + viewHeight(listEl) >= totalHeightPx - ROW_HEIGHT * 2;
    scheduleRender();
  });
  const emptyEl = h("div", { class: "si-empty", attrs: { "data-role": "empty" } });
  const detailEl = h("div", { class: "si-detail", attrs: { "data-role": "detail" } });
  const timelineView = h("div", { class: "si-view", attrs: { "data-view": "timeline" } }, nowLine, chipBar, toolbar, listEl, emptyEl, detailEl);

  const sesList = h("div", { class: "si-ses-list", attrs: { "data-role": "sessions" } });
  const sesEmpty = h("div", { class: "si-empty", attrs: { "data-role": "sessions-empty" } });
  const sesFoot = h("div", { class: "si-foot", attrs: { "data-role": "sessions-foot" } });
  sesList.addEventListener("scroll", () => scheduleRender());
  const sessionsView = h("div", { class: "si-view", attrs: { "data-view": "sessions" } }, sesEmpty, sesList, sesFoot);

  root.append(style, tabs, timelineView, sessionsView);
  host.append(root);

  // ---- theme ----
  function applyTheme(): void {
    // Live references, never copies: a copied value goes stale the moment the app switches theme.
    for (const [mine, app, fallback] of THEME_MAP) root.style.setProperty(mine, `var(${app}, ${fallback})`);
  }
  applyTheme();
  if (opts.onThemeChange) cleanups.push(opts.onThemeChange(applyTheme));

  // ---- helpers ----
  function viewHeight(el: HTMLElement): number {
    return el.clientHeight > 0 ? el.clientHeight : 400;
  }

  function resetFilter(): void {
    filter = defaultFilter();
    textInput.value = "";
  }

  function feed(): ThreadFeed | undefined {
    return threadId ? pool.get(threadId) : undefined;
  }

  function deriveFor(records: TimelineRecord[]): Derived {
    if (derivedFor !== records) {
      derivedFor = records;
      derived = { records, byId: indexById(records), models: modelByRecord(records) };
    }
    return derived;
  }

  function filtered(records: TimelineRecord[]): TimelineRecord[] {
    if (filteredFor && filteredFor.records === records && filteredFor.filter === filter) return filteredFor.out;
    const out = filterRecords(records, filter);
    filteredFor = { records, filter, out };
    return out;
  }

  function want(): void {
    const ids: string[] = [];
    if (threadId) ids.push(threadId);
    if (tab === "sessions") for (const t of threads) if (t.running && t.threadId !== threadId) ids.push(t.threadId);
    pool.want(ids);
  }

  function showTab(next: "timeline" | "sessions"): void {
    tab = next;
    if (next === "sessions") void refreshThreads();
    want();
    flush();
  }

  async function refreshThreads(): Promise<void> {
    try {
      const rows = await api.threads.list();
      if (disposed) return;
      threads = rows.filter((t) => !isArchived(t));
      listError = null;
      listLoaded = true;
    } catch (e) {
      if (disposed) return;
      listError = e instanceof Error ? e.message : String(e);
      listLoaded = true;
    }
    want();
    scheduleRender();
  }

  function isArchived(t: ThreadSummary): boolean {
    const raw = t.raw;
    if (raw !== null && typeof raw === "object") {
      const a = (raw as Record<string, unknown>).archivedAt;
      return a !== undefined && a !== null;
    }
    return false;
  }

  function doExport(): void {
    const f = feed();
    const all = f ? f.records() : [];
    const shown = filtered(all);
    const t = now();
    const payload = buildExport({ threadId, all, shown, filter, now: t });
    download(exportFileName(threadId, t), safeStringify(payload, 2));
  }

  function select(id: string | null): void {
    selectedId = id;
    scheduleRender();
  }

  /** Select a record and scroll it into view; clears the filters first when they hide it. */
  function jumpTo(id: string): void {
    const f = feed();
    if (!f) return;
    const all = f.records();
    if (!all.some((r) => r.id === id)) return;
    selectedId = id;
    let list = filtered(all);
    let idx = list.findIndex((r) => r.id === id);
    if (idx < 0) {
      resetFilter();
      list = filtered(all);
      idx = list.findIndex((r) => r.id === id);
    }
    follow = false;
    if (idx >= 0) listEl.scrollTop = scrollTopFor(idx, ROW_HEIGHT, viewHeight(listEl), list.length);
    flush();
  }

  // ---- render: timeline ----
  let currentActivity: Activity | null = null;

  function renderNow(records: TimelineRecord[]): void {
    const a = deriveActivity(records);
    currentActivity = a;
    nowLine.dataset.state = a.state;
    nowText.textContent = threadId ? a.text : "No thread selected. Open a thread to see its timeline.";
    nowSince.textContent = a.since && (a.state !== "empty") ? (a.state === "idle" ? formatAge(a.since, now()) : formatDuration(Math.max(0, now() - a.since))) : "";
    nowLine.style.cursor = a.recordId ? "pointer" : "default";
  }

  function renderRows(list: TimelineRecord[], d: Derived, durations: Map<string, Duration>): void {
    const win = computeWindow({ count: list.length, rowHeight: ROW_HEIGHT, scrollTop: listEl.scrollTop, viewHeight: viewHeight(listEl) });
    spacer.style.height = `${win.totalHeight}px`;
    totalHeightPx = win.totalHeight;
    const frag = document.createDocumentFragment();
    for (let i = win.start; i < win.end; i++) {
      const r = list[i]!;
      const kind = KIND_LABEL[r.kind] ?? KIND_LABEL.unknown;
      const dur = durations.get(r.id);
      const model = d.models.get(r.id) ?? null;
      const prov = model ? `${r.provider} · ${model}` : r.provider;
      const row = h(
        "div",
        {
          class: "si-row",
          data: { id: r.id, kind: r.kind, group: groupOf(r.kind) },
          attrs: { role: "option", "aria-selected": r.id === selectedId ? "true" : "false" },
          style: { top: `${i * ROW_HEIGHT}px`, height: `${ROW_HEIGHT}px` },
          on: { click: () => select(r.id === selectedId ? null : r.id) },
        },
        h("span", { class: "si-c-time", text: formatClock(r.at), title: r.at > 0 ? new Date(r.at).toISOString() : "" }),
        h("span", { class: "si-c-dur", text: dur ? `${dur.open ? "▸ " : ""}${formatDuration(dur.ms)}` : "", data: { open: dur?.open ? "1" : "0" } }),
        h("span", { class: "si-c-prov", text: prov, title: prov }),
        h("span", { class: "si-c-icon", text: kind.icon, title: kind.label }),
        h("span", { class: "si-c-sum", text: r.summary, title: `${kind.label}: ${r.summary}` }),
        r.cause ? h("span", { class: "si-c-why", text: relationText(r.cause.relation), title: "Why: click the row to see the cause chain" }) : null,
      );
      frag.append(row);
    }
    // Keep the spacer element, replace only the row children.
    for (const el of Array.from(spacer.children)) el.remove();
    spacer.append(frag);
  }

  function renderDetail(d: Derived, durations: Map<string, Duration>): void {
    clear(detailEl);
    const rec = selectedId ? d.byId.get(selectedId) : undefined;
    if (!rec) {
      detailEl.append(h("div", { class: "si-note", text: selectedId ? "That record is not in this thread (yet)." : "Click a row to see why it happened." }));
      return;
    }
    const kind = KIND_LABEL[rec.kind] ?? KIND_LABEL.unknown;
    const dur = durations.get(rec.id);
    const model = d.models.get(rec.id);
    detailEl.append(
      h("h4", { text: `${kind.label}: ${rec.summary}` }),
      h("div", {
        class: "si-note",
        text: [
          formatClock(rec.at),
          dur ? `${dur.open ? "so far " : ""}${formatDuration(dur.ms)}` : null,
          model ? `${rec.provider} · ${model}` : rec.provider,
          rec.status ? `status ${rec.status}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
      }),
    );

    const chain = causeChain(d.byId, rec.id);
    detailEl.append(h("h4", { text: "Why (cause chain)", style: { marginTop: "6px" } }));
    const chainEl = h("div", { attrs: { "data-role": "chain" } });
    chain.hops.forEach((hop, i) => {
      const target = hop.record;
      chainEl.append(
        h(
          "div",
          {
            class: "si-hop",
            data: { id: target.id, hop: String(i) },
            title: "Scroll to this record",
            on: { click: () => (i === 0 ? undefined : jumpTo(target.id)) },
          },
          h("span", { class: "si-hop-rel", text: hop.relation ? `↑ ${relationText(hop.relation)}` : "this record" }),
          h("span", { class: "si-hop-time", text: formatClock(target.at) }),
          h("span", { class: "si-hop-sum", text: `${(KIND_LABEL[target.kind] ?? KIND_LABEL.unknown).label}: ${target.summary}` }),
        ),
      );
    });
    detailEl.append(chainEl);
    const endText: Record<typeof chain.end, string> = {
      root: chain.hops.length <= 1 ? "No cause recorded (this is a root event)." : "Root cause reached.",
      missing: "The next cause is not in the loaded timeline.",
      cycle: "Loop in cause links cut.",
      limit: "Chain cut at the depth limit.",
    };
    detailEl.append(h("div", { class: "si-note", text: endText[chain.end] }));

    const details = h("details", { attrs: { "data-role": "raw" } });
    details.open = rawOpen;
    details.append(h("summary", { text: "Raw event (record.raw)" }));
    const fill = (): void => {
      if (details.querySelector("pre")) return;
      let text = safeStringify(rec.raw, 2) ?? "undefined";
      if (text.length > RAW_LIMIT) text = `${text.slice(0, RAW_LIMIT)}\n… truncated (${text.length} chars)`;
      details.append(h("pre", { class: "si-raw", text }));
    };
    details.addEventListener("toggle", () => {
      rawOpen = details.open;
      if (details.open) fill();
    });
    if (rawOpen) fill();
    detailEl.append(details);
  }

  function renderTimeline(): void {
    const f = feed();
    const records = f ? f.records() : [];
    const d = deriveFor(records);
    const list = filtered(records);
    const t = now();
    const durations = computeDurations(records, t);

    renderNow(records);
    for (const g of GROUPS) chips.get(g.id)!.setAttribute("aria-pressed", filter.groups.has(g.id) ? "true" : "false");
    countEl.textContent = list.length === records.length ? `${records.length} records` : `${list.length} of ${records.length}`;
    exportBtn.disabled = records.length === 0;

    const hasRows = list.length > 0;
    listEl.hidden = !hasRows;
    emptyEl.hidden = hasRows;
    if (!threadId) emptyEl.textContent = "Open a thread to inspect it.";
    else if (!f) emptyEl.textContent = "Not tracking this thread.";
    else if (records.length === 0) emptyEl.textContent = "No records yet.";
    else emptyEl.textContent = "No records match the filter.";

    if (hasRows) {
      if (follow) listEl.scrollTop = Math.max(0, list.length * ROW_HEIGHT - viewHeight(listEl));
      renderRows(list, d, durations);
    } else {
      for (const el of Array.from(spacer.children)) el.remove();
    }
    renderDetail(d, durations);
  }

  // ---- render: sessions ----
  function renderSessions(): void {
    const t = now();
    const rows = threads;
    sesEmpty.hidden = rows.length > 0;
    sesList.hidden = rows.length === 0;
    if (listError) sesEmpty.textContent = `Could not read the thread list: ${listError}`;
    else if (!listLoaded) sesEmpty.textContent = "Loading threads…";
    else sesEmpty.textContent = "No active threads. Start or open a thread and it shows up here.";

    const win = computeWindow({ count: rows.length, rowHeight: SESSION_ROW_HEIGHT, scrollTop: sesList.scrollTop, viewHeight: viewHeight(sesList) });
    for (const el of Array.from(sesList.children)) el.remove();
    sesList.style.height = "";
    const spacerEl = h("div", { class: "si-spacer", style: { height: `${win.totalHeight}px` } });
    for (let i = win.start; i < win.end; i++) {
      const th = rows[i]!;
      const fd = pool.get(th.threadId);
      let activity: string;
      let lastAt: number | null;
      if (fd) {
        const a = deriveActivity(fd.records());
        activity = a.state === "empty" ? (th.running ? "Running" : "No activity yet") : a.text;
        lastAt = fd.lastEventAt > 0 ? fd.lastEventAt : null;
      } else {
        activity = th.running ? "Running (not tracked: subscription cap reached)" : "Idle";
        lastAt = null;
      }
      if (lastAt === null && th.updatedAt) {
        const ms = Date.parse(th.updatedAt);
        lastAt = Number.isFinite(ms) ? ms : null;
      }
      const provModel = [th.providerInstanceId, th.model].filter(Boolean).join(" · ") || "unknown provider";
      const row = h(
        "div",
        {
          class: "si-ses",
          data: { threadId: th.threadId, current: th.threadId === threadId ? "1" : "0", running: th.running ? "1" : "0" },
          style: { top: `${i * SESSION_ROW_HEIGHT}px`, height: `${SESSION_ROW_HEIGHT}px` },
          title: "Open this thread",
          on: { click: () => focusThread(th) },
        },
        h("div", { class: "si-ses-title", text: th.title || th.threadId }),
        h("div", { class: "si-ses-sub" }, h("span", { class: "si-ses-act", text: activity, title: activity }), h("span", { text: provModel }), h("span", { text: formatAge(lastAt, t) })),
      );
      spacerEl.append(row);
    }
    sesList.append(spacerEl);
    sesFoot.textContent = `${rows.length} active thread${rows.length === 1 ? "" : "s"} · ${pool.active}/${pool.cap} timelines tracked`;
  }

  function focusThread(th: ThreadSummary): void {
    const env = envFromRaw(th.raw) ?? lastEnv;
    if (!env) {
      sesFoot.textContent = "Cannot open: the environment id is unknown. Open any thread once, then try again.";
      return;
    }
    navigate(buildThreadHash(env, th.threadId));
  }

  // ---- scheduling ----
  function render(): void {
    if (disposed) return;
    timelineView.hidden = tab !== "timeline";
    sessionsView.hidden = tab !== "sessions";
    tabTimeline.setAttribute("aria-selected", tab === "timeline" ? "true" : "false");
    tabSessions.setAttribute("aria-selected", tab === "sessions" ? "true" : "false");
    if (tab === "timeline") renderTimeline();
    else renderSessions();
  }

  function flush(): void {
    if (renderTimer !== null) {
      clearTimeout(renderTimer);
      renderTimer = null;
    }
    try {
      render();
    } catch (e) {
      api.log("error", `session-inspector render failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function scheduleRender(): void {
    if (disposed || renderTimer !== null) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      flush();
    }, renderDelay);
  }

  // ---- wiring ----
  cleanups.push(pool.onChange(scheduleRender));
  cleanups.push(
    api.events.on("thread:focus", (p) => {
      threadId = p.threadId;
      const parsed = parseThreadHash(readHash());
      if (parsed) lastEnv = parsed.environmentId;
      selectedId = null;
      follow = true;
      resetFilter();
      want();
      scheduleRender();
    }),
  );
  want();

  const tick = setInterval(() => {
    if (disposed) return;
    // Ages ("5s ago"), open durations and the now-line all move with the clock.
    scheduleRender();
  }, TICK_MS);
  cleanups.push(() => clearInterval(tick));

  const pollMs = opts.listPollMs ?? 5000;
  const poll = setInterval(() => {
    if (!disposed && tab === "sessions") void refreshThreads();
  }, pollMs);
  cleanups.push(() => clearInterval(poll));
  // Prime the list once so the sessions tab opens with data.
  void refreshThreads();

  flush();

  return {
    flush,
    showTab,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (renderTimer !== null) clearTimeout(renderTimer);
      for (const c of cleanups.splice(0)) {
        try {
          c();
        } catch {
          /* ignore */
        }
      }
      pool.dispose();
      root.remove();
    },
  };
}
