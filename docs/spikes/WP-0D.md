# WP-0D: RPC spike (U4)

Date 2026-11-18. Stock T3 Code 0.1.10 (server protocol 2) on rig slot 2, throwaway home. FOX's T3 Code was never touched and none of its tokens were read.

## Answers to U4

| Question | Answer |
|---|---|
| Is the Effect RPC JSON frame shape known? | **Yes, verified on the wire.** One JSON object per WebSocket text frame. See "Frame shapes". |
| Does a second socket with the desktop bearer token work while the app's own socket is open? | **Yes.** The app socket stayed alive (11 Pongs) while the spike held 4 more sockets. The bearer does not open the socket itself: it is traded for a short-lived `wsTicket` (or sent as an `Authorization` header by non-browser clients). |
| Can a renderer plugin do all of it itself? | **Yes.** `window.desktopBridge.getLocalEnvironmentBearerToken()` and `getLocalEnvironmentBootstraps()` are callable from the page main world. `fetch` and `WebSocket` to the server work from the `t3code://app` origin (CSP and CORS allow it). Proven in `renderer-probe.js`. |
| Reconnect with `afterSequence` | **Gap-free, 0 duplicates**, in a 40-write stream with an abrupt socket kill. |

## Auth recommendation (3 lines)

1. **Renderer plugin:** `bearer = await desktopBridge.getLocalEnvironmentBearerToken()` (cached per app run, no prompt), `POST {httpBaseUrl}/api/auth/websocket-ticket/rpc` with `Authorization: Bearer`, then `new WebSocket(wsBase + "ws?wsTicket=...&orchestrationProtocol=2")`. Fetch a fresh ticket on every (re)connect. No cookies are involved (`document.cookie` is empty).
2. **Main-process component:** the bearer is minted inside the desktop's own Effect services and is not reachable from outside them. Get it by running the same bridge call in the main window (`mainWindow.webContents.executeJavaScript("window.desktopBridge.getLocalEnvironmentBearerToken()")`, equivalent to the CDP `Runtime.evaluate` used here), or ask the renderer RPC client over a `t3p:` IPC channel. Then use the same ticket flow (Node has `WebSocket`) or send `Authorization: Bearer` on the upgrade.
3. **One client, not two:** keep the single RPC client in the renderer runtime and relay for main plugins over IPC. A second socket is cheap and allowed, but the token path is the same either way.

Details and evidence:

- Bearer = access token of a session the desktop bootstraps against its own backend (`apps/desktop/src/backend/DesktopLocalEnvironmentAuth.ts`: bootstrap credential, then `bootstrapRemoteBearerSession`). `getLocalEnvironmentBootstraps()` returns `{id, label, runningDistro, httpBaseUrl, wsBaseUrl, bootstrapToken}`. Plugins should not use `bootstrapToken`: it mints a new session. The bearer is enough.
- Scopes of that session include `orchestration:read`, `orchestration:operate`, `terminal:operate`, `access:*`, `relay:*` (`GET /api/auth/session`). Treat the bearer as a full-power credential in plugin permissions.
- The server port is bound to **127.0.0.1 only** (rig `Get-NetTCPConnection`: `127.0.0.1:3874`). From FOX the spike reaches it through `ssh -L`.

## Auth matrix (measured)

| Attempt | Result |
|---|---|
| `GET /.well-known/t3/environment`, no auth | 200, `environmentId`, `serverVersion`, `orchestrationProtocolVersion: 2`, `capabilities{}` |
| `POST /api/auth/websocket-ticket`, no credential | 401 `{"_tag":"EnvironmentAuthInvalidError","code":"auth_invalid","reason":"missing_credential"}` |
| `POST /api/auth/websocket-ticket` with `Bearer` | 200 `{ticket, expiresAt}` |
| `POST /api/auth/websocket-ticket/rpc` with `Bearer` | 200, same shape, ticket bound to audience `rpc`, TTL about 300 s. The app uses this path (`use: "rpc"`) and falls back to the bare path on a 404 from old servers. |
| `GET /api/auth/session` with `Bearer` | 200 `{authenticated, auth{policy:"desktop-managed-local", ...}, scopes[]}` |
| WebSocket `/ws?orchestrationProtocol=2`, no credential | rejected at upgrade (non-101) |
| WebSocket with a bogus `wsTicket` | rejected at upgrade (non-101) |
| WebSocket with `Authorization: Bearer` header, no ticket | **accepted**. Only for non-browser clients: a browser `WebSocket` cannot set headers. Node 24's built-in `WebSocket` accepts a non-standard `{headers}` option. |
| Same ticket used for a second socket | **accepted** (not single-use for non-DPoP sessions, within its TTL) |
| `GET /ws?orchestrationProtocol=1` or missing param | 426 `{"code":"orchestration_protocol_incompatible","orchestrationProtocolVersion":2}` |
| Second concurrent socket, fresh ticket | accepted, alongside the app's own socket |

Upgrade query parameters the app sends: `wsTicket`, `clientSurface=desktop`, `clientAppVersion`, `clientDeviceType`, `clientOs`, `connectionMethod=direct`, `clientDevice` (hash), `orchestrationProtocol=2`, `clientCapabilities=settingsSecretReferences`, `frameParts=1`. Only `wsTicket` and `orchestrationProtocol=2` are required. Real capture: `fixtures/app-load.jsonl` line 1.

## Frame shapes

Transport: WebSocket text frames. Serialization is `RpcSerialization.layerJson` on the server (`apps/server/src/ws.ts:3651`), i.e. **one JSON object per frame, no newline delimiter and no length prefix**. (The `\u001e` byte seen in captures is the separate `frameParts` mechanism, below.)

### Client to server

```jsonc
// call (unary or stream: the server decides by method)
{"_tag":"Request","id":0,"tag":"server.getConfig","payload":{},"headers":[]}
// the app also sends tracing fields; optional: "traceId":"…","spanId":"…","sampled":true
// stream flow control: one Ack per received Chunk
{"_tag":"Ack","requestId":0}
// cancel a stream (or call)
{"_tag":"Interrupt","requestId":0}
// keepalive, every 5 s
{"_tag":"Ping"}
```

- `id` is a client-chosen counter starting at 0. The app sends it as a JSON number; the server echoes it back in `requestId` exactly as sent (a string also round-tripped in a first probe). Use numbers like the app.
- `tag` is the method name from `WS_METHODS` / `ORCHESTRATION_V2_WS_METHODS` (see the list below). Note the stream methods without a dotted prefix: `subscribeServerConfig`, `subscribeServerLifecycle`, `subscribeVcsStatus` and so on.
- `payload` is the schema's input object, plain JSON (no envelope).
- No handshake message, no protocol version header. Versioning is only the `orchestrationProtocol=2` query parameter (426 on mismatch).

### Server to client

```jsonc
// stream data: values is an array (can batch several items)
{"_tag":"Chunk","requestId":6,"values":[{"kind":"snapshot","snapshotSequence":56,"projection":{…}}]}
// terminal frame for unary calls and for finished or cancelled streams
{"_tag":"Exit","requestId":0,"exit":{"_tag":"Success","value":{…}}}
{"_tag":"Exit","requestId":2,"exit":{"_tag":"Failure","cause":[{"_tag":"Interrupt","fiberId":6828}]}}
{"_tag":"Pong"}
```

- Unary calls: exactly one `Exit`. Streams: any number of `Chunk`, then `Exit` only on cancel, error or server end.
- `Failure.cause` is an array of `{"_tag":"Fail","error":{…typed error with _tag…}}`, `{"_tag":"Die","defect":"…message…"}` or `{"_tag":"Interrupt","fiberId":N}`.
- Error examples (real, `fixtures/standalone-frames.jsonl`, section 6/7):
  - unknown method: `Die` with `"Unknown request tag: no.such.method"`
  - bad payload: `Die` with `"Missing key\n  at [\"threadId\"]"` (a schema decode error is a defect, not a typed error)
  - unknown provider instance in `thread.model-selection.set`: `Fail` with `OrchestrationV2DispatchCommandError {commandId, commandType, message:"No orchestration provider adapter is registered for nope.", cause{…}}`
- Ack: the client must `Ack` every `Chunk` (the app does, see `fixtures/app-load.jsonl`). The spike always acks. Not tested: what happens if acks are withheld (Effect RPC flow control says the server then pauses the stream).

### Ping / pong

Client sends `{"_tag":"Ping"}` every 5 s, server replies `{"_tag":"Pong"}` (app: `PING_TIMEOUT` 15 s without any frame drops the socket, `packages/client-runtime/src/rpc/protocol.ts`). The server does not ping the client.

### Frame parts (`frameParts=1`)

Optional. With it, the server splits any frame larger than about 48 KB into parts: every part but the last is prefixed with U+001E (`\u001e`); the client concatenates until a frame without the prefix and parses that (`packages/shared/src/socketFrameParts.ts`). Without the parameter frames arrive whole. The spike tested both: the client in `lib.mjs` handles joining and works with and without it. **Recommendation: omit `frameParts`** unless a proxy needs it (the reason upstream added it is slow links); join logic is 6 lines and is implemented anyway.

### Id scheme

Request `id` (client) equals `requestId` (server) on every reply. Streams and calls share the one counter space. Cancel = `Interrupt` with the same id; the stream then ends with `Exit/Failure/Interrupt`. Closing the socket cancels all server-side streams; nothing needs to be unsubscribed (verified: reader A was killed with no `Interrupt`).

## Verified flows

All in `spike.mjs` (output: `spike-output.txt`; frames: `fixtures/standalone-frames.jsonl`).

### server.getConfig and providers

`server.getConfig {}` returns one `Exit/Success` with keys `environment, auth, cwd, hostname, keybindings*, issues, providers, availableEditors, remoteOpenTargets, directEndpoints, observability, settings, scratchWorkspaceRoot, newProjectsRoot, serverTime, …` (full sample: `fixtures/server-getConfig.json`, about 70 KB, so cache it).

`providers[]` on the rig (no accounts logged in): 10 entries, each `{instanceId, driver, displayName, continuation{groupKey}, enabled, installed, version, status, auth{status}, checkedAt, message, models[], slashCommands[], skills[], versionAdvisory?, usageLimits?}`.

```
codex       enabled installed=false status=error    auth=unknown        models=0
claudeAgent enabled installed=true  status=error    auth=unauthenticated models=11   (Claude Code not logged in)
opencode    disabled                                usageLimits={"checkedAt":…,"windows":[],"unavailable":{"reason":"unsupported"}}
cursor grok antigravity fx kiro muse pi: disabled
```

`usageLimits` is **optional and absent** until a provider has a successful probe (only `opencode` carried one here, with `unavailable`). A populated example comes from FOX's `~/.t3/caches/*.json` (read-only, `fixtures/usage-limits-sample.json`, no tokens):

```json
{"checkedAt":"…","windows":[
  {"id":"five_hour","kind":"session","label":"Session","windowDurationMins":300,"usedPercent":23,"resetsAt":"…"},
  {"id":"seven_day","kind":"weekly","label":"Weekly","windowDurationMins":10080,"usedPercent":42,"resetsAt":"…"},
  {"id":"seven_day_fable","kind":"weekly","label":"Weekly · Fable","windowDurationMins":10080,"usedPercent":1,"resetsAt":"…"}],
 "resetCredits":{"availableCount":1,"nextExpiresAt":"…","nextCreditId":"…","options":[{"creditId":"…","label":"…","description":"…","availableCount":1,"expiresAt":"…"}]}}
```

Caveat: I could not observe a populated `usageLimits` coming over the live socket, because no provider can authenticate on the rig. The schema (`providerUsageLimits.ts`) and the cache file agree, and the live path (`server.getConfig` plus `subscribeServerConfig` `providerStatuses` updates) is the same code that wrote the cache. The first real-account check belongs in the WP-1C integration test on FOX's dev setup or WP-4.

### subscribeServerConfig

`subscribeServerConfig {environmentThemes, usageLimitSources, usageLimitsCommand, workspaceSnapshotsOnDemand}` (the app's payload) streams `{version:1,type:"snapshot",config}`, then `usageLimitSourcesUpdated`, `environmentThemesUpdated`, then repeated `providerStatuses` updates (also triggered by `server.refreshProviders`). Cancel with `Interrupt`: `Exit/Failure/[Interrupt]`.

### Thread subscribe and live events

```
orchestration.subscribeThread {threadId, afterSequence:0}
  -> {"kind":"snapshot","snapshotSequence":56,"projection":{thread,runs,attempts,nodes,subagents,providerSessions,providerThreads,providerTurns,runtimeRequests,messages,plans,turnItems,checkpoints,contextHandoffs,visibleTurnItems,updatedAt}}
  -> {"kind":"event","sequence":57,"event":{id,threadId,runId?,nodeId?,driver?,providerInstanceId,occurredAt,type,payload}}   (live, one per domain event)
```

- Created through RPC with no provider login: `projects.ensureScratch {}` then `orchestration.dispatchCommand {type:"thread.create", commandId, createdBy:"user", creationSource:"web", threadId, projectId, title, modelSelection:{instanceId,model}, runtimeMode, interactionMode, branch:null, worktreePath:null}` returns `{sequence}`. `threadId`, `commandId` are client UUIDs.
- Live proof: `thread.metadata.update {title}` while subscribed produced `event type=thread.metadata-updated` immediately.
- Event types seen on one thread: `thread.metadata-updated`, `thread.model-selection-updated`, `thread.provider-switched`, then, after `message.dispatch`: `provider-thread.updated, run.created, run-attempt.created, node.updated, checkpoint-scope.created, message.updated, turn-item.updated, provider-session.attached/updated, run.updated, run-attempt.updated, provider-turn.updated`. A **real run attempt happened** (`message.dispatch` with `dispatchMode:{type:"start_immediately"}`): Claude is not authenticated on the rig, so the run failed within about 1 s, with a `terminal-failure` turn item and `provider-turn.updated {status:"failed", turnTokenUsage{…}}`. No model was called, no cost. `fixtures/subscribeThread-items.json` holds all of it.
- `sequence` is a **global, per-environment event counter**, not per thread (one thread's events jump from 6 to 57 when other threads write). Store the last `sequence` seen per subscription.
- The app's own call (`fixtures/app-thread-open.jsonl`): `{"threadId":…,"afterSequence":86,"requestCompletionMarker":true,"acceptBoundedSnapshot":true,"acceptDeferredWork":true,"acceptCompactTurnItems":true,"acceptDedupedBodies":true,"acceptCompactIds":true}`. A plugin client should **omit the `accept*` flags**: the spike omitted them and got full, uncompacted snapshots and events. With the flags, bodies may be omitted and ids compacted, and the client must restore them (more code, no benefit).

### thread.model-selection.set and provider.switch

| Call | Result |
|---|---|
| `thread.model-selection.set` same provider, other model | `{sequence}`, event `thread.model-selection-updated` |
| `thread.model-selection.set` unknown instance | `Fail OrchestrationV2DispatchCommandError … "No orchestration provider adapter is registered for nope."` |
| `provider.switch` to `codex` (not installed on the rig) | `{sequence}`, event `thread.provider-switched`. **No installed/auth check at dispatch time**; failures show up when the next run starts. |
| `provider.switch` right after `message.dispatch` (run active) | **`OrchestratorProviderSelectionBusyError` reproduced**: `Fail OrchestrationV2DispatchCommandError {commandType:"provider.switch", message:"Thread … has an active turn. Wait for it to finish, then retry the provider selection change.", cause{name:"OrchestratorProviderSelectionBusyError", …}}`. Detect it with `cause.name`, not `_tag` (the outer `_tag` is `OrchestrationV2DispatchCommandError`). Window was about 1 s here. |
| Invalid command `type` | `Die` listing the expected union (about 5 KB of text, truncate it in UIs) |

`thread.model-selection.set` across providers (to another `instanceId` with valid adapter) was not tested; `provider.switch` is the documented path for that. `message.dispatch` requires `dispatchMode` (contracts `orchestrationV2.ts:3383`).

### Reconnect and resubscribe

Reader A subscribed (`afterSequence:0`, got `snapshot@87` then events 88..100) while a writer renamed the thread every 60 ms. A's socket was closed abruptly (no `Interrupt`) after sequence 100; 600 ms later reader B subscribed with `afterSequence: 100`.

```
A saw snapshot@87,88,...,100
B (afterSequence=100) saw 101,102,...,126        <- first item is an event, no snapshot
union: first 88 last 126, 39 distinct, 39 received => duplicates 0, contiguous true
```

Rules for the client: `afterSequence` = last **event** `sequence` (or the snapshot's `snapshotSequence` if no event arrived yet). The server sends events with `sequence > afterSequence` only, and a snapshot only when `afterSequence` is 0 (not tested beyond that: an `afterSequence` older than the server's retention may force a snapshot, the app sets `acceptBoundedSnapshot` for that case). Ticket: fetch a new one per reconnect (TTL 300 s).

### Renderer proof (`renderer-probe.js`)

Run in the page main world through `cdp-eval`: bridge bearer, ticket, `WebSocket`, `server.getConfig` all work from `t3code://app` and returned the 10 providers (`fixtures/renderer-probe-output.json`). Page-side `document.cookie` is empty and unneeded.

## RPC methods (221 found, 30 streams marked `*`)

Complete machine-readable list: `fixtures/methods.json` (extracted by `list-methods.mjs` from `packages/contracts/src/*.ts`; the 221 equal the number of `Rpc.make` registrations, none left unmatched). The plugin-relevant ones with a purpose:

| Method | Purpose |
|---|---|
| `server.getConfig` | environment, auth policy, settings, keybindings, `providers[]` (+`usageLimits`) in one call |
| `subscribeServerConfig*` | config snapshot then `providerStatuses`, usage-limit-source and theme updates |
| `server.refreshProviders` | re-probe providers (and usage limits with `usageLimitsCommand`) |
| `server.updateProvider`, `provider.consumeResetCredit` | update a provider CLI; redeem a banked usage reset |
| `server.getSettings`, `server.updateSettings` | read, change server settings |
| `server.getUsageSummary`, `server.refreshUsageRates` | token and cost totals; refresh price tables |
| `server.probe`, `server.reportClientActivity` | connection probe; presence ping |
| `subscribeServerLifecycle*` | `welcome` and lifecycle events with a sequence |
| `orchestration.subscribeShell*` | sidebar-level stream: projects, thread summaries (`thread.updated`, `thread.removed`, `project.updated`) |
| `orchestration.subscribeThread*` | per-thread snapshot plus live domain events |
| `orchestration.getThreadProjection` | one-shot projection of a thread (no stream) |
| `orchestration.dispatchCommand` | send any `OrchestrationV2Command` (`thread.create`, `thread.metadata.update`, `thread.model-selection.set`, `provider.switch`, `message.dispatch`, `run.interrupt`, `thread.stop`, …) |
| `orchestration.getTurnItem`, `getTurnDiff`, `getFullThreadDiff` | fetch one turn item (omitted bodies), diffs |
| `orchestration.searchThreads`, `searchThread`, `searchThreadStream*` | find threads and text inside one |
| `orchestration.getThreadFamily`, `getThreadTitles`, `getThreadLinkMetadata`, `getWorktreeThreadIds` | lineage and link metadata |
| `orchestration.getOlderSettledThreads`, `getArchivedShellSnapshot` | paging for settled and archived threads |
| `orchestration.launchThread`, `forceStopThread`, `stopWorkflow`, `getWorkflowScript`, `getNativeChildWork` | start a thread with workspace strategy; force stop; workflow and child-work reads |
| `orchestration.subscribeCommandOutput*`, `subscribePromptSuggestion*` | live command output tail of one turn item; prompt suggestions |
| `projects.ensureScratch`, `createNew`, `createFromThread`, `mutate` | project creation and mutation (`project.create/update/delete`) |
| `projects.readFile`, `writeFile`, `listEntries`, `searchEntries`, `searchContents`, `listIgnoredFiles` | workspace file access scoped to a cwd |
| `provider.auth.start/respond/complete/cancel/logout/subscribe*`, `provider.install.*` | provider login and install flows |
| `terminal.open/write/resize/clear/close`, `terminal.attach*`, `terminal.observe*`, `subscribeTerminalMetadata*` | PTY terminals |
| `vcs.*`, `subscribeVcsStatus*`, `subscribeVcsBranch*`, `git.runStackedAction*` | git status, refs, worktrees, stacked actions |
| `pullRequests.*` (35), `review.*`, `sourceControl.*` | PR list, detail, checks, review guide, source-control sign-in |
| `scheduledTasks.*`, `peerLinks.*`, `guestShare.create` | scheduled tasks, linked environments, guest share |
| `device.*`, `preview.*`, `mcpApps.*`, `secrets.answerRequest` | device hub, in-app browser preview, MCP apps, secret requests |
| `filesystem.browse/getMetadata`, `shell.openInEditor`, `assets.*`, `attachments.*`, `agentSessions.*` | filesystem browse, open in editor, uploads, import of native agent sessions |
| `server.*` remaining (about 30) | diagnostics, storage cleanup, ACP registry, updates, source-control discovery, telemetry |
| `projectClone.*`, `worktreeSetup.cancel`, `cloud.*` | clone and worktree-setup jobs, relay client |

Methods used by the app on page load, in order (`fixtures/app-load.jsonl`): `subscribeServerConfig`, `subscribeServerLifecycle` (twice), `subscribeProjectClones`, `subscribePreviewEvents`, `orchestration.subscribeShell`, `agentSessions.scan`, `subscribeDeviceState`, `preview.reportProfiles`, `server.refreshProviders`.

Deviation: the task asked for a one-line purpose per method. 221 hand-written lines would be mostly noise, so only the 45 or so methods plugins can use are described; the rest are grouped. The names are all in `methods.json`.

## Recommendations and plan amendments

**Section 2 (facts)**

- `usageLimits.windows[]` items are `{id, kind: "session"|"weekly"|"monthly"|"other", label, usedPercent, resetsAt?, windowDurationMins?, modelIds?, providerIds?}`; the plan listed four of them. `usageLimits` also has `resetCredits`, `unavailable{reason}`, `zeroSpendCap`, `externalUsage`, and **the whole object is optional**: absent until a successful probe. Update the sentence.
- "Auth: a `wsTicket` from `POST /api/auth/websocket-ticket`, or a bearer token": replace with: ticket from `POST /api/auth/websocket-ticket/rpc` (needs `Authorization: Bearer`, TTL about 300 s, reusable inside the TTL), or the bearer on the upgrade header for non-browser clients. Browsers must use the ticket.
- Add: server binds 127.0.0.1 only; sequences are global per environment; the `thread.provider-switched` event has no installed or auth check.
- U4 is resolved: close it.

**Section 3 (architecture)**

- Keep "no server patch". Add a line: the renderer runtime owns the single RPC client; main-side plugins reach it by IPC, or get a bearer by running the bridge call in the main window.
- The renderer needs no `t3.native` for RPC: the bridge in the main world is enough. This removes a possible dependency of WP-3A on WP-2's preload bridge for `t3.rpc`.

**Section 4 (API surface)**

- `t3.rpc.subscribe` returns `{cancel(), done}`; resumption is built in (`{afterSequence}` handled by `t3.threads.subscribe`, not by plugins).
- `t3.threads.setModel` = `thread.model-selection.set`, `switchProvider` = `provider.switch`; both reject with a typed `ProviderSelectionBusy` error mapped from `cause.name`. `switchProvider` must check `providers.get(id).status` and `installed` itself, because the server accepts a switch to an uninstalled provider.
- `t3.timeline`: events carry `occurredAt`, `runId`, `nodeId`, `driver`, `providerInstanceId`, `type`, `payload` on every event; they map directly onto the planned record. `cause` links need the ids inside payloads (turn-item ids embed the run and attempt).
- Error type for plugins: `{kind: "fail"|"die"|"interrupt", tag?, message}` derived from `Failure.cause[0]`.

**WP-1C (`rpc-client`) spec updates**

1. Start from `docs/spikes/wp-0d/lib.mjs` (`RpcSocket`, about 90 lines, no dependency). Port to TypeScript; keep it dependency-free so the renderer bundle stays small.
2. API: `call(tag, payload)`, `subscribe(tag, payload, onItem, {onClose})` with `cancel()`, `close()`. Send `Ack` per `Chunk`, `Ping` every 5 s, treat 15 s without any frame as dead, reconnect with exponential backoff and a **new ticket each time**.
3. `resubscribe`: store `lastSequence` per `orchestration.subscribeThread` (event `sequence` or `snapshotSequence`); on reconnect send `afterSequence: lastSequence`. Expect events only; expect a snapshot only when starting from 0.
4. Omit `frameParts` and `accept*` flags (or implement joining and still omit). Send numeric ids.
5. Auth provider interface: `getTicket(): Promise<string>` with two implementations, renderer (bridge bearer then ticket) and node (injected bearer). Do not cache tickets beyond one connection attempt.
6. Typed method map from the vendored contracts: the wire tags are in `fixtures/methods.json`. Generate the map from it, not by hand.
7. Fixtures for framing unit tests: `fixtures/standalone-frames.jsonl` (sent and received, per socket, per section; large frames are truncated with a `...<truncated N chars>` marker and are meant for shape tests only), `app-load.jsonl`, `app-thread-open.jsonl`, `app-concurrent.jsonl` (CDP captures of the app's own socket; `op:1` is a text frame; the leading `\u001e` rows show real frame parts). Full-size payloads: `server-getConfig.json`, `subscribeThread-items.json`.
8. Integration test on rig: reuse `spike.mjs` sections 2, 5 and 8 almost verbatim. Accept check "lists providers and streams one thread's events" is satisfiable on an unauthenticated rig (providers list, a thread, and a failed run's events). A populated `usageLimits` needs a logged-in provider.

**Risks recorded**

- `usageLimits` content was not seen live (see caveat above).
- `thread.model-selection.set` across providers is untested.
- `Ack` withholding and `afterSequence` older than retention are untested.
- A reused ticket is accepted today; do not depend on that.
- The bearer is a full-scope token: the permission model (WP-2) should gate `t3.rpc` and any API that exposes the bridge token.

## Reproduce

All commands from the repo root on FOX, node 22+ (tested on 24.7). No npm dependencies.

```
pwsh -NoProfile -File tools/rig/launch.ps1 -Slot 2
node docs/spikes/wp-0d/capture-cdp.mjs --slot 2 --reload --seconds 8 --out docs/spikes/wp-0d/fixtures/app-load.jsonl
MSYS_NO_PATHCONV=1 node docs/spikes/wp-0d/capture-cdp.mjs --slot 2 --seconds 8 --hash "#/<environmentId>/<threadId>" --out docs/spikes/wp-0d/fixtures/app-thread-open.jsonl
node docs/spikes/wp-0d/spike.mjs                       # sections 0 to 8, writes fixtures/, prints spike-output.txt
node tools/rig/cdp-eval.mjs --slot 2 "$(cat docs/spikes/wp-0d/renderer-probe.js)"
node docs/spikes/wp-0d/list-methods.mjs <upstream-root> > docs/spikes/wp-0d/fixtures/methods.json
pwsh -NoProfile -File tools/rig/stop.ps1 -Slot 2; pwsh -NoProfile -File tools/rig/reset.ps1 -Slot 2
```

Files: `lib.mjs` (tunnel, CDP bearer fetch, `RpcSocket`), `spike.mjs`, `capture-cdp.mjs`, `list-threads.mjs`, `list-methods.mjs`, `renderer-probe.js`, `spike-output.txt` (one full run).
Sanitizing: tickets, bearer, `wsTicket=` values replaced with `<redacted>`; Windows user directory names replaced with `<user>`; the throwaway home `G:\rig-run\t3patcher\home-s2` appears as-is. `fixtures/usage-limits-sample.json` is usage numbers only from FOX's cache (credential fingerprint dropped).

Notes on the environment: slot 2 shares rig's real user home for provider config discovery (`~/.claude`, `~/.codex`), which is why `claudeAgent` shows as installed. Only `T3CODE_HOME` is throwaway.
