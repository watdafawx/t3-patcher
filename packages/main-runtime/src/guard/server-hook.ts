/**
 * Preloaded into the T3 server process with `--import=<file URL of server-hook.mjs>` (added by the
 * spawn wrap in spawn-wrap.ts, only for the backend spawn). Bundled to its own ESM file.
 *
 * 1. Runs only on the main thread of the server entry (`.../apps/server/dist/bin.mjs`). Workers and
 *    forked children inherit `execArgv`; there it does nothing.
 * 2. Reads the guard pipe path and token from the env and removes them at once, so no provider
 *    process the server spawns inherits them.
 * 3. Registers a synchronous `module.registerHooks` load hook that:
 *    - applies the turn-guard patch (server-patch.ts) to `runtimeLayer-*.mjs` when the pipe/token
 *      are present, and installs `globalThis.__t3pServerGuard`;
 *    - applies the MCP tools patch (mcp-patch.ts) to `server-*.mjs` unless `T3P_MCP_TOOLS=0`, and
 *      installs `globalThis.__t3pMcpTools` (registering `t3_provider_limits`).
 *
 * Any failure leaves the server untouched (no hook, no global: the patched code checks for it).
 */
import * as nodeModule from "node:module";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";

import { applyServerMcpPatch, SERVER_MCP_FILE_RE, SERVER_MCP_FIND, SERVER_MCP_GLOBAL } from "./mcp-patch.js";
import { createServerMcpTools, T3_MCP_TOOLS_ENV } from "./mcp-tools.js";
import { GUARD_PIPE_ENV, GUARD_TOKEN_ENV, createGuardPipeClient } from "./pipe.js";
import { createServerGuard } from "./server-guard.js";
import { applyServerGuardPatch, SERVER_GUARD_FILE_RE, SERVER_GUARD_GLOBAL } from "./server-patch.js";

const SERVER_ENTRY_RE = /(?:^|[\\/])apps[\\/]server[\\/]dist[\\/]bin\.mjs$/;

function log(level: "info" | "warn", message: string): void {
  try {
    process.stderr.write(`[t3p server-hook] ${level}: ${message}\n`);
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

/** Load hook body for the turn guard, exported for tests. */
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

/** Load hook body for the server MCP tools patch, exported for tests. */
export function patchLoadedMcp(url: string, result: LoadResult, onResult: (file: string, ok: boolean, detail: string) => void): LoadResult {
  if (!url.startsWith("file:")) return result;
  let file: string;
  try {
    file = fileURLToPath(url);
  } catch {
    return result;
  }
  if (!SERVER_MCP_FILE_RE.test(file)) return result;
  const text = sourceText(result.source);
  if (text === null || !text.includes(SERVER_MCP_FIND)) return result;
  const patched = applyServerMcpPatch(text);
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

  const enableGuard = Boolean(pipe && token);
  const enableMcp = process.env[T3_MCP_TOOLS_ENV] !== "0";
  if (!enableGuard && !enableMcp) return;

  const registerHooks = (nodeModule as unknown as { registerHooks?: RegisterHooks }).registerHooks;
  if (typeof registerHooks !== "function") {
    log("warn", "module.registerHooks is missing in this runtime; server hooks are off");
    return;
  }

  if (enableGuard && pipe && token) {
    const client = createGuardPipeClient({ path: pipe, token });
    (globalThis as Record<string, unknown>)[SERVER_GUARD_GLOBAL] = createServerGuard({ request: (ctx) => client.request(ctx), log });
  }
  if (enableMcp) {
    (globalThis as Record<string, unknown>)[SERVER_MCP_GLOBAL] = createServerMcpTools({ log });
  }

  let guardDone = !enableGuard;
  let mcpDone = !enableMcp;
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (guardDone && mcpDone) return result;
      try {
        if (!guardDone) {
          const next = patchLoaded(url, result, (file, ok, detail) => {
            if (ok) {
              guardDone = true;
              log("info", `turn guard patched ${file} (${detail})`);
            } else log("warn", `turn guard could not patch ${file}: ${detail}; turns are not guarded`);
          });
          if (next !== result) return next;
        }
        if (!mcpDone) {
          return patchLoadedMcp(url, result, (file, ok, detail) => {
            if (ok) {
              mcpDone = true;
              log("info", `mcp tools patched ${file} (${detail})`);
            } else log("warn", `mcp tools could not patch ${file}: ${detail}; custom MCP tools are off`);
          });
        }
        return result;
      } catch (error) {
        log("warn", `server load hook failed: ${error instanceof Error ? error.message : String(error)}`);
        return result;
      }
    },
  });
}

try {
  install();
} catch (error) {
  log("warn", `server hook setup failed: ${error instanceof Error ? error.message : String(error)}`);
}
