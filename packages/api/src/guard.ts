/**
 * Turn-start guard (WP-6C): types and pure helpers shared by the server hook, the main runtime,
 * the renderer runtime and plugins.
 *
 * Every orchestration command that starts a provider turn (a user message, a continuation, a new
 * thread with a first message, a delegated task) is held in the T3 server until the registered
 * handlers answered, or until the timeout passed (then it runs: a hung plugin never wedges T3).
 * Mechanics: docs/patching.md "Server guard".
 */

/** Default time a guard waits for a handler before the turn runs anyway. */
export const TURN_GUARD_TIMEOUT_MS = 120_000;
/** Longest timeout a handler may ask for. */
export const TURN_GUARD_MAX_TIMEOUT_MS = 300_000;
/** Shortest timeout a handler may ask for. */
export const TURN_GUARD_MIN_TIMEOUT_MS = 1_000;
/** Characters of the message text a handler sees. */
export const TURN_GUARD_PREVIEW_CHARS = 200;
/** Longest block reason passed on to the user. */
export const TURN_GUARD_MAX_REASON = 500;

/** Orchestration commands the guard holds. */
export const GUARDED_COMMAND_TYPES = ["message.dispatch", "thread.create", "delegated_task.request"] as const;
export type GuardedCommandType = (typeof GUARDED_COMMAND_TYPES)[number];

/**
 * What starts the turn.
 * - `message`: a message to an existing thread (`message.dispatch`), also server continuations.
 * - `thread-create`: a new thread with its first message (`thread.create` with `initialMessage`).
 * - `delegate`: a delegated sub-session (`delegated_task.request`, from an agent's `delegate_task`).
 */
export type TurnStartKind = "message" | "thread-create" | "delegate";

/** Why the server sends a message on its own (set on `message.dispatch` continuations). */
export type TurnStartContinuation = "restart" | "usage-limit" | "manual" | "steer" | "delegated-completion" | "idle-compaction";

/** What a {@link TurnStartHandler} sees. */
export interface TurnStartContext {
  /** Unique per guarded command. */
  requestId: string;
  commandType: GuardedCommandType;
  kind: TurnStartKind;
  /**
   * The thread the turn runs on. For `delegate` this is the PARENT thread: the child thread is
   * created by the same command, so its id is not known yet.
   */
  threadId: string;
  /** For `delegate`, the parent thread (same as `threadId`). Otherwise the sending thread, when the server reports one. */
  parentThreadId: string | null;
  /** Provider instance id the turn will run on (`"claudeAgent"`, `"codex"`, ...). `null` when unknown. */
  provider: string | null;
  /** Model id. `null` when unknown. */
  model: string | null;
  /**
   * `"command"`: provider and model were named by the command. `"thread"`: the command did not name
   * them (a message to an existing thread keeps its model) and the runtime filled them from the
   * thread list. `null`: unknown.
   */
  modelSource: "command" | "thread" | null;
  /** True for delegated sub-sessions and agent-created threads (`createdBy: "agent"`, or a linked environment's delegated task). */
  isSubagent: boolean;
  /** Server `creationSource`: `web`, `mobile`, `mcp`, `provider`, `server`. `null` when the command has none. */
  source: string | null;
  /** Server `createdBy`: `user`, `agent`, `system`. `null` when the command has none. */
  createdBy: string | null;
  /** Set when the server sends this message on its own. */
  continuation: TurnStartContinuation | null;
  /** First {@link TURN_GUARD_PREVIEW_CHARS} characters of the message (or task) text. */
  textPreview: string;
  /** Epoch ms when the server received the command. */
  at: number;
}

/**
 * A handler's answer.
 * - `allow`: let it run (also what `undefined` means).
 * - `block`: refuse the command. `reason` is shown to the user, or returned to the delegating agent
 *   as the `delegate_task` error.
 * - `modify`: run it on another provider and/or model. Without `provider` the provider stays;
 *   on an existing thread the server applies its usual rules for a provider change.
 */
export type TurnStartDecision = { action: "allow" } | { action: "block"; reason: string } | { action: "modify"; provider?: string; model?: string };

/** A decision as the main process passes it on: plus the plugin that made it. */
export type AttributedDecision = TurnStartDecision & { plugin?: string };

export type TurnStartHandler = (ctx: TurnStartContext) => TurnStartDecision | void | undefined | Promise<TurnStartDecision | void | undefined>;

export interface BeforeStartOptions {
  /** How long this handler may take before the turn runs anyway. Default {@link TURN_GUARD_TIMEOUT_MS}, clamped to 1 s..5 min. */
  timeoutMs?: number;
}

/** Clamps a handler timeout. */
export function clampGuardTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return TURN_GUARD_TIMEOUT_MS;
  return Math.min(TURN_GUARD_MAX_TIMEOUT_MS, Math.max(TURN_GUARD_MIN_TIMEOUT_MS, Math.round(value)));
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

/**
 * Validates a handler's return value. Anything that is not a well-formed decision is `allow`
 * (fail open). A `modify` with neither a valid provider nor model is `allow`.
 */
export function normalizeTurnStartDecision(value: unknown): TurnStartDecision {
  if (value === null || typeof value !== "object") return { action: "allow" };
  const v = value as { action?: unknown; reason?: unknown; provider?: unknown; model?: unknown };
  if (v.action === "block") {
    const reason = typeof v.reason === "string" && v.reason.trim().length > 0 ? v.reason.trim().slice(0, TURN_GUARD_MAX_REASON) : "Blocked by a T3 Patcher plugin.";
    return { action: "block", reason };
  }
  if (v.action === "modify") {
    const out: { action: "modify"; provider?: string; model?: string } = { action: "modify" };
    if (typeof v.provider === "string" && ID_RE.test(v.provider)) out.provider = v.provider;
    if (typeof v.model === "string" && ID_RE.test(v.model)) out.model = v.model;
    return out.provider === undefined && out.model === undefined ? { action: "allow" } : out;
  }
  return { action: "allow" };
}

/**
 * Runs handlers in order. Each sees the context as earlier `modify` answers left it. The first
 * `block` ends the chain. A handler that throws, times out or answers garbage counts as `allow`.
 */
export async function runTurnStartHandlers(
  ctx: TurnStartContext,
  handlers: ReadonlyArray<{ plugin: string; handler: TurnStartHandler; timeoutMs: number }>,
  onError: (plugin: string, error: unknown) => void = () => undefined,
): Promise<{ decision: AttributedDecision; ctx: TurnStartContext }> {
  let current = ctx;
  let modifiedBy: string | null = null;
  for (const entry of handlers) {
    let decision: TurnStartDecision;
    try {
      decision = normalizeTurnStartDecision(await withGuardTimeout(Promise.resolve().then(() => entry.handler(Object.freeze({ ...current }))), entry.timeoutMs));
    } catch (error) {
      onError(entry.plugin, error);
      decision = { action: "allow" };
    }
    if (decision.action === "block") return { decision: { ...decision, plugin: entry.plugin }, ctx: current };
    if (decision.action === "modify") {
      current = { ...current, ...(decision.provider ? { provider: decision.provider } : {}), ...(decision.model ? { model: decision.model } : {}) };
      modifiedBy = entry.plugin;
    }
  }
  if (modifiedBy !== null) return { decision: modifyFrom(current, modifiedBy), ctx: current };
  return { decision: { action: "allow" }, ctx: current };
}

/**
 * The `modify` decision for a final context: the full provider and model the turn should use (the
 * server hook needs both when the command named no model).
 */
export function modifyFrom(ctx: Pick<TurnStartContext, "provider" | "model">, plugin?: string): AttributedDecision {
  return {
    action: "modify",
    ...(ctx.provider ? { provider: ctx.provider } : {}),
    ...(ctx.model ? { model: ctx.model } : {}),
    ...(plugin ? { plugin } : {}),
  };
}

/** Rejects with a `GuardTimeoutError` after `ms`. */
export function withGuardTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new GuardTimeoutError(ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class GuardTimeoutError extends Error {
  readonly code = "guard-timeout";
  constructor(ms: number) {
    super(`turn guard handler timed out after ${ms} ms`);
    this.name = "GuardTimeoutError";
  }
}

/** `t3p:event` payload the main process pushes when renderer handlers must answer. */
export interface GuardRequestEvent {
  type: "guard-request";
  id: string;
  ctx: TurnStartContext;
}
