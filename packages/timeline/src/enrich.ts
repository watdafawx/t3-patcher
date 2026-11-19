import type { ProviderFrame, TimelineRecord } from "./types.js";
import { isObj, str, toMs } from "./util.js";

/**
 * Optional enrichment (caller supplies the text of `events.<threadId>.log`; reading the file is
 * `t3.native`'s job). Line format written by the server (`EventNdjsonLogger`):
 *
 *   [2026-11-18T21:36:03.356Z] NTIVE: {...json...}      (also CANON: and ORCH:)
 *
 * Everything is parsed defensively: bad lines are skipped, nothing throws, and a record only gets
 * `enrichment` when a native id of the record appears as an id-like value inside a logged frame.
 */

const HEADER = /^\[([^\]\r\n]+)\] (NTIVE|CANON|ORCH): (.*)$/;
const ID_KEYS = new Set([
  "id", "itemId", "item_id", "toolUseId", "tool_use_id", "callId", "call_id", "turnId", "turn_id",
  "requestId", "request_id", "nativeId", "rawEventId", "uuid", "parent_tool_use_id", "taskId", "task_id",
]);
const MIN_ID_LENGTH = 6;
const MAX_LINE_CHARS = 1_000_000;
const MAX_DEPTH = 8;
const MAX_FRAMES_PER_RECORD = 50;

const STREAMS: Record<string, ProviderFrame["stream"]> = { NTIVE: "native", CANON: "canonical", ORCH: "orchestration" };

interface ParsedLine {
  frame: ProviderFrame;
  ids: Set<string>;
}

function collectIds(v: unknown, out: Set<string>, depth: number, key: string | null): void {
  if (depth > MAX_DEPTH) return;
  if (typeof v === "string") {
    if (key !== null && ID_KEYS.has(key) && v.length >= MIN_ID_LENGTH) out.add(v);
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v.slice(0, 200)) collectIds(x, out, depth + 1, key);
    return;
  }
  if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) collectIds(x, out, depth + 1, k);
  }
}

function parseLine(line: string): ParsedLine | null {
  if (line.length === 0 || line.length > MAX_LINE_CHARS) return null;
  let at: number | null = null;
  let stream: ProviderFrame["stream"] = "unknown";
  let body = line;
  const m = HEADER.exec(line);
  if (m) {
    at = toMs(m[1]);
    stream = STREAMS[m[2] ?? ""] ?? "unknown";
    body = m[3] ?? "";
  }
  let frame: unknown;
  try {
    frame = JSON.parse(body);
  } catch {
    return null;
  }
  const ids = new Set<string>();
  collectIds(frame, ids, 0, null);
  return { frame: { at, stream, frame }, ids };
}

/** Native ids a record can be matched by (all read from the untouched `raw`). */
function nativeIdsOf(raw: unknown): string[] {
  if (!isObj(raw)) return [];
  const out: string[] = [];
  for (const key of ["nativeItemRef", "nativeRequestRef", "nativeTaskRef", "nativeTurnRef"]) {
    const ref = raw[key];
    if (isObj(ref)) {
      const id = str(ref.nativeId);
      if (id) out.push(id);
    }
  }
  const rawEventId = str(raw.rawEventId);
  if (rawEventId) out.push(rawEventId);
  return out.filter((x) => x.length >= MIN_ID_LENGTH);
}

/**
 * Returns a new array; records without a match are returned as the same object. Records with a match
 * are copied with `enrichment: { matchedBy, frames }` (frames in log order, capped). Pure and idempotent
 * (enriching twice with the same text gives the same result).
 */
export function enrichFromProviderLog(records: readonly TimelineRecord[], logText: string): TimelineRecord[] {
  if (typeof logText !== "string" || logText.length === 0) return [...records];
  const byId = new Map<string, ParsedLine[]>();
  for (const line of logText.split(/\r?\n/)) {
    let parsed: ParsedLine | null = null;
    try {
      parsed = parseLine(line);
    } catch {
      parsed = null;
    }
    if (!parsed) continue;
    for (const id of parsed.ids) {
      const list = byId.get(id);
      if (list) list.push(parsed);
      else byId.set(id, [parsed]);
    }
  }
  if (byId.size === 0) return [...records];

  return records.map((rec) => {
    const matchedBy: string[] = [];
    const frames: ProviderFrame[] = [];
    const seen = new Set<ParsedLine>();
    for (const id of nativeIdsOf(rec.raw)) {
      const hits = byId.get(id);
      if (!hits) continue;
      matchedBy.push(id);
      for (const h of hits) {
        if (seen.has(h) || frames.length >= MAX_FRAMES_PER_RECORD) continue;
        seen.add(h);
        frames.push(h.frame);
      }
    }
    if (frames.length === 0) return rec;
    return { ...rec, enrichment: { matchedBy, frames } };
  });
}
