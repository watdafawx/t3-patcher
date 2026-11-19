import { fork } from "node:child_process";

import { type PathPlatform, resolveAllowedPath } from "./path-guard.js";

export type SqlParam = string | number | boolean | null;

export interface SqliteQueryRequest {
  path: string;
  sql: string;
  params?: SqlParam[];
  maxRows?: number;
  timeoutMs?: number;
}

export interface SqliteQueryResult {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
  ms: number;
}

export interface SqliteOptions {
  roots: readonly string[];
  platform: PathPlatform;
  home: string;
  realpath?: (p: string) => string;
  /** Starts one query process (see sqlite-worker.cjs). */
  launch: QueryLauncher;
}

export const SQLITE_DEFAULT_ROWS = 1000;
export const SQLITE_MAX_ROWS = 10_000;
export const SQLITE_DEFAULT_TIMEOUT = 5000;
export const SQLITE_MAX_TIMEOUT = 30_000;
const DB_EXT = /\.(sqlite3?|db)$/i;

/**
 * Accepts one read statement: starts with SELECT or WITH, no `;` except one
 * trailing, no comments (they could hide a second statement from this check).
 * The database is also opened read-only with `PRAGMA query_only=1`, so a
 * statement that slips past still cannot write.
 */
export function checkSelect(sql: unknown): { ok: true; sql: string } | { ok: false; reason: string } {
  if (typeof sql !== "string" || sql.length === 0 || sql.length > 20_000) return { ok: false, reason: "sql must be a non-empty string up to 20000 chars" };
  let text = sql.trim();
  if (text.endsWith(";")) text = text.slice(0, -1).trimEnd();
  if (text.includes(";")) return { ok: false, reason: "only one statement is allowed" };
  if (text.includes("--") || text.includes("/*")) return { ok: false, reason: "comments are not allowed" };
  if (!/^(select|with)\b/i.test(text)) return { ok: false, reason: "only SELECT statements are allowed" };
  if (/\b(insert|update|delete|create|drop|alter|attach|detach|pragma|vacuum|reindex|analyze)\b/i.test(text.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, "''"))) {
    return { ok: false, reason: "write or schema keywords are not allowed" };
  }
  return { ok: true, sql: text };
}

/** One query process. Implemented by child_process.fork (tests, plain Node) and Electron's utilityProcess. */
export interface QueryProcess {
  send(job: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (code: number | null) => void): void;
  kill(): void;
}
export type QueryLauncher = () => Promise<QueryProcess>;

/** child_process.fork launcher. Under Electron it relies on ELECTRON_RUN_AS_NODE (RunAsNode fuse). */
export function forkLauncher(workerFile: string, env: NodeJS.ProcessEnv): QueryLauncher {
  return async () => {
    const child = fork(workerFile, [], {
      execArgv: [],
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
      serialization: "json",
    });
    return {
      send: (job) => void child.send(job as object),
      onMessage: (listener) => void child.once("message", listener),
      onExit: (listener) => {
        child.once("exit", (code) => listener(code));
        child.once("error", () => listener(null));
      },
      kill: () => void child.kill(),
    };
  };
}

export interface UtilityProcessLike {
  fork(
    modulePath: string,
    args?: string[],
    options?: { env?: NodeJS.ProcessEnv; execArgv?: string[]; serviceName?: string; stdio?: "ignore" | "pipe" | "inherit" },
  ): {
    postMessage(message: unknown): void;
    once(event: "message", listener: (message: unknown) => void): unknown;
    once(event: "exit", listener: (code: number) => void): unknown;
    kill(): boolean;
  };
}

/**
 * Electron launcher: utilityProcess works whatever the RunAsNode fuse says. It
 * can only fork once the app is ready, so a query from a plugin's activate()
 * waits for ready.
 */
export function utilityProcessLauncher(utility: UtilityProcessLike, whenReady: () => Promise<unknown>, workerFile: string, env: NodeJS.ProcessEnv): QueryLauncher {
  return async () => {
    await whenReady();
    const child = utility.fork(workerFile, [], { env, execArgv: [], serviceName: "t3p sqlite.read", stdio: "ignore" });
    return {
      send: (job) => child.postMessage(job),
      onMessage: (listener) => void child.once("message", listener),
      onExit: (listener) => void child.once("exit", (code) => listener(code)),
      kill: () => void child.kill(),
    };
  };
}

/** Starts query processes on demand and enforces the timeout by killing the process. */
function runQuery(launch: QueryLauncher, job: object, timeoutMs: number): Promise<SqliteQueryResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let proc: QueryProcess | null = null;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        proc?.kill();
      } catch {
        // already gone
      }
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`t3p: sqlite.read: query timed out after ${timeoutMs} ms`))), timeoutMs);
    launch().then(
      (p) => {
        proc = p;
        if (settled) {
          p.kill();
          return;
        }
        p.onMessage((raw) => {
          const message = raw as { ok: boolean; error?: string } & SqliteQueryResult;
          if (message && message.ok) finish(() => resolve({ columns: message.columns, rows: message.rows, truncated: message.truncated, ms: message.ms }));
          else finish(() => reject(new Error(`t3p: sqlite.read: ${message?.error ?? "bad reply"}`)));
        });
        p.onExit((code) => finish(() => reject(new Error(`t3p: sqlite.read: query process exited (${code})`))));
        p.send(job);
      },
      (error: unknown) => finish(() => reject(new Error(`t3p: sqlite.read: cannot start query process: ${(error as Error).message}`))),
    );
  });
}

/**
 * Read-only SELECT against a .sqlite/.sqlite3/.db file inside the granted
 * roots. Each query runs in its own process that is killed on timeout. Never
 * copies or writes the database.
 */
export function createSqliteQuery(options: SqliteOptions): (request: SqliteQueryRequest) => Promise<SqliteQueryResult> {
  return (request) => {
    const check = resolveAllowedPath(request.path, options.roots, options);
    if (!check.ok) return Promise.reject(new Error(`t3p: sqlite.read denied: ${check.reason}`));
    if (!DB_EXT.test(check.path)) return Promise.reject(new Error("t3p: sqlite.read denied: not a .sqlite/.sqlite3/.db file"));
    const statement = checkSelect(request.sql);
    if (!statement.ok) return Promise.reject(new Error(`t3p: sqlite.read denied: ${statement.reason}`));
    const params = request.params ?? [];
    if (!Array.isArray(params) || params.length > 100 || !params.every((p) => p === null || ["string", "number", "boolean"].includes(typeof p))) {
      return Promise.reject(new Error("t3p: sqlite.read: params must be up to 100 strings, numbers, booleans or nulls"));
    }
    const maxRows = Math.min(Math.max(1, request.maxRows ?? SQLITE_DEFAULT_ROWS), SQLITE_MAX_ROWS);
    const timeoutMs = Math.min(Math.max(100, request.timeoutMs ?? SQLITE_DEFAULT_TIMEOUT), SQLITE_MAX_TIMEOUT);
    const job = { path: check.path, sql: statement.sql, params: params.map((p) => (typeof p === "boolean" ? Number(p) : p)), maxRows };
    return runQuery(options.launch, job, timeoutMs);
  };
}
