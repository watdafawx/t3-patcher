/**
 * Renderer side of the turn guard (WP-6C, `t3.threads.beforeStart`).
 *
 * Plugins register handlers here; the client tells the main process which plugins have one
 * (`t3p:guard:register`, with the plugin's total timeout) so it only asks when someone listens.
 * A `t3p:event` `{type:"guard-request"}` runs every handler in plugin load order and answers with
 * `t3p:guard:answer`. Errors and timeouts count as allow.
 */
import {
  clampGuardTimeout,
  type GuardRequestEvent,
  runTurnStartHandlers,
  type ThreadSummary,
  type TurnStartContext,
  type TurnStartHandler,
} from "@t3p/api";

import type { NativeBridgeLike, RemoteLog } from "./types.js";

export interface GuardClientDeps {
  native: NativeBridgeLike;
  log: RemoteLog;
  /** Plugin ids in load order. */
  order(): readonly string[];
  /** Thread list for filling provider/model a command did not name. */
  threads?(): Promise<ThreadSummary[]>;
  /** How long the thread lookup may take. Default 1500 ms. */
  lookupMs?: number;
}

export interface GuardClient {
  register(plugin: string, handler: TurnStartHandler, timeoutMs?: number): () => void;
  /** Runs the handlers for one request and answers the main process. */
  handle(event: GuardRequestEvent): Promise<void>;
  /** Plugins with handlers (tests). */
  plugins(): string[];
}

interface Entry {
  handler: TurnStartHandler;
  timeoutMs: number;
}

export function isGuardRequest(payload: unknown): payload is GuardRequestEvent {
  const p = payload as Partial<GuardRequestEvent> | null;
  return !!p && p.type === "guard-request" && typeof p.id === "string" && !!p.ctx && typeof p.ctx === "object";
}

/** Fills provider/model from the thread list when the command named neither. Never throws. */
export async function enrichContext(ctx: TurnStartContext, threads: (() => Promise<ThreadSummary[]>) | undefined, lookupMs: number): Promise<TurnStartContext> {
  if (!threads || ctx.provider || ctx.model || !ctx.threadId) return ctx;
  try {
    const list = await Promise.race([threads(), new Promise<null>((resolve) => setTimeout(() => resolve(null), lookupMs))]);
    const thread = list?.find((t) => t.threadId === ctx.threadId);
    if (!thread || (!thread.providerInstanceId && !thread.model)) return ctx;
    return { ...ctx, provider: thread.providerInstanceId, model: thread.model, modelSource: "thread" };
  } catch {
    return ctx;
  }
}

export function createGuardClient(deps: GuardClientDeps): GuardClient {
  const byPlugin = new Map<string, Entry[]>();
  const lookupMs = deps.lookupMs ?? 1_500;

  const sync = (plugin: string): void => {
    const entries = byPlugin.get(plugin);
    const request = entries?.length
      ? deps.native.invoke("t3p:guard:register", { plugin, timeoutMs: entries.reduce((sum, e) => sum + e.timeoutMs, 0) })
      : deps.native.invoke("t3p:guard:unregister", { plugin });
    request.catch((error: unknown) => deps.log("warn", `turn guard registration failed: ${error instanceof Error ? error.message : String(error)}`, plugin));
  };

  const ordered = (): Array<{ plugin: string; handler: TurnStartHandler; timeoutMs: number }> => {
    const order = deps.order();
    const plugins = [...byPlugin.keys()].sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      return (ia < 0 ? Number.MAX_SAFE_INTEGER : ia) - (ib < 0 ? Number.MAX_SAFE_INTEGER : ib);
    });
    return plugins.flatMap((plugin) => (byPlugin.get(plugin) ?? []).map((e) => ({ plugin, handler: e.handler, timeoutMs: e.timeoutMs })));
  };

  const answer = (id: string, decision: unknown): Promise<void> =>
    deps.native.invoke("t3p:guard:answer", { id, decision }).then(
      () => undefined,
      (error: unknown) => deps.log("warn", `turn guard answer failed: ${error instanceof Error ? error.message : String(error)}`),
    );

  return {
    register(plugin, handler, timeoutMs) {
      const entry: Entry = { handler, timeoutMs: clampGuardTimeout(timeoutMs) };
      const list = byPlugin.get(plugin) ?? [];
      list.push(entry);
      byPlugin.set(plugin, list);
      sync(plugin);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        const current = byPlugin.get(plugin);
        if (!current) return;
        const i = current.indexOf(entry);
        if (i >= 0) current.splice(i, 1);
        if (current.length === 0) byPlugin.delete(plugin);
        sync(plugin);
      };
    },
    async handle(event) {
      const handlers = ordered();
      if (handlers.length === 0) {
        await answer(event.id, { action: "allow" });
        return;
      }
      let decision: unknown = { action: "allow" };
      try {
        const ctx = await enrichContext(event.ctx, deps.threads, lookupMs);
        const result = await runTurnStartHandlers(ctx, handlers, (plugin, error) =>
          deps.log("warn", `beforeStart handler failed, counted as allow: ${error instanceof Error ? error.message : String(error)}`, plugin),
        );
        decision = result.decision;
      } catch (error) {
        deps.log("warn", `turn guard failed, allowing: ${error instanceof Error ? error.message : String(error)}`);
      }
      await answer(event.id, decision);
    },
    plugins: () => [...byPlugin.keys()],
  };
}
