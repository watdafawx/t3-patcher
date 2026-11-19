/**
 * Turn guard wiring for the main process (WP-6C). See docs/patching.md "Server guard".
 *
 * - The broker answers guard requests (main-process handlers, then the renderer round trip).
 * - A local pipe carries the requests from the T3 server process.
 * - The spawn wrap preloads server-hook.mjs into the backend, which patches the server's dispatch.
 *
 * `T3P_GUARD=0` turns all of it off (no spawn change). Fail-open: any setup error leaves T3 as is.
 */
import type * as childProcess from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

import type { GuardRequestEvent } from "@t3p/api";

import { createGuardBroker, type GuardBroker } from "./broker.js";
import { newGuardEndpoint, startGuardPipeServer } from "./pipe.js";
import { installSpawnWrap } from "./spawn-wrap.js";

export interface TurnGuardDeps {
  env: NodeJS.ProcessEnv;
  hookPath: string;
  emit(payload: GuardRequestEvent): boolean;
  log: { info(message: string): void; warn(message: string): void };
}

export interface TurnGuard {
  broker: GuardBroker;
  /** Null when the guard is off. */
  endpoint: { path: string } | null;
}

export function guardDisabled(env: NodeJS.ProcessEnv): boolean {
  return env.T3P_GUARD === "0";
}

/**
 * Starts the broker and, unless disabled or the hook file is missing, the pipe and the spawn wrap.
 * Call before the desktop main.cjs loads.
 */
export function startTurnGuard(deps: TurnGuardDeps): TurnGuard {
  const broker = createGuardBroker({ emit: deps.emit, log: deps.log });
  if (guardDisabled(deps.env)) {
    deps.log.info("turn guard off (T3P_GUARD=0)");
    return { broker, endpoint: null };
  }
  if (!existsSync(deps.hookPath)) {
    deps.log.warn(`turn guard off: ${deps.hookPath} is missing`);
    return { broker, endpoint: null };
  }
  const endpoint = newGuardEndpoint();
  let listening = true;
  startGuardPipeServer({ path: endpoint.path, token: endpoint.token, decide: (ctx) => broker.decide(ctx), log: deps.log }).then(
    (server) => {
      server.unref();
      deps.log.info(`turn guard pipe listening on ${endpoint.path}`);
    },
    (error: unknown) => {
      listening = false;
      deps.log.warn(`turn guard pipe failed (${String(error)}); turns are not guarded`);
    },
  );
  // The CJS module object, the one the desktop main.cjs reads `spawn` from at load.
  const cp = createRequire(__filename)("node:child_process") as typeof childProcess;
  installSpawnWrap(
    cp,
    () => (listening ? { hookPath: deps.hookPath, pipe: endpoint.path, token: endpoint.token } : null),
    () => deps.log.info("turn guard: backend spawned with the server hook"),
  );
  return { broker, endpoint: { path: endpoint.path } };
}
