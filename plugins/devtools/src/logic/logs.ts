/**
 * Plugin log access. The renderer gets no log event: `t3.events` only carries
 * lifecycle events, and `t3.log` writes to the main log file. The only public
 * read path is `t3.native.logTail`, so this plugin declares `log.tail` scoped to
 * `~/.t3-patcher/logs` (main.log), the smallest root that holds plugin lines.
 *
 * Lines look like `<ISO> LEVEL [tag] message`; plugin lines are tagged
 * `renderer:<id>` (t3.log) or `plugin:<id>` (a main entry's logger).
 */

export const LOG_PATH = "~/.t3-patcher/logs/main.log";
export const LOG_LIMIT = 500;
/** A line still arriving when a tail chunk ended; kept for the next chunk. */
export const MAX_CARRY = 64_000;

export type LogLevel = "debug" | "info" | "warn" | "error" | "other";

export interface LogLine {
  at: string;
  level: LogLevel;
  tag: string;
  message: string;
}

export interface PluginLogEntry extends LogLine {
  /** Plugin id taken from the tag. */
  plugin: string;
}

const LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) ([A-Z]+)\s+(?:\[([^\]]*)\] )?(.*)$/;

/** Parses one main.log line; continuation lines and anything else return null. */
export function parseLogLine(line: string): LogLine | null {
  const match = LINE.exec(line);
  if (!match) return null;
  const level = match[2]!.toLowerCase();
  return {
    at: match[1]!,
    level: level === "debug" || level === "info" || level === "warn" || level === "error" ? level : "other",
    tag: match[3] ?? "",
    message: match[4] ?? "",
  };
}

/** Plugin id of a log tag, or null for core lines. */
export function pluginOf(tag: string): string | null {
  if (tag.startsWith("renderer:")) {
    const id = tag.slice("renderer:".length);
    return id.length > 0 ? id : null;
  }
  if (tag.startsWith("plugin:")) {
    const id = tag.slice("plugin:".length);
    return id.length > 0 ? id : null;
  }
  return null;
}

/** Parses lines and keeps the plugin ones. */
export function toPluginEntries(lines: readonly string[]): PluginLogEntry[] {
  const out: PluginLogEntry[] = [];
  for (const line of lines) {
    const parsed = parseLogLine(line);
    if (!parsed) continue;
    const plugin = pluginOf(parsed.tag);
    if (!plugin) continue;
    out.push({ ...parsed, plugin });
  }
  return out;
}

/** `null` means "all plugins". */
export function filterEntries(entries: readonly PluginLogEntry[], plugin: string | null): PluginLogEntry[] {
  return plugin === null ? [...entries] : entries.filter((entry) => entry.plugin === plugin);
}

/** Splits a tail chunk into complete lines and the partial line to carry over. */
export function splitTail(carry: string, data: string): { lines: string[]; carry: string } {
  const combined = carry + data;
  if (combined.length === 0) return { lines: [], carry: "" };
  const parts = combined.split("\n");
  const partial = parts.pop() ?? "";
  return { lines: parts, carry: partial.length > MAX_CARRY ? partial.slice(-MAX_CARRY) : partial };
}

/** The newest `max` entries. */
export function capEntries<T>(entries: readonly T[], max = LOG_LIMIT): T[] {
  return entries.length <= max ? [...entries] : entries.slice(entries.length - max);
}
