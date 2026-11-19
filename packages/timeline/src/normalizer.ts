import type {
  CauseRelation,
  Timeline,
  TimelineCause,
  TimelineChange,
  TimelineKind,
  TimelineRecord,
} from "./types.js";
import { arr, errMsg, isObj, num, short, str, toMs, type Obj } from "./util.js";

/**
 * Incremental normalizer. See docs/wp-3c-notes.md for the record kinds and the exact cause rules.
 *
 * Model: every record lives in a "slot" that owns a pure `build(ctx)` function over the current
 * index state (runs, nodes, runtime requests, handoffs, subagents, ...). A build reports which keys
 * it read (`ctx.watch`); when one of those keys changes (an index entry is written, or a record it
 * could point at is created) the slot is rebuilt. That makes `cause` independent of arrival order:
 * an approval request that arrives before its tool node still gets linked once the node shows up.
 */

interface Candidate {
  id: string;
  relation: CauseRelation;
}

interface Draft {
  threadId: string | null;
  at: number;
  kind: TimelineKind;
  runId: string | null;
  provider: string;
  summary: string;
  status: string | null;
  candidates: Candidate[];
  raw: unknown;
}

interface Ctx {
  watch(key: string): void;
}

interface Slot {
  id: string;
  order: number;
  sequence: number | null;
  build: (ctx: Ctx) => Draft | null;
  watching: Set<string>;
  rec: TimelineRecord | undefined;
}

const TOOL_TYPES = new Set(["command_execution", "file_change", "file_search", "web_search", "dynamic_tool"]);
const REQUEST_ITEM_TYPES = new Set(["approval_request", "user_input_request"]);
const TERMINAL_RUN = new Set(["completed", "interrupted", "failed", "cancelled", "rolled_back"]);
const TERMINAL_SUB = new Set(["completed", "failed", "cancelled", "interrupted"]);

/** Event types handled only for their effect on indexes / thread state, or deliberately not surfaced. */
const SILENT_EVENTS = new Set([
  "message.updated",
  "plan.updated",
  "node.updated",
  "provider-session.attached",
  "provider-session.updated",
  "provider-session.detached",
  "provider-thread.updated",
  "provider-turn.updated",
  "checkpoint-scope.created",
  "checkpoint.captured",
  "checkpoint.rollback-requested",
  "context-transfer.created",
  "context-transfer.updated",
  "run.background-work-cancelled",
  "run-attempt.created",
  "run-attempt.updated",
  "thread.visit-recorded",
  "thread.pull-request-link-updated",
  "thread.pull-request-synced",
  "thread.metadata-updated",
  "thread.runtime-mode-updated",
  "thread.interaction-mode-updated",
  "thread.settled",
  "thread.unsettled",
  "thread.snoozed",
  "thread.unsnoozed",
  "thread.pinned",
  "thread.unpinned",
  "thread.pin-reordered",
  "thread.active-reordered",
  "thread.auto-settle-set",
  "thread.tags-updated",
  "thread.visited",
  "thread.marked-unread",
  "thread.guest-share-updated",
]);
const LIFECYCLE_EVENTS = new Set(["thread.created", "thread.archived", "thread.unarchived", "thread.deleted"]);

const KIND_RANK: Partial<Record<TimelineKind, number>> = { "run.start": 0, "run.end": 2, "subagent.end": 2 };

export function createTimeline(): Timeline {
  let slots = new Map<string, Slot>();
  let deps = new Map<string, Set<string>>();
  let orderCounter = 0;
  let unknownCounter = 0;
  let cache: TimelineRecord[] | null = null;

  // ---- index state (all raw upstream entities, last write wins) ----
  let runs = new Map<string, Obj>();
  let nodes = new Map<string, Obj>();
  let requests = new Map<string, Obj>();
  let handoffs = new Map<string, Obj>();
  let subEntities = new Map<string, Obj>();
  let subItems = new Map<string, Obj>();
  let msgToItem = new Map<string, string>(); // messageId -> record id of the user_message item
  let itemsByNode = new Map<string, Array<{ rid: string; type: string }>>();
  let reqToItem = new Map<string, string>(); // runtime request id -> record id of its request item
  let thread: { provider: string | null; model: string | null; modelInstance: string | null } = {
    provider: null,
    model: null,
    modelInstance: null,
  };

  let appliedSeq = new Set<number>();
  let snapshotSeq = -1;
  let lastSnapshotSeq: number | null = null;

  const listeners = new Set<(c: TimelineChange) => void>();
  let added = new Map<string, TimelineRecord>();
  let updated = new Map<string, TimelineRecord>();

  // ---- slot engine ----

  function sigOf(r: Pick<TimelineRecord, "kind" | "at" | "runId" | "provider" | "summary" | "status" | "cause" | "threadId">): string {
    return JSON.stringify([r.kind, r.at, r.runId, r.provider, r.summary, r.status, r.cause, r.threadId]);
  }
  function stampOf(raw: unknown): string {
    if (!isObj(raw)) return "";
    return `${str(raw.updatedAt) ?? str(raw.occurredAt) ?? ""}|${str(raw.status) ?? ""}|${str(raw.completedAt) ?? ""}`;
  }

  function runBuild(slot: Slot): void {
    for (const k of slot.watching) deps.get(k)?.delete(slot.id);
    slot.watching = new Set();
    const watch = (key: string): void => {
      slot.watching.add(key);
      let s = deps.get(key);
      if (!s) deps.set(key, (s = new Set()));
      s.add(slot.id);
    };
    let draft: Draft | null;
    try {
      draft = slot.build({ watch });
    } catch (e) {
      draft = {
        threadId: null,
        at: slot.rec?.at ?? 0,
        kind: "unknown",
        runId: null,
        provider: "unknown",
        summary: `Failed to normalise: ${short(errMsg(e), 100)}`,
        status: null,
        candidates: [],
        raw: slot.rec?.raw ?? null,
      };
    }
    if (!draft) return;
    let cause: TimelineCause | null = null;
    for (const c of draft.candidates) {
      if (c.id !== slot.id) watch(`rec:${c.id}`);
      if (!cause && c.id !== slot.id && slots.get(c.id)?.rec) cause = { recordId: c.id, relation: c.relation };
    }
    const old = slot.rec;
    const next: TimelineRecord = {
      id: slot.id,
      threadId: draft.threadId,
      sequence: slot.sequence,
      at: draft.at,
      kind: draft.kind,
      runId: draft.runId,
      provider: draft.provider,
      summary: draft.summary,
      status: draft.status,
      cause,
      raw: draft.raw,
    };
    if (old?.enrichment) next.enrichment = old.enrichment;
    if (old && sigOf(old) === sigOf(next) && stampOf(old.raw) === stampOf(next.raw)) return;
    slot.rec = next;
    cache = null;
    if (!old) added.set(slot.id, next);
    else if (added.has(slot.id)) added.set(slot.id, next);
    else updated.set(slot.id, next);
    if (!old) touch(`rec:${slot.id}`);
  }

  function touch(key: string): void {
    const set = deps.get(key);
    if (!set) return;
    for (const id of [...set]) {
      const s = slots.get(id);
      if (s) runBuild(s);
    }
  }

  function upsert(id: string, sequence: number | null, build: (ctx: Ctx) => Draft | null): void {
    let slot = slots.get(id);
    if (!slot) {
      slot = { id, order: orderCounter++, sequence, build, watching: new Set(), rec: undefined };
      slots.set(id, slot);
    } else {
      slot.build = build;
      slot.sequence = sequence;
    }
    runBuild(slot);
  }

  function flush(): void {
    if (added.size === 0 && updated.size === 0) return;
    const change: TimelineChange = { added: [...added.values()], updated: [...updated.values()], reset: false };
    added = new Map();
    updated = new Map();
    for (const cb of [...listeners]) {
      try {
        cb(change);
      } catch {
        /* a listener must not break the normalizer */
      }
    }
  }

  // ---- helpers shared by builders ----

  function providerFor(ctx: Ctx, runId: string | null, evProvider: string | null): string {
    if (runId) {
      ctx.watch(`run:${runId}`);
      const p = str(runs.get(runId)?.providerInstanceId);
      if (p) return p;
    }
    if (evProvider) return evProvider;
    ctx.watch("thread");
    return thread.provider ?? "unknown";
  }

  /** Tool item that owns `nodeId` (prefers real tool items over anything else on that node). */
  function toolItemOf(ctx: Ctx, nodeId: string | null): string | null {
    if (!nodeId) return null;
    ctx.watch(`inode:${nodeId}`);
    const list = itemsByNode.get(nodeId);
    if (!list) return null;
    const hit = list.find((e) => TOOL_TYPES.has(e.type)) ?? list.find((e) => !REQUEST_ITEM_TYPES.has(e.type));
    return hit?.rid ?? null;
  }

  /** Nearest subagent on the node ancestry of `nodeId` (including the node itself), or null. */
  function subagentOfNode(ctx: Ctx, nodeId: string | null, skipSelf: string | null): string | null {
    let cur = nodeId;
    for (let i = 0; cur && i < 8; i++) {
      ctx.watch(`sub:${cur}`);
      if (cur !== skipSelf && (subEntities.has(cur) || subItems.has(cur))) return cur;
      ctx.watch(`node:${cur}`);
      cur = str(nodes.get(cur)?.parentNodeId);
    }
    return null;
  }

  const runStartId = (runId: string): string => `run:${runId}:start`;

  // ---- turn items ----

  function itemKind(type: string): TimelineKind {
    switch (type) {
      case "user_message":
        return "message.user";
      case "assistant_message":
        return "message.assistant";
      case "reasoning":
        return "reasoning";
      case "proposed_plan":
      case "todo_list":
        return "plan";
      case "command_execution":
        return "command";
      case "file_change":
        return "file-change";
      case "file_search":
      case "web_search":
        return "search";
      case "dynamic_tool":
        return "tool";
      case "approval_request":
        return "approval.request";
      case "user_input_request":
        return "input.request";
      case "secret_request":
        return "secret-request";
      case "link_request":
        return "link-request";
      case "checkpoint":
        return "checkpoint";
      case "run_interrupt_request":
        return "interrupt.request";
      case "run_interrupt_result":
        return "interrupt.result";
      case "system_notice":
        return "notice";
      case "notification":
        return "notification";
      case "error":
        return "error";
      case "compaction":
        return "compaction";
      case "handoff":
        return "handoff";
      case "fork":
        return "fork";
      case "thread_created":
        return "thread.spawn";
      default:
        return "unknown";
    }
  }

  function itemSummary(item: Obj, type: string): string {
    switch (type) {
      case "user_message": {
        const sw = isObj(item.modelSwitch) ? item.modelSwitch : null;
        const to = sw && isObj(sw.to) ? str(sw.to.model) : null;
        return `You: ${short(item.text)}${to ? ` [model → ${to}]` : ""}`;
      }
      case "assistant_message":
        return `Assistant: ${short(item.text)}`;
      case "reasoning":
        return `Reasoning: ${short(item.text)}`;
      case "proposed_plan":
        return `Plan proposed: ${short(item.markdown, 100)}`;
      case "todo_list":
        return `Todo list: ${arr(item.steps).length} steps`;
      case "command_execution": {
        const code = num(item.exitCode);
        return `$ ${short(item.input, 110)}${code !== null && code !== 0 ? ` (exit ${code})` : ""}`;
      }
      case "file_change": {
        const a = num(item.additions);
        const d = num(item.deletions);
        const stat = a !== null || d !== null ? ` (+${a ?? 0} -${d ?? 0})` : "";
        return `Edit ${short(item.fileName, 100)}${stat}`;
      }
      case "file_search":
        return `Search files: ${short(item.pattern ?? "", 100)}`;
      case "web_search":
        return `Web search: ${short(arr(item.patterns)[0] ?? "", 100)}`;
      case "dynamic_tool":
        return `Tool ${str(item.toolName) ?? "call"}`;
      case "approval_request":
        return `Approval needed (${str(item.requestKind) ?? "request"}): ${short(item.prompt ?? item.reason ?? "", 100)}`;
      case "user_input_request": {
        const q = arr(item.questions)[0];
        const text = isObj(q) ? (str(q.question) ?? str(q.header) ?? str(q.prompt) ?? str(q.text) ?? "") : "";
        return `Input requested: ${short(text, 110)}`;
      }
      case "secret_request":
        return "Secret requested";
      case "link_request":
        return "Link requested";
      case "checkpoint":
        return `Checkpoint (${arr(item.files).length} files)`;
      case "run_interrupt_request":
        return `Interrupt requested: ${short(item.message, 100)}`;
      case "run_interrupt_result":
        return `Interrupt result: ${short(item.message, 100)}`;
      case "system_notice":
        return `Notice${str(item.level) ? ` (${String(item.level)})` : ""}: ${short(item.message, 110)}`;
      case "notification":
        return `Notification: ${short(item.summary, 110)}`;
      case "error": {
        const f = isObj(item.failure) ? item.failure : {};
        const retry = isObj(item.retry) ? ` (retry ${num(item.retry.attempt) ?? "?"}${num(item.retry.maxAttempts) ? `/${String(item.retry.maxAttempts)}` : ""})` : "";
        return `Error [${str(f.class) ?? "unknown"}]: ${short(f.message, 110)}${retry}`;
      }
      case "compaction": {
        const b = num(item.beforeTokenCount);
        const a = num(item.afterTokenCount);
        return `Context compacted${b !== null && a !== null ? ` (${b} → ${a} tokens)` : ""}`;
      }
      case "handoff": {
        const from = arr(item.fromProviderInstanceIds).filter((x) => typeof x === "string").join(", ") || "?";
        return `Handoff ${from} → ${str(item.toProviderInstanceId) ?? "?"} (${str(item.strategy) ?? "?"})`;
      }
      case "fork":
        return `Forked to thread ${str(item.targetThreadId) ?? "?"}`;
      case "thread_created":
        return `Spawned thread ${str(item.targetThreadId) ?? "?"} (${str(item.targetProviderInstanceId) ?? "?"} ${str(item.targetModel) ?? ""})`.trimEnd();
      default:
        return `Unrecognised item type ${type}`;
    }
  }

  function itemAt(item: Obj, fallback: number | null): number {
    return toMs(item.startedAt) ?? toMs(item.updatedAt) ?? fallback ?? 0;
  }

  function applyTurnItem(item: Obj, evProvider: string | null, evAt: number | null, seq: number | null): void {
    const type = str(item.type) ?? "unknown";
    const itemId = str(item.id);
    if (!itemId) throw new Error("turn item without id");

    if (type === "subagent") {
      const sid = str(item.subagentId) ?? str(item.nodeId);
      if (!sid) throw new Error("subagent item without subagentId");
      subItems.set(sid, item);
      applySubagent(sid, seq, evProvider);
      touch(`sub:${sid}`);
      return;
    }

    const rid = `item:${itemId}`;
    const nodeId = str(item.nodeId);
    const runId = str(item.runId);
    // indexes first, so dependents rebuilt below see them
    if (type === "user_message") {
      const mid = str(item.messageId);
      if (mid && msgToItem.get(mid) !== rid) {
        msgToItem.set(mid, rid);
        touch(`msg:${mid}`);
      }
    }
    if (REQUEST_ITEM_TYPES.has(type)) {
      const reqId = str(item.requestId);
      if (reqId && reqToItem.get(reqId) !== rid) {
        reqToItem.set(reqId, rid);
        touch(`reqitem:${reqId}`);
      }
    }
    if (nodeId) {
      const list = itemsByNode.get(nodeId) ?? [];
      if (!list.some((e) => e.rid === rid)) {
        list.push({ rid, type });
        itemsByNode.set(nodeId, list);
        touch(`inode:${nodeId}`);
      }
    }

    upsert(rid, seq, (ctx) => {
      const cands: Candidate[] = [];
      if (type === "approval_request" || type === "user_input_request") {
        // rule: request -> tool call that needed it, via runtimeRequest.nodeId / own node -> parentNodeId
        const reqId = str(item.requestId);
        if (reqId) {
          ctx.watch(`req:${reqId}`);
          const reqNode = str(requests.get(reqId)?.nodeId);
          if (reqNode) {
            ctx.watch(`node:${reqNode}`);
            const t = toolItemOf(ctx, str(nodes.get(reqNode)?.parentNodeId));
            if (t) cands.push({ id: t, relation: "approval-for" });
          }
        }
        if (nodeId) {
          ctx.watch(`node:${nodeId}`);
          const t = toolItemOf(ctx, str(nodes.get(nodeId)?.parentNodeId));
          if (t) cands.push({ id: t, relation: "approval-for" });
        }
      }
      if (type === "handoff") {
        const hid = str(item.contextHandoffId);
        if (hid) {
          ctx.watch(`handoff:${hid}`);
          const target = str(handoffs.get(hid)?.targetRunId);
          if (target) cands.push({ id: runStartId(target), relation: "handoff-into" });
        }
      }
      const parent = str(item.parentItemId);
      if (parent) cands.push({ id: `item:${parent}`, relation: "child-of" });
      const sub = subagentOfNode(ctx, nodeId, null);
      if (sub) cands.push({ id: `subagent:${sub}:start`, relation: "in-subagent" });
      if (runId) {
        let triggers = false;
        if (type === "user_message") {
          ctx.watch(`run:${runId}`);
          const run = runs.get(runId);
          triggers = !!run && str(run.userMessageId) === str(item.messageId);
        }
        if (!triggers) cands.push({ id: runStartId(runId), relation: "in-run" });
      }
      return {
        threadId: str(item.threadId),
        at: itemAt(item, evAt),
        kind: itemKind(type),
        runId,
        provider: providerFor(ctx, runId, evProvider),
        summary: itemSummary(item, type),
        status: str(item.status),
        candidates: cands,
        raw: item,
      };
    });
  }

  // ---- runs ----

  function applyRun(run: Obj, seq: number | null): void {
    const id = str(run.id);
    if (!id) throw new Error("run without id");
    runs.set(id, run);
    touch(`run:${id}`);
    const model = isObj(run.modelSelection) ? str(run.modelSelection.model) : null;
    const ordinal = num(run.ordinal);
    upsert(runStartId(id), seq, (ctx) => {
      const cands: Candidate[] = [];
      const prev = str(run.restartContinuationOfRunId) ?? str(run.manualContinuationOfRunId) ?? str(run.usageLimitContinuationOfRunId);
      if (prev) cands.push({ id: `run:${prev}:end`, relation: "continues" });
      const delegated = str(run.delegatedTaskId);
      if (delegated) cands.push({ id: `subagent:${delegated}:start`, relation: "delegated-by" });
      const mid = str(run.userMessageId);
      if (mid) {
        ctx.watch(`msg:${mid}`);
        const rid = msgToItem.get(mid);
        if (rid) cands.push({ id: rid, relation: "triggered-by" });
      }
      const prov = str(run.providerInstanceId) ?? "unknown";
      return {
        threadId: str(run.threadId),
        at: toMs(run.requestedAt) ?? toMs(run.startedAt) ?? 0,
        kind: "run.start",
        runId: id,
        provider: prov,
        summary: `Run #${ordinal ?? "?"} on ${prov}${model ? ` (${model})` : ""}`,
        status: str(run.status),
        candidates: cands,
        raw: run,
      };
    });
    const status = str(run.status);
    if (status && TERMINAL_RUN.has(status)) {
      upsert(`run:${id}:end`, seq, () => {
        const prov = str(run.providerInstanceId) ?? "unknown";
        return {
          threadId: str(run.threadId),
          at: toMs(run.completedAt) ?? toMs(run.startedAt) ?? toMs(run.requestedAt) ?? 0,
          kind: "run.end",
          runId: id,
          provider: prov,
          summary: `Run #${ordinal ?? "?"} ${status}`,
          status,
          candidates: [{ id: runStartId(id), relation: "ends" }],
          raw: run,
        };
      });
    }
  }

  // ---- runtime requests (approvals / input) ----

  function applyRequest(req: Obj, seq: number | null, evRunId: string | null, evProvider: string | null): void {
    const id = str(req.id);
    if (!id) throw new Error("runtime request without id");
    requests.set(id, req);
    touch(`req:${id}`);
    const status = str(req.status);
    if (!status || status === "pending") return;
    upsert(`request:${id}:resolved`, seq, (ctx) => {
      const cands: Candidate[] = [];
      ctx.watch(`reqitem:${id}`);
      const item = reqToItem.get(id);
      if (item) cands.push({ id: item, relation: "resolves" });
      const nodeId = str(req.nodeId);
      let runId = evRunId;
      if (nodeId) {
        ctx.watch(`node:${nodeId}`);
        const node = nodes.get(nodeId);
        runId = runId ?? str(node?.runId);
        const t = toolItemOf(ctx, str(node?.parentNodeId));
        if (t) cands.push({ id: t, relation: "approval-for" });
      }
      const isInput = str(req.kind) === "user_input";
      const label = isInput ? "Input" : "Approval";
      const decision = str(req.decision);
      return {
        threadId: null,
        at: toMs(req.resolvedAt) ?? toMs(req.createdAt) ?? 0,
        kind: isInput ? "input.resolved" : "approval.resolved",
        runId,
        provider: providerFor(ctx, runId, evProvider),
        summary: status === "resolved" ? `${label} resolved${decision ? `: ${decision}` : ""} (${str(req.kind) ?? "request"})` : `${label} ${status} (${str(req.kind) ?? "request"})`,
        status,
        candidates: cands,
        raw: req,
      };
    });
  }

  // ---- subagents (entity and turn item merged) ----

  function applySubagent(sid: string, seq: number | null, evProvider: string | null): void {
    const merged = (): Obj => ({ ...(subItems.get(sid) ?? {}), ...(subEntities.get(sid) ?? {}) });
    const m0 = merged();
    const status0 = str(m0.status);
    upsert(`subagent:${sid}:start`, seq, (ctx) => {
      const ent = subEntities.get(sid);
      const item = subItems.get(sid);
      const m = merged();
      const cands: Candidate[] = [];
      const parentItem = str(item?.parentItemId);
      if (parentItem) cands.push({ id: `item:${parentItem}`, relation: "spawned-by" });
      const pn = str(ent?.parentNodeId);
      if (pn) {
        ctx.watch(`node:${pn}`);
        const t = toolItemOf(ctx, pn);
        if (t) cands.push({ id: t, relation: "spawned-by" });
      }
      const outer = subagentOfNode(ctx, pn ?? str(item?.nodeId), sid);
      if (outer) cands.push({ id: `subagent:${outer}:start`, relation: "in-subagent" });
      const runId = str(m.runId);
      if (runId) cands.push({ id: runStartId(runId), relation: "in-run" });
      const title = str(m.title) ?? short(m.prompt, 80);
      return {
        threadId: str(m.threadId),
        at: toMs(m.startedAt) ?? toMs(m.updatedAt) ?? 0,
        kind: "subagent.start",
        runId,
        provider: str(m.providerInstanceId) ?? providerFor(ctx, runId, evProvider),
        summary: `Subagent started: ${short(title, 100)}`,
        status: str(m.status),
        candidates: cands,
        raw: ent ?? item,
      };
    });
    if (status0 && TERMINAL_SUB.has(status0)) {
      upsert(`subagent:${sid}:end`, seq, (ctx) => {
        const m = merged();
        const status = str(m.status) ?? status0;
        const runId = str(m.runId);
        return {
          threadId: str(m.threadId),
          at: toMs(m.completedAt) ?? toMs(m.updatedAt) ?? 0,
          kind: "subagent.end",
          runId,
          provider: str(m.providerInstanceId) ?? providerFor(ctx, runId, evProvider),
          summary: `Subagent ${status}${str(m.result) ? `: ${short(m.result, 100)}` : ""}`,
          status,
          candidates: [{ id: `subagent:${sid}:start`, relation: "ends" }],
          raw: subEntities.get(sid) ?? subItems.get(sid),
        };
      });
    }
  }

  // ---- thread events ----

  function noteThread(payload: unknown): void {
    if (!isObj(payload)) return;
    const p = str(payload.providerInstanceId);
    const ms = isObj(payload.modelSelection) ? payload.modelSelection : null;
    const changed = (p !== null && p !== thread.provider) || (ms !== null && str(ms.model) !== thread.model);
    if (p) thread.provider = p;
    if (ms) {
      thread.model = str(ms.model) ?? thread.model;
      thread.modelInstance = str(ms.instanceId) ?? thread.modelInstance;
    }
    if (changed) touch("thread");
  }

  function applyThreadEvent(ev: Obj, type: string, seq: number): void {
    const payload = isObj(ev.payload) ? ev.payload : {};
    const evId = str(ev.id) ?? `seq:${seq}`;
    const at = toMs(ev.occurredAt) ?? 0;
    const evProvider = str(ev.providerInstanceId);
    const threadId = str(ev.threadId);
    if (type === "thread.provider-switched") {
      const to = str(payload.providerInstanceId) ?? evProvider ?? "unknown";
      const from = thread.provider;
      const toModel = isObj(payload.modelSelection) ? str(payload.modelSelection.model) : null;
      noteThread(payload);
      if (from !== null && from === to) return; // no-op switch
      upsert(`event:${evId}`, seq, () => ({
        threadId,
        at,
        kind: "provider-switch",
        runId: str(ev.runId),
        provider: to,
        summary: `Provider switch ${from ?? "?"} → ${to}${toModel ? ` (${toModel})` : ""}`,
        status: null,
        candidates: [],
        raw: ev,
      }));
      return;
    }
    if (type === "thread.model-selection-updated") {
      const ms = isObj(payload.modelSelection) ? payload.modelSelection : {};
      const toModel = str(ms.model);
      const toInst = str(ms.instanceId) ?? str(payload.providerInstanceId);
      const fromModel = thread.model;
      const fromInst = thread.modelInstance;
      noteThread(payload);
      if (fromModel !== null && fromModel === toModel && fromInst === toInst) return;
      upsert(`event:${evId}`, seq, () => ({
        threadId,
        at,
        kind: "model-switch",
        runId: str(ev.runId),
        provider: toInst ?? evProvider ?? "unknown",
        summary: `Model ${fromModel ?? "?"} → ${toModel ?? "?"}${toInst && toInst !== fromInst && fromInst ? ` (${fromInst} → ${toInst})` : ""}`,
        status: null,
        candidates: [],
        raw: ev,
      }));
      return;
    }
    // lifecycle
    noteThread(payload);
    upsert(`event:${evId}`, seq, () => ({
      threadId,
      at,
      kind: "thread.lifecycle",
      runId: null,
      provider: str(payload.providerInstanceId) ?? evProvider ?? "unknown",
      summary: `Thread ${type.slice("thread.".length)}${str(payload.title) ? `: ${short(payload.title, 80)}` : ""}`,
      status: null,
      candidates: [],
      raw: ev,
    }));
  }

  function recordUnknown(raw: unknown, seq: number | null, why: string, idHint: string | null): void {
    const id = idHint ? `unknown:${idHint}` : `unknown:#${unknownCounter++}`;
    let at = 0;
    let provider = "unknown";
    let threadId: string | null = null;
    let runId: string | null = null;
    const ev = isObj(raw) && isObj(raw.event) ? raw.event : isObj(raw) ? raw : null;
    if (ev) {
      at = toMs(ev.occurredAt) ?? 0;
      provider = str(ev.providerInstanceId) ?? provider;
      threadId = str(ev.threadId);
      runId = str(ev.runId);
    }
    upsert(id, seq, () => ({
      threadId,
      at,
      kind: "unknown",
      runId,
      provider,
      summary: short(why, 140),
      status: null,
      candidates: runId ? [{ id: runStartId(runId), relation: "in-run" }] : [],
      raw,
    }));
  }

  // ---- public apply ----

  function handleEvent(ev: Obj, seq: number): void {
    const type = str(ev.type);
    if (!type) {
      recordUnknown(ev, seq, "Event without type", `event:${str(ev.id) ?? `seq:${seq}`}`);
      return;
    }
    const payload = ev.payload;
    const evProvider = str(ev.providerInstanceId);
    const evAt = toMs(ev.occurredAt);
    switch (type) {
      case "turn-item.updated":
        if (!isObj(payload)) throw new Error("turn-item.updated without payload");
        applyTurnItem(payload, evProvider, evAt, seq);
        return;
      case "run.created":
      case "run.updated":
        if (!isObj(payload)) throw new Error(`${type} without payload`);
        applyRun(payload, seq);
        return;
      case "runtime-request.updated":
        if (!isObj(payload)) throw new Error(`${type} without payload`);
        applyRequest(payload, seq, str(ev.runId), evProvider);
        return;
      case "subagent.updated": {
        if (!isObj(payload)) throw new Error(`${type} without payload`);
        const sid = str(payload.id);
        if (!sid) throw new Error("subagent without id");
        subEntities.set(sid, payload);
        applySubagent(sid, seq, evProvider);
        touch(`sub:${sid}`);
        return;
      }
      case "node.updated": {
        if (!isObj(payload)) return;
        const nid = str(payload.id);
        if (nid) {
          nodes.set(nid, payload);
          touch(`node:${nid}`);
        }
        return;
      }
      case "context-handoff.updated": {
        if (!isObj(payload)) return;
        const hid = str(payload.id);
        if (hid) {
          handoffs.set(hid, payload);
          touch(`handoff:${hid}`);
        }
        return;
      }
      default:
        break;
    }
    if (type === "thread.provider-switched" || type === "thread.model-selection-updated" || LIFECYCLE_EVENTS.has(type)) {
      applyThreadEvent(ev, type, seq);
      return;
    }
    if (SILENT_EVENTS.has(type)) {
      if (type.startsWith("thread.")) noteThread(payload);
      return;
    }
    recordUnknown(ev, seq, `Unrecognised event ${type}`, `event:${str(ev.id) ?? `seq:${seq}`}`);
  }

  function handleProjection(projection: Obj, seq: number): void {
    if (isObj(projection.thread)) noteThread(projection.thread);
    // indexes first
    for (const n of arr(projection.nodes)) {
      if (isObj(n) && str(n.id)) {
        nodes.set(String(n.id), n);
        touch(`node:${String(n.id)}`);
      }
    }
    for (const h of arr(projection.contextHandoffs)) {
      if (isObj(h) && str(h.id)) {
        handoffs.set(String(h.id), h);
        touch(`handoff:${String(h.id)}`);
      }
    }
    for (const s of arr(projection.subagents)) {
      if (isObj(s) && str(s.id)) subEntities.set(String(s.id), s);
    }
    const tasks: Array<() => void> = [];
    for (const r of arr(projection.runs)) if (isObj(r)) tasks.push(() => applyRun(r, seq));
    // items: local turnItems plus local/synthetic visible ones (inherited belong to another thread)
    const byId = new Map<string, Obj>();
    for (const it of arr(projection.turnItems)) if (isObj(it) && str(it.id)) byId.set(String(it.id), it);
    for (const v of arr(projection.visibleTurnItems)) {
      if (!isObj(v) || !isObj(v.item)) continue;
      if (str(v.visibility) === "inherited") continue;
      const id = str(v.item.id);
      if (id && !byId.has(id)) byId.set(id, v.item);
    }
    const items = [...byId.values()].sort((a, b) => (num(a.ordinal) ?? 0) - (num(b.ordinal) ?? 0));
    for (const it of items) tasks.push(() => applyTurnItem(it, null, null, seq));
    for (const s of arr(projection.subagents)) {
      if (isObj(s) && str(s.id)) tasks.push(() => { applySubagent(String(s.id), seq, null); touch(`sub:${String(s.id)}`); });
    }
    for (const q of arr(projection.runtimeRequests)) if (isObj(q)) tasks.push(() => applyRequest(q, seq, null, null));
    for (const t of tasks) {
      try {
        t();
      } catch (e) {
        recordUnknown(projection, seq, `Failed to normalise snapshot entry: ${errMsg(e)}`, null);
      }
    }
  }

  const api: Timeline = {
    applySnapshot(item) {
      try {
        if (!isObj(item) || !isObj(item.projection)) {
          recordUnknown(item, null, "Malformed snapshot item", null);
          return;
        }
        const seq = num(item.snapshotSequence);
        if (seq !== null) {
          if (lastSnapshotSeq !== null && seq <= lastSnapshotSeq) return; // duplicate / older snapshot
          lastSnapshotSeq = seq;
          snapshotSeq = Math.max(snapshotSeq, seq);
        }
        handleProjection(item.projection, seq ?? 0);
      } catch (e) {
        recordUnknown(item, null, `Failed to normalise snapshot: ${errMsg(e)}`, null);
      } finally {
        flush();
      }
    },
    applyEvent(item) {
      try {
        if (!isObj(item) || !isObj(item.event)) {
          recordUnknown(item, null, "Malformed event item", null);
          return;
        }
        const seq = num(item.sequence);
        if (seq !== null) {
          if (appliedSeq.has(seq) || seq <= snapshotSeq) return; // duplicate, or already inside the snapshot
          appliedSeq.add(seq);
        }
        try {
          handleEvent(item.event, seq ?? -1);
        } catch (e) {
          recordUnknown(item.event, seq, `Failed to normalise ${str(item.event.type) ?? "event"}: ${errMsg(e)}`, `event:${str(item.event.id) ?? `seq:${seq}`}`);
        }
      } catch {
        /* never throw */
      } finally {
        flush();
      }
    },
    apply(item) {
      if (!isObj(item)) {
        recordUnknown(item, null, "Non-object stream item", null);
        flush();
        return;
      }
      switch (item.kind) {
        case "snapshot":
          api.applySnapshot(item);
          return;
        case "event":
          api.applyEvent(item);
          return;
        case "synchronized":
          return;
        default:
          recordUnknown(item, num(item.sequence), `Unrecognised stream item kind ${String(item.kind)}`, null);
          flush();
      }
    },
    records() {
      if (!cache) {
        cache = [...slots.values()]
          .filter((s): s is Slot & { rec: TimelineRecord } => s.rec !== undefined)
          .sort((a, b) => a.rec.at - b.rec.at || (KIND_RANK[a.rec.kind] ?? 1) - (KIND_RANK[b.rec.kind] ?? 1) || a.order - b.order)
          .map((s) => s.rec);
      }
      return [...cache];
    },
    get(id) {
      return slots.get(id)?.rec;
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    reset() {
      slots = new Map();
      deps = new Map();
      orderCounter = 0;
      unknownCounter = 0;
      cache = null;
      runs = new Map();
      nodes = new Map();
      requests = new Map();
      handoffs = new Map();
      subEntities = new Map();
      subItems = new Map();
      msgToItem = new Map();
      itemsByNode = new Map();
      reqToItem = new Map();
      thread = { provider: null, model: null, modelInstance: null };
      appliedSeq = new Set();
      snapshotSeq = -1;
      lastSnapshotSeq = null;
      added = new Map();
      updated = new Map();
      for (const cb of [...listeners]) {
        try {
          cb({ added: [], updated: [], reset: true });
        } catch {
          /* ignore */
        }
      }
    },
  };
  return api;
}
