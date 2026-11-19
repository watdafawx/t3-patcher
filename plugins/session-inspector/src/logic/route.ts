export interface ThreadRoute {
  environmentId: string;
  threadId: string;
}

/** Same first segments the runtime reads as non-thread routes (wp-3b-notes: RESERVED_FIRST_SEGMENTS). */
const RESERVED = new Set(["settings", "draft", "welcome", "connect", "pair", "projects", "threads"]);

/** `#/<environmentId>/<threadId>` -> parts, or null for any other route. */
export function parseThreadHash(hash: string): ThreadRoute | null {
  if (!hash.startsWith("#/")) return null;
  const path = hash.slice(1).split("?")[0]!.replace(/\/+$/, "");
  const parts = path.split("/").filter((p) => p !== "");
  if (parts.length !== 2) return null;
  try {
    const [environmentId, threadId] = parts.map((p) => decodeURIComponent(p)) as [string, string];
    if (RESERVED.has(environmentId)) return null;
    return { environmentId, threadId };
  } catch {
    return null;
  }
}

export function buildThreadHash(environmentId: string, threadId: string): string {
  return `#/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
}

/** Environment id of a thread row, when the shell entry carries one (`raw.environmentId`). */
export function envFromRaw(raw: unknown): string | null {
  if (raw !== null && typeof raw === "object") {
    const v = (raw as Record<string, unknown>).environmentId;
    if (typeof v === "string" && v !== "") return v;
  }
  return null;
}
