import type { CacheState, OrchestrationCommand, PluginModule, SettingSchema, T3Api, ThreadSummary } from "@t3p/api";

import { buildRow, decide, isUnknownThreadError, nextPingAt, SETTLED_REASON, pingsAfterActivity, threadFacts, type ListRow, type Rules, type ThreadFacts, type ThreadInfo, type Watch } from "./model.js";
import { mountDecorator, mountStatus, type Controller } from "./ui.js";

const TICK_MS = 15_000;
/** How often settled state is re-read so the chip reacts to settle/un-settle without a reload. */
const SETTLED_POLL_MS = 3_000;
/** Consecutive "no such thread" answers before a watch is dropped (a dropped socket answers too). */
const GONE_POLLS = 3;
const PING_TEXT = 'Keep-warm ping. Reply with just "ok". Use no tools.';

const settings: SettingSchema[] = [
  { key: "leadMinutes", type: "number", default: 8, min: 1, max: 30, label: "Ping this many minutes before expiry", description: "The ping goes out this long before the cache would expire." },
  { key: "maxPings", type: "number", default: 20, min: 1, max: 100, label: "Stop after this many pings in a row", description: "Pings reset whenever you or a run use the thread. Past about 17 hours of silence one re-write is cheaper than more pings." },
  { key: "minCacheMinutes", type: "number", default: 30, min: 1, max: 120, label: "Only keep caches this long warm (minutes)", description: "On a 5-minute cache a ping every few minutes costs more than it saves." },
  { key: "keepWarmSettled", type: "boolean", default: false, label: "Also keep settled threads warm", description: "Off by default: threads in T3's Settled section are done, so pinging them wastes money. A paused watch resumes if you un-settle the thread." },
];

type Stored = Record<string, Watch>;

const plugin: PluginModule = {
  start(t3: T3Api) {
    const disposers: Array<() => void> = [];
    const defs = t3.settings.define(settings);
    disposers.push(() => defs.dispose());

    const watches = new Map<string, Watch>();
    const redraws = new Set<() => void>();
    const notes = new Map<string, string>();
    /** Thread ids currently in T3's Settled section (from the shell list, when it mentions them). */
    const settledIds = new Set<string>();
    /** Latest thread facts (title, project, model) and cache states, for the list and the sidebar icon. */
    const infos = new Map<string, ThreadInfo>();
    const states = new Map<string, CacheState | null>();
    /**
     * Facts read from each watched thread's projection. The shell list is only a convenience: in
     * current T3 builds it can omit threads (it streams a subset of projects), so existence,
     * settled state and run activity come from the projection instead.
     */
    const facts = new Map<string, ThreadFacts>();
    /** Consecutive "no such thread" projection failures per watch. */
    const goneStreak = new Map<string, number>();
    const isSettled = (threadId: string): boolean =>
      (settledIds.has(threadId) || facts.get(threadId)?.settled === true) && t3.settings.get<boolean>("keepWarmSettled") !== true;
    let stopped = false;
    let ticking = false;

    const rules = (): Rules => ({
      leadMs: t3.settings.get<number>("leadMinutes") * 60_000,
      maxPings: t3.settings.get<number>("maxPings"),
      minTtlMs: t3.settings.get<number>("minCacheMinutes") * 60_000,
      keepWarmSettled: t3.settings.get<boolean>("keepWarmSettled") === true,
    });
    const save = (): void => {
      const out: Stored = {};
      for (const [id, w] of watches) out[id] = w;
      void t3.storage.set("watches", out as never).catch((error) => t3.log("warn", `save failed: ${String(error)}`));
    };
    const redraw = (): void => {
      for (const fn of redraws) fn();
    };

    /** Remembers the thread facts the shell list does carry (titles, project names). Never drops a watch. */
    const absorb = (list: ThreadSummary[]): void => {
      infos.clear();
      for (const t of list) infos.set(t.threadId, { title: t.title, projectName: t.projectName ?? null, providerInstanceId: t.providerInstanceId, model: t.model });
    };

    /** Drops a watch and everything kept for it (thread archived, deleted or removed by the user). */
    const forget = (threadId: string): void => {
      watches.delete(threadId);
      notes.delete(threadId);
      states.delete(threadId);
      facts.delete(threadId);
      goneStreak.delete(threadId);
    };

    /** Facts for the watched thread from its projection, or undefined when it could not be read. */
    const readFacts = async (threadId: string): Promise<ThreadFacts | undefined> => {
      try {
        const f = threadFacts(await t3.threads.projection(threadId));
        goneStreak.delete(threadId);
        facts.set(threadId, f);
        return f;
      } catch (error) {
        // A dropped socket answers every call with an error; only a thread T3 says does not exist
        // drops the watch, and only after several answers in a row.
        const streak = isUnknownThreadError(error) ? (goneStreak.get(threadId) ?? 0) + 1 : 0;
        if (streak >= GONE_POLLS) {
          forget(threadId);
          save();
          t3.log("info", `keep-warm: thread ${threadId} is gone; watch dropped`);
        } else {
          goneStreak.set(threadId, streak);
        }
        return undefined;
      }
    };

    const ping = async (threadId: string, watch: Watch): Promise<void> => {
      const command = {
        type: "message.dispatch",
        commandId: crypto.randomUUID(),
        threadId,
        messageId: crypto.randomUUID(),
        text: PING_TEXT,
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "start_immediately" },
      } as unknown as OrchestrationCommand;
      watch.lastPingAt = Date.now();
      try {
        await t3.threads.dispatch(command);
        watch.pings += 1;
        notes.set(threadId, `ping ${watch.pings} sent`);
      } catch (error) {
        notes.set(threadId, `ping failed: ${String(error)}`);
        t3.log("warn", `ping ${threadId} failed: ${String(error)}`);
      }
      save();
    };

    /** Re-reads settled state (cheap: the list is the live shell stream) and redraws on change. */
    const refreshSettled = async (): Promise<void> => {
      try {
        const list = await t3.threads.list();
        if (stopped) return;
        absorb(list);
        const next = new Set(list.filter((t) => t.settled).map((t) => t.threadId));
        const changed = next.size !== settledIds.size || [...next].some((id) => !settledIds.has(id));
        settledIds.clear();
        for (const id of next) settledIds.add(id);
        // Redraw even without a change: this poll is the safety net that keeps the header button
        // in step with the route (a header can be re-mounted after `thread:focus` already fired).
        redraw();
        if (changed) void tick();
      } catch (error) {
        t3.log("debug", `settled refresh failed: ${String(error)}`);
      }
    };

    const tick = async (): Promise<void> => {
      if (stopped || ticking || watches.size === 0) return;
      ticking = true;
      try {
        const list = await t3.threads.list();
        absorb(list);
        const running = new Set(list.filter((t) => t.running).map((t) => t.threadId));
        settledIds.clear();
        for (const t of list) if (t.settled) settledIds.add(t.threadId);
        for (const [threadId, watch] of [...watches]) {
          if (!watches.has(threadId)) continue;
          const f = await readFacts(threadId);
          if (!watches.has(threadId)) continue; // dropped above: the thread is gone
          if (f?.archived) {
            forget(threadId);
            save();
            t3.ui.toast({ title: "Keep warm stopped", message: "The thread was archived.", kind: "info" });
            continue;
          }
          const state = await t3.cache.state(threadId).catch(() => null);
          states.set(threadId, state);
          watch.pings = pingsAfterActivity(watch, state);
          const busy = running.has(threadId) || f?.activeTurn === true;
          const decision = decide(watch, state, busy, Date.now(), rules(), isSettled(threadId));
          if (decision.action === "stop") {
            forget(threadId);
            save();
            t3.ui.toast({ title: "Keep warm stopped", message: decision.reason, kind: "info" });
          } else if (decision.action === "settled") {
            notes.set(threadId, `${decision.reason}. Resumes if you un-settle it.`);
          } else if (decision.action === "ping") {
            await ping(threadId, watch);
          } else {
            const at = nextPingAt(state, Date.now(), rules().leadMs);
            const when = at === null ? "" : ` next ping ${new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`;
            notes.set(threadId, `${decision.reason}.${when}`);
          }
        }
      } catch (error) {
        t3.log("warn", `tick failed: ${String(error)}`);
      } finally {
        ticking = false;
        redraw();
      }
    };

    const setPaused = (threadId: string, paused: boolean): void => {
      const watch = watches.get(threadId);
      if (!watch) return;
      watch.paused = paused;
      if (!paused) notes.delete(threadId);
      save();
      redraw();
      if (!paused) void tick();
    };
    const stopWatching = (threadId: string): void => {
      if (!watches.has(threadId)) return;
      forget(threadId);
      save();
      redraw();
    };
    /** The list's facts, else the projection's (the shell list can omit a thread entirely). */
    const infoOf = (threadId: string): ThreadInfo | null => {
      const fromList = infos.get(threadId);
      if (fromList) return fromList;
      const f = facts.get(threadId);
      return f ? { title: f.title ?? "", projectName: null, providerInstanceId: f.providerInstanceId, model: f.model } : null;
    };
    const controller: Controller = {
      redraws,
      rows(now: number): ListRow[] {
        const r = rules();
        return [...watches].map(([threadId, watch]) =>
          buildRow({ threadId, watch, info: infoOf(threadId), state: states.get(threadId) ?? null, settled: isSettled(threadId), note: watch.paused ? "paused by you" : notes.get(threadId) ?? "" }, now, r),
        );
      },
      pause: (id) => setPaused(id, true),
      resume: (id) => setPaused(id, false),
      stop: stopWatching,
      stopAll(): void {
        if (watches.size === 0) return;
        watches.clear();
        notes.clear();
        states.clear();
        save();
        redraw();
      },
    };

    const toggle = (threadId: string): void => {
      if (isSettled(threadId)) return;
      if (watches.has(threadId)) watches.delete(threadId);
      else watches.set(threadId, { pings: 0, until: null, lastPingAt: 0 });
      save();
      redraw();
      void tick();
    };

    const reg = t3.ui.register({
      slot: "threadHeader",
      id: "toggle",
      render(host, ctx) {
        // The route tracker (`t3.threads.current()`) follows pushState immediately; the slot
        // context can trail a route change by a moment, so it is only the fallback.
        const headerThread = (): string | null => t3.threads.current() ?? ctx.threadId;
        const style = document.createElement("style");
        style.textContent = `
          [data-t3p-plugin="keep-warm"] .kw[data-on="true"] { color: var(--success-foreground, var(--success)); }
          [data-t3p-plugin="keep-warm"] .kw[hidden] { display: none; }`;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "t3p-btn kw";
        button.setAttribute("data-variant", "ghost");
        button.addEventListener("click", () => {
          const id = headerThread();
          if (id) toggle(id);
        });
        host.append(style, button);
        const draw = (): void => {
          const id = headerThread();
          const watch = id ? watches.get(id) : undefined;
          const settled = id ? isSettled(id) : false;
          button.dataset.on = String(Boolean(watch) && !settled);
          button.disabled = settled;
          if (settled) {
            button.textContent = SETTLED_REASON;
            button.title = watch
              ? "This thread is settled, so it is not kept warm. Your keep-warm setting is saved and resumes if you un-settle it."
              : "This thread is settled, so keep-warm is off. Un-settle it, or turn on \"Also keep settled threads warm\" in the plugin settings.";
            button.hidden = !id;
            return;
          }
          button.textContent = watch ? (watch.pings > 0 ? `Warm · ${watch.pings} ping${watch.pings === 1 ? "" : "s"}` : "Warm") : "Keep warm";
          button.title = watch
            ? `Keeping this thread's cache warm. ${notes.get(id ?? "") ?? ""} Click to stop.`
            : "Keep this thread's prompt cache warm while you are away: a short message is sent just before it would expire.";
          button.hidden = !id;
        };
        redraws.add(draw);
        draw();
        return () => redraws.delete(draw);
      },
    });
    disposers.push(() => reg.dispose());
    const statusReg = t3.ui.register({
      slot: "statusBar",
      id: "list",
      order: 30,
      render: (host) => mountStatus(t3, host, controller),
    });
    const decoReg = t3.ui.register({
      slot: "threadListDecorator",
      id: "flame",
      render: (host, ctx) => mountDecorator(host, ctx, controller),
    });
    disposers.push(() => statusReg.dispose(), () => decoReg.dispose());

    // The header button follows the route: redraw at once (the list refresh can take a moment),
    // then re-read settled state and let the list refresh draw again.
    disposers.push(t3.events.on("thread:focus", () => {
      redraw();
      void refreshSettled();
    }));
    disposers.push(t3.settings.onChange(() => void refreshSettled().then(redraw)));
    const timer = setInterval(() => void tick(), TICK_MS);
    const settledTimer = setInterval(() => void refreshSettled(), SETTLED_POLL_MS);
    disposers.push(() => clearInterval(timer), () => clearInterval(settledTimer));

    void t3.storage.get("watches").then((raw) => {
      const stored = raw as unknown as Stored | undefined;
      if (stopped || !stored) return;
      for (const [id, w] of Object.entries(stored)) watches.set(id, w);
      redraw();
      void refreshSettled().then(() => {
        redraw();
        void tick();
      });
    });

    return () => {
      stopped = true;
      for (const off of disposers.reverse()) off();
    };
  },
};

export default plugin;
