/** Pure helpers for the RPC console: payloads, the risky-method guard, timing and the capped live log. */

export const MAX_RPC_LOG = 500;

/** The unary and stream methods typed in `@t3p/rpc-client` (values, so the console can suggest them). */
export const RPC_METHOD_SUGGESTIONS: readonly string[] = [
  "orchestration.dispatchCommand",
  "orchestration.getArchivedShellSnapshot",
  "orchestration.getOlderSettledThreads",
  "orchestration.getThreadFamily",
  "orchestration.getThreadProjection",
  "orchestration.getThreadTitles",
  "orchestration.searchThreads",
  "orchestration.subscribeShell",
  "orchestration.subscribeThread",
  "projects.ensureScratch",
  "server.getConfig",
  "server.refreshProviders",
  "subscribeServerConfig",
];

/** Method names that need a confirm click: they can change or expose the user's environment. */
export const RISKY_METHOD_PARTS: readonly string[] = ["dispatch", "delete", "remove", "terminal", "auth"];

/** True when the method name contains a risky part (case-insensitive). */
export function isDangerousMethod(method: string): boolean {
  const lower = method.toLowerCase();
  return RISKY_METHOD_PARTS.some((part) => lower.includes(part));
}

/** JSON payload for the editor. Empty text means `{}`; anything but a JSON object is rejected. */
export function parsePayload(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return { ok: false, error: `payload is not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "payload must be a JSON object" };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/** `12 ms`, `1.24 s`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** Pretty JSON with a hard size cap, so one huge frame cannot freeze the panel. */
export function summarizeJson(value: unknown, maxChars = 4000): string {
  let text: string;
  if (value === undefined) text = "undefined";
  else {
    try {
      text = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... [${text.length - maxChars} more chars]`;
}

/** One line for an RPC failure, including the structural error fields Gate 3 froze (`code`, `kind`, `tag`). */
export function formatRpcError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const message = typeof record.message === "string" ? record.message : null;
    const kind = typeof record.kind === "string" ? record.kind : null;
    const tag = typeof record.tag === "string" ? record.tag : null;
    const code = typeof record.code === "string" ? record.code : null;
    if (message || kind || tag || code) {
      return [message ?? "RPC failed", kind && `(${kind})`, tag && `[${tag}]`, code && `code=${code}`].filter(Boolean).join(" ");
    }
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Appends and trims to the newest `cap` items. */
export function appendCapped<T>(items: readonly T[], item: T, cap = MAX_RPC_LOG): T[] {
  if (cap <= 0) return [];
  const next = items.length >= cap ? items.slice(items.length - cap + 1) : [...items];
  next.push(item);
  return next;
}
