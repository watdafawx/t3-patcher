import type { TimelineRecord } from "@t3p/api";
import { isTerminalStatus } from "./durations.js";

export type ActivityState = "empty" | "idle" | "approval" | "input" | "running" | "streaming" | "run";

export interface Activity {
  state: ActivityState;
  /** One line, e.g. `Running: $ pnpm test`. */
  text: string;
  /** The record the line is about, when there is one. */
  recordId: string | null;
  /** Epoch ms the activity began (or the last event, for `idle`). */
  since: number | null;
}

const WORKING_KINDS = new Set(["command", "file-change", "search", "tool", "reasoning", "plan"]);

function isTrue(raw: unknown, key: string): boolean {
  return raw !== null && typeof raw === "object" && (raw as Record<string, unknown>)[key] === true;
}

/**
 * What the thread is doing right now, from its records (ordered by time).
 * Priority: waiting for the user (approval, input), a running tool, a streaming message, an open
 * run, else idle. "Open" = no `ends`/`resolves` record points at it and its status is not terminal.
 * Tool and streaming activity only count while a run is open (stale rows of a finished run are ignored).
 */
export function deriveActivity(records: readonly TimelineRecord[]): Activity {
  if (records.length === 0) return { state: "empty", text: "No activity yet", recordId: null, since: null };

  const closed = new Set<string>();
  for (const r of records) {
    if (r.cause && (r.cause.relation === "ends" || r.cause.relation === "resolves")) closed.add(r.cause.recordId);
  }

  let approval: TimelineRecord | null = null;
  let input: TimelineRecord | null = null;
  let working: TimelineRecord | null = null;
  let streaming: TimelineRecord | null = null;
  let run: TimelineRecord | null = null;

  for (const r of records) {
    switch (r.kind) {
      case "approval.request":
        if (!closed.has(r.id)) approval = r;
        break;
      case "input.request":
        if (!closed.has(r.id)) input = r;
        break;
      case "run.start":
        if (!closed.has(r.id) && !isTerminalStatus(r.status)) run = r;
        break;
      case "message.assistant":
        if (isTrue(r.raw, "streaming") || (r.status !== null && !isTerminalStatus(r.status))) streaming = r;
        break;
      default:
        if (WORKING_KINDS.has(r.kind) && r.status !== null && !isTerminalStatus(r.status)) working = r;
    }
  }

  if (approval) return { state: "approval", text: `Waiting for approval: ${approval.summary}`, recordId: approval.id, since: approval.at };
  if (input) return { state: "input", text: `Waiting for input: ${input.summary}`, recordId: input.id, since: input.at };
  if (run && working) return { state: "running", text: `Running: ${working.summary}`, recordId: working.id, since: working.at };
  if (run && streaming) return { state: "streaming", text: "Streaming a reply", recordId: streaming.id, since: streaming.at };
  if (run) return { state: "run", text: "Run in progress", recordId: run.id, since: run.at };
  const last = records[records.length - 1]!;
  return { state: "idle", text: "Idle", recordId: last.id, since: last.at };
}
