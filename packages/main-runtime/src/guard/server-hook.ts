/**
 * Preloaded into the T3 server process with `--import=<file URL of server-hook.mjs>` (added by the
 * spawn wrap in spawn-wrap.ts, only for the backend spawn). Bundled to its own ESM file.
 *
 * 1. Runs only on the main thread of the server entry (`.../apps/server/dist/bin.mjs`). Workers and
 *    forked children inherit `execArgv`; there it does nothing.
 * 2. Reads the guard pipe path and token from the env and removes them at once, so no provider
 *    process the server spawns inherits them.
 * 3. Registers a synchronous `module.registerHooks` load hook that applies the guard patch
 *    (server-patch.ts) to the server's `runtimeLayer-*.mjs` chunk as it loads.
 * 4. Installs `globalThis.__t3pServerGuard`, which asks the main process over the pipe.
 *
 * Any failure leaves the server untouched (no hook, no global: the patched code checks for it).
 */
import * as nodeModule from "node:module";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";

import { GUARD_PIPE_ENV, GUARD_TOKEN_ENV, createGuardPipeClient } from "./pipe.js";
import { createServerGuard } from "./server-guard.js";
import { applyServerGuardPatch, SERVER_GUARD_FILE_RE, SERVER_GUARD_GLOBAL } from "./server-patch.js";

const SERVER_ENTRY_RE = /(?:^|[\\/])apps[\\/]server[\\/]dist[\\/]bin\.mjs$/;

function log(level: "info" | "warn", message: string): void {
  try {
    process.stderr.write(`[t3p guard] ${level}: ${message}\n`);
  } catch {
    /* ignore */
  }
}

type LoadResult = { format?: string | null; source?: string | ArrayBuffer | ArrayBufferView | null; shortCircuit?: boolean };
type RegisterHooks = (hooks: { load?: (url: string, context: unknown, nextLoad: (url: string, context?: unknown) => LoadResult) => LoadResult }) => unknown;

function sourceText(source: LoadResult["source"]): string | null {
  if (typeof source === "string") return source;
  if (source instanceof ArrayBuffer) return Buffer.from(source).toString("utf8");
  if (source && ArrayBuffer.isView(source)) return Buffer.from(source.buffer, source.byteOffset, source.byteLength).toString("utf8");
  return null;
}

/** Load hook body, exported for tests. */
export function patchLoaded(url: string, result: LoadResult, onResult: (file: string, ok: boolean, detail: string) => void): LoadResult {
  if (!url.startsWith("file:")) return result;
  let file: string;
  try {
    file = fileURLToPath(url);
  } catch {
    return result;
  }
  if (!SERVER_GUARD_FILE_RE.test(file)) return result;
  const text = sourceText(result.source);
  if (text === null || !text.includes("const dispatchWithReceipt = ")) return result;
  const patched = applyServerGuardPatch(text);
  if (!patched.ok) {
    onResult(file, false, `${patched.reason}: ${patched.detail}`);
    return result;
  }
  onResult(file, true, patched.detail);
  return { ...result, source: patched.code };
}

export function isServerEntry(argv: readonly string[]): boolean {
  return argv.some((arg) => SERVER_ENTRY_RE.test(arg));
}

function install(): void {
  if (!isMainThread || !isServerEntry(process.argv)) return;
  const pipe = process.env[GUARD_PIPE_ENV];
  const token = process.env[GUARD_TOKEN_ENV];
  delete process.env[GUARD_PIPE_ENV];
  delete process.env[GUARD_TOKEN_ENV];
  if (!pipe || !token) return;
  const registerHooks = (nodeModule as unknown as { registerHooks?: RegisterHooks }).registerHooks;
  if (typeof registerHooks !== "function") {
    log("warn", "module.registerHooks is missing in this runtime; the turn guard is off");
    return;
  }
  const client = createGuardPipeClient({ path: pipe, token });
  (globalThis as Record<string, unknown>)[SERVER_GUARD_GLOBAL] = createServerGuard({ request: (ctx) => client.request(ctx), log });
  let patchedOnce = false;
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (patchedOnce) return result;
      try {
        return patchLoaded(url, result, (file, ok, detail) => {
          if (ok) {
            patchedOnce = true;
            log("info", `turn guard patched ${file} (${detail})`);
          } else log("warn", `turn guard could not patch ${file}: ${detail}; turns are not guarded`);
        });
      } catch (error) {
        log("warn", `turn guard load hook failed: ${error instanceof Error ? error.message : String(error)}`);
        return result;
      }
    },
  });
}

try {
  install();
} catch (error) {
  log("warn", `turn guard setup failed: ${error instanceof Error ? error.message : String(error)}`);
}
