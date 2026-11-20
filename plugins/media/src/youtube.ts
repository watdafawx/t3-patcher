/** A parsed YouTube target. Only ids that match the strict patterns below ever reach an iframe URL. */
export interface YouTubeTarget {
  kind: "video" | "playlist";
  /** 11-character video id. Absent for a playlist without a video. */
  id?: string;
  /** Playlist id. */
  list?: string;
  /** Start offset in whole seconds. */
  start?: number;
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const LIST_ID = /^[A-Za-z0-9_-]{10,64}$/;
const HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com", "youtu.be", "www.youtu.be"]);
const MAX_INPUT = 300;
const MAX_START = 24 * 3600;

/** `90`, `1m30s`, `1h2m3s` to seconds; `undefined` when it is not a plain duration. */
export function parseStart(raw: string | null): number | undefined {
  if (!raw) return undefined;
  if (/^\d{1,6}$/.test(raw)) return clampStart(Number(raw));
  const m = /^(?:(\d{1,3})h)?(?:(\d{1,4})m)?(?:(\d{1,6})s)?$/.exec(raw);
  if (!m || (!m[1] && !m[2] && !m[3])) return undefined;
  return clampStart(Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0));
}

function clampStart(n: number): number | undefined {
  return Number.isFinite(n) && n > 0 && n <= MAX_START ? Math.floor(n) : undefined;
}

/**
 * Parses what a user pastes: youtu.be/<id>, youtube.com/watch?v=<id>, /shorts/<id>, /embed/<id>, /live/<id>,
 * /playlist?list=<id>, music.youtube.com and the nocookie host. https only (a missing scheme is accepted),
 * no credentials, no port, ids checked against strict patterns. Returns `null` for anything else.
 */
export function parseYouTube(input: string): YouTubeTarget | null {
  if (typeof input !== "string") return null;
  const text = input.trim();
  if (text.length === 0 || text.length > MAX_INPUT || /[\s\p{Cc}]/u.test(text)) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (!HOSTS.has(host)) return null;
  const list = url.searchParams.get("list");
  const listId = list && LIST_ID.test(list) ? list : undefined;
  const start = parseStart(url.searchParams.get("t") ?? url.searchParams.get("start"));
  const parts = url.pathname.split("/").filter(Boolean);
  let id: string | undefined;
  if (host.endsWith("youtu.be")) {
    if (parts.length !== 1) return null;
    id = parts[0];
  } else if (parts[0] === "watch" && parts.length === 1) {
    id = url.searchParams.get("v") ?? undefined;
  } else if (parts.length === 2 && ["shorts", "embed", "live", "v"].includes(parts[0] as string)) {
    id = parts[1];
  } else if (parts[0] === "playlist" && parts.length === 1) {
    return listId ? { kind: "playlist", list: listId } : null;
  } else {
    return null;
  }
  if (id === undefined) return null;
  if (id === "videoseries" && listId) return { kind: "playlist", list: listId };
  if (!VIDEO_ID.test(id)) return null;
  return { kind: "video", id, ...(listId ? { list: listId } : {}), ...(start ? { start } : {}) };
}

/** Stable key for a target (de-duplicating the recent list). */
export function targetKey(t: YouTubeTarget): string {
  return t.kind === "playlist" ? `list:${t.list}` : `v:${t.id}`;
}

/** The privacy-enhanced embed URL. `origin` is only added when it is an http(s) origin. */
export function embedUrl(t: YouTubeTarget, opts: { autoplay?: boolean; start?: number; origin?: string } = {}): string {
  const base = t.kind === "playlist" || !t.id ? "https://www.youtube-nocookie.com/embed/videoseries" : `https://www.youtube-nocookie.com/embed/${t.id}`;
  const q = new URLSearchParams({ enablejsapi: "1", rel: "0", playsinline: "1", modestbranding: "1" });
  if (t.list) q.set("list", t.list);
  const start = opts.start ?? t.start;
  if (start && start > 0) q.set("start", String(Math.floor(start)));
  if (opts.autoplay) q.set("autoplay", "1");
  if (opts.origin && /^https?:\/\/[^\s/]+$/.test(opts.origin)) q.set("origin", opts.origin);
  return `${base}?${q.toString()}`;
}

/** Thumbnail of a video (i.ytimg.com); `null` for a playlist-only target. */
export function thumbUrl(t: YouTubeTarget): string | null {
  return t.id && VIDEO_ID.test(t.id) ? `https://i.ytimg.com/vi/${t.id}/mqdefault.jpg` : null;
}

/** Canonical watch URL, used for the oEmbed request. */
export function watchUrl(t: YouTubeTarget): string {
  if (t.kind === "playlist" || !t.id) return `https://www.youtube.com/playlist?list=${t.list ?? ""}`;
  return `https://www.youtube.com/watch?v=${t.id}`;
}

/** Command message for the embed's postMessage channel (the iframe API script is blocked by T3's script-src). */
export function playerCommand(func: "playVideo" | "pauseVideo" | "stopVideo" | "setVolume" | "mute" | "unMute", args: unknown = ""): string {
  return JSON.stringify({ event: "command", func, args: func === "setVolume" ? [args] : args });
}

/** Messages from the embed: `{event:"onStateChange",info:1}` (1 playing, 2 paused) and `infoDelivery` with `currentTime`. */
export interface PlayerUpdate {
  playing?: boolean;
  currentTime?: number;
  /** 0..100, as reported by the embed. */
  volume?: number;
  muted?: boolean;
}

export function parsePlayerMessage(data: unknown): PlayerUpdate | null {
  let msg: unknown = data;
  if (typeof data === "string") {
    if (data.length > 20_000) return null;
    try {
      msg = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (!msg || typeof msg !== "object") return null;
  const m = msg as { event?: unknown; info?: unknown };
  const out: PlayerUpdate = {};
  if (m.event === "onStateChange" && typeof m.info === "number") out.playing = m.info === 1;
  if (m.event === "infoDelivery" && m.info && typeof m.info === "object") {
    const info = m.info as { playerState?: unknown; currentTime?: unknown; volume?: unknown; muted?: unknown };
    if (typeof info.playerState === "number") out.playing = info.playerState === 1;
    if (typeof info.currentTime === "number" && Number.isFinite(info.currentTime) && info.currentTime >= 0) out.currentTime = info.currentTime;
    if (typeof info.volume === "number" && Number.isFinite(info.volume) && info.volume >= 0 && info.volume <= 100) out.volume = Math.round(info.volume);
    if (typeof info.muted === "boolean") out.muted = info.muted;
  }
  return "playing" in out || "currentTime" in out || "volume" in out || "muted" in out ? out : null;
}
