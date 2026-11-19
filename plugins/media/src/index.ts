import type { JsonValue, PluginModule, SettingSchema, T3Api } from "@t3p/api";

import { currentPosition, formatTime, parseMediaPoll, pollInterval, progressFraction, type MediaPoll, type MediaState } from "./smtc.js";
import { embedUrl, parsePlayerMessage, parseYouTube, playerCommand, targetKey, thumbUrl, watchUrl, type YouTubeTarget } from "./youtube.js";

const EMBED_ORIGIN = "https://www.youtube-nocookie.com";
const MAX_RECENT = 5;

const settings: SettingSchema[] = [
  { key: "statusChip", type: "boolean", default: false, label: "Status bar chip", description: "Show the current title in the status bar with a play/pause click. Reads the media session every 5 seconds while on." },
  { key: "rememberLinks", type: "boolean", default: false, label: "Remember the last 5 YouTube links", description: "Stores pasted links and asks YouTube (oEmbed) for their titles. Off: no network calls other than the embedded player and its thumbnail." },
];

const STYLE = `
[data-t3p-plugin="media"] .md-col{display:flex;flex-direction:column;gap:2px;min-width:0}
[data-t3p-plugin="media"] .md-now{align-items:center;gap:.625rem;padding:.25rem .625rem}
[data-t3p-plugin="media"] .md-text{flex:1;min-width:0;display:flex;flex-direction:column}
[data-t3p-plugin="media"] .md-artist{font-size:11px;color:var(--muted-foreground,inherit);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
[data-t3p-plugin="media"] .md-ctl{display:flex;align-items:center;gap:2px;flex:none}
[data-t3p-plugin="media"] .md-ico{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:1.5rem;height:1.5rem;padding:0;border:1px solid transparent;border-radius:calc(var(--radius,.5rem) - 4px);background:transparent;color:var(--muted-foreground,inherit);cursor:pointer;outline:none;transition:background-color .15s,color .15s}
[data-t3p-plugin="media"] .md-ico:hover{background:var(--accent,color-mix(in srgb,currentColor 8%,transparent));color:var(--foreground,inherit)}
[data-t3p-plugin="media"] .md-ico:focus-visible{box-shadow:0 0 0 2px var(--background,canvas),0 0 0 4px var(--ring,currentColor)}
[data-t3p-plugin="media"] .md-ico:disabled{opacity:.4;pointer-events:none}
[data-t3p-plugin="media"] .md-ico svg{width:1rem;height:1rem;fill:currentColor}
[data-t3p-plugin="media"] .md-prog{display:flex;align-items:center;gap:.5rem;padding:0 .625rem}
[data-t3p-plugin="media"] .md-prog .t3p-bar{flex:1}
[data-t3p-plugin="media"] .md-yt{gap:.5rem;padding:0 .25rem 0 0}
[data-t3p-plugin="media"] .md-yt .t3p-input{flex:1;min-width:0;height:2rem}
[data-t3p-plugin="media"] .md-frame{position:relative;width:100%;aspect-ratio:16/9;border-radius:var(--t3p-radius);overflow:hidden;background:var(--muted,color-mix(in srgb,currentColor 10%,transparent))}
[data-t3p-plugin="media"] .md-frame iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
[data-t3p-plugin="media"] .md-recent{padding:0 .625rem;font-size:11px}
[data-t3p-plugin="media"] .md-err{padding:0 .625rem;font-size:11px;color:var(--destructive-foreground,var(--destructive,inherit))}
.md-mini{position:fixed;right:12px;bottom:30px;width:320px;max-width:calc(100vw - 16px);padding:4px;display:flex;flex-direction:column;gap:4px}
.md-mini-head{display:flex;align-items:center;gap:4px;cursor:grab;user-select:none;padding:0 2px 0 6px;font-size:11px;color:var(--muted-foreground,inherit)}
.md-mini-head .md-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.md-mini .md-frame{position:relative;width:100%;aspect-ratio:16/9;border-radius:var(--t3p-radius);overflow:hidden;background:var(--muted,color-mix(in srgb,currentColor 10%,transparent))}
.md-mini .md-frame iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
.md-mini .md-ico{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:1.5rem;height:1.5rem;padding:0;border:0;border-radius:calc(var(--radius,.5rem) - 4px);background:transparent;color:var(--muted-foreground,inherit);cursor:pointer}
.md-mini .md-ico:hover{background:var(--accent,color-mix(in srgb,currentColor 8%,transparent));color:var(--foreground,inherit)}
.md-mini .md-ico svg{width:1rem;height:1rem;fill:currentColor}
`;

const PATHS = {
  play: "M8 5v14l11-7z",
  pause: "M6 5h4v14H6zm8 0h4v14h-4z",
  prev: "M6 6h2v12H6zm3.5 6 8.5 6V6z",
  next: "M16 6h2v12h-2zM6 18l8.5-6L6 6z",
  close: "M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3l6.3 6.3 6.3-6.3z",
  popout: "M14 3h7v7h-2V6.4l-8.3 8.3-1.4-1.4L17.6 5H14zM5 5h6v2H7v10h10v-4h2v6H5z",
  dock: "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm1 11v5h6v-5z",
} as const;

function icon(name: keyof typeof PATHS): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", PATHS[name]);
  svg.append(path);
  return svg;
}

function iconButton(name: keyof typeof PATHS, label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "md-ico";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.append(icon(name));
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

interface Recent {
  key: string;
  url: string;
  title?: string;
}

/** The one YouTube player: inline in the popover or floating. */
interface Player {
  target: YouTubeTarget;
  where: "inline" | "floating";
  /** Seconds to resume from when the embed is rebuilt (pop-out, popover reopened). */
  startAt: number;
  playing: boolean;
  currentTime: number;
  autoplay: boolean;
}

const plugin: PluginModule = {
  start(t3: T3Api) {
    const disposers: Array<() => void> = [];
    const defs = t3.settings.define(settings);
    disposers.push(() => defs.dispose());

    const listeners = new Set<() => void>();
    const notify = (): void => {
      for (const fn of listeners) fn();
    };

    // ---- media session polling (demand driven: only while a view is open or the chip is on) ----
    const needs = { view: 0, chip: false };
    let poll: MediaPoll = { state: "idle" };
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let polling = false;
    let stopped = false;

    const retryMs = (): number => (poll.state === "unavailable" ? poll.retryInMs : 0);
    const interval = (): number | null => pollInterval({ view: needs.view > 0, chip: needs.chip }, retryMs());
    const doPoll = async (): Promise<void> => {
      if (polling || stopped) return;
      polling = true;
      try {
        if (!document.hidden) poll = parseMediaPoll(await t3.native.invoke("poll"));
      } catch (error) {
        poll = { state: "unavailable", retryInMs: 10_000 };
        t3.log("warn", `poll failed: ${String(error)}`);
      } finally {
        polling = false;
      }
      notify();
    };
    const reschedule = (): void => {
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      const ms = interval();
      if (ms === null || stopped) return;
      pollTimer = setTimeout(() => {
        void doPoll().finally(reschedule);
      }, ms);
    };
    const need = (kind: "view" | "chip", on: boolean): void => {
      const before = interval();
      if (kind === "view") needs.view += on ? 1 : -1;
      else needs.chip = on;
      if (on && before === null) void doPoll().finally(reschedule);
      else reschedule();
    };
    const command = async (name: "toggle" | "next" | "prev"): Promise<void> => {
      try {
        poll = parseMediaPoll(await t3.native.invoke("command", { name }));
      } catch (error) {
        t3.log("warn", `${name} failed: ${String(error)}`);
      }
      notify();
    };

    // ---- YouTube ----
    let player: Player | null = null;
    let recent: Recent[] = [];
    let lastError = "";
    const remember = (): boolean => t3.settings.get<boolean>("rememberLinks");
    void t3.storage.get<JsonValue>("recent").then((v) => {
      if (Array.isArray(v)) recent = (v as unknown as Recent[]).filter((r) => r && typeof r.url === "string" && parseYouTube(r.url)).slice(0, MAX_RECENT);
      notify();
    });
    const saveRecent = (): void => {
      void t3.storage.set("recent", recent as unknown as JsonValue).catch(() => undefined);
    };
    const addRecent = async (target: YouTubeTarget): Promise<void> => {
      if (!remember()) return;
      const key = targetKey(target);
      const url = watchUrl(target);
      const entry: Recent = { key, url, ...(recent.find((r) => r.key === key)?.title ? { title: recent.find((r) => r.key === key)!.title as string } : {}) };
      recent = [entry, ...recent.filter((r) => r.key !== key)].slice(0, MAX_RECENT);
      saveRecent();
      notify();
      if (entry.title) return;
      try {
        const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`, { credentials: "omit", referrerPolicy: "no-referrer" });
        const body = (await res.json()) as { title?: unknown };
        if (typeof body.title === "string" && body.title) {
          const hit = recent.find((r) => r.key === key);
          if (hit) {
            hit.title = body.title.slice(0, 200);
            saveRecent();
            notify();
          }
        }
      } catch {
        // title stays unknown
      }
    };
    const play = (input: string, where: "inline" | "floating"): boolean => {
      const target = parseYouTube(input);
      if (!target) {
        lastError = "Not a YouTube link (watch, youtu.be, shorts or playlist).";
        notify();
        return false;
      }
      lastError = "";
      player = { target, where, startAt: target.start ?? 0, playing: true, currentTime: target.start ?? 0, autoplay: true };
      void addRecent(target);
      notify();
      return true;
    };
    const closePlayer = (): void => {
      player = null;
      notify();
    };
    const popOut = (): void => {
      if (!player) return;
      player = { ...player, where: "floating", startAt: player.currentTime, autoplay: player.playing };
      notify();
    };
    const dockBack = (): void => {
      if (!player) return;
      player = { ...player, where: "inline", startAt: player.currentTime, autoplay: player.playing };
      notify();
    };

    /** Builds the iframe + postMessage control. Returns the controls and a dispose. */
    const mountEmbed = (host: HTMLElement, p: Player): { toggle(): void; dispose(): void } => {
      const frame = el("div", "md-frame");
      const iframe = document.createElement("iframe");
      iframe.src = embedUrl(p.target, { autoplay: p.autoplay, start: p.startAt });
      iframe.title = "YouTube player";
      iframe.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
      iframe.setAttribute("allowfullscreen", "");
      iframe.referrerPolicy = "strict-origin-when-cross-origin";
      iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation allow-popups");
      frame.append(iframe);
      host.append(frame);
      const send = (msg: string): void => iframe.contentWindow?.postMessage(msg, EMBED_ORIGIN);
      const onLoad = (): void => send(JSON.stringify({ event: "listening", id: "t3p", channel: "widget" }));
      iframe.addEventListener("load", onLoad);
      const onMessage = (e: MessageEvent): void => {
        if (e.origin !== EMBED_ORIGIN || e.source !== iframe.contentWindow) return;
        const update = parsePlayerMessage(e.data);
        if (!update || player !== p) return;
        if (update.playing !== undefined) p.playing = update.playing;
        if (update.currentTime !== undefined) p.currentTime = update.currentTime;
        notify();
      };
      window.addEventListener("message", onMessage);
      return {
        toggle: () => send(playerCommand(p.playing ? "pauseVideo" : "playVideo")),
        dispose: () => {
          window.removeEventListener("message", onMessage);
          iframe.removeEventListener("load", onLoad);
          frame.remove();
        },
      };
    };

    // ---- floating mini player (lives outside the popover, so it survives it closing) ----
    let mini: { root: HTMLElement; target: YouTubeTarget; startedAt: number; dispose(): void } | null = null;
    const syncMini = (): void => {
      const wantTarget = player && player.where === "floating" ? player : null;
      if (mini && (!wantTarget || mini.startedAt !== wantTarget.startAt || targetKey(mini.target) !== targetKey(wantTarget.target) || mini.root.dataset.autoplay !== String(wantTarget.autoplay))) {
        mini.dispose();
        mini = null;
      }
      if (!wantTarget || mini) return;
      const p = wantTarget;
      const root = el("div", "t3p-popover t3p-glass md-mini");
      root.dataset.t3pPlugin = "media";
      root.dataset.autoplay = String(p.autoplay);
      const head = el("div", "md-mini-head");
      const title = el("span", "md-title", recent.find((r) => r.key === targetKey(p.target))?.title ?? "YouTube");
      head.append(title, iconButton("dock", "Back to the details card", dockBack), iconButton("close", "Close player", closePlayer));
      root.append(head);
      const embed = mountEmbed(root, p);
      document.body.append(root);
      // Drag by the header.
      head.addEventListener("pointerdown", (e) => {
        if ((e.target as Element).closest("button")) return;
        e.preventDefault();
        head.setPointerCapture(e.pointerId);
        const rect = root.getBoundingClientRect();
        const dx = e.clientX - rect.left;
        const dy = e.clientY - rect.top;
        const move = (ev: PointerEvent): void => {
          const x = Math.min(Math.max(0, ev.clientX - dx), window.innerWidth - 60);
          const y = Math.min(Math.max(0, ev.clientY - dy), window.innerHeight - 40);
          root.style.left = `${x}px`;
          root.style.top = `${y}px`;
          root.style.right = "auto";
          root.style.bottom = "auto";
        };
        const up = (): void => {
          head.removeEventListener("pointermove", move);
          head.removeEventListener("pointerup", up);
        };
        head.addEventListener("pointermove", move);
        head.addEventListener("pointerup", up);
      });
      mini = {
        root,
        target: p.target,
        startedAt: p.startAt,
        dispose: () => {
          embed.dispose();
          root.remove();
        },
      };
    };
    listeners.add(syncMini);
    disposers.push(() => {
      listeners.delete(syncMini);
      mini?.dispose();
      mini = null;
    });

    // ---- the thread details section ----
    const section = t3.ui.register({
      slot: "threadDetails",
      id: "media",
      order: 100,
      render(host) {
        const style = el("style");
        style.textContent = STYLE;
        const root = el("div", "md-col");
        host.append(style, root);
        need("view", true);
        let embed: { toggle(): void; dispose(): void } | null = null;
        let embedFor: Player | null = null;
        const progressBar = el("span");
        const timeText = el("span", "t3p-meta");
        let tick: ReturnType<typeof setInterval> | null = null;

        const buildNow = (m: MediaState): HTMLElement => {
          const row = el("div", "t3p-td-row md-now");
          if (m.thumb) {
            const img = el("img", "t3p-td-thumb");
            img.src = m.thumb;
            img.alt = "";
            row.append(img);
          }
          const text = el("div", "md-text");
          text.append(el("span", "t3p-td-title", m.title || "Unknown title"), el("span", "md-artist", m.artist || m.album));
          const playing = m.status === "Playing";
          const ctl = el("div", "md-ctl");
          const prev = iconButton("prev", "Previous", () => void command("prev"));
          prev.disabled = !m.canPrev;
          const toggle = iconButton(playing ? "pause" : "play", playing ? "Pause" : "Play", () => void command("toggle"));
          toggle.disabled = !m.canToggle;
          const next = iconButton("next", "Next", () => void command("next"));
          next.disabled = !m.canNext;
          ctl.append(prev, toggle, next);
          row.append(text, ctl);
          return row;
        };
        const updateProgress = (): void => {
          if (poll.state !== "ok") return;
          const f = progressFraction(poll.media, Date.now());
          progressBar.style.width = f === null ? "0%" : `${(f * 100).toFixed(1)}%`;
          timeText.textContent = poll.media.durSec > 0 ? `${formatTime(currentPosition(poll.media, Date.now()))} / ${formatTime(poll.media.durSec)}` : "";
        };

        const buildYouTube = (): HTMLElement => {
          const wrap = el("div", "md-col");
          const row = el("div", "t3p-td-row md-yt");
          const input = el("input", "t3p-input");
          input.type = "text";
          input.placeholder = "Paste YouTube link";
          input.setAttribute("aria-label", "Paste YouTube link");
          input.autocomplete = "off";
          input.spellcheck = false;
          const go = (): void => {
            if (play(input.value, "inline")) input.value = "";
          };
          input.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter") go();
          });
          const btn = iconButton("play", "Play link", go);
          row.append(input, btn);
          wrap.append(row);
          if (lastError) wrap.append(el("div", "md-err", lastError));
          if (remember() && recent.length > 0 && !player) {
            const list = el("div", "md-col md-recent");
            list.append(el("span", "t3p-meta", "Recent"));
            for (const r of recent) {
              const b = el("button", "t3p-td-row", r.title ?? r.url.replace(/^https:\/\/www\./, ""));
              b.type = "button";
              b.style.minHeight = "1.5rem";
              b.style.fontSize = "12px";
              b.addEventListener("click", () => play(r.url, "inline"));
              list.append(b);
            }
            wrap.append(list);
          }
          return wrap;
        };

        const draw = (): void => {
          embed?.dispose();
          embed = null;
          embedFor = null;
          root.textContent = "";
          if (poll.state === "ok") {
            root.append(buildNow(poll.media));
            if (poll.media.durSec > 0) {
              const prog = el("div", "md-prog");
              const bar = el("div", "t3p-bar");
              progressBar.style.width = "0%";
              bar.append(progressBar);
              prog.append(bar, timeText);
              root.append(prog);
              updateProgress();
            }
          } else {
            const msg = poll.state === "unavailable" ? "Media session unavailable" : poll.state === "error" ? "Media session error" : "Nothing playing";
            root.append(el("div", "t3p-td-row md-now", msg));
          }
          root.append(buildYouTube());
          if (player) {
            const p = player;
            const card = el("div", "md-col");
            const head = el("div", "t3p-td-row md-now");
            const thumb = thumbUrl(p.target);
            if (thumb) {
              const img = el("img", "t3p-td-thumb");
              img.src = thumb;
              img.alt = "";
              img.referrerPolicy = "no-referrer";
              head.append(img);
            }
            const text = el("div", "md-text");
            text.append(el("span", "t3p-td-title", recent.find((r) => r.key === targetKey(p.target))?.title ?? (p.target.kind === "playlist" ? "YouTube playlist" : "YouTube video")), el("span", "md-artist", p.where === "floating" ? "Playing in the mini player" : "youtube-nocookie.com"));
            const ctl = el("div", "md-ctl");
            ctl.append(iconButton(p.where === "floating" ? "dock" : "popout", p.where === "floating" ? "Show here" : "Pop out", p.where === "floating" ? dockBack : popOut), iconButton("close", "Close player", closePlayer));
            head.append(text, ctl);
            card.append(head);
            root.append(card);
            if (p.where === "inline") {
              const holder = el("div", "md-col");
              holder.style.padding = "0 .625rem";
              card.append(holder);
              embed = mountEmbed(holder, p);
              embedFor = p;
            }
          }
        };

        // Redraw on state changes, but never while the user is typing in the link field or the iframe would reload.
        const redraw = (): void => {
          const active = root.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement;
          const needsEmbedChange = (player && player.where === "inline") !== (embedFor !== null) || (embedFor !== null && embedFor !== player);
          if (active && !needsEmbedChange && poll.state === "ok" && lastPollKey === pollKey()) {
            updateProgress();
            return;
          }
          if (!needsEmbedChange && lastPollKey === pollKey() && lastErr === lastError && lastRecent === recent.length && lastPlaying === Boolean(player?.playing)) {
            updateProgress();
            return;
          }
          lastPollKey = pollKey();
          lastErr = lastError;
          lastRecent = recent.length;
          lastPlaying = Boolean(player?.playing);
          draw();
        };
        let lastPollKey = "";
        let lastErr = "";
        let lastRecent = -1;
        let lastPlaying = false;
        const pollKey = (): string => (poll.state === "ok" ? `${poll.media.key}|${poll.media.status}|${poll.media.canPrev}|${poll.media.canNext}|${poll.media.thumb ? 1 : 0}` : poll.state);
        listeners.add(redraw);
        redraw();
        tick = setInterval(updateProgress, 500);
        return () => {
          if (tick) clearInterval(tick);
          listeners.delete(redraw);
          // Closing the card ends an inline player; remember where it was for next time.
          if (player && player.where === "inline") {
            player = { ...player, startAt: player.currentTime, autoplay: false, playing: false };
          }
          embed?.dispose();
          need("view", false);
        };
      },
    });
    disposers.push(() => section.dispose());

    // ---- optional status bar chip ----
    let chipReg: { dispose(): void } | null = null;
    const syncChip = (): void => {
      const on = t3.settings.get<boolean>("statusChip");
      if (on && !chipReg) {
        need("chip", true);
        chipReg = t3.ui.register({
          slot: "statusBar",
          id: "chip",
          order: 40,
          render(host) {
            const style = el("style");
            style.textContent = `[data-t3p-plugin="media"] .md-chip-t{max-width:220px;overflow:hidden;text-overflow:ellipsis}`;
            const chip = el("button", "t3p-chip");
            chip.type = "button";
            chip.setAttribute("data-compact", "");
            const label = el("span", "md-chip-t");
            chip.append(label);
            host.append(style, chip);
            const draw = (): void => {
              if (poll.state !== "ok") {
                chip.hidden = true;
                return;
              }
              chip.hidden = false;
              const playing = poll.media.status === "Playing";
              label.textContent = `${playing ? "▶" : "❚❚"} ${poll.media.title}`;
              chip.title = `${poll.media.title}${poll.media.artist ? ` - ${poll.media.artist}` : ""} (click to ${playing ? "pause" : "play"})`;
            };
            chip.addEventListener("click", () => void command("toggle"));
            listeners.add(draw);
            draw();
            return () => listeners.delete(draw);
          },
        });
      } else if (!on && chipReg) {
        chipReg.dispose();
        chipReg = null;
        need("chip", false);
      }
    };
    syncChip();
    const offSettings = t3.settings.onChange(() => syncChip());
    disposers.push(() => {
      offSettings();
      chipReg?.dispose();
    });

    // ---- command palette ----
    const cmd = t3.commands.register({
      id: "play-youtube",
      title: "Media: play YouTube link",
      description: "Opens a small player above the status bar",
      keywords: ["youtube", "video", "music", "media"],
      run: async () => {
        let value = "";
        const chosen = await t3.ui.modal({
          title: "Play YouTube link",
          buttons: ["Play", "Cancel"],
          body: (host) => {
            const input = el("input", "t3p-input");
            input.type = "text";
            input.placeholder = "https://youtu.be/...";
            input.style.width = "100%";
            input.autocomplete = "off";
            input.addEventListener("input", () => (value = input.value));
            input.addEventListener("keydown", (e) => e.stopPropagation());
            host.append(input);
            queueMicrotask(() => input.focus());
          },
        });
        if (chosen === 0 && !play(value, "floating")) t3.ui.toast({ message: "Not a YouTube link", kind: "warning" });
      },
    });
    disposers.push(() => cmd.dispose());

    return () => {
      stopped = true;
      if (pollTimer) clearTimeout(pollTimer);
      for (const d of disposers.reverse()) {
        try {
          d();
        } catch {
          // keep disposing
        }
      }
    };
  },
};

export default plugin;
