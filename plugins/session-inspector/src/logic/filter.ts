import type { TimelineKind, TimelineRecord } from "@t3p/api";

export type KindGroup = "messages" | "tools" | "approvals" | "errors" | "switches" | "subagents" | "runs" | "other";

export const GROUPS: ReadonlyArray<{ id: KindGroup; label: string }> = [
  { id: "messages", label: "Messages" },
  { id: "tools", label: "Tools / commands" },
  { id: "approvals", label: "Approvals" },
  { id: "errors", label: "Errors" },
  { id: "switches", label: "Provider / model" },
  { id: "subagents", label: "Subagents" },
  { id: "runs", label: "Runs" },
  { id: "other", label: "Other" },
];

const GROUP_OF: Record<TimelineKind, KindGroup> = {
  "message.user": "messages",
  "message.assistant": "messages",
  reasoning: "messages",
  plan: "messages",
  command: "tools",
  "file-change": "tools",
  search: "tools",
  tool: "tools",
  "approval.request": "approvals",
  "approval.resolved": "approvals",
  "input.request": "approvals",
  "input.resolved": "approvals",
  "secret-request": "approvals",
  "link-request": "approvals",
  "interrupt.request": "approvals",
  "interrupt.result": "approvals",
  error: "errors",
  notice: "errors",
  unknown: "errors",
  "provider-switch": "switches",
  "model-switch": "switches",
  handoff: "switches",
  "subagent.start": "subagents",
  "subagent.end": "subagents",
  "thread.spawn": "subagents",
  "run.start": "runs",
  "run.end": "runs",
  checkpoint: "other",
  notification: "other",
  compaction: "other",
  fork: "other",
  "thread.lifecycle": "other",
};

export function groupOf(kind: TimelineKind): KindGroup {
  return GROUP_OF[kind] ?? "other";
}

/** Short icon text and label per kind (plain text, no icon font needed). */
export const KIND_LABEL: Record<TimelineKind, { icon: string; label: string }> = {
  "message.user": { icon: "U", label: "You" },
  "message.assistant": { icon: "A", label: "Assistant" },
  reasoning: { icon: "~", label: "Reasoning" },
  plan: { icon: "=", label: "Plan" },
  command: { icon: "$", label: "Command" },
  "file-change": { icon: "±", label: "File change" },
  search: { icon: "/", label: "Search" },
  tool: { icon: "*", label: "Tool" },
  "approval.request": { icon: "?", label: "Approval request" },
  "approval.resolved": { icon: "✓", label: "Approval resolved" },
  "input.request": { icon: "?", label: "Input request" },
  "input.resolved": { icon: "✓", label: "Input resolved" },
  "secret-request": { icon: "#", label: "Secret request" },
  "link-request": { icon: ">", label: "Link request" },
  checkpoint: { icon: "◆", label: "Checkpoint" },
  "interrupt.request": { icon: "■", label: "Interrupt request" },
  "interrupt.result": { icon: "■", label: "Interrupt result" },
  notice: { icon: "!", label: "Notice" },
  notification: { icon: "•", label: "Notification" },
  error: { icon: "✕", label: "Error" },
  compaction: { icon: "«", label: "Compaction" },
  handoff: { icon: "⇄", label: "Handoff" },
  fork: { icon: "⑂", label: "Fork" },
  "thread.spawn": { icon: "+", label: "Thread spawned" },
  "thread.lifecycle": { icon: "○", label: "Thread" },
  "provider-switch": { icon: "⇄", label: "Provider switch" },
  "model-switch": { icon: "⇄", label: "Model switch" },
  "subagent.start": { icon: "▶", label: "Subagent start" },
  "subagent.end": { icon: "◼", label: "Subagent end" },
  "run.start": { icon: "▶", label: "Run start" },
  "run.end": { icon: "◼", label: "Run end" },
  unknown: { icon: "?", label: "Unknown" },
};

export interface RecordFilter {
  /** Groups that are shown. */
  groups: ReadonlySet<KindGroup>;
  /** Case-insensitive substring over summary, kind, provider and status. Empty = no text filter. */
  text: string;
}

export function allGroups(): Set<KindGroup> {
  return new Set(GROUPS.map((g) => g.id));
}

export function defaultFilter(): RecordFilter {
  return { groups: allGroups(), text: "" };
}

export function isUnfiltered(f: RecordFilter): boolean {
  return f.text.trim() === "" && f.groups.size === GROUPS.length;
}

export function matchesFilter(r: TimelineRecord, f: RecordFilter): boolean {
  if (!f.groups.has(groupOf(r.kind))) return false;
  const q = f.text.trim().toLowerCase();
  if (q === "") return true;
  return (
    r.summary.toLowerCase().includes(q) ||
    r.kind.toLowerCase().includes(q) ||
    r.provider.toLowerCase().includes(q) ||
    (r.status ?? "").toLowerCase().includes(q)
  );
}

export function filterRecords(records: readonly TimelineRecord[], f: RecordFilter): TimelineRecord[] {
  return isUnfiltered(f) ? records.slice() : records.filter((r) => matchesFilter(r, f));
}
