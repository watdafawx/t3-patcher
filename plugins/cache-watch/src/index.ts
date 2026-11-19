import type { PluginModule, SettingSchema, T3Api, ThreadSummary, Unsubscribe } from "@t3p/api";

import { applyOverride, contextLabel, formatRemaining, pricesFor, sortRows, sourceLabel, verdictHint, type CachePrices, type Row, type TtlOverrides } from "./model.js";

/** How often the thread list and every cache state are re-read. */
const REFRESH_MS = 10_000;
/** Threads older than this (by last activity) are not watched. */
const MAX_AGE_MS = 24 * 3_600_000;
/** At most this many threads are watched (most recent first). */
const MAX_THREADS = 30;

const settings: SettingSchema[] = [
  {
    key: "notifyLeadSeconds",
    type: "number",
    default: 60,
    min: 0,
    max: 3600,
    label: "Warn before expiry (seconds)",
    description: "Show a toast this many seconds before a thread's prompt cache expires. 0 turns it off.",
  },
  {
    key: "ttlMinutesClaudeAgent",
    type: "number",
    default: 0,
    min: 0,
    max: 1440,
    label: "Claude: assumed cache minutes",
    description: "Only used when Claude reports no expiry. 0 = built-in default (5 min, Anthropic docs). Use 60 if your requests use the 1 h cache.",
  },
  {
    key: "ttlMinutesCodex",
    type: "number",
    default: 0,
    min: 0,
    max: 1440,
    label: "Codex: assumed cache minutes",
    description: "Codex reports no expiry, so this is always an estimate. 0 = built-in default (5 min; OpenAI says 5 to 10 min of inactivity).",
  },
  {
    key: "ttlMinutesOpencode",
    type: "number",
    default: 0,
    min: 0,
    max: 1440,
    label: "OpenCode: assumed cache minutes",
    description: "OpenCode reports no expiry, so this is an estimate. 0 = built-in default (3 h, DeepSeek's disk cache: cleared after a few hours to days). If you run Anthropic or OpenAI models through OpenCode, set 5.",
  },
  {
    key: "cacheReadPerM",
    type: "number",
    default: 0,
    min: 0,
    max: 1000,
    label: "Cache read price ($ per 1M tokens)",
    description: "Override for the re-warm estimate. 0 = built-in table by model family (0.1x input price).",
  },
  {
    key: "cacheWritePerM",
    type: "number",
    default: 0,
    min: 0,
    max: 1000,
    label: "Cache write price ($ per 1M tokens)",
    description: "Override for the re-warm estimate. 0 = built-in table (Claude 1.25x input for the 5 min cache, GPT/Codex = input price). Unknown models show tokens only.",
  },
];

const PROVIDER_KEYS: Record<string, string> = { claudeAgent: "ttlMinutesClaudeAgent", codex: "ttlMinutesCodex", opencode: "ttlMinutesOpencode" };

const plugin: PluginModule = {
  start(t3: T3Api) {
    const disposers: Array<() => void> = [];
    const schemas = t3.settings.define(settings);
    disposers.push(() => schemas.dispose());

    const rows = new Map<string, Row>();
    const redraws = new Set<() => void>();
    const watches = new Map<string, Unsubscribe>();
    let watchedLead = -1;
    let stopped = false;
    let refreshing = false;

    const overrides = (): TtlOverrides => {
      const out: Record<string, number> = {};
      for (const [provider, key] of Object.entries(PROVIDER_KEYS)) out[provider] = t3.settings.get<number>(key);
      return out;
    };

    const rowPrices = (row: Row): CachePrices | null =>
      pricesFor(row.model ?? null, { cacheReadPerM: t3.settings.get<number>("cacheReadPerM"), cacheWritePerM: t3.settings.get<number>("cacheWritePerM") });

    /** `~85k ctx · re-warm ~$0.40 — cold: re-warm ~$0.40, new session ~$0`, or `""`. */
    const ctxText = (row: Row): string => {
      const state = applyOverride(row.state, row.providerInstanceId, overrides());
      const prices = rowPrices(row);
      const label = contextLabel(row.usedTokens ?? null, prices);
      const verdict = verdictHint(state, row.usedTokens ?? null, prices, Date.now());
      return [label, verdict].filter(Boolean).join(" — ");
    };

    const syncWatches =(): void => {
      const lead = Math.max(0, Math.floor(t3.settings.get<number>("notifyLeadSeconds"))) * 1000;
      if (lead !== watchedLead) {
        for (const off of watches.values()) off();
        watches.clear();
        watchedLead = lead;
      }
      for (const [id, off] of [...watches]) {
        if (!rows.has(id) || lead === 0) {
          off();
          watches.delete(id);
        }
      }
      if (lead === 0) return;
      for (const id of rows.keys()) {
        if (watches.has(id)) continue;
        watches.set(
          id,
          t3.cache.onExpiring(id, lead, () => {
            const row = rows.get(id);
            const state = applyOverride(row?.state ?? null, row?.providerInstanceId ?? null, overrides());
            t3.ui.toast({
              title: "Prompt cache expiring",
              message: `${row?.title || id}: ${formatRemaining(state, Date.now())} left`,
              kind: "warning",
            });
          }),
        );
      }
    };

    const refresh = async (): Promise<void> => {
      if (stopped || refreshing) return;
      refreshing = true;
      try {
        const threads: ThreadSummary[] = (await t3.threads.list())
          .filter((t) => {
            const at = t.updatedAt ? Date.parse(t.updatedAt) : Number.NaN;
            return Number.isNaN(at) || Date.now() - at < MAX_AGE_MS;
          })
          .slice(0, MAX_THREADS);
        const current = t3.threads.current();
        if (current && !threads.some((t) => t.threadId === current)) {
          threads.push({ threadId: current, title: "", projectId: null, providerInstanceId: null, model: null, updatedAt: null, running: false, raw: null });
        }
        const seen = new Set<string>();
        await Promise.all(
          threads.map(async (thread) => {
            seen.add(thread.threadId);
            let state = null;
            try {
              state = await t3.cache.state(thread.threadId);
            } catch (error) {
              t3.log("debug", `cache.state(${thread.threadId}) failed: ${String(error)}`);
            }
            let usedTokens: number | null = null;
            try {
              usedTokens = (await t3.usage.context(thread.threadId)).usedTokens;
            } catch (error) {
              t3.log("debug", `usage.context(${thread.threadId}) failed: ${String(error)}`);
            }
            rows.set(thread.threadId, {
              threadId: thread.threadId,
              title: thread.title,
              providerInstanceId: thread.providerInstanceId,
              model: thread.model,
              usedTokens,
              state,
            });
          }),
        );
        for (const id of [...rows.keys()]) if (!seen.has(id)) rows.delete(id);
        if (!stopped) syncWatches();
      } catch (error) {
        t3.log("warn", `refresh failed: ${String(error)}`);
      } finally {
        refreshing = false;
        for (const redraw of redraws) redraw();
      }
    };

    const sortedRows = (): Row[] =>
      sortRows(
        [...rows.values()].map((r) => ({ ...r, state: applyOverride(r.state, r.providerInstanceId, overrides()) })),
        Date.now(),
      );

    const addStyle = (host: HTMLElement): void => {
      const style = document.createElement("style");
      style.textContent = `
        [data-t3p-plugin="cache-watch"] .cw { font-size: 12px; line-height: 1.4; color: var(--foreground); }
        [data-t3p-plugin="cache-watch"] .t3p-badge.cw { gap: 4px; }
        [data-t3p-plugin="cache-watch"] .t3p-badge.cw > span:first-child { color: var(--muted-foreground); font-weight: 400; }
        [data-t3p-plugin="cache-watch"] .cw-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 24px; padding: 0 4px; border-radius: calc(var(--radius, .5rem) - 4px); }
        [data-t3p-plugin="cache-watch"] .cw-row:hover { background: var(--accent, color-mix(in srgb, currentColor 8%, transparent)); }
        [data-t3p-plugin="cache-watch"] .cw-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        [data-t3p-plugin="cache-watch"] .cw-time { flex: none; font-variant-numeric: tabular-nums; white-space: nowrap; }
        [data-t3p-plugin="cache-watch"] .cw-src { color: var(--muted-foreground); margin-left: 6px; font-size: 11px; }
        [data-t3p-plugin="cache-watch"] .cw-urgent { color: var(--warning-foreground, var(--warning)); }
        [data-t3p-plugin="cache-watch"] .cw-meta { padding: 0 4px 4px; margin-top: -2px; }
        [data-t3p-plugin="cache-watch"] .cw-head { font-weight: 500; font-size: 12px; padding: 0 4px 4px; margin-bottom: 4px; color: var(--muted-foreground); }
        [data-t3p-plugin="cache-watch"] .cw-empty { padding: 4px; color: var(--muted-foreground); }`;
      host.append(style);
    };

    const timeEl = (row: Row): HTMLElement => {
      const now = Date.now();
      const state = applyOverride(row.state, row.providerInstanceId, overrides());
      const left = state?.expiresAt == null ? null : state.expiresAt - now;
      const el = document.createElement("span");
      el.className = `cw-time${left !== null && left > 0 && left <= 60_000 ? " cw-urgent" : ""}`;
      el.textContent = formatRemaining(state, now);
      const label = sourceLabel(state);
      if (label) {
        const src = document.createElement("span");
        src.className = "cw-src";
        src.textContent = label;
        el.append(src);
      }
      return el;
    };

    const listView = (host: HTMLElement, limit: number, heading: string | null): (() => void) => {
      addStyle(host);
      const root = document.createElement("div");
      root.className = "cw";
      if (heading === null) root.style.padding = "8px 12px";
      root.dataset.cacheWatch = "list";
      host.append(root);
      const draw = (): void => {
        root.replaceChildren();
        if (heading) {
          const h = document.createElement("div");
          h.className = "cw-head";
          h.textContent = heading;
          root.append(h);
        }
        const list = sortedRows().slice(0, limit);
        if (list.length === 0) {
          const e = document.createElement("div");
          e.className = "cw-empty";
          e.textContent = "No threads with a prompt cache yet.";
          root.append(e);
        }
        for (const row of list) {
          const line = document.createElement("div");
          line.className = "cw-row";
          const title = document.createElement("span");
          title.className = "cw-title";
          title.textContent = row.title || row.threadId;
          line.append(title, timeEl(row));
          root.append(line);
          const hint = ctxText(row);
          if (heading !== null && hint) {
            const meta = document.createElement("div");
            meta.className = "t3p-meta cw-meta";
            meta.textContent = hint;
            root.append(meta);
          }
        }
      };
      redraws.add(draw);
      draw();
      return () => redraws.delete(draw);
    };

    const registrations = [
      t3.ui.register({
        slot: "statusBar",
        id: "status",
        order: 20,
        render(host) {
          addStyle(host);
          const style = document.createElement("style");
          style.textContent = `
            [data-t3p-plugin="cache-watch"] .cw-pop { left: 8px; bottom: 26px; width: min(340px, calc(100vw - 16px)); max-height: 50vh; }`;
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = "t3p-chip";
          chip.setAttribute("data-compact", "");
          chip.dataset.cacheWatch = "status";
          const pop = document.createElement("div");
          pop.className = "t3p-popover t3p-glass cw-pop";
          pop.hidden = true;
          host.append(style, chip, pop);
          const stopList = listView(pop, MAX_THREADS, "Prompt cache");
          chip.addEventListener("click", () => {
            pop.hidden = !pop.hidden;
          });
          const onDoc = (e: Event): void => {
            if (!pop.hidden && !host.contains(e.target as Node)) pop.hidden = true;
          };
          document.addEventListener("pointerdown", onDoc, true);
          const draw = (): void => {
            const now = Date.now();
            const live = sortedRows().filter((r) => r.state?.expiresAt != null && r.state.expiresAt > now);
            chip.textContent = live.length === 0 ? "Cache: none live" : `Cache: ${live.length} live · next ${formatRemaining(live[0]!.state, now)}`;
          };
          redraws.add(draw);
          draw();
          return () => {
            redraws.delete(draw);
            stopList();
            document.removeEventListener("pointerdown", onDoc, true);
          };
        },
      }),
      t3.ui.register({ slot: "rightPanel", id: "all-threads", title: "Cache", render: (host) => listView(host, MAX_THREADS, null) }),
      t3.ui.register({
        slot: "threadHeader",
        id: "header",
        render(host, ctx) {
          addStyle(host);
          const root = document.createElement("span");
          root.className = "cw t3p-badge";
          root.dataset.cacheWatch = "header";
          host.append(root);
          const draw = (): void => {
            root.replaceChildren();
            const row = ctx.threadId ? rows.get(ctx.threadId) : undefined;
            if (!row || !row.state) return;
            const prefix = document.createElement("span");
            prefix.textContent = "Cache ";
            root.append(prefix, timeEl(row));
            root.title = ctxText(row);
          };
          redraws.add(draw);
          draw();
          return () => redraws.delete(draw);
        },
      }),
    ];
    disposers.push(() => registrations.forEach((r) => r.dispose()));

    // A one-second tick redraws every mounted view from the cached state (no RPC).
    const tick = setInterval(() => {
      for (const redraw of redraws) redraw();
    }, 1000);
    const poll = setInterval(() => void refresh(), REFRESH_MS);
    disposers.push(() => clearInterval(tick), () => clearInterval(poll));
    disposers.push(t3.events.on("thread:focus", () => void refresh()));
    disposers.push(t3.settings.onChange(() => syncWatches()));
    void refresh();

    return () => {
      stopped = true;
      for (const off of watches.values()) off();
      watches.clear();
      redraws.clear();
      for (const d of disposers.reverse()) {
        try {
          d();
        } catch {
          // already gone
        }
      }
    };
  },
};

export default plugin;
