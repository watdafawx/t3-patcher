/** What the main helper returns for one poll, after validation. */
export interface MediaState {
  title: string;
  artist: string;
  album: string;
  status: "Playing" | "Paused" | "Stopped" | "Other";
  posSec: number;
  durSec: number;
  /** Epoch ms of the helper's last timeline update (for extrapolating the position while playing). */
  updated: number;
  canPrev: boolean;
  canNext: boolean;
  canToggle: boolean;
  /** Small `data:image/jpeg` URL, or `null`. */
  thumb: string | null;
  key: string;
}

export type MediaPoll = { state: "ok"; media: MediaState } | { state: "idle" } | { state: "unavailable"; retryInMs: number } | { state: "error"; error: string };

const MAX_TEXT = 300;
const MAX_THUMB = 64 * 1024;

const text = (v: unknown): string => (typeof v === "string" ? v.replace(/\p{Cc}/gu, " ").trim().slice(0, MAX_TEXT) : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e9 ? v : 0);

/** Validates the payload of `invoke("poll")`. Anything unexpected becomes `unavailable`, never a throw. */
export function parseMediaPoll(raw: unknown): MediaPoll {
  if (!raw || typeof raw !== "object") return { state: "unavailable", retryInMs: 5000 };
  const r = raw as Record<string, unknown>;
  if (r.state === "idle") return { state: "idle" };
  if (r.state === "unavailable") return { state: "unavailable", retryInMs: num(r.retryInMs) };
  if (r.state === "error") return { state: "error", error: text(r.error) || "error" };
  if (r.state !== "ok" || !r.media || typeof r.media !== "object") return { state: "unavailable", retryInMs: 5000 };
  const m = r.media as Record<string, unknown>;
  const title = text(m.title);
  const artist = text(m.artist);
  if (!title && !artist) return { state: "idle" };
  const status = m.status === "Playing" || m.status === "Paused" || m.status === "Stopped" ? m.status : "Other";
  const thumb = typeof m.thumb === "string" && /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(m.thumb) && m.thumb.length <= MAX_THUMB ? m.thumb : null;
  return {
    state: "ok",
    media: {
      title,
      artist,
      album: text(m.album),
      status,
      posSec: num(m.posSec),
      durSec: num(m.durSec),
      updated: num(m.updated),
      canPrev: m.canPrev === true,
      canNext: m.canNext === true,
      canToggle: m.canToggle !== false,
      thumb,
      key: text(m.key),
    },
  };
}

/** Current position in seconds, extrapolated while playing and clamped to the duration. */
export function currentPosition(m: Pick<MediaState, "status" | "posSec" | "durSec" | "updated">, nowMs: number): number {
  let pos = m.posSec;
  if (m.status === "Playing" && m.updated > 0) pos += Math.max(0, (nowMs - m.updated) / 1000);
  if (m.durSec > 0) pos = Math.min(pos, m.durSec);
  return Math.max(0, pos);
}

/** 0..1, or `null` when the duration is unknown (live streams, apps without a timeline). */
export function progressFraction(m: Pick<MediaState, "status" | "posSec" | "durSec" | "updated">, nowMs: number): number | null {
  if (!(m.durSec > 0)) return null;
  return Math.min(1, Math.max(0, currentPosition(m, nowMs) / m.durSec));
}

/** `3:07`, `1:02:03`. */
export function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}

/** Poll interval: fast while a view is open, slow for the chip alone, none otherwise. */
export function pollInterval(needs: { view: boolean; chip: boolean }, unavailableMs = 0): number | null {
  if (!needs.view && !needs.chip) return null;
  const base = needs.view ? 1000 : 5000;
  return Math.max(base, unavailableMs);
}
