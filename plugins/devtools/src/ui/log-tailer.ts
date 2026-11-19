import type { Unsubscribe } from "@t3p/api";

import { capEntries, LOG_PATH, splitTail, toPluginEntries, type PluginLogEntry } from "../logic/logs.js";

export interface LogTailApi {
  native: {
    logTail(request: { path: string; cursor?: number; maxBytes?: number }): Promise<{
      path: string;
      data: string;
      cursor: number;
      size: number;
      reset: boolean;
      truncated: boolean;
    }>;
  };
}

export interface TailState {
  entries: readonly PluginLogEntry[];
  cursor: number | null;
  size: number | null;
  error: string | null;
  reading: boolean;
  /** Number of times the file shrank (rotation) and the buffer restarted. */
  resets: number;
}

export interface LogTailerOptions {
  /** Poll interval while started. Default 2000 ms. */
  pollMs?: number;
  path?: string;
  /** Safety cap on reads per poll when the file has more data than one call returns. */
  maxReadsPerPoll?: number;
}

/**
 * Incremental tail of `main.log`, reduced to plugin-tagged lines. One instance
 * per plugin: it holds the cursor and the buffer, so the Logs tab and the
 * "refresh logs" command see the same data.
 */
export class LogTailer {
  #entries: PluginLogEntry[] = [];
  #cursor: number | null = null;
  #size: number | null = null;
  #carry = "";
  #error: string | null = null;
  #reading = false;
  #resets = 0;
  #timer: ReturnType<typeof setInterval> | null = null;
  #listeners = new Set<() => void>();
  readonly #path: string;

  constructor(
    private readonly api: LogTailApi,
    private readonly options: LogTailerOptions = {},
  ) {
    this.#path = options.path ?? LOG_PATH;
  }

  get path(): string {
    return this.#path;
  }

  get entries(): readonly PluginLogEntry[] {
    return this.#entries;
  }

  get state(): TailState {
    return {
      entries: this.#entries,
      cursor: this.#cursor,
      size: this.#size,
      error: this.#error,
      reading: this.#reading,
      resets: this.#resets,
    };
  }

  /** Plugin ids seen so far, sorted. */
  pluginIds(): string[] {
    return [...new Set(this.#entries.map((entry) => entry.plugin))].sort();
  }

  onUpdate(callback: () => void): Unsubscribe {
    this.#listeners.add(callback);
    return () => void this.#listeners.delete(callback);
  }

  start(): void {
    if (this.#timer !== null) return;
    void this.poll();
    this.#timer = setInterval(() => void this.poll(), this.options.pollMs ?? 2000);
  }

  stop(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  get started(): boolean {
    return this.#timer !== null;
  }

  /** Reads what is new now. Returns the number of plugin entries added. */
  async poll(): Promise<number> {
    if (this.#reading) return 0;
    this.#reading = true;
    this.notify();
    const before = this.#entries.length;
    try {
      const maxReads = this.options.maxReadsPerPoll ?? 8;
      for (let read = 0; read < maxReads; read++) {
        const result = await this.api.native.logTail({ path: this.#path, ...(this.#cursor === null ? {} : { cursor: this.#cursor }) });
        if (result.reset) {
          this.#entries = [];
          this.#carry = "";
          this.#resets += 1;
        }
        this.#cursor = result.cursor;
        this.#size = result.size;
        const tail = splitTail(this.#carry, result.data);
        this.#carry = tail.carry;
        const fresh = toPluginEntries(tail.lines);
        if (fresh.length > 0) this.#entries = capEntries([...this.#entries, ...fresh]);
        if (!result.truncated) break;
      }
      this.#error = null;
    } catch (error) {
      this.#error = error instanceof Error ? error.message : String(error);
    } finally {
      this.#reading = false;
      this.notify();
    }
    return Math.max(0, this.#entries.length - before);
  }

  clear(): void {
    this.#entries = [];
    this.notify();
  }

  dispose(): void {
    this.stop();
    this.#listeners.clear();
  }

  private notify(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        // a listener must not break the tail
      }
    }
  }
}

/** Helper for the UI's permission hint. */
export function missingGrantHint(id: string, path: string): string {
  return `The log viewer needs the log.tail grant: t3p grant ${id} log.tail --root "${path.replace(/\/[^/]*$/, "")}"`;
}
