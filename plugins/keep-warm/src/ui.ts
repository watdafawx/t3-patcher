import type { T3Api, UiSlotContext } from "@t3p/api";

import { activeCount, cacheLabel, decoratorTip, formatCountdown, sortListRows, type ListRow } from "./model.js";

/** What the UI needs from the plugin. Kept small so tests can fake it. */
export interface Controller {
  /** Every watched thread as list rows (unsorted). */
  rows(now: number): ListRow[];
  pause(threadId: string): void;
  resume(threadId: string): void;
  stop(threadId: string): void;
  stopAll(): void;
  /** Redraw callbacks; the plugin calls them all after any change. */
  readonly redraws: Set<() => void>;
}

const STYLE = `
[data-t3p-plugin="keep-warm"] .kw-pop { bottom: 26px; width: min(460px, calc(100vw - 16px)); max-height: 60vh; padding: 0; display: flex; flex-direction: column; }
[data-t3p-plugin="keep-warm"] .kw-pop[hidden] { display: none; }
[data-t3p-plugin="keep-warm"] .kw-head { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--t3p-line); }
[data-t3p-plugin="keep-warm"] .kw-head b { font-weight: 500; margin-right: auto; }
[data-t3p-plugin="keep-warm"] .kw-body { overflow: auto; padding: 4px; }
[data-t3p-plugin="keep-warm"] .kw-empty { padding: 12px 8px; color: var(--muted-foreground); }
[data-t3p-plugin="keep-warm"] .kw-row { display: flex; flex-direction: column; gap: 3px; padding: 6px 8px; border-radius: calc(var(--radius, .5rem) - 4px); }
[data-t3p-plugin="keep-warm"] .kw-row:hover { background: var(--accent, color-mix(in srgb, currentColor 8%, transparent)); }
[data-t3p-plugin="keep-warm"] .kw-row[data-dim="true"] { opacity: .6; }
[data-t3p-plugin="keep-warm"] .kw-line { display: flex; align-items: center; gap: 8px; min-width: 0; }
[data-t3p-plugin="keep-warm"] .kw-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; background: none; border: 0; padding: 0; font: inherit; font-weight: 500; text-align: left; color: var(--foreground); cursor: pointer; }
[data-t3p-plugin="keep-warm"] .kw-title:hover { text-decoration: underline; }
[data-t3p-plugin="keep-warm"] .kw-next { flex: none; font-variant-numeric: tabular-nums; }
[data-t3p-plugin="keep-warm"] .kw-meta { color: var(--muted-foreground); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-t3p-plugin="keep-warm"] .kw-actions { display: flex; gap: 4px; }
[data-t3p-plugin="keep-warm"] .kw-state[data-kind="warm"] { color: var(--success-foreground, var(--success)); }
[data-t3p-plugin="keep-warm"] .kw-state[data-kind="cooling"] { color: var(--warning-foreground, var(--warning)); }
[data-t3p-plugin="keep-warm"] .kw-state[data-kind="cold"] { color: var(--destructive-foreground, var(--destructive)); }
[data-t3p-plugin="keep-warm"] .kw-flame { color: var(--warning-foreground, var(--warning)); }`;

const FLAME =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8.6 1.2c.3 2.1-.7 3.1-1.7 4.2C5.8 6.6 4.5 7.9 4.5 10a3.5 3.5 0 0 0 7 0c0-1.3-.6-2.3-1.2-3.1-.2.9-.7 1.5-1.3 1.8.5-2.3.3-5.1-.4-7.5Z"/></svg>';

const btn = (label: string, onClick: () => void, title?: string): HTMLButtonElement => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "t3p-btn";
  b.setAttribute("data-variant", "ghost");
  b.setAttribute("data-compact", "");
  b.style.height = "22px";
  b.textContent = label;
  if (title) b.title = title;
  b.addEventListener("click", onClick);
  return b;
};

/** The status bar chip "Warm N" and its popover. Returns the cleanup. */
export function mountStatus(t3: T3Api, host: HTMLElement, ctrl: Controller): () => void {
  const style = document.createElement("style");
  style.textContent = STYLE;
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "t3p-chip";
  chip.setAttribute("data-compact", "");
  chip.dataset.keepWarm = "status";
  chip.setAttribute("aria-haspopup", "dialog");
  const pop = document.createElement("div");
  pop.className = "t3p-popover t3p-glass kw-pop";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Kept warm threads");
  pop.hidden = true;
  host.append(style, chip, pop);

  let timer: ReturnType<typeof setInterval> | null = null;

  const drawChip = (): void => {
    const n = activeCount(ctrl.rows(Date.now()));
    chip.textContent = n === 0 ? "Warm —" : `Warm ${n}`;
    chip.style.opacity = n === 0 ? "0.6" : "";
    chip.dataset.tone = n === 0 ? "" : "ok";
  };

  /** Updates only the live text (countdowns) so buttons are never replaced under the pointer. */
  const tickText = (): void => {
    const now = Date.now();
    for (const el of Array.from(pop.querySelectorAll<HTMLElement>("[data-next]"))) el.textContent = `next ping in ${formatCountdown(Number(el.dataset.next) - now)}`;
    for (const el of Array.from(pop.querySelectorAll<HTMLElement>("[data-exp]"))) {
      const left = Number(el.dataset.exp) - now;
      el.textContent = left <= 0 ? "cold" : `${el.dataset.kind} · ${formatCountdown(left)} left`;
    }
  };

  const drawRow = (row: ListRow, now: number): HTMLElement => {
    const el = document.createElement("div");
    el.className = "kw-row";
    el.dataset.thread = row.threadId;
    el.dataset.dim = String(!row.active);
    const line = document.createElement("div");
    line.className = "kw-line";
    const name = document.createElement("button");
    name.type = "button";
    name.className = "kw-title";
    name.textContent = row.title;
    name.title = "Open thread";
    name.addEventListener("click", () => {
      setOpen(false);
      t3.threads.open(row.threadId);
    });
    const next = document.createElement("span");
    next.className = "kw-next";
    if (row.settled) next.textContent = "settled: paused";
    else if (row.paused) next.textContent = "paused";
    else if (row.nextPingAt !== null) {
      next.dataset.next = String(row.nextPingAt);
      next.textContent = `next ping in ${formatCountdown(row.nextPingAt - now)}`;
    } else next.textContent = "no ping scheduled";
    line.append(name, next);

    const meta = document.createElement("div");
    meta.className = "kw-meta";
    const parts = [row.project, [row.provider, row.model].filter(Boolean).join(" / ") || null].filter(Boolean).join(" · ");
    meta.textContent = parts;
    meta.title = parts;

    const state = document.createElement("div");
    state.className = "kw-line kw-meta";
    const cache = document.createElement("span");
    cache.className = "kw-state";
    cache.dataset.kind = row.cache;
    if (row.expiresAt !== null && row.cache !== "unknown") cache.dataset.exp = String(row.expiresAt);
    cache.textContent = cacheLabel(row, now);
    const count = document.createElement("span");
    count.textContent = `${row.pings}/${row.maxPings} pings`;
    const note = document.createElement("span");
    note.textContent = row.note;
    note.title = row.note;
    note.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    state.append(cache, count, note);

    const actions = document.createElement("div");
    actions.className = "kw-actions";
    const toggle = row.paused ? btn("Resume", () => ctrl.resume(row.threadId)) : btn("Pause", () => ctrl.pause(row.threadId));
    toggle.dataset.action = row.paused ? "resume" : "pause";
    toggle.disabled = row.settled;
    const stop = btn("Stop watching", () => ctrl.stop(row.threadId));
    stop.dataset.action = "stop";
    const open = btn("Open thread", () => {
      setOpen(false);
      t3.threads.open(row.threadId);
    });
    open.dataset.action = "open";
    actions.append(toggle, stop, open);
    el.append(line, meta, state, actions);
    return el;
  };

  const drawList = (): void => {
    const now = Date.now();
    const rows = sortListRows(ctrl.rows(now));
    const active = activeCount(rows);
    pop.replaceChildren();
    const head = document.createElement("div");
    head.className = "kw-head";
    const title = document.createElement("b");
    title.textContent = `Kept warm · ${active} active${rows.length > active ? ` of ${rows.length}` : ""}`;
    const stopAll = btn("Stop all", () => ctrl.stopAll(), "Stop watching every thread");
    stopAll.dataset.action = "stop-all";
    stopAll.disabled = rows.length === 0;
    const settings = btn(
      "Settings",
      () => {
        setOpen(false);
        t3.ui.openSettings();
      },
      "Open keep-warm settings",
    );
    settings.dataset.action = "settings";
    head.append(title, stopAll, settings);
    const body = document.createElement("div");
    body.className = "kw-body";
    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "kw-empty";
      empty.dataset.empty = "";
      empty.textContent = 'No threads are being kept warm. Open a thread and press "Keep warm" in its header to start: a tiny message goes out just before the prompt cache would expire.';
      body.append(empty);
    }
    for (const row of rows) body.append(drawRow(row, now));
    pop.append(head, body);
  };

  const place = (): void => {
    const r = chip.getBoundingClientRect();
    const w = Math.min(460, window.innerWidth - 16);
    pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  };

  function setOpen(open: boolean): void {
    pop.hidden = !open;
    chip.setAttribute("aria-expanded", String(open));
    if (timer) clearInterval(timer);
    timer = null;
    if (!open) return;
    drawList();
    place();
    // The only 1 s timer, alive only while the popover is open.
    timer = setInterval(tickText, 1000);
  }

  chip.addEventListener("click", () => setOpen(pop.hidden));
  const onDown = (e: Event): void => {
    if (!pop.hidden && !host.contains(e.target as Node)) setOpen(false);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && !pop.hidden) {
      setOpen(false);
      chip.focus();
    }
  };
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("keydown", onKey, true);

  const draw = (): void => {
    drawChip();
    if (!pop.hidden) drawList();
  };
  ctrl.redraws.add(draw);
  drawChip();
  return () => {
    ctrl.redraws.delete(draw);
    if (timer) clearInterval(timer);
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
  };
}

/** The sidebar row icon (`threadListDecorator`). Hidden when the thread has no watch. */
export function mountDecorator(host: HTMLElement, ctx: UiSlotContext, ctrl: Controller): () => void {
  const style = document.createElement("style");
  style.textContent = STYLE;
  const icon = document.createElement("span");
  icon.className = "t3p-tld-icon kw-flame";
  icon.dataset.keepWarm = "flame";
  icon.innerHTML = FLAME;
  icon.hidden = true;
  host.append(style, icon);
  const draw = (): void => {
    const id = ctx.threadId;
    const row = id ? ctrl.rows(Date.now()).find((r) => r.threadId === id) : undefined;
    icon.hidden = !row;
    if (!row) return;
    if (row.active) icon.removeAttribute("data-dim");
    else icon.setAttribute("data-dim", "");
    icon.title = decoratorTip(row, Date.now());
  };
  // The tooltip text is recomputed as the pointer arrives, so the countdown is fresh without any timer.
  icon.addEventListener("pointerenter", draw);
  ctrl.redraws.add(draw);
  draw();
  return () => ctrl.redraws.delete(draw);
}
