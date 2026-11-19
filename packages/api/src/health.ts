import { isValidPluginId } from "./manifest.js";

/**
 * Crash-loop guard counters, kept in <home>/.t3-patcher/health.json (main process owns it).
 *
 * ```json
 * { "version": 1, "plugins": { "my-plugin": { "failures": 2, "lastError": "start() threw", "updated": "..." } } }
 * ```
 *
 * A start that fails (start() throws or rejects, the main entry fails to activate, or an uncaught error
 * attributed to the plugin arrives inside the health window) adds 1. A clean window resets to 0.
 * At `threshold` consecutive failures the host disables the plugin (reason `crash-loop`).
 */
export const HEALTH_FILE = "health.json";
export const CRASH_LOOP_REASON = "crash-loop";
export const DEFAULT_CRASH_THRESHOLD = 3;
/** A start counts as healthy after this long without an attributed error. */
export const HEALTH_WINDOW_MS = 10_000;

export interface PluginHealth {
  failures: number;
  lastError?: string;
  updated?: string;
}

export interface HealthJson {
  version: 1;
  plugins: Record<string, PluginHealth>;
}

export function emptyHealth(): HealthJson {
  return { version: 1, plugins: {} };
}

/** Tolerant parse: anything malformed is dropped (a broken counter file never blocks startup). */
export function parseHealth(raw: unknown): HealthJson {
  const out = emptyHealth();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const plugins = (raw as Record<string, unknown>).plugins;
  if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) return out;
  for (const [id, value] of Object.entries(plugins as Record<string, unknown>)) {
    if (!isValidPluginId(id) || !value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const failures = typeof v.failures === "number" && Number.isInteger(v.failures) && v.failures > 0 ? Math.min(v.failures, 1000) : 0;
    if (failures === 0) continue;
    const entry: PluginHealth = { failures };
    if (typeof v.lastError === "string") entry.lastError = v.lastError.slice(0, 500);
    if (typeof v.updated === "string") entry.updated = v.updated.slice(0, 40);
    out.plugins[id] = entry;
  }
  return out;
}

/** Threshold from `T3P_CRASH_LOOP_THRESHOLD` (integer >= 1), else 3. */
export function crashThreshold(env: Record<string, string | undefined> = {}): number {
  const n = Number(env.T3P_CRASH_LOOP_THRESHOLD);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_CRASH_THRESHOLD;
}

export interface HealthOutcome {
  failures: number;
  /** The counter reached the threshold with this report. */
  tripped: boolean;
}

/** Applies one start outcome to `health` (mutates it). */
export function recordOutcome(health: HealthJson, id: string, ok: boolean, threshold: number, error?: string, now: () => Date = () => new Date()): HealthOutcome {
  if (ok) {
    delete health.plugins[id];
    return { failures: 0, tripped: false };
  }
  const failures = (health.plugins[id]?.failures ?? 0) + 1;
  const entry: PluginHealth = { failures, updated: now().toISOString() };
  if (error) entry.lastError = error.slice(0, 500);
  health.plugins[id] = entry;
  return { failures, tripped: failures >= threshold };
}

/** Clears a plugin's counter (`t3p enable`). */
export function clearHealth(health: HealthJson, id: string): HealthJson {
  delete health.plugins[id];
  return health;
}
