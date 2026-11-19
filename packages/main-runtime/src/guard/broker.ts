/**
 * Main-process side of the turn guard: collects the handlers (main-process plugins directly,
 * renderer plugins as registrations) and answers the server's guard requests.
 *
 * Order: main-process handlers first (load order), then the renderer handlers (one round trip:
 * `t3p:event` `{type:"guard-request"}` out, `t3p:guard:answer` back; the renderer runs its handlers
 * in load order). Every path that fails, times out or finds no window answers `allow`.
 */
import {
  type AttributedDecision,
  clampGuardTimeout,
  type GuardRequestEvent,
  modifyFrom,
  normalizeTurnStartDecision,
  type PermissionSet,
  runTurnStartHandlers,
  TURN_GUARD_MAX_TIMEOUT_MS,
  type TurnStartContext,
  type TurnStartHandler,
} from "@t3p/api";

import type { IpcRouter } from "../ipc/router.js";
import { s } from "../ipc/schema.js";
import { describeContext } from "./command.js";

export interface GuardBrokerDeps {
  /** Pushes a `t3p:event` to the renderer; false when no window took it. */
  emit(payload: GuardRequestEvent): boolean;
  log: { info(message: string): void; warn(message: string): void };
  /** Extra time for the renderer round trip on top of its handler timeouts. Default 2 s. */
  slackMs?: number;
  newId?(): string;
}

export interface GuardBroker {
  /** A main-process plugin's handler. */
  addMainHandler(plugin: string, handler: TurnStartHandler, timeoutMs?: number): () => void;
  /** A renderer plugin registered (or re-registered) a handler. */
  registerRenderer(plugin: string, timeoutMs?: number): void;
  /** Without a plugin: the renderer reloaded, drop every registration and allow what is pending. */
  unregisterRenderer(plugin?: string): void;
  /** The renderer's answer to a guard request. False when the id is unknown (late or foreign). */
  answer(id: string, decision: unknown): boolean;
  /** The server asks. Never rejects. */
  decide(ctx: TurnStartContext): Promise<AttributedDecision>;
  /** For logs and tests. */
  status(): { main: string[]; renderer: string[]; pending: number };
}

export function createGuardBroker(deps: GuardBrokerDeps): GuardBroker {
  const main: Array<{ plugin: string; handler: TurnStartHandler; timeoutMs: number }> = [];
  const renderer = new Map<string, number>();
  const pending = new Map<string, { resolve(decision: AttributedDecision): void; timer: ReturnType<typeof setTimeout> }>();
  let counter = 0;
  const newId = deps.newId ?? (() => `r${Date.now().toString(36)}-${(++counter).toString(36)}`);
  const slack = deps.slackMs ?? 2_000;

  const settle = (id: string, decision: AttributedDecision): boolean => {
    const p = pending.get(id);
    if (!p) return false;
    pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(decision);
    return true;
  };

  const askRenderer = (ctx: TurnStartContext): Promise<AttributedDecision> => {
    if (renderer.size === 0) return Promise.resolve({ action: "allow" });
    let total = 0;
    for (const ms of renderer.values()) total += ms;
    const waitMs = Math.min(total + slack, TURN_GUARD_MAX_TIMEOUT_MS + 20_000);
    const id = newId();
    return new Promise<AttributedDecision>((resolve) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) {
          deps.log.warn(`guard: renderer did not answer ${describeContext(ctx)} within ${waitMs} ms, allowing`);
          resolve({ action: "allow" });
        }
      }, waitMs);
      pending.set(id, { resolve, timer });
      let sent = false;
      try {
        sent = deps.emit({ type: "guard-request", id, ctx });
      } catch {
        sent = false;
      }
      if (!sent) settle(id, { action: "allow" });
    });
  };

  return {
    addMainHandler(plugin, handler, timeoutMs) {
      const entry = { plugin, handler, timeoutMs: clampGuardTimeout(timeoutMs) };
      main.push(entry);
      return () => {
        const i = main.indexOf(entry);
        if (i >= 0) main.splice(i, 1);
      };
    },
    registerRenderer(plugin, timeoutMs) {
      renderer.set(plugin, clampGuardTimeout(timeoutMs));
    },
    unregisterRenderer(plugin) {
      if (plugin !== undefined) {
        renderer.delete(plugin);
        return;
      }
      renderer.clear();
      for (const id of [...pending.keys()]) settle(id, { action: "allow" });
    },
    answer(id, decision) {
      const raw = decision as { plugin?: unknown } | null;
      const normalized = normalizeTurnStartDecision(decision);
      const plugin = raw && typeof raw.plugin === "string" ? raw.plugin : undefined;
      return settle(id, plugin ? { ...normalized, plugin } : normalized);
    },
    async decide(ctx) {
      try {
        const first = await runTurnStartHandlers(ctx, [...main], (plugin, error) =>
          deps.log.warn(`guard: handler of ${plugin} failed (${error instanceof Error ? error.message : String(error)}), counted as allow`),
        );
        if (first.decision.action === "block") return first.decision;
        const fromRenderer = await askRenderer(first.ctx);
        if (fromRenderer.action !== "allow") {
          // A renderer modify carries the full target; fill from the main pass when it names only one part.
          return fromRenderer.action === "modify"
            ? { ...modifyFrom({ provider: fromRenderer.provider ?? first.ctx.provider, model: fromRenderer.model ?? first.ctx.model }), ...(fromRenderer.plugin ? { plugin: fromRenderer.plugin } : {}) }
            : fromRenderer;
        }
        return first.decision;
      } catch (error) {
        deps.log.warn(`guard: decide failed (${error instanceof Error ? error.message : String(error)}), allowing`);
        return { action: "allow" };
      }
    },
    status: () => ({ main: main.map((m) => m.plugin), renderer: [...renderer.keys()], pending: pending.size }),
  };
}

const pluginId = s.string({ max: 64, pattern: /^[a-z0-9][a-z0-9.-]*$/ });
const decisionSchema = s.object({
  action: s.literal("allow", "block", "modify"),
  reason: s.optional(s.string({ max: 2000 })),
  provider: s.optional(s.string({ max: 200 })),
  model: s.optional(s.string({ max: 200 })),
  plugin: s.optional(pluginId),
});

/** IPC: `t3p:guard:register` / `unregister` / `answer`. Registering needs the `guard` permission. */
export function registerGuardChannels(router: IpcRouter, broker: GuardBroker, permissionsFor: (id: string) => PermissionSet | null, log: { info(message: string): void }): void {
  router.handle("t3p:guard:register", s.object({ plugin: pluginId, timeoutMs: s.optional(s.int({ min: 0, max: 3_600_000 })) }), (p) => {
    const perms = permissionsFor(p.plugin);
    if (!perms) throw new Error(`t3p: plugin ${p.plugin} is not loaded`);
    if (!perms.guard) throw new Error(`t3p: guard is not granted to ${p.plugin}`);
    broker.registerRenderer(p.plugin, p.timeoutMs);
    log.info(`guard: ${p.plugin} registered a beforeStart handler`);
    return true;
  });
  router.handle("t3p:guard:unregister", s.object({ plugin: s.optional(pluginId) }), (p) => {
    broker.unregisterRenderer(p.plugin);
    return true;
  });
  router.handle("t3p:guard:answer", s.object({ id: s.string({ min: 1, max: 100 }), decision: decisionSchema }), (p) => broker.answer(p.id, p.decision));
}
