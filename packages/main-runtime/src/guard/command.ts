/**
 * Pure helpers over upstream orchestration commands (contracts `orchestrationV2.ts`, the
 * `OrchestrationV2Command` union): which commands start a turn, the {@link TurnStartContext} a
 * handler sees, and how a `modify` decision rewrites the command. Bundled into the server hook,
 * so no Node or Electron imports here.
 */
import {
  type AttributedDecision,
  GUARDED_COMMAND_TYPES,
  type GuardedCommandType,
  TURN_GUARD_PREVIEW_CHARS,
  type TurnStartContext,
  type TurnStartContinuation,
} from "@t3p/api";

/** The fields of an upstream command the guard reads. Everything else passes through untouched. */
export interface CommandLike {
  type?: unknown;
  [key: string]: unknown;
}

interface SelectionLike {
  instanceId?: unknown;
  provider?: unknown;
  model?: unknown;
  options?: unknown;
}

const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const obj = (value: unknown): Record<string, unknown> | null => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

/** True for a command that starts a provider turn: `message.dispatch`, `thread.create` with a first message, `delegated_task.request`. */
export function isGuardedCommand(command: unknown): command is CommandLike & { type: GuardedCommandType } {
  const c = obj(command);
  if (!c || !(GUARDED_COMMAND_TYPES as readonly unknown[]).includes(c.type)) return false;
  if (c.type === "thread.create") return obj(c.initialMessage) !== null;
  return true;
}

/** The thread whose guarded commands must keep their order (the parent for a delegated task). */
export function guardOrderKey(command: CommandLike): string {
  return str(command.type === "delegated_task.request" ? command.parentThreadId : command.threadId) ?? "";
}

function selectionOf(value: unknown): { provider: string | null; model: string | null } {
  const s = obj(value) as SelectionLike | null;
  if (!s) return { provider: null, model: null };
  return { provider: str(s.instanceId) ?? str(s.provider), model: str(s.model) };
}

function continuationOf(c: CommandLike): TurnStartContinuation | null {
  if (c.restartContinuationOfRunId !== undefined) return "restart";
  if (c.usageLimitContinuationOfRunId !== undefined) return "usage-limit";
  if (c.manualContinuationOfRunId !== undefined) return "manual";
  if (c.steerFollowUpOfRunId !== undefined) return "steer";
  if (c.delegatedCompletion !== undefined) return "delegated-completion";
  if (c.idleCompaction !== undefined) return "idle-compaction";
  return null;
}

function preview(text: unknown): string {
  return typeof text === "string" ? text.slice(0, TURN_GUARD_PREVIEW_CHARS) : "";
}

/** The handler context for a guarded command, or `null` for any other command. */
export function turnStartContext(command: unknown, requestId: string, now: number): TurnStartContext | null {
  if (!isGuardedCommand(command)) return null;
  const c = command;
  const createdBy = str(c.createdBy);
  const source = str(c.creationSource);
  const base = { requestId, commandType: c.type, createdBy, source, at: now };
  if (c.type === "delegated_task.request") {
    const parent = str(c.parentThreadId) ?? "";
    const sel = selectionOf(c.modelSelection);
    return {
      ...base,
      kind: "delegate",
      threadId: parent,
      parentThreadId: parent,
      ...sel,
      modelSource: sel.provider || sel.model ? "command" : null,
      isSubagent: true,
      continuation: null,
      textPreview: preview(c.task),
    };
  }
  if (c.type === "thread.create") {
    const initial = obj(c.initialMessage) ?? {};
    const sel = selectionOf(c.modelSelection);
    return {
      ...base,
      kind: "thread-create",
      threadId: str(c.threadId) ?? "",
      parentThreadId: str(initial.senderThreadId),
      ...sel,
      modelSource: sel.provider || sel.model ? "command" : null,
      isSubagent: createdBy === "agent" || c.delegatedFrom !== undefined,
      continuation: null,
      textPreview: preview(initial.text),
    };
  }
  const sel = selectionOf(c.modelSelection);
  return {
    ...base,
    kind: "message",
    threadId: str(c.threadId) ?? "",
    parentThreadId: str(c.senderThreadId),
    ...sel,
    modelSource: sel.provider || sel.model ? "command" : null,
    isSubagent: createdBy === "agent",
    continuation: continuationOf(c),
    textPreview: preview(c.text),
  };
}

/**
 * Applies a `modify` decision: a new `modelSelection` on the command (a copy; the input is not
 * changed). Model options are dropped when the provider or model changes (they are model-specific).
 * Returns the command unchanged when the decision cannot be applied (no provider known for a
 * command that named no model), with `applied: false`.
 */
export function applyTurnStartDecision<T extends CommandLike>(command: T, decision: AttributedDecision): { command: T; applied: boolean } {
  if (decision.action !== "modify") return { command, applied: false };
  const old = obj(command.modelSelection) as SelectionLike | null;
  const oldSel = selectionOf(old);
  const provider = decision.provider ?? oldSel.provider;
  const model = decision.model ?? oldSel.model;
  if (!provider || !model) return { command, applied: false };
  if (provider === oldSel.provider && model === oldSel.model) return { command, applied: false };
  const selection: Record<string, unknown> = { instanceId: provider, model };
  return { command: { ...command, modelSelection: selection }, applied: true };
}

/** One-line description for logs. */
export function describeContext(ctx: TurnStartContext): string {
  const who = [ctx.source, ctx.createdBy].filter(Boolean).join("/");
  const target = ctx.provider || ctx.model ? ` ${ctx.provider ?? "?"}/${ctx.model ?? "?"}` : "";
  return `${ctx.commandType} thread ${ctx.threadId}${target}${who ? ` (${who})` : ""}${ctx.isSubagent ? " subagent" : ""}${ctx.continuation ? ` ${ctx.continuation}` : ""}`;
}
