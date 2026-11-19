# WP-3C: timeline normalizer (`@t3p/timeline`)

Pure, runtime-free normalizer from `orchestration.subscribeThread` items to `t3.timeline` records. No dependencies (inputs are typed structurally, so it accepts `ThreadSnapshotItem` / `ThreadEventItem` of `@t3p/rpc-client` without importing the vendored contracts). ESM (`.mjs`) and CJS (`.cjs`) dist.

```ts
import { createTimeline, enrichFromProviderLog } from "@t3p/timeline";
const tl = createTimeline();
watchThread(client, threadId, (s) => tl.applySnapshot(s), (e) => tl.applyEvent(e));
tl.subscribe(({ added, updated, reset }) => { /* new / changed records */ });
tl.records();                       // ordered
enrichFromProviderLog(tl.records(), logText);   // optional, caller supplies events.<threadId>.log text
```

`TimelineRecord` is defined in this package (`src/types.ts`). The master reconciles it with `@t3p/api` (WP-3A). Fields: `id, threadId, sequence, at, kind, runId, provider, summary, status, cause, raw, enrichment?` (PLAN section 4 shape plus `id`, `threadId`, `sequence`, `status`).

## Decisions

- `at` is **epoch milliseconds** (UTC). `0` when the source timestamp is unparseable. It is the time the thing happened and is stable across updates (a turn item's `startedAt`, else `updatedAt`).
- Ordering: `records()` sorts by `(at, rank, creation order)`; `rank` puts `run.start` first and `run.end` / `subagent.end` last among equal `at`. Snapshot items are inserted in `ordinal` order. (Sequence is not a sort key: snapshot items have no per-item sequence, and `sequence` on a record is "last writer", not "creation".)
- `id` is derived from upstream ids, never from sequence: `item:<turnItemId>`, `run:<runId>:start|end`, `request:<id>:resolved`, `subagent:<nodeId>:start|end`, `event:<eventId>` (thread-level events), `unknown:...`.
- `raw` is the source object as delivered: the turn item for item records (not the surrounding `turn-item.updated` event), the run / runtime-request / subagent entity, or the full event for thread-level events. Never copied or mutated.
- Updates replace records in place (same `id`, new object). A record is reported as `updated` only if its non-raw fields changed or its source `updatedAt`/`status`/`completedAt` stamp changed, so replaying a stream is silent.
- `subscribe(cb)`: one call per `apply*`, `{added, updated, reset}`. `reset()` calls it once with `reset: true`. A throwing listener is swallowed.
- Idempotency: an event whose `sequence` was already applied, or is `<=` the applied snapshot's `snapshotSequence`, is ignored. A snapshot with `snapshotSequence <=` the last applied one is ignored. A resubscribe-from-0 snapshot with a higher sequence is applied over existing records (records absent from it are kept; there is no deletion signal).
- Never throws: malformed or unrecognised input is recorded as kind `unknown` with `raw` kept; an exception inside a builder becomes an `unknown` record whose summary says why.
- The `subagent` turn item is not its own record. Item and `Subagent` entity are merged into one `subagent.start` (+ `subagent.end` when terminal) pair, so the two sources never double-count.
- Not surfaced (known, deliberately silent): `message.updated` (the turn item carries the text), `provider-session.*`, `provider-thread.updated`, `provider-turn.updated`, `run-attempt.*`, `checkpoint*`, `context-transfer.*`, `plan.updated`, most `thread.*` housekeeping (metadata, pin, tags, visit, ...), `run.background-work-cancelled`. `node.updated`, `context-handoff.updated`, runtime requests and subagents feed the link indexes. Any other event type becomes `unknown`.
- Inherited items (`visibleTurnItems[].visibility === "inherited"`) belong to another thread and are skipped; `local` and `synthetic` are kept.

## Record kinds

| kind | source | `summary` example |
|---|---|---|
| `run.start` | `run.created/updated` entity, or `projection.runs` | `Run #2 on codex (gpt-6.1-sol)` |
| `run.end` | same run, once status is terminal (`completed`, `interrupted`, `failed`, `cancelled`, `rolled_back`) | `Run #1 failed` |
| `message.user` | turn item `user_message` | `You: run the api tests` |
| `message.assistant` | `assistant_message` | `Assistant: All 12 api tests pass.` |
| `reasoning` | `reasoning` | `Reasoning: ...` |
| `plan` | `proposed_plan`, `todo_list` | `Todo list: 4 steps` |
| `command` | `command_execution` | `$ pnpm test (exit 1)` |
| `file-change` | `file_change` | `Edit src/a.ts (+3 -1)` |
| `search` | `file_search`, `web_search` | `Web search: ...` |
| `tool` | `dynamic_tool` | `Tool Task` |
| `approval.request` | `approval_request` | `Approval needed (command_execution): ...` |
| `approval.resolved` | `runtime-request.updated` (or `projection.runtimeRequests`) with status != `pending`, kind != `user_input` | `Approval resolved: accept (command_execution)` |
| `input.request` / `input.resolved` | `user_input_request` / runtime request of kind `user_input` | `Input requested: ...` |
| `secret-request`, `link-request` | `secret_request`, `link_request` | |
| `checkpoint` | `checkpoint` | `Checkpoint (3 files)` |
| `interrupt.request` / `interrupt.result` | `run_interrupt_request` / `run_interrupt_result` | |
| `notice` | `system_notice` | `Notice (warning): ...` |
| `notification` | `notification` (background task / subagent wake) | |
| `error` | `error` | `Error [usage_limit]: ... (retry 2/3)` |
| `compaction` | `compaction` | `Context compacted (182000 → 14000 tokens)` |
| `handoff` | `handoff` | `Handoff claudeAgent → codex (full_thread_summary)` |
| `fork` | `fork` | `Forked to thread ...` |
| `thread.spawn` | `thread_created` | `Spawned thread ... (codex gpt-6.1-sol)` |
| `provider-switch` | event `thread.provider-switched` (only when provider actually changes) | `Provider switch claudeAgent → codex (gpt-6.1-sol)` |
| `model-switch` | event `thread.model-selection-updated` (only when model or instance changes) | `Model claude-opus-5-5 → claude-sonnet-5-5` |
| `thread.lifecycle` | events `thread.created`, `.archived`, `.unarchived`, `.deleted` | `Thread archived` |
| `subagent.start` / `subagent.end` | `subagent.updated` entity, `projection.subagents`, `subagent` turn item | `Subagent started: Scan repo` |
| `unknown` | unrecognised event type, item type or stream kind; or a builder failure | `Unrecognised item type hologram` |

`provider` = the run's `providerInstanceId` when the record has a `runId` and the run is known, else the event's `providerInstanceId`, else the thread's current provider, else `"unknown"`. For `provider-switch` it is the new provider.

## Cause rules

`cause = { recordId, relation } | null`. Each record has an ordered list of candidates; the **first candidate whose record exists** wins. Links are recomputed when a candidate or an index entry arrives late, so arrival order does not matter (tested: tool node and tool item delivered after the approval that points at them).

Upstream fields read (`orchestrationV2.ts`, tag v0.1.10):

| Record | Candidates, in priority order | Upstream field(s) read |
|---|---|---|
| `run.start` | 1. `run:<prev>:end` `continues` 2. `subagent:<task>:start` `delegated-by` 3. the user message item `triggered-by` | `Run.restartContinuationOfRunId` / `manualContinuationOfRunId` / `usageLimitContinuationOfRunId`; `Run.delegatedTaskId`; `Run.userMessageId` matched to a `user_message` item's `messageId` |
| `run.end` | `run.start` of the same run, `ends` | `Run.id` |
| `message.user` that started its run | none (the run points at it; no cycle) | `Run.userMessageId === item.messageId` |
| `approval_request`, `user_input_request` item | 1. tool item on the parent node of the runtime request's node, `approval-for` 2. tool item on the parent node of the item's own node, `approval-for` 3..5 generic (below) | `item.requestId` -> `RuntimeRequest.nodeId` -> `ExecutionNode.parentNodeId` -> turn items with `nodeId ==` that node (prefers `command_execution`, `file_change`, `file_search`, `web_search`, `dynamic_tool`); `item.nodeId` -> `ExecutionNode.parentNodeId` |
| `handoff` item | 1. `run.start` of the handoff's target run, `handoff-into` 2..4 generic | `item.contextHandoffId` -> `ContextHandoff.targetRunId` (from `context-handoff.updated` / `projection.contextHandoffs`) |
| any turn item (generic tail) | 3. parent item, `child-of` 4. nearest enclosing subagent's `subagent.start`, `in-subagent` 5. `run.start`, `in-run` | `item.parentItemId`; `item.nodeId` then `ExecutionNode.parentNodeId` chain (max 8 hops) until a node id equals a known `Subagent.id`; `item.runId` |
| `approval.resolved`, `input.resolved` | 1. the request's item, `resolves` 2. tool item on the request node's parent, `approval-for` | `RuntimeRequest.id` == item `requestId`; `RuntimeRequest.nodeId` -> `ExecutionNode.parentNodeId` |
| `subagent.start` | 1. parent item, `spawned-by` 2. tool item on the parent node, `spawned-by` 3. enclosing outer subagent, `in-subagent` 4. `run.start`, `in-run` | subagent turn item `parentItemId`; `Subagent.parentNodeId`; node ancestry; `Subagent.runId` |
| `subagent.end` | `subagent.start`, `ends` | `Subagent.id` |
| `provider-switch`, `model-switch`, `thread.lifecycle` | none | event-level; no upstream field names a trigger |
| `unknown` | `run.start` of `event.runId`, `in-run`, if known | `event.runId` |

Switch detection compares against the thread's last seen `providerInstanceId` / `modelSelection` (from the snapshot's `thread` and every `thread.*` event payload). With no snapshot and no earlier event the first switch reports `?` as the source.

## Provider log enrichment

`enrichFromProviderLog(records, logText)` is pure and returns a new array (unmatched records are returned as the same object, input is not mutated). Line format (server `EventNdjsonLogger`): `[<ISO>] NTIVE|CANON|ORCH: <json>`. Lines that do not parse are skipped.

A record is matched when a native id of its `raw` (`nativeItemRef.nativeId`, `nativeRequestRef.nativeId`, `nativeTaskRef.nativeId`, `nativeTurnRef.nativeId`, event `rawEventId`; length >= 6) equals an id-like value in a logged frame (keys such as `id`, `itemId`, `tool_use_id`, `callId`, `requestId`, `turnId`, `nativeId`, `rawEventId`; depth <= 8). Result: `record.enrichment = { matchedBy: string[], frames: { at, stream, frame }[] }`, frames in log order, max 50 per record. The log omits streaming deltas by design (`shouldPersistProviderEvent`), so frames are lifecycle and tool frames only. Fetching the file is `t3.native`'s job, not this package's.

## Known gaps

- Items of a **child thread** (`Subagent.childThreadId` set, or app-owned delegated tasks) live in that thread's own stream. Subscribe a second `createTimeline()` for it; `run.start.cause` `delegated-by` only resolves when the delegating subagent record is in the same timeline.
- Provider switch is not linked to the run or handoff it causes (no upstream field ties them; a time-adjacency guess was left out on purpose).
- The cause rules for approvals assume `ExecutionNode(kind: approval_request).parentNodeId` points at the tool-call node (as the contract's node tree implies). Verified on synthetic fixtures built from the schema, not on a captured approval: the rig account is unauthenticated, so no real tool run exists in the repo (the only real capture is the WP-0D failed run). Re-check when WP-6 or a logged-in rig produces a real approval frame.
- Snapshots with `acceptCompactTurnItems` / `acceptDedupedBodies` / `acceptCompactIds` are not decoded (the rpc-client omits those flags, as WP-0D recommends). Bodies marked `outputOmitted` / `promptOmitted` are summarised from what is present.
- Bounded snapshots (`hasMoreHistory`) only cover the recent window; older history needs `getThreadHistoryPage`, which this package does not call.
- `run.end` is created once a run is terminal and not removed if the run later restarts (rare; the next `run.updated` keeps the start record current).
- A resubscribe-from-0 snapshot cannot delete records that no longer exist upstream (no tombstones in the stream).
- `thread.metadata-updated` and other housekeeping events are intentionally not surfaced; add kinds if a plugin needs them.
