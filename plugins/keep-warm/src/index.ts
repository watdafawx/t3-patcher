import type { OrchestrationCommand, PluginModule, SettingSchema, T3Api } from "@t3p/api";

import { decide, nextPingAt, SETTLED_REASON, pingsAfterActivity, type Rules, type Watch } from "./model.js";

const TICK_MS = 15_000;
/** How often settled state is re-read so the chip reacts to settle/un-settle without a reload. */
const SETTLED_POLL_MS = 3_000;
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
    /** Thread ids currently in T3's Settled section (from the live shell list). */
    const settledIds = new Set<string>();
    const isSettled = (threadId: string): boolean => settledIds.has(threadId) && t3.settings.get<boolean>("keepWarmSettled") !== true;
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
        const next = new Set((await t3.threads.list()).filter((t) => t.settled).map((t) => t.threadId));
        if (stopped) return;
        const changed = next.size !== settledIds.size || [...next].some((id) => !settledIds.has(id));
        settledIds.clear();
        for (const id of next) settledIds.add(id);
        if (changed) {
          redraw();
          void tick();
        }
      } catch (error) {
        t3.log("debug", `settled refresh failed: ${String(error)}`);
      }
    };

    const tick = async (): Promise<void> => {
      if (stopped || ticking || watches.size === 0) return;
      ticking = true;
      try {
        const list = await t3.threads.list();
        const running = new Set(list.filter((t) => t.running).map((t) => t.threadId));
        settledIds.clear();
        for (const t of list) if (t.settled) settledIds.add(t.threadId);
        for (const [threadId, watch] of [...watches]) {
          const state = await t3.cache.state(threadId).catch(() => null);
          watch.pings = pingsAfterActivity(watch, state);
          const decision = decide(watch, state, running.has(threadId), Date.now(), rules(), settledIds.has(threadId));
          if (decision.action === "stop") {
            watches.delete(threadId);
            notes.delete(threadId);
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
        const style = document.createElement("style");
        style.textContent = `
          [data-t3p-plugin="keep-warm"] .kw[data-on="true"] { color: var(--success-foreground, var(--success)); }`;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "t3p-btn kw";
        button.setAttribute("data-variant", "ghost");
        button.addEventListener("click", () => {
          if (ctx.threadId) toggle(ctx.threadId);
        });
        host.append(style, button);
        const draw = (): void => {
          const id = ctx.threadId;
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

    disposers.push(t3.events.on("thread:focus", () => void refreshSettled().then(redraw)));
    disposers.push(t3.settings.onChange(() => void refreshSettled().then(redraw)));
    const timer = setInterval(() => void tick(), TICK_MS);
    const settledTimer = setInterval(() => void refreshSettled(), SETTLED_POLL_MS);
    disposers.push(() => clearInterval(timer), () => clearInterval(settledTimer));

    void t3.storage.get("watches").then((raw) => {
      const stored = raw as unknown as Stored | undefined;
      if (stopped || !stored) return;
      for (const [id, w] of Object.entries(stored)) watches.set(id, w);
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
