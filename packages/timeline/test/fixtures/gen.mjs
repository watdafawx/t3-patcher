// Regenerates the synthetic fixtures: `node packages/timeline/test/fixtures/gen.mjs`.
// Shapes follow the JSON side (Encoded) of orchestrationV2.ts at upstream v0.1.10 (turn items,
// runtime requests, handoffs, subagents, nodes, runs), cross-checked against the captured real
// frames in real-failed-run.json (docs/spikes/wp-0d). ids follow the real id grammar.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const THREAD = "7d0f2c1e-5b1a-4c63-9d0e-3a2f1b9c8e11";
const enc = encodeURIComponent;
const runId = (n) => `run:thread:${THREAD}:ordinal:${n}`;
const rootNode = (n) => `node:run:${enc(runId(n))}:root`;
const nativeNode = (driver, id) => `node:provider:${driver}:native-item:${id}`;
const nativeItem = (driver, id) => `turn-item:provider:${driver}:native-item:${id}`;
const t0 = Date.parse("2026-11-19T10:00:00.000Z");
const iso = (s) => new Date(t0 + s * 1000).toISOString();

let seq = 100;
let evN = 0;
const ev = (type, payload, o = {}) => ({
  kind: "event",
  sequence: ++seq,
  event: {
    id: `event:thread:${THREAD}:command:c${++evN}:e${evN}`,
    threadId: THREAD,
    ...(o.runId ? { runId: o.runId } : {}),
    ...(o.nodeId ? { nodeId: o.nodeId } : {}),
    providerInstanceId: o.provider ?? "claudeAgent",
    occurredAt: iso(o.at ?? 0),
    type,
    payload,
  },
});

const appThread = (provider, model, extra = {}) => ({
  createdBy: "user", creationSource: "web", id: THREAD, projectId: "proj-1", title: "demo",
  providerInstanceId: provider, modelSelection: { instanceId: provider, model },
  runtimeMode: "approval-required", interactionMode: "default", branch: null, worktreePath: null,
  pullRequests: [], activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: THREAD },
  forkedFrom: null, createdAt: iso(-60), updatedAt: iso(0), archivedAt: null, ...extra,
});

const TERMINAL = ["completed", "failed", "interrupted", "cancelled"];
const run = (n, provider, model, status, at, o = {}) => ({
  id: runId(n), threadId: THREAD, ordinal: n, providerInstanceId: provider,
  modelSelection: { instanceId: provider, model }, providerThreadId: null,
  userMessageId: `msg-${n}`, rootNodeId: rootNode(n), activeAttemptId: null, status,
  queuePosition: null, requestedAt: iso(at), startedAt: iso(at + 0.2),
  completedAt: TERMINAL.includes(status) ? iso(o.end ?? at + 20) : null,
  checkpointId: null, contextHandoffId: o.handoff ?? null, ...(o.extra ?? {}),
});

const node = (id, n, kind, parent, status, o = {}) => ({
  id, threadId: THREAD, runId: runId(n), parentNodeId: parent, rootNodeId: rootNode(n), kind, status,
  countsForRun: false, providerThreadId: null, providerTurnId: null,
  nativeItemRef: o.nativeId ? { driver: "claudeAgent", nativeId: o.nativeId, strength: "strong" } : null,
  runtimeRequestId: o.request ?? null, checkpointScopeId: null, startedAt: iso(o.at ?? 0), completedAt: null,
});

const baseItem = (id, n, nodeId, ordinal, status, at, o = {}) => ({
  id, threadId: THREAD, runId: runId(n), nodeId, providerThreadId: null, providerTurnId: null,
  nativeItemRef: o.nativeId ? { driver: "claudeAgent", nativeId: o.nativeId, strength: "strong" } : null,
  parentItemId: o.parent ?? null, ordinal, status, title: null,
  startedAt: iso(at), completedAt: status === "completed" || status === "failed" ? iso(at + (o.dur ?? 0.5)) : null,
  updatedAt: iso(at + (o.dur ?? 0.5)),
});

const userMsg = (n, text, at, extra = {}) => ({
  ...baseItem(`turn-item:message:msg-${n}`, n, rootNode(n), n * 1000000 + 1, "completed", at, { dur: 0 }),
  createdBy: "user", creationSource: "web", type: "user_message", messageId: `msg-${n}`,
  inputIntent: "turn_start", text, attachments: [], ...extra,
});
const assistant = (n, id, text, at, status = "completed", provider = "claudeAgent") => ({
  ...baseItem(nativeItem(provider, id), n, nativeNode(provider, id), n * 1000000 + 90, status, at, { nativeId: id }),
  type: "assistant_message", phase: "final_answer", messageId: `message:provider:${provider}:native-item:${id}`,
  text, streaming: status !== "completed",
});

const write = (name, data) => writeFileSync(join(dir, name), JSON.stringify(data, null, 1) + "\n");
const reset = () => { seq = 100; evN = 0; };

// ---- 1. tool call with approval ------------------------------------------------------------
reset();
{
  const TOOL_ID = "toolu_01ABCdefGHIjklMNOpqr";
  const N_TOOL = nativeNode("claudeAgent", TOOL_ID);
  const N_APPR = "node:runtime-request:RR1";
  const cmd = (status, at, extra = {}) => ({
    ...baseItem(nativeItem("claudeAgent", TOOL_ID), 1, N_TOOL, 1000010, status, at, { nativeId: TOOL_ID, dur: 2 }),
    type: "command_execution", input: "pnpm test --filter api", ...extra,
  });
  const REQ = (status, extra = {}) => ({
    id: "RR1", nodeId: N_APPR, providerTurnId: null,
    nativeRequestRef: { driver: "claudeAgent", nativeId: TOOL_ID, strength: "weak" },
    kind: "command_execution", status, responseCapability: { type: "message" },
    createdAt: iso(3), resolvedAt: status === "pending" ? null : iso(8), ...extra,
  });
  write("tool-approval.json", [
    ev("run.created", run(1, "claudeAgent", "claude-opus-5-5", "starting", 1), { runId: runId(1), at: 1 }),
    ev("turn-item.updated", userMsg(1, "run the api tests", 1), { runId: runId(1), nodeId: rootNode(1), at: 1 }),
    ev("node.updated", node(rootNode(1), 1, "root_turn", null, "running", { at: 1 }), { runId: runId(1), at: 1.1 }),
    ev("node.updated", node(N_TOOL, 1, "tool_call", rootNode(1), "running", { at: 3, nativeId: TOOL_ID }), { runId: runId(1), at: 3 }),
    ev("turn-item.updated", cmd("running", 3), { runId: runId(1), nodeId: N_TOOL, at: 3 }),
    ev("node.updated", node(N_APPR, 1, "approval_request", N_TOOL, "waiting", { at: 3.5, request: "RR1" }), { runId: runId(1), at: 3.5 }),
    ev("runtime-request.updated", REQ("pending"), { runId: runId(1), nodeId: N_APPR, at: 3.6 }),
    ev("turn-item.updated", {
      ...baseItem("turn-item:approval:RR1", 1, N_APPR, 1000011, "waiting", 3.6, { dur: 0 }),
      type: "approval_request", requestId: "RR1", requestKind: "command_execution", prompt: "Run `pnpm test --filter api`?",
    }, { runId: runId(1), nodeId: N_APPR, at: 3.6 }),
    ev("runtime-request.updated", REQ("resolved", { decision: "accept" }), { runId: runId(1), nodeId: N_APPR, at: 8 }),
    ev("turn-item.updated", cmd("completed", 3, { output: "Tests  12 passed", exitCode: 0 }), { runId: runId(1), nodeId: N_TOOL, at: 12 }),
    ev("turn-item.updated", assistant(1, "msg-a1", "All 12 api tests pass.", 13), { runId: runId(1), at: 13 }),
    ev("run.updated", run(1, "claudeAgent", "claude-opus-5-5", "completed", 1, { end: 14 }), { runId: runId(1), at: 14 }),
  ]);
}

// ---- 2. provider switch (claude -> codex) with handoff -------------------------------------
reset();
{
  const snapshot = {
    kind: "snapshot", snapshotSequence: 100,
    projection: {
      thread: appThread("claudeAgent", "claude-opus-5-5"),
      runs: [run(1, "claudeAgent", "claude-opus-5-5", "completed", 1, { end: 6 })],
      attempts: [], nodes: [node(rootNode(1), 1, "root_turn", null, "completed")], subagents: [],
      providerSessions: [], providerThreads: [], providerTurns: [], runtimeRequests: [], messages: [], plans: [],
      turnItems: [userMsg(1, "design the cache", 1), assistant(1, "msg-a1", "Here is a design.", 5)],
      checkpointScopes: [], checkpoints: [], contextHandoffs: [], contextTransfers: [], visibleTurnItems: [], updatedAt: iso(6),
    },
  };
  const H1 = "context-handoff:H1";
  write("provider-switch.json", [
    snapshot,
    ev("thread.model-selection-updated", appThread("claudeAgent", "claude-sonnet-5-5"), { at: 10 }),
    ev("thread.provider-switched", appThread("codex", "gpt-6.1-sol"), { provider: "codex", at: 11 }),
    ev("run.created", run(2, "codex", "gpt-6.1-sol", "starting", 12, { handoff: H1 }), { runId: runId(2), provider: "codex", at: 12 }),
    ev("context-handoff.updated", {
      id: H1, threadId: THREAD, targetRunId: runId(2), fromProviderThreadIds: ["pt-claude"], toProviderThreadId: "pt-codex",
      coveredRunOrdinals: { from: 1, to: 1 }, strategy: "full_thread_summary", status: "ready", summaryMessageId: null,
      summaryText: "Earlier: designed the cache.", createdByProviderInstanceId: "codex", createdAt: iso(12), updatedAt: iso(12),
    }, { runId: runId(2), provider: "codex", at: 12 }),
    ev("turn-item.updated", {
      ...baseItem("turn-item:handoff:H1", 2, rootNode(2), 2000000, "completed", 12.1, { dur: 0 }),
      type: "handoff", contextHandoffId: H1, fromProviderThreadIds: ["pt-claude"], toProviderThreadId: "pt-codex",
      fromProviderInstanceIds: ["claudeAgent"], toProviderInstanceId: "codex", strategy: "full_thread_summary",
      summary: "Earlier: designed the cache.",
    }, { runId: runId(2), provider: "codex", at: 12.1 }),
    ev("turn-item.updated", userMsg(2, "now implement it", 12), { runId: runId(2), provider: "codex", at: 12 }),
    ev("turn-item.updated", assistant(2, "cx-1", "Implementing.", 15, "completed", "codex"), { runId: runId(2), provider: "codex", at: 15 }),
    ev("run.updated", run(2, "codex", "gpt-6.1-sol", "completed", 12, { end: 16, handoff: H1 }), { runId: runId(2), provider: "codex", at: 16 }),
  ]);
}

// ---- 3. compaction ------------------------------------------------------------------------
reset();
{
  const U = userMsg(1, "/compact", 1, { idleCompaction: "onReturn" });
  write("compaction.json", [
    ev("run.created", run(1, "claudeAgent", "claude-opus-5-5", "starting", 1), { runId: runId(1), at: 1 }),
    ev("turn-item.updated", U, { runId: runId(1), at: 1 }),
    ev("turn-item.updated", {
      ...baseItem(nativeItem("claudeAgent", "compact-1"), 1, nativeNode("claudeAgent", "compact-1"), 1000050, "completed", 2, { parent: U.id, nativeId: "compact-1" }),
      type: "compaction", driver: "claudeAgent", summary: "Conversation summarised.", beforeTokenCount: 182000, afterTokenCount: 14000,
    }, { runId: runId(1), at: 2 }),
    ev("run.updated", run(1, "claudeAgent", "claude-opus-5-5", "completed", 1, { end: 3 }), { runId: runId(1), at: 3 }),
  ]);
}

// ---- 4. error (usage limit with retry) then failed run --------------------------------------
reset();
write("error.json", [
  ev("run.created", run(1, "codex", "gpt-6.1-sol", "starting", 1), { runId: runId(1), provider: "codex", at: 1 }),
  ev("turn-item.updated", userMsg(1, "refactor module", 1), { runId: runId(1), provider: "codex", at: 1 }),
  ev("turn-item.updated", {
    ...baseItem("turn-item:provider:codex:native-item:err-1", 1, rootNode(1), 1000070, "failed", 4, { dur: 0 }),
    type: "error",
    failure: { class: "usage_limit", message: "You hit the 5 hour usage limit.", code: "usage_limit_reached", retryable: false, resetAt: iso(3600) },
    retry: { attempt: 2, maxAttempts: 3, retryDelayMs: 1000 },
  }, { runId: runId(1), provider: "codex", at: 4 }),
  ev("run.updated", run(1, "codex", "gpt-6.1-sol", "failed", 1, { end: 4.5 }), { runId: runId(1), provider: "codex", at: 4.5 }),
]);

// ---- 5. subagent run ------------------------------------------------------------------------
reset();
{
  const SUB = nativeNode("claudeAgent", "toolu_TASK01xyz");
  const N_TASK = nativeNode("claudeAgent", "toolu_TASKcall01");
  const N_CHILD = nativeNode("claudeAgent", "toolu_CHILDbash1");
  const taskItem = {
    ...baseItem(nativeItem("claudeAgent", "toolu_TASKcall01"), 1, N_TASK, 1000020, "completed", 2, { nativeId: "toolu_TASKcall01", dur: 9 }),
    type: "dynamic_tool", toolName: "Task", input: { description: "scan repo" }, output: "done",
  };
  const subEntity = (status, extra = {}) => ({
    id: SUB, threadId: THREAD, runId: runId(1), parentNodeId: N_TASK, origin: "provider_native", createdBy: "agent", driver: "claudeAgent",
    providerInstanceId: "claudeAgent", providerThreadId: null, childThreadId: null,
    nativeTaskRef: { driver: "claudeAgent", nativeId: "toolu_TASK01xyz", strength: "strong" },
    prompt: "Scan the repo for TODOs", title: "Scan repo", model: "claude-haiku-5-5", status, result: null,
    startedAt: iso(2.5), completedAt: status === "completed" ? iso(10) : null, updatedAt: iso(status === "completed" ? 10 : 2.5), ...extra,
  });
  const subItem = (status, extra = {}) => ({
    ...baseItem(nativeItem("claudeAgent", "toolu_TASK01xyz"), 1, SUB, 1000021, status, 2.5, { parent: taskItem.id, nativeId: "toolu_TASK01xyz", dur: 7.5 }),
    type: "subagent", subagentId: SUB, origin: "provider_native", driver: "claudeAgent", providerInstanceId: "claudeAgent",
    childThreadId: null, prompt: "Scan the repo for TODOs", result: null, ...extra,
  });
  const childCmd = {
    ...baseItem(nativeItem("claudeAgent", "toolu_CHILDbash1"), 1, N_CHILD, 1000022, "completed", 4, { nativeId: "toolu_CHILDbash1", dur: 1 }),
    type: "command_execution", input: "rg TODO -n", output: "3 matches", exitCode: 0,
  };
  write("subagent.json", [
    ev("run.created", run(1, "claudeAgent", "claude-opus-5-5", "starting", 1), { runId: runId(1), at: 1 }),
    ev("turn-item.updated", userMsg(1, "find all TODOs", 1), { runId: runId(1), at: 1 }),
    ev("node.updated", node(rootNode(1), 1, "root_turn", null, "running"), { runId: runId(1), at: 1.1 }),
    ev("node.updated", node(N_TASK, 1, "tool_call", rootNode(1), "running", { at: 2 }), { runId: runId(1), at: 2 }),
    ev("turn-item.updated", { ...taskItem, status: "running", completedAt: null }, { runId: runId(1), nodeId: N_TASK, at: 2 }),
    ev("node.updated", node(SUB, 1, "subagent", N_TASK, "running", { at: 2.5 }), { runId: runId(1), at: 2.5 }),
    ev("subagent.updated", subEntity("running"), { runId: runId(1), nodeId: SUB, at: 2.5 }),
    ev("turn-item.updated", subItem("running"), { runId: runId(1), nodeId: SUB, at: 2.5 }),
    ev("node.updated", node(N_CHILD, 1, "tool_call", SUB, "running", { at: 4 }), { runId: runId(1), at: 4 }),
    ev("turn-item.updated", childCmd, { runId: runId(1), nodeId: N_CHILD, at: 5 }),
    ev("subagent.updated", subEntity("completed", { result: "Found 3 TODOs in 2 files." }), { runId: runId(1), nodeId: SUB, at: 10 }),
    ev("turn-item.updated", subItem("completed", { result: "Found 3 TODOs in 2 files." }), { runId: runId(1), nodeId: SUB, at: 10 }),
    ev("turn-item.updated", { ...taskItem }, { runId: runId(1), nodeId: N_TASK, at: 11 }),
    ev("run.updated", run(1, "claudeAgent", "claude-opus-5-5", "completed", 1, { end: 12 }), { runId: runId(1), at: 12 }),
  ]);
}

// ---- provider log sample (events.<threadId>.log) ---------------------------------------------
const logLines = [
  `[${iso(3)}] NTIVE: ${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_01ABCdefGHIjklMNOpqr", name: "Bash", input: { command: "pnpm test --filter api" } }] } })}`,
  `[${iso(8)}] NTIVE: ${JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_01ABCdefGHIjklMNOpqr", content: "Tests  12 passed" }] } })}`,
  `[${iso(9)}] CANON: ${JSON.stringify({ type: "item.completed", payload: { itemId: "unrelated-item-id-000" } })}`,
  "this line is not json and must be skipped",
  `[${iso(9)}] ORCH: {"broken":`,
  "",
];
writeFileSync(join(dir, "provider-events.jsonl"), logLines.join("\n") + "\n");
console.log("fixtures written");
