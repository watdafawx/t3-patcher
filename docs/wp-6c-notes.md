# WP-6C: pre-dispatch turn guard

Goal: a plugin can intercept every turn or session start, including turns that delegated sub-sessions start, and allow, block or redirect it (`t3.threads.beforeStart`).

## 1. Spike: where turns start

Read against `.upstream` (tag `v0.1.10`) and the shipped bundles of stable `v0.1.10` and nightly `v0.1.11-nightly.20261119.4918` (`tools/compat/.cache/<tag>/server.asar`).

### The server is a separate process

- `apps/desktop/src/backend/DesktopBackendConfiguration.ts:557-581`: the desktop main process starts the backend as `process.execPath` (the Electron exe) with `ELECTRON_RUN_AS_NODE=1`, args `[--require <compileCache>] <resources>/server.asar/apps/server/dist/bin.mjs --bootstrap-fd 3`, `extendEnv: true` (inherits main's env; `backendChildEnvPatch` only clears the `T3CODE_*` names, not `NODE_OPTIONS`).
- So server code never runs inside the main process. Our main runtime cannot patch it in memory, and `server.asar` is never served through `protocol.handle`, so the client patch engine never sees it.
- The spawn goes through Effect's `ChildProcessSpawner`, built in the desktop `main.cjs` as `makeWithSpawn(node_child_process.spawn)` (line 78394 of the 0.1.10 bundle). That reads `require("node:child_process").spawn` when `main.cjs` is evaluated, which is after our runtime ran. So a wrapper installed on `child_process.spawn` by the runtime is the function the backend spawn uses.
- The backend's Node is Electron 44.10.1 = Node 24.22.1 (checked with `ELECTRON_RUN_AS_NODE=1 "T3 Code (Beta).exe" -e ...`). `module.registerHooks` (synchronous, in-thread module hooks) exists there.
- The server bundle is unminified ESM: `apps/server/dist/*.mjs`, hash-named chunks, original identifiers kept (imports are aliased to their export names, e.g. `import { Fs as tryPromise }`).

### Candidate chokepoints

| Candidate | Sees | Misses | Can block cleanly | Can change model |
|---|---|---|---|---|
| `ProviderTurnStartService.start` (`orchestration-v2/ProviderTurnStartService.ts:1887`) | every provider turn, also queued runs and retries | command text and source (only a `runId`); the run, its model and the provider session already exist | only by failing the run after it was created | no (session already bound) |
| `ThreadMessageIntake.dispatchCommand` (ws.ts RPC path) | client commands | MCP tools, internal reactors, delegated tasks | yes | yes |
| **`Orchestrator.dispatchWithReceipt`** (`orchestration-v2/Orchestrator.ts:15678`, exported as the service's `dispatch`) | **every orchestration command from every caller**: the WebSocket RPC (`ws.ts` -> `ThreadMessageIntake`), MCP tools (`OrchestratorMcpService` -> `ThreadManagementService.dispatch`), `ThreadLaunchService`, scheduled tasks and the server's own reactors (continuations, delegated completion delivery) | turns that start without a new command: a queued `message.dispatch` released when the active run ends, and provider-side retries. Both were guarded when their command was dispatched | yes | yes (rewrite `modelSelection` before the command is decided) |

Chosen: **`dispatchWithReceipt`**. It is the outermost function of the orchestrator's `dispatch`, it runs before the per-thread locks are taken, and the commands that create a run all pass through it:

- `message.dispatch`: a user message, a steer or restart, and the server's continuations (`restartContinuationOfRunId`, `usageLimitContinuationOfRunId`, `manualContinuationOfRunId`, `delegatedCompletion` wake-ups of a parent).
- `thread.create` with `initialMessage`: new threads (`ThreadLaunchService.launch`, also a linked environment's delegated task, which carries `delegatedFrom`).
- `delegated_task.request`: a local `delegate_task` MCP call (`OrchestratorMcpService.delegateTask`, line 2734) creates the child thread and its first run in this one command.

A blocked command fails with the module's own `OrchestratorDispatchError` whose `cause` is the reason string. `userFacingDispatchErrorMessage` (`UserFacingErrors.ts:140`) returns the last non-generic message in the cause chain, so:

- the web client gets `OrchestrationV2DispatchCommandError{ message: <reason>, detail: <reason> }` (`ws.ts:2004`) and shows it as the send error;
- a delegating agent's `delegate_task` call fails with `Unable to create delegated task: <reason>` (`OrchestratorMcpService.ts:2757`).

### Findability in the bundles

| | stable v0.1.10 | nightly 20261119.4918 |
|---|---|---|
| chunk | `runtimeLayer-CMUqXtti.mjs` (6.3 MB) | `runtimeLayer-3i4tIb8r.mjs` |
| `const dispatchWithReceipt = fnUntraced(function* (command) {` | line 97425, once | line 91285, once |
| `import { ... Fs as tryPromise ... }` (Effect `tryPromise`, used 32 times in the chunk as `tryPromise({ try, catch })`) | yes | yes |
| `var OrchestratorDispatchError = class extends TaggedError$1()(...)` | line 87507 | line 81278 |

The patch (`packages/main-runtime/src/guard/server-patch.ts`) anchors on `const dispatchWithReceipt = <fn>(function* (<param>) {` and resolves the local names of `tryPromise` and `OrchestratorDispatchError` from the same chunk, so a renamed import alias (`tryPromise$1`) still works. If any of the three is missing or ambiguous the chunk is served unpatched and the guard is reported off: fail open. The compat checker runs the same function against every target (section 2, Compat).

### How the code gets into the server

Not by rewriting `server.asar` (the installer never edits upstream files, and NSIS replaces it on every update). Instead:

1. The main runtime wraps `child_process.spawn` before `main.cjs` loads. For the one spawn whose args end in `server.asar/apps/server/dist/bin.mjs` it adds `--import=<file URL of runtime/server-hook.mjs>` before the entry and two env vars: the guard pipe name and a random token. Every other spawn passes through untouched.
2. `server-hook.mjs` runs first in the backend. It checks it really is the T3 server (main thread, entry `.../server.asar/.../bin.mjs`), removes the two env vars from `process.env` (provider CLIs never see them), and calls `module.registerHooks({ load })`. The load hook patches only `apps/server/dist/runtimeLayer-*.mjs`, with the function above.
3. The patched `dispatchWithReceipt` calls `globalThis.__t3pServerGuard`, which talks to the main process over a Windows named pipe (`\\.\pipe\t3p-guard-<pid>-<random>`, JSON lines, token checked on every request).
4. The main process asks main-side handlers, then forwards the request to the renderer over the existing `t3p:event` push channel; renderer handlers answer through a new `t3p:guard:answer` invoke channel (sender-checked like every `t3p:` channel).

Considered and rejected:

- `NODE_OPTIONS=--import ...` in main's env: every child of the main process would inherit it (snapshot helpers, the updater), and so would the provider CLIs the server spawns unless stripped. Arg injection on the one spawn is narrower.
- An RPC proxy in the main process: the renderer talks to the server directly over `ws://127.0.0.1:3773`, and MCP and internal reactors never touch a socket. A proxy would miss delegated tasks, the main requirement.
- Patching a copy of `server.asar`: needs the installer to own another upstream file and redo it after every NSIS update; the module hook needs nothing on disk outside `~/.t3-patcher/runtime`.

### Limits found in the spike

- A queued message (`dispatchMode: queue_after_active`) is guarded when it is sent, not when the queue releases it later.
- `message.dispatch` carries `modelSelection` only when the sender changes model. Without it the context has no provider; the renderer runtime fills `provider`/`model` from the thread list (`t3.threads.list()` summary) when it can.
- `modify` rewrites `modelSelection` on the command. On an existing thread a different provider is then the server's normal provider change: it may refuse it (for example while a run is active) with its own error.
- While a handler waits (a modal), later guarded commands for the same thread wait behind it (the hook keeps per-thread order), other threads are not affected. Commands that are not turn starts never wait.
- A client `thread.create` never carries a first message: the WebSocket path (`ThreadManagementService.withCreationProvenance`) strips `initialMessage` from client commands, and the web client sends the first message as its own `message.dispatch`. `thread.create` with `initialMessage` comes from the server's own launches (`ThreadLaunchService`, MCP `t3_thread_launch`, scheduled tasks, linked-environment delegation).

## 2. What was built

- **API** (`@t3p/api`): permission `guard`; `t3.threads.beforeStart(handler, { timeoutMs })` in the renderer and `ctx.threads.beforeStart` for main plugins. Context `{ requestId, commandType, kind, threadId, parentThreadId, provider, model, modelSource, isSubagent, source, createdBy, continuation, textPreview, at }`. Answers `allow` (also `undefined`), `{ action: "block", reason }`, `{ action: "modify", provider?, model? }`. Default timeout 120 s (1 s to 300 s); a timeout, a throw or a malformed answer counts as allow. Handlers run in plugin load order, main-side first; a `modify` is passed on to the next handler, the first `block` wins.
- **Server side** (`packages/main-runtime/src/guard/`): `spawn-wrap.ts` (arg + env injection on the backend spawn only), `server-hook.ts` (built to `runtime/server-hook.mjs`, load hook + pipe client), `server-patch.ts` (the chunk patch, shared with the compat checker), `command.ts` (which commands are turn starts, context, `modify` rewrite), `pipe.ts`, `broker.ts` (main handlers, renderer round trip, `t3p:guard:*` channels), `index.ts` (`startTurnGuard`). `T3P_GUARD=0` turns all of it off.
- **Renderer** (`packages/renderer-runtime/src/guard.ts`): runs handlers, fills `provider`/`model` from the thread list when the command named none (`modelSource: "thread"`), answers on `t3p:guard:answer`. A page load first sends `t3p:guard:unregister {}` so a reload never leaves a stale registration in main.
- **Fail-open everywhere**: no pipe, broken pipe, no renderer handler, renderer gone, timeout, unknown answer, unpatchable chunk: the command runs as if there were no guard. A block is never silent: it is an `OrchestratorDispatchError` with the reason.
- **provider-limits**: settings `guardThresholdPercent` (default 5, 0 = off) and `guardFallback` (`provider/model`). Pure decision code in `plugins/provider-limits/src/guard.ts` (`evaluateTurn`, `resolveChoice`, `ChoiceMemory`). When the provider's lowest window is at or under the threshold it asks: **Switch to <fallback>** / **Keep going** / **Cancel**. Switch and Keep going are remembered per thread for 10 minutes; Cancel (or closing the modal) blocks with `Cancelled: <provider> has X% left in the <window> window (provider-limits guard).` The modal races a 118 s timer so the answer always beats the 120 s guard timeout; a late click shows a toast.
- **Compat**: `tools/compat` reports `serverGuard` (owner `t3p.core`) per target from the same `server-patch.ts` function.

## 3. Verification

Measured, not assumed:

| Check | Where | Result |
|---|---|---|
| `pnpm -r build`, `pnpm -r test`, `pnpm lint` | FOX | exit 0 |
| Patch on the real chunks | vitest with `T3P_SERVER_DIST` (stable v0.1.10 + nightly 20261119.4918 extracted) | each patched exactly once |
| Compat CLI `--asar` | stable v0.1.10, nightly 20261119.4918 | PASS, `ok serverGuard apps/server/dist/runtimeLayer-CMUqXtti.mjs` / `-3i4tIb8r.mjs`; `--update-baseline` on stable gave no diff |
| Hook under T3's Electron 44.10.1 run-as-node, chunk inside an asar | FOX, headless script | modify → `codex/gpt-6.1-sol`, block → `OrchestratorDispatchError` "Quota low", allow passes, other commands not asked, guard env vars removed |
| Real app, rig slot 3 (nightly, patched runtime, probe plugin granted `guard`, driven over CDP) | rig | see below |

Rig slot 3, real `orchestration.dispatchCommand` from the renderer:

- `message.dispatch`, probe answers block: rejected in 6 ms with `OrchestrationV2DispatchCommandError (orchestration.dispatchCommand): WP6C probe: blocked`. Context seen: `kind message, provider claudeAgent, model claude-opus-5-5, modelSource command, isSubagent false, source web`.
- `message.dispatch`, probe answers modify `codex/gpt-5.4-mini`: accepted; the thread list then showed the thread on `codex / gpt-5.4-mini` with a running run (stopped right after).
- `message.dispatch`, probe hangs (timeoutMs 3000): accepted after 3020 ms (timeout = allow).
- `thread.create` without a first message: not asked (correct). Client `thread.create` with `initialMessage`: not asked, because the server strips the message from client commands (section 1); nothing starts.
- main.log: guard pipe listening, backend spawned with the server hook, the probe's handler registered.

Not verified on a real app:

- `delegated_task.request` from a real agent's `delegate_task` and server-internal `thread.create` launches (need a signed-in provider session on rig). Covered only by unit tests and the fixture chunk.
- provider-limits' modal against live usage data (unit tests only).
- The server-side log line `[t3p guard] info: turn guard patched ...`: the backend's stderr is not written to any log file on rig. The block result above proves the chunk was patched.

## 4. Limits

- WSL and remote (SSH) backends are not guarded: the hook rides on the local backend spawn only.
- The renderer cannot close an open provider-limits modal when the guard times out; a late click shows a toast instead.
- Context enrichment from the thread list happens in the renderer only; main-side handlers see what the command carried.
