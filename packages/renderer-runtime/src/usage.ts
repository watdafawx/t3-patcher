import { type T3Usage, type TokenTotals, type UsageRange, type UsageSummary } from "@t3p/api";

import { requireRpc, type SharedRpc } from "./rpc.js";
import type { Scope } from "./scope.js";
import type { RemoteLog } from "./types.js";
import { threadStore } from "./threads.js";

// ---------------------------------------------------------------------------------------------
// Which fields are summed
// ---------------------------------------------------------------------------------------------
//
// A thread projection (`orchestration.getThreadProjection`) carries one `providerTurns[]` entry
// per provider turn. Each may carry `tokenUsage` (contracts `OrchestrationV2ProviderTurnTokenUsage`,
// orchestrationV2.ts:230-242). Only these three counters are summed:
//
//   inputTokens        += turn.tokenUsage.inputTokens        ?? 0
//   cachedInputTokens  += turn.tokenUsage.cachedInputTokens  ?? 0
//   outputTokens       += turn.tokenUsage.outputTokens       ?? 0
//   totalTokens         = inputTokens + cachedInputTokens + outputTokens
//
// `totalTokens` counts cache reads as tokens processed, so it is the sum of the three counters
// above. NOT summed: `usedTokens` (the context-window gauge, not a per-turn cost; `usage.context()` returns the latest value), `maxTokens`,
// `reasoningOutputTokens` (an output subset in some providers, already inside `outputTokens`),
// `promptCacheTtlMs`, `promptCacheExpiresAt`, `autoCompactThreshold`, and the separate
// `turnTokenUsage` object (a turn-level roll-up that overlaps `tokenUsage`; summing both would
// double count).
//
// A turn belongs to the moment it finished: `completedAt`, else `startedAt`, else
// `tokenUsage.updatedAt` (epoch ms). The range filter is inclusive on both ends.
// `byProvider` is keyed by the provider instance that ran the turn (`providerThreads[]`), with
// the projection's `thread.providerInstanceId` as the fallback when the provider thread is gone.

interface ProviderTurnUsageWire {
  inputTokens?: unknown;
  cachedInputTokens?: unknown;
  outputTokens?: unknown;
  usedTokens?: unknown;
  maxTokens?: unknown;
  updatedAt?: unknown;
}

interface ProviderTurnWire {
  providerThreadId?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
  tokenUsage?: ProviderTurnUsageWire | null;
}

interface ProviderThreadWire {
  id?: unknown;
  providerInstanceId?: unknown;
}

interface ProjectionWire {
  thread?: { providerInstanceId?: unknown } | null;
  providerThreads?: ProviderThreadWire[] | null;
  providerTurns?: ProviderTurnWire[] | null;
}

interface Summed {
  totals: TokenTotals;
  byProvider: Map<string, TokenTotals>;
  /** Turns that carried `tokenUsage` and matched the range. */
  turns: number;
}

function emptyTotals(): TokenTotals {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function addInto(into: TokenTotals, from: TokenTotals): void {
  into.inputTokens += from.inputTokens;
  into.cachedInputTokens += from.cachedInputTokens;
  into.outputTokens += from.outputTokens;
  into.totalTokens += from.totalTokens;
}

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/** Epoch ms of a turn, or NaN when no timestamp parses. */
function turnTime(turn: ProviderTurnWire): number {
  for (const value of [turn.completedAt, turn.startedAt, turn.tokenUsage?.updatedAt]) {
    if (typeof value !== "string") continue;
    const at = Date.parse(value);
    if (!Number.isNaN(at)) return at;
  }
  return Number.NaN;
}

function inRange(at: number, range: UsageRange): boolean {
  if (Number.isNaN(at)) return false;
  if (range.from !== undefined && at < range.from) return false;
  if (range.to !== undefined && at > range.to) return false;
  return true;
}

function sumProjection(projection: ProjectionWire, range: UsageRange | null): Summed {
  const totals = emptyTotals();
  const byProvider = new Map<string, TokenTotals>();
  const providers = new Map<string, string>();
  for (const providerThread of projection.providerThreads ?? []) {
    if (typeof providerThread?.id === "string" && typeof providerThread.providerInstanceId === "string") {
      providers.set(providerThread.id, providerThread.providerInstanceId);
    }
  }
  const threadProvider = typeof projection.thread?.providerInstanceId === "string" ? projection.thread.providerInstanceId : "unknown";
  let turns = 0;
  for (const turn of projection.providerTurns ?? []) {
    const usage = turn?.tokenUsage;
    if (!usage) continue;
    if (range && !inRange(turnTime(turn), range)) continue;
    const providerThreadId = typeof turn.providerThreadId === "string" ? turn.providerThreadId : "";
    const provider = providers.get(providerThreadId) ?? threadProvider;
    const per: TokenTotals = {
      inputTokens: count(usage.inputTokens),
      cachedInputTokens: count(usage.cachedInputTokens),
      outputTokens: count(usage.outputTokens),
      totalTokens: 0,
    };
    per.totalTokens = per.inputTokens + per.cachedInputTokens + per.outputTokens;
    addInto(totals, per);
    const existing = byProvider.get(provider);
    if (existing) addInto(existing, per);
    else byProvider.set(provider, per);
    turns++;
  }
  return { totals, byProvider, turns };
}

/** Latest context-window gauge of a projection: the newest turn that reported each field. */
export function latestContext(projection: ProjectionWire): { usedTokens: number | null; maxTokens: number | null } {
  let usedTokens: number | null = null;
  let maxTokens: number | null = null;
  let usedAt = Number.NEGATIVE_INFINITY;
  let maxAt = Number.NEGATIVE_INFINITY;
  let index = 0;
  for (const turn of projection.providerTurns ?? []) {
    const usage = turn?.tokenUsage;
    index++;
    if (!usage) continue;
    // Newest by timestamp; array order breaks ties and covers turns with no parseable time.
    const parsed = turnTime(turn);
    const at = (Number.isNaN(parsed) ? 0 : parsed) + index * 1e-6;
    if (count(usage.usedTokens) > 0 && at >= usedAt) {
      usedAt = at;
      usedTokens = count(usage.usedTokens);
    }
    if (count(usage.maxTokens) > 0 && at >= maxAt) {
      maxAt = at;
      maxTokens = count(usage.maxTokens);
    }
  }
  return { usedTokens, maxTokens };
}

export interface UsageDeps {
  id: string;
  allowed: boolean;
  shared: SharedRpc;
  scope: Scope;
  log: RemoteLog;
}

/** `t3.usage` for one plugin. Needs the `rpc` permission. Reads every thread projection. */
export function createUsageApi(deps: UsageDeps): T3Usage {
  const { id, allowed, shared, scope, log } = deps;
  const need = (): void => {
    requireRpc(id, allowed);
    scope.assertAlive();
  };
  const project = async (threadId: string): Promise<ProjectionWire> => {
    const { client } = await shared.ready();
    return (await client.call("orchestration.getThreadProjection", { threadId })) as ProjectionWire;
  };

  return Object.freeze({
    async summary(range: UsageRange = {}): Promise<UsageSummary> {
      need();
      if (range === null || typeof range !== "object") throw new TypeError("range must be an object");
      const bounded = range.from !== undefined || range.to !== undefined;
      const totals = emptyTotals();
      const byThread: Record<string, TokenTotals> = {};
      const byProvider: Record<string, TokenTotals> = {};
      for (const thread of await threadStore(shared, log).list()) {
        // Cheap skip: a thread whose last activity is before the range cannot hold a turn inside
        // it. (`updatedAt` only grows, so this is safe; the per-turn filter below is exact.)
        if (bounded && range.from !== undefined && thread.updatedAt !== null) {
          const lastActivity = Date.parse(thread.updatedAt);
          if (!Number.isNaN(lastActivity) && lastActivity < range.from) continue;
        }
        const summed = sumProjection(await project(thread.threadId), bounded ? range : null);
        if (summed.turns === 0) continue;
        byThread[thread.threadId] = summed.totals;
        addInto(totals, summed.totals);
        for (const [provider, per] of summed.byProvider) {
          const into = byProvider[provider] ?? (byProvider[provider] = emptyTotals());
          addInto(into, per);
        }
      }
      return { range: { ...range }, totals, byThread, byProvider };
    },
    async thread(threadId: string): Promise<TokenTotals> {
      need();
      if (typeof threadId !== "string" || threadId.length === 0) throw new TypeError("threadId must be a non-empty string");
      return sumProjection(await project(threadId), null).totals;
    },
    async context(threadId: string): Promise<{ usedTokens: number | null; maxTokens: number | null }> {
      need();
      if (typeof threadId !== "string" || threadId.length === 0) throw new TypeError("threadId must be a non-empty string");
      return latestContext(await project(threadId));
    },
  });
}
