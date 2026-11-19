/**
 * `globalThis.__t3pServerGuard` inside the T3 server process (installed by the server hook, called
 * by the patched `dispatchWithReceipt`, see server-patch.ts).
 *
 * - `wants(command)`: synchronous, true only for commands that start a turn.
 * - `check(command)`: resolves the command to dispatch (maybe with a new `modelSelection`), or
 *   rejects with the block reason. Any failure to reach the main process, a garbled answer or a
 *   timeout resolves the original command: the guard fails open.
 *
 * Guarded commands of one thread keep their order: a later one waits until the earlier one is
 * decided, so a message held by a modal cannot be overtaken by the next message to that thread.
 */
import { type AttributedDecision, normalizeTurnStartDecision, TURN_GUARD_MAX_TIMEOUT_MS, type TurnStartContext } from "@t3p/api";

import { applyTurnStartDecision, type CommandLike, describeContext, guardOrderKey, isGuardedCommand, turnStartContext } from "./command.js";

export interface ServerGuardDeps {
  /** Asks the main process. May reject or never settle; the guard covers both. */
  request(ctx: TurnStartContext): Promise<AttributedDecision>;
  log(level: "info" | "warn", message: string): void;
  now?(): number;
  /** Hard cap on one decision, past every handler timeout. Default 5.5 min. */
  maxWaitMs?: number;
  newId?(): string;
}

export interface ServerGuard {
  wants(command: unknown): boolean;
  check<T>(command: T): Promise<T>;
}

/** Error the patched dispatch turns into `OrchestratorDispatchError({ cause: message })`. */
export class TurnBlockedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "TurnBlockedError";
  }
}

export function createServerGuard(deps: ServerGuardDeps): ServerGuard {
  const now = deps.now ?? Date.now;
  const maxWaitMs = deps.maxWaitMs ?? TURN_GUARD_MAX_TIMEOUT_MS + 30_000;
  let counter = 0;
  const newId = deps.newId ?? (() => `g${now().toString(36)}-${(++counter).toString(36)}`);
  /** Tail of each thread's chain of pending decisions. */
  const tails = new Map<string, Promise<unknown>>();

  const ask = (ctx: TurnStartContext): Promise<AttributedDecision> =>
    new Promise<AttributedDecision>((resolve) => {
      const timer = setTimeout(() => {
        deps.log("warn", `guard: no answer for ${describeContext(ctx)} after ${maxWaitMs} ms, allowing`);
        resolve({ action: "allow" });
      }, maxWaitMs);
      (timer as { unref?: () => void }).unref?.();
      let settled = false;
      const done = (decision: AttributedDecision): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(decision);
      };
      try {
        deps.request(ctx).then(
          (decision) => {
            const normalized = normalizeTurnStartDecision(decision);
            done(typeof decision?.plugin === "string" ? { ...normalized, plugin: decision.plugin } : normalized);
          },
          (error: unknown) => {
            deps.log("warn", `guard: request failed for ${describeContext(ctx)} (${error instanceof Error ? error.message : String(error)}), allowing`);
            done({ action: "allow" });
          },
        );
      } catch (error) {
        deps.log("warn", `guard: request threw (${error instanceof Error ? error.message : String(error)}), allowing`);
        done({ action: "allow" });
      }
    });

  const decide = async <T>(command: T): Promise<T> => {
    const ctx = turnStartContext(command, newId(), now());
    if (!ctx) return command;
    const decision = await ask(ctx);
    if (decision.action === "allow") return command;
    const by = decision.plugin ? ` by ${decision.plugin}` : "";
    if (decision.action === "block") {
      deps.log("info", `guard: blocked ${describeContext(ctx)}${by}: ${decision.reason}`);
      throw new TurnBlockedError(decision.reason);
    }
    const { command: next, applied } = applyTurnStartDecision(command as unknown as CommandLike, decision);
    deps.log("info", `guard: ${applied ? "modified" : "could not modify"} ${describeContext(ctx)}${by} -> ${decision.provider ?? "?"}/${decision.model ?? "?"}`);
    return next as unknown as T;
  };

  return {
    wants: (command) => {
      try {
        return isGuardedCommand(command);
      } catch {
        return false;
      }
    },
    check<T>(command: T): Promise<T> {
      let key = "";
      try {
        if (!isGuardedCommand(command)) return Promise.resolve(command);
        key = guardOrderKey(command);
      } catch {
        return Promise.resolve(command);
      }
      const previous = tails.get(key) ?? Promise.resolve();
      const result = previous.then(
        () => decide(command),
        () => decide(command),
      );
      const tail = result.then(
        () => undefined,
        () => undefined,
      );
      tails.set(key, tail);
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      // Unexpected internal errors fail open; only a block rejects.
      return result.catch((error: unknown) => {
        if (error instanceof TurnBlockedError) throw error;
        deps.log("warn", `guard: internal error (${error instanceof Error ? error.message : String(error)}), allowing`);
        return command;
      });
    },
  };
}
