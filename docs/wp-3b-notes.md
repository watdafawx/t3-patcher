# WP-3B notes: `t3.providers`, `t3.threads`, `t3.usage`

Branch `t3/renderer-runtime-providers-threads-usage`. Implements the WP-3B slice of the frozen API in
`packages/api/src/t3.ts` (no type changed; `T3_API_VERSION` stays `1.0`).

| Piece | Where |
|---|---|
| `t3.providers` + shared provider store | `packages/renderer-runtime/src/providers.ts` |
| `t3.threads`, shell thread store, route/focus tracker | `packages/renderer-runtime/src/threads.ts` |
| `t3.usage` | `packages/renderer-runtime/src/usage.ts` |
| Wiring (3 lines in `createT3`) | `packages/renderer-runtime/src/t3.ts` |
| Tests (21) | `packages/renderer-runtime/test/services.test.ts` |

Everything goes through the one shared `RpcClient` (`SharedRpc` in `rpc.ts`); no second client, no
new IPC channel, no main-process change. The stubs for `timeline`, `cache`, `ui`, `commands`,
`keybinds`, `patches` and `internals` are untouched.

## Permission

All three namespaces need the `rpc` permission (declared in `plugin.json` **and** granted), the same
gate as `t3.rpc`; without it every method throws/rejects `T3PermissionError` before any RPC or
subscription is created. The check moved into an exported `requireRpc()` in `rpc.ts` so `t3.rpc` and
the data services share one message (the only change to `rpc.ts`).

## `t3.providers`

- One `ProviderStore` per renderer, keyed by the shared RPC client: every plugin sees the same
  cache and the same single `subscribeServerConfig` stream. It is started lazily by the first
  `list()` / `onChange()` / `refresh()`; `server.getConfig` is called once.
- Stream payload: `{ usageLimitSources: true, usageLimitsCommand: true }` (the flags the app itself
  sends for live limits). No `accept*` flags, per WP-0D.
- Cache updates from `snapshot` (`config.providers`), `providerStatuses` (`payload.providers`) and
  `providerStatusDeltas`. Deltas are merged by `instanceId`; when a delta leaves out `models`,
  `slashCommands` or `skills` (the client is expected to hold them) the previous list is kept.
- `onChange(cb)` gets the full list after a stream update or `refresh()`, **not** after the first
  load. The disposer is registered on the plugin `Scope`, so stop/disable/reload removes it.
- `refresh(options)` calls `server.refreshProviders` (`{}` or `{instanceId}`) and replaces the cache
  with the returned full list (falling back to `server.getConfig` if the answer has no providers).
- `limits(instanceId)` returns the provider's `usageLimits` verbatim, `undefined` when the provider
  reports none. A provider that cannot measure returns `{checkedAt, windows: [], unavailable:
  {reason: "unsupported"}}` (the recorded fixture's `opencode`), which is returned as-is.
- `list()`/`get()` return array copies; entries are the wire objects (treat as read-only).

## `t3.threads`

**Route pattern (documented finding).** `.upstream/apps/web/src/appInit.tsx:253-254` builds the
router with `createHashHistory()` in Electron and `createBrowserHistory()` in a browser. The thread
route is `_chat.$environmentId.$threadId` (`routes/_chat.$environmentId.$threadId.tsx`), i.e.
`/<environmentId>/<threadId>`. So the desktop URL is `t3code://app/#/<environmentId>/<threadId>`
(consistent with WP-0D's `--hash "#/<environmentId>/<threadId>"` capture). `threads.$environmentId.$threadId`
is only a copied-link route that redirects there. The reader takes the hash when it starts with `#/`,
otherwise `pathname`, drops the query and trailing slashes, decodes segments, and rejects the app's
other two-segment routes (`settings`, `draft`, `welcome`, `connect`, `pair`, `projects`, ... see
`RESERVED_FIRST_SEGMENTS`) so `/settings/general` is not read as a thread.

`current()` returns that id; a tracker per window wraps `history.pushState`/`replaceState` and
listens to `popstate`/`hashchange`. The tracker is shared by all plugins (one `thread:focus` system
event per navigation, not one per plugin) and is released when the last plugin using it stops.

- `list()` comes from `orchestration.subscribeShell` (one stream per renderer, started by the first
  `list()`): a snapshot replaces the map, `thread.updated` upserts (an `archive` location removes the
  row), `thread.removed` deletes. Rows are sorted by `updatedAt` descending (id ascending on ties).
  `running` uses the live shell statuses (`queued|preparing|starting|running|waiting`).
- `projection(id)` = `orchestration.getThreadProjection`.
- `subscribe(id, cb, {afterSequence})` uses `watchThread` from `@t3p/rpc-client`, so reconnects
  resume with `resumeAfterSequence` (snapshot first, then each event; no duplicates, no gap).
  The API callback sees the stream items as they are (`snapshot`/`event`); the internal
  `synchronized` marker is not forwarded (it only exists when `requestCompletionMarker` is set).
  Cancelling is idempotent and also happens when the plugin stops.
- `dispatch(command)` = `orchestration.dispatchCommand`; rejects on transport/server errors, like
  the API says.
- `setModel(id, selection)` dispatches `thread.model-selection.set`. `switchProvider` dispatches
  `provider.switch`. Both build `commandId` with `crypto.randomUUID()` (fallback: timestamp+random)
  and map the wire selection: `providerInstanceId` becomes `instanceId`; `options` is passed through
  unchanged because the server's `ModelSelection` schema accepts both the canonical `[{id, value}]`
  array and the legacy record form the API type uses.
- Result mapping (`SwitchResult`, never throws for these outcomes):
  - `{status: "ok", result: {sequence}}` on success;
  - `{status: "busy"}` when the failure's nested cause name is
    `OrchestratorProviderSelectionBusyError` (outer tag `OrchestrationV2DispatchCommandError`).
    Detection uses `RpcError.causeName`/`isProviderSelectionBusy` and, for plain errors, walks the
    Effect cause array, so a mocked/other client maps the same way;
  - `{status: "unavailable"}` for a provider that is unknown, not installed, `enabled: false`, or in
    a status other than `ready`/`warning` (`error` covers unauthenticated providers). Nothing is
    sent in that case. The status rule is the brief's "status is usable" made concrete: only a
    provider that can run a turn is accepted;
  - `{status: "error", message, cause}` for every other failure (including "provider list could not
    be read").

## `t3.usage`

Computed from thread projections (`orchestration.getThreadProjection`), one call per thread.
`thread(id)` sums every `providerTurns[].tokenUsage` of that projection. `summary(range)` walks
`t3.threads.list()` and sums the turns inside the range.

Exactly which fields are summed (also in the `usage.ts` header comment):

```
inputTokens       += turn.tokenUsage.inputTokens       ?? 0
cachedInputTokens += turn.tokenUsage.cachedInputTokens ?? 0
outputTokens      += turn.tokenUsage.outputTokens      ?? 0
totalTokens        = inputTokens + cachedInputTokens + outputTokens
```

`totalTokens` therefore counts cache reads as processed tokens. Not summed: `usedTokens` (context
window gauge; `t3.usage.context(threadId)` returns the latest `usedTokens`/`maxTokens`, not a sum), `maxTokens`, `reasoningOutputTokens` (already inside `outputTokens`), the
prompt-cache fields, and the separate `turnTokenUsage` roll-up (it overlaps `tokenUsage`; summing
both would double count).

A turn's time is `completedAt`, else `startedAt`, else `tokenUsage.updatedAt`; the range is
inclusive on both ends. `byProvider` is keyed by the provider instance that ran the turn (via
`providerThreads[]`), falling back to the projection's `thread.providerInstanceId`. Threads with no
matching turn are left out of `byThread`/`byProvider`. A thread whose `updatedAt` is before
`range.from` is not fetched at all (a safe shortcut: `updatedAt` only grows; the per-turn filter is
still exact).

## Gaps and decisions for the master to review

1. **Archived threads are not in `t3.threads.list()`** (snapshot `threads` only, archived rows are
   dropped). `usage.summary` therefore counts active threads only. WP-4D's all-sessions view may
   want archived rows: the shell snapshot carries `archivedThreads`, so adding them is a one-line
   change if the API intends "every thread" rather than "the thread list".
2. **"Usable" provider status** is `ready|warning` (plus `installed` and not `enabled: false`), as
   above; the brief did not spell the exact set.
3. `usage.summary` is one `getThreadProjection` call per thread, sequential. Fine for tens of
   threads; a server-side `server.getUsageSummary` exists (WP-0D method list) but is not typed in
   `@t3p/rpc-client` and was out of scope.
4. `setModel` does not pre-check the provider (the API only asks `switchProvider` to). A model from
   another provider is answered by the server as an error result.
5. `t3.providers`/`t3.threads` caches and their two streams live for the page, not per plugin; a
   plugin stop only removes its listeners/subscriptions. This is deliberate (one socket, one
   stream), but a future `app:unload` could clear them.
6. `providerStatusDeltas` merge assumes the server's ordering/omission rule from
   `contracts/src/server.ts` ("every provider in order, lists left out when the client holds them").
   A delta for an unknown provider starts with empty lists.
7. Test evidence is synthetic WebSocket-less RPC (a fake `RpcClientLike`) seeded with the recorded
   `docs/spikes/wp-0d/fixtures/server-getConfig.json`; no rig run was required for this package.

## Acceptance (worktree `t3/renderer-runtime-providers-threads-usage`)

```
pnpm -r build    exit 0
pnpm -r test     exit 0   (renderer-runtime 69 tests: 21 new in test/services.test.ts)
pnpm lint        exit 0
```

`packages/contracts-vendor/UPSTREAM.json` is regenerated by the vendor build (timestamp only); it
was reverted before the commit.
