import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
  /** A logger that prefixes every line with `[tag]`, writing to the same file. */
  child(tag: string): Logger;
}

export interface FileLoggerOptions {
  dir: string;
  file?: string;
  /** Rotate when the file grows past this many bytes. */
  maxBytes?: number;
  /** Rotated files kept: main.log.1 .. main.log.N. */
  keep?: number;
  now?: () => Date;
  /** Mirror lines to stderr (dev). */
  echo?: boolean;
}

const MAX_LINE = 8_000;

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  try {
    return typeof error === "string" ? error : JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Append-only file logger. Never throws: every failure (disk full, locked
 * file, bad path) is swallowed, because logging must not break app startup.
 */
export function createFileLogger(options: FileLoggerOptions): Logger {
  const file = join(options.dir, options.file ?? "main.log");
  const maxBytes = options.maxBytes ?? 1_000_000;
  const keep = options.keep ?? 3;
  const now = options.now ?? (() => new Date());
  let size = -1;
  let dirReady = false;

  const rotate = (): void => {
    try {
      rmSync(`${file}.${keep}`, { force: true });
      for (let i = keep - 1; i >= 1; i--) {
        try {
          renameSync(`${file}.${i}`, `${file}.${i + 1}`);
        } catch {
          // missing generation
        }
      }
      renameSync(file, `${file}.1`);
    } catch {
      // keep appending to the current file
    }
    size = 0;
  };

  const write = (level: LogLevel, tag: string, message: string): void => {
    try {
      if (!dirReady) {
        mkdirSync(options.dir, { recursive: true });
        dirReady = true;
      }
      if (size < 0) {
        try {
          size = statSync(file).size;
        } catch {
          size = 0;
        }
      }
      let text = message.length > MAX_LINE ? `${message.slice(0, MAX_LINE)}... [${message.length - MAX_LINE} more chars]` : message;
      text = text.replace(/\r?\n/g, "\n    ");
      const line = `${now().toISOString()} ${level.toUpperCase().padEnd(5)} ${tag ? `[${tag}] ` : ""}${text}\n`;
      if (size + line.length > maxBytes && size > 0) rotate();
      appendFileSync(file, line, "utf8");
      size += Buffer.byteLength(line);
      if (options.echo) process.stderr.write(`t3p ${line}`);
    } catch {
      // never throw from the logger
    }
  };

  const make = (tag: string): Logger => ({
    debug: (m) => write("debug", tag, m),
    info: (m) => write("info", tag, m),
    warn: (m) => write("warn", tag, m),
    error: (m, e) => write("error", tag, e === undefined ? m : `${m}: ${describeError(e)}`),
    child: (t) => make(tag ? `${tag}:${t}` : t),
  });
  return make("");
}

/** A logger that drops everything (tests). */
export const nullLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => nullLogger,
};

/** Runs fn; on throw logs and returns the fallback. */
export function guard<T>(log: Logger, what: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (error) {
    log.error(`${what} failed`, error);
    return fallback;
  }
}
