/**
 * Wraps `child_process.spawn` in the main process so the T3 backend (the server, run as
 * `<Electron exe> [--require <compile cache>] <...>/apps/server/dist/bin.mjs --bootstrap-fd 3` with
 * `ELECTRON_RUN_AS_NODE=1`) starts with the turn-guard server hook preloaded.
 *
 * Must be installed before the desktop `main.cjs` loads: it captures `spawn` once at load
 * (`makeWithSpawn(node_child_process.spawn)`). Only the local backend spawn is changed; WSL backends
 * (spawned through `wsl.exe`) and every other process are passed through untouched.
 */
import type * as ChildProcess from "node:child_process";
import { pathToFileURL } from "node:url";

import { GUARD_PIPE_ENV, GUARD_TOKEN_ENV } from "./pipe.js";

const SERVER_ENTRY_RE = /(?:^|[\\/])apps[\\/]server[\\/]dist[\\/]bin\.mjs$/;

export interface GuardInjection {
  /** Absolute path of the bundled server-hook.mjs. */
  hookPath: string;
  pipe: string;
  token: string;
}

/** True for the local T3 backend spawn. */
export function isBackendSpawn(command: unknown, args: unknown, execPath: string = process.execPath): args is string[] {
  if (typeof command !== "string" || !Array.isArray(args)) return false;
  if (command !== execPath) return false;
  const entry = args.findIndex((a) => typeof a === "string" && SERVER_ENTRY_RE.test(a));
  return entry >= 0 && args.includes("--bootstrap-fd");
}

/**
 * Returns the spawn arguments with the hook preloaded and the pipe env set. `options.env` missing
 * means the child inherits `process.env`; then a copy of it is used.
 */
export function injectGuard(args: readonly string[], options: ChildProcess.SpawnOptions | undefined, injection: GuardInjection): { args: string[]; options: ChildProcess.SpawnOptions } {
  const hookArg = `--import=${pathToFileURL(injection.hookPath).href}`;
  const nextArgs = args.includes(hookArg) ? [...args] : [hookArg, ...args];
  const baseEnv = options?.env ?? process.env;
  const env: NodeJS.ProcessEnv = { ...baseEnv, [GUARD_PIPE_ENV]: injection.pipe, [GUARD_TOKEN_ENV]: injection.token };
  return { args: nextArgs, options: { ...(options ?? {}), env } };
}

type SpawnFn = typeof ChildProcess.spawn;

/**
 * Replaces `cp.spawn` with a wrapper. `getInjection` is read per spawn (null = guard off, spawn
 * unchanged). Returns an uninstall function.
 */
export function installSpawnWrap(cp: { spawn: SpawnFn }, getInjection: () => GuardInjection | null, onInject: (args: string[]) => void = () => undefined): () => void {
  const original = cp.spawn;
  const wrapped = function spawn(this: unknown, command: unknown, argsOrOptions?: unknown, maybeOptions?: unknown) {
    try {
      const injection = getInjection();
      if (injection && isBackendSpawn(command, argsOrOptions)) {
        const next = injectGuard(argsOrOptions, maybeOptions as ChildProcess.SpawnOptions | undefined, injection);
        onInject(next.args);
        return (original as (...a: unknown[]) => unknown).call(this, command, next.args, next.options);
      }
    } catch {
      /* fall through to the untouched spawn */
    }
    return (original as (...a: unknown[]) => unknown).apply(this, [command, argsOrOptions, maybeOptions].slice(0, arguments.length));
  } as unknown as SpawnFn;
  cp.spawn = wrapped;
  return () => {
    if (cp.spawn === wrapped) cp.spawn = original;
  };
}
