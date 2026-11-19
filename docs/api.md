# T3 Patcher API reference

This document is generated directly from `@t3p/api` type definitions in `packages/api/src/t3.ts`.
It provides the complete API reference for the frozen `t3` object available to plugin modules.

## Table of contents

- [Core and Lifecycle](#core-and-lifecycle)
- [t3 (Root API)](#root-api)
- [t3.rpc](#t3-rpc)
- [t3.providers](#t3-providers)
- [t3.threads](#t3-threads)
- [t3.timeline](#t3-timeline)
- [t3.cache](#t3-cache)
- [t3.usage](#t3-usage)
- [t3.ui](#t3-ui)
- [t3.commands](#t3-commands)
- [t3.keybinds](#t3-keybinds)
- [t3.patches](#t3-patches)
- [t3.internals](#t3-internals)
- [t3.storage](#t3-storage)
- [t3.settings](#t3-settings)
- [t3.native](#t3-native)
- [t3.events](#t3-events)

## <a id="core-and-lifecycle"></a>Core and Lifecycle

Common types, plugin module interface, lifecycle contracts, and disposable handles.

### `PluginModule`

The shape of a renderer entry module. Export either named `start`/`stop` or the same
two members on the `default` export.

- `start(t3)` runs once per load. It has 5 seconds to finish (a returned promise is awaited);
  a throw or a timeout marks the plugin `failed` and leaves the others untouched.
- It may return a cleanup. The runtime runs it, then `stop()`, then disposes everything the
  plugin registered through `t3` (commands, slots, listeners, subscriptions, settings schemas).
- `stop()` is optional and gets the same time limit.

```ts
export interface PluginModule {
  /** Called once per load with the plugin's own frozen `t3`. */
  start(t3: T3Api): void | PluginCleanup | Promise<void | PluginCleanup>;
  /** Called on disable, hot reload and unload. */
  stop?(): void | Promise<void>;
}
```

#### Members

- `start`: Called once per load with the plugin's own frozen `t3`.
- `stop`: Called on disable, hot reload and unload.

### `PluginCleanup`

What `start` may return to release its own resources on stop: a function or a disposable.

```ts
export type PluginCleanup = (() => void | Promise<void>) | T3Disposable;
```

### `T3Disposable`

An object that releases what it holds.

```ts
export interface T3Disposable {
  /** Releases the registration. Safe to call more than once. */
  dispose(): void;
}
```

#### Members

- `dispose`: Releases the registration. Safe to call more than once.

### `Unsubscribe`

Call to stop listening. Safe to call more than once.

```ts
export type Unsubscribe = () => void;
```

### `JsonValue`

Anything JSON can carry. Storage and settings values are JSON.

```ts
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
```

### `T3LogLevel`

Log level for `T3Api.log`.

```ts
export type T3LogLevel = "debug" | "info" | "warn" | "error";
```

### `T3_API_VERSION`

Version of this API surface, `major.minor`. The major changes only on a breaking change.

```ts
export const T3_API_VERSION = "1.0";
```

## <a id="root-api"></a>t3 (Root API)

The root `T3Api` instance provided to plugin modules, plugin metadata, and development helpers.

### `T3Api`

The `t3` object a plugin receives in `start`. It is frozen, and bound to one plugin: every
registration, storage key and native call it makes is attributed to that plugin's id.

```ts
export interface T3Api {
  /** API version, `major.minor`. */
  readonly apiVersion: string;
  /** Plugin id (same as `plugin.id`). */
  readonly id: string;
  readonly plugin: T3PluginInfo;
  /** Writes to the main-process log, tagged with the plugin id. */
  log(level: T3LogLevel, message: string): void;

  readonly rpc: T3Rpc;
  readonly providers: T3Providers;
  readonly threads: T3Threads;
  readonly timeline: T3Timeline;
  readonly cache: T3Cache;
  readonly usage: T3Usage;
  readonly ui: T3Ui;
  readonly commands: T3Commands;
  readonly keybinds: T3Keybinds;
  readonly patches: T3Patches;
  readonly internals: T3Internals;
  readonly storage: T3Storage;
  readonly settings: T3Settings;
  readonly native: T3Native;
  readonly events: T3Events;
  /** Dev mode only. */
  readonly __dev?: T3Dev;
}
```

#### Members

- `apiVersion`: API version, `major.minor`.
- `id`: Plugin id (same as `plugin.id`).
- `log`: Writes to the main-process log, tagged with the plugin id.
- `__dev`: Dev mode only.

### `T3PluginInfo`

Identity of the plugin that owns a `t3` object.

```ts
export interface T3PluginInfo {
  id: string;
  version: string;
  /** Highest tier the plugin declared. */
  tier: 1 | 2 | 3;
}
```

#### Members

- `tier`: Highest tier the plugin declared.

### `T3Dev`

Development helpers; present only when the runtime runs in dev mode (`T3P_DEV=1`).

```ts
export interface T3Dev {
  /** Stops a plugin, disposes what it registered, re-imports its files and starts it again. */
  reload(pluginId: string): Promise<void>;
}
```

#### Members

- `reload`: Stops a plugin, disposes what it registered, re-imports its files and starts it again.

## <a id="t3-rpc"></a>t3.rpc

Direct Effect RPC communication over the shared authenticated WebSocket with the T3 Code server.

### `T3Rpc`

The T3 server API: Effect RPC over one WebSocket shared by every plugin. Needs the `rpc`
permission (declared in plugin.json and granted). Gating here is a consent signal, not a boundary
(docs/security.md section 3).

```ts
export interface T3Rpc {
  /**
   * One request, one response. Typed for the methods in `@t3p/rpc-client`'s `RpcMethods`; any
   * other method name compiles with `unknown` payload and result.
   * Rejects with an `RpcError` (`kind` tells why).
   */
  call<M extends keyof RpcMethods & string>(method: M, payload: RpcMethods[M]["payload"]): Promise<RpcMethods[M]["result"]>;
  /** Streaming request. Reconnects and resubscribes by itself; see {@link T3RpcSubscribeOptions.resume}. */
  subscribe<M extends keyof RpcStreams & string>(
    method: M,
    payload: RpcStreams[M]["payload"],
    onItem: (item: RpcStreams[M]["item"]) => void,
    options?: T3RpcSubscribeOptions<RpcStreams[M]["payload"], RpcStreams[M]["item"]>,
  ): T3RpcSubscription;
  /**
   * `fetch` against the T3 server HTTP API with the bearer token attached. `path` starts with `/`,
   * for example `/api/auth/session`. Absolute URLs are refused.
   */
  http(path: string, init?: RequestInit): Promise<Response>;
  /** Connection state of the shared socket. */
  readonly state: RpcClientState;
  /** Observes {@link T3Rpc.state}. */
  onState(callback: (state: RpcClientState) => void): Unsubscribe;
}
```

#### Members

- `call`: One request, one response. Typed for the methods in `@t3p/rpc-client`'s `RpcMethods`; any
other method name compiles with `unknown` payload and result.
Rejects with an `RpcError` (`kind` tells why).
- `subscribe`: Streaming request. Reconnects and resubscribes by itself; see `T3RpcSubscribeOptions.resume`.
- `http`: `fetch` against the T3 server HTTP API with the bearer token attached. `path` starts with `/`,
for example `/api/auth/session`. Absolute URLs are refused.
- `state`: Connection state of the shared socket.
- `onState`: Observes `T3Rpc.state`.

### `T3RpcSubscribeOptions`

Options for `T3Rpc.subscribe`.

```ts
export interface T3RpcSubscribeOptions<P = unknown, I = unknown> {
  /** Stream failure (the stream is over afterwards). */
  onError?(error: Error): void;
  /**
   * Called on every resubscribe after a reconnect. Returns the payload of the new request, so a
   * stream can continue after its last item (for threads: `afterSequence`).
   */
  resume?(lastItem: I | undefined, payload: P): P;
}
```

#### Members

- `onError`: Stream failure (the stream is over afterwards).
- `resume`: Called on every resubscribe after a reconnect. Returns the payload of the new request, so a
stream can continue after its last item (for threads: `afterSequence`).

### `T3RpcSubscription`

A live stream handle.

```ts
export interface T3RpcSubscription {
  /** Stops the stream. Idempotent. */
  cancel(): void;
  /** Resolves (never rejects) when the stream ended for any reason. */
  readonly done: Promise<void>;
}
```

#### Members

- `cancel`: Stops the stream. Idempotent.
- `done`: Resolves (never rejects) when the stream ended for any reason.

## <a id="t3-providers"></a>t3.providers

Inspection of connected AI providers, authentication states, and rate limits.

### `T3Providers`

Connected providers, their auth state and rate limits.

```ts
export interface T3Providers {
  /** All provider instances (cached; the first call loads them). */
  list(): Promise<ProviderSnapshot[]>;
  /** One instance by `instanceId`, or `undefined`. */
  get(instanceId: string): Promise<ProviderSnapshot | undefined>;
  /** Usage limits of one instance, or `undefined` when it reports none. */
  limits(instanceId: string): Promise<ProviderUsageLimits | undefined>;
  /** Fires with the full list whenever any provider changes. */
  onChange(callback: (providers: ProviderSnapshot[]) => void): Unsubscribe;
  /** Asks the server to re-probe providers (`server.refreshProviders`) and returns the new list. */
  refresh(options?: { instanceId?: string }): Promise<ProviderSnapshot[]>;
}
```

#### Members

- `list`: All provider instances (cached; the first call loads them).
- `get`: One instance by `instanceId`, or `undefined`.
- `limits`: Usage limits of one instance, or `undefined` when it reports none.
- `onChange`: Fires with the full list whenever any provider changes.
- `refresh`: Asks the server to re-probe providers (`server.refreshProviders`) and returns the new list.

### `ProviderSnapshot`

NOTE (API freeze): the provider, thread, command and stream types in this file are the WIRE shapes of the
vendored upstream contracts (packages/contracts-vendor). They follow upstream, not this API's version:
a T3 Code release can change them (tier 1 rule: breaks when upstream changes its public contract).
`T3_API_VERSION` covers everything else.

One provider instance as `server.getConfig` reports it (wire shape): status, auth, models, usage limits.

```ts
export type ProviderSnapshot = RpcMethods["server.getConfig"]["result"]["providers"][number];
```

### `ProviderUsageLimits`

Rate-limit windows of a provider instance, when the server reports them.

```ts
export type ProviderUsageLimits = NonNullable<ProviderSnapshot["usageLimits"]>;
```

## <a id="t3-threads"></a>t3.threads

Session thread inspection, projection streaming, model changes, and provider switching.

### `T3Threads`

Threads: list, read, follow, and change a thread's model or provider.

```ts
export interface T3Threads {
  /** Threads known to the shell stream, most recently active first. */
  list(): Promise<ThreadSummary[]>;
  /** The thread the user is looking at, or `null`. Changes are announced on `t3.events` (`thread:focus`). */
  current(): string | null;
  /** Full projection of one thread. */
  projection(threadId: string): Promise<ThreadProjection>;
  /**
   * Snapshot then every event of a thread, gap-free across reconnects. Without `afterSequence`
   * the stream starts with a snapshot.
   */
  subscribe(threadId: string, callback: (item: ThreadStreamItem) => void, options?: { afterSequence?: number }): Unsubscribe;
  /** Sends any orchestration command. Rejects on a transport or server error. */
  dispatch(command: OrchestrationCommand): Promise<DispatchResult>;
  /** Changes the model within the thread's provider (`thread.model-selection.set`). */
  setModel(threadId: string, selection: ModelSelection): Promise<SwitchResult>;
  /** Moves the thread to another provider (`provider.switch`). Checks `installed` and status first. */
  switchProvider(threadId: string, selection: ModelSelection): Promise<SwitchResult>;
  /**
   * Runs `handler` before any turn starts: a message, a server continuation, a new thread, a
   * delegated sub-session (WP-6C). The server holds the command until the handler answers
   * `allow`, `block` (with a reason the user or the delegating agent sees) or `modify` (another
   * provider/model). No answer within `options.timeoutMs` (default 120 s) means allow.
   * Needs the `guard` permission (`t3p grant <id> guard`); throws `T3PermissionError` without it.
   * Handlers of all plugins run in load order; the first `block` wins.
   */
  beforeStart(handler: TurnStartHandler, options?: BeforeStartOptions): T3Disposable;
}
```

#### Members

- `list`: Threads known to the shell stream, most recently active first.
- `current`: The thread the user is looking at, or `null`. Changes are announced on `t3.events` (`thread:focus`).
- `projection`: Full projection of one thread.
- `subscribe`: Snapshot then every event of a thread, gap-free across reconnects. Without `afterSequence`
the stream starts with a snapshot.
- `dispatch`: Sends any orchestration command. Rejects on a transport or server error.
- `setModel`: Changes the model within the thread's provider (`thread.model-selection.set`).
- `switchProvider`: Moves the thread to another provider (`provider.switch`). Checks `installed` and status first.
- `beforeStart`: Runs `handler` before any turn starts: a message, a server continuation, a new thread, a
delegated sub-session (WP-6C). The server holds the command until the handler answers
`allow`, `block` (with a reason the user or the delegating agent sees) or `modify` (another
provider/model). No answer within `options.timeoutMs` (default 120 s) means allow.
Needs the `guard` permission (`t3p grant <id> guard`); throws `T3PermissionError` without it.
Handlers of all plugins run in load order; the first `block` wins.

### `ModelSelection`

A provider instance plus model, the unit of `setModel` and `switchProvider`.

```ts
export interface ModelSelection {
  /** Provider instance id, e.g. `"claudeAgent"`. */
  providerInstanceId: string;
  /** Model id as the provider lists it. */
  model: string;
  /** Provider-specific options (effort and so on). */
  options?: Record<string, JsonValue>;
}
```

#### Members

- `providerInstanceId`: Provider instance id, e.g. `"claudeAgent"`.
- `model`: Model id as the provider lists it.
- `options`: Provider-specific options (effort and so on).

### `ThreadSummary`

One row of the thread list. `raw` is the server shell entry, unmodified.

```ts
export interface ThreadSummary {
  threadId: string;
  title: string;
  projectId: string | null;
  providerInstanceId: string | null;
  model: string | null;
  /** ISO timestamp of the last activity, when known. */
  updatedAt: string | null;
  /** True while a run is active. */
  running: boolean;
  raw: unknown;
}
```

#### Members

- `updatedAt`: ISO timestamp of the last activity, when known.
- `running`: True while a run is active.

### `ThreadProjection`

A thread projection as `orchestration.getThreadProjection` returns it (wire shape).

```ts
export type ThreadProjection = RpcMethods["orchestration.getThreadProjection"]["result"];
```

### `OrchestrationCommand`

An orchestration command (wire shape), for `T3Threads.dispatch`.

```ts
export type OrchestrationCommand = RpcMethods["orchestration.dispatchCommand"]["payload"];
```

### `DispatchResult`

What the server answered to a command (wire shape).

```ts
export type DispatchResult = RpcMethods["orchestration.dispatchCommand"]["result"];
```

### `SwitchResult`

Outcome of `setModel` and `switchProvider`.

```ts
export type SwitchResult =
  | { status: "ok"; result: DispatchResult }
  /** A run is active (`OrchestratorProviderSelectionBusyError`). Retry when it ends. */
  | { status: "busy"; message: string }
  /** The provider is not installed or not ready; nothing was sent. */
  | { status: "unavailable"; message: string }
  | { status: "error"; message: string; cause?: unknown };
```

## <a id="t3-timeline"></a>t3.timeline

Normalized event stream and cause chains for thread turn items, requests, and tool calls.

### `T3Timeline`

Normalized activity records per thread.

```ts
export interface T3Timeline {
  /** All records of a thread so far, oldest first. */
  list(threadId: string): Promise<TimelineRecord[]>;
  /** Existing records first (as one call each, in order), then every new record live. */
  subscribe(threadId: string, callback: (record: TimelineRecord) => void): Unsubscribe;
}
```

#### Members

- `list`: All records of a thread so far, oldest first.
- `subscribe`: Existing records first (as one call each, in order), then every new record live.

### `TimelineRecord`

```ts
export interface TimelineRecord {
  /** Stable across updates and re-delivery. Derived from upstream ids, never from sequence. */
  id: string;
  threadId: string | null;
  /** Sequence of the event (or snapshot) that last wrote this record. */
  sequence: number | null;
  /** Epoch milliseconds (UTC) of when the thing happened. Stable across updates. 0 if unparseable. */
  at: number;
  kind: TimelineKind;
  runId: string | null;
  /** providerInstanceId, e.g. "claudeAgent". "unknown" when nothing identifies it. */
  provider: string;
  /** Short single-line human text (<= 160 chars). */
  summary: string;
  /** Upstream status string (turn item / run / request status), when the source has one. */
  status: string | null;
  cause: TimelineCause | null;
  /** The source item / event / entity, untouched (same object the caller passed in). */
  raw: unknown;
  /** Present only after `enrichFromProviderLog`. */
  enrichment?: TimelineEnrichment;
}
```

#### Members

- `id`: Stable across updates and re-delivery. Derived from upstream ids, never from sequence.
- `sequence`: Sequence of the event (or snapshot) that last wrote this record.
- `at`: Epoch milliseconds (UTC) of when the thing happened. Stable across updates. 0 if unparseable.
- `provider`: providerInstanceId, e.g. "claudeAgent". "unknown" when nothing identifies it.
- `summary`: Short single-line human text (<= 160 chars).
- `status`: Upstream status string (turn item / run / request status), when the source has one.
- `raw`: The source item / event / entity, untouched (same object the caller passed in).
- `enrichment`: Present only after `enrichFromProviderLog`.

### `TimelineKind`

Closed set of record kinds. Anything the normalizer cannot classify becomes `unknown`.

```ts
export type TimelineKind =
  | "message.user"
  | "message.assistant"
  | "reasoning"
  | "plan"
  | "command"
  | "file-change"
  | "search"
  | "tool"
  | "approval.request"
  | "approval.resolved"
  | "input.request"
  | "input.resolved"
  | "secret-request"
  | "link-request"
  | "checkpoint"
  | "interrupt.request"
  | "interrupt.result"
  | "notice"
  | "notification"
  | "error"
  | "compaction"
  | "handoff"
  | "fork"
  | "thread.spawn"
  | "thread.lifecycle"
  | "provider-switch"
  | "model-switch"
  | "subagent.start"
  | "subagent.end"
  | "run.start"
  | "run.end"
  | "unknown";
```

### `CauseRelation`

```ts
export type CauseRelation =
  | "in-run" // item belongs to the run
  | "triggered-by" // run started by this user message
  | "continues" // run continues an earlier run (restart / manual / usage-limit)
  | "ends" // end record closes its start record
  | "child-of" // item's parentItemId
  | "approval-for" // approval/input request blocks this tool call
  | "resolves" // resolution answers a request
  | "in-subagent" // item produced inside a subagent's node tree
  | "spawned-by" // subagent started from this item/run
  | "handoff-into" // handoff delivered context into this run
  | "delegated-by";
```

### `TimelineCause`

```ts
export interface TimelineCause {
  /** `TimelineRecord.id` of the record that caused this one. */
  recordId: string;
  relation: CauseRelation;
}
```

#### Members

- `recordId`: `TimelineRecord.id` of the record that caused this one.

### `ProviderFrame`

A provider frame merged in by `enrichFromProviderLog`.

```ts
export interface ProviderFrame {
  /** Log line timestamp (epoch ms), or null when the line header was unreadable. */
  at: number | null;
  /** `native`, `canonical` or `orchestration` (log stream label), lowercased. */
  stream: "native" | "canonical" | "orchestration" | "unknown";
  /** Parsed JSON of the line payload (as logged, possibly truncated by the server). */
  frame: unknown;
}
```

#### Members

- `at`: Log line timestamp (epoch ms), or null when the line header was unreadable.
- `stream`: `native`, `canonical` or `orchestration` (log stream label), lowercased.
- `frame`: Parsed JSON of the line payload (as logged, possibly truncated by the server).

### `TimelineEnrichment`

```ts
export interface TimelineEnrichment {
  /** Why these frames were attached (matched id). */
  matchedBy: string[];
  frames: ProviderFrame[];
}
```

#### Members

- `matchedBy`: Why these frames were attached (matched id).

## <a id="t3-cache"></a>t3.cache

Prompt-cache countdown tracking, TTL state, and expiration notifications.

### `T3Cache`

Prompt-cache state per thread.

```ts
export interface T3Cache {
  /** Current state, or `null` when the thread has no provider turn yet. */
  state(threadId: string): Promise<CacheState | null>;
  /** Fires once when the cache is `leadMs` milliseconds from expiring. */
  onExpiring(threadId: string, leadMs: number, callback: (state: CacheState) => void): Unsubscribe;
}
```

#### Members

- `state`: Current state, or `null` when the thread has no provider turn yet.
- `onExpiring`: Fires once when the cache is `leadMs` milliseconds from expiring.

### `CacheState`

Prompt-cache state of one thread.

```ts
export interface CacheState {
  /** Epoch ms when the cache expires, or `null` when unknown. */
  expiresAt: number | null;
  ttlMs: number | null;
  /** `reported`: the provider said so. `carried`: reused from an earlier turn. `assumed`: a per-provider estimate. */
  source: "reported" | "carried" | "assumed";
  /** Epoch ms of the last provider request, or `null`. */
  lastRequestAt: number | null;
}
```

#### Members

- `expiresAt`: Epoch ms when the cache expires, or `null` when unknown.
- `source`: `reported`: the provider said so. `carried`: reused from an earlier turn. `assumed`: a per-provider estimate.
- `lastRequestAt`: Epoch ms of the last provider request, or `null`.

## <a id="t3-usage"></a>t3.usage

Token usage aggregation by time range, session thread, and provider instance.

### `T3Usage`

Token usage.

```ts
export interface T3Usage {
  /** Usage over a time range across all threads. */
  summary(range?: UsageRange): Promise<UsageSummary>;
  /** Token totals of one thread. */
  thread(threadId: string): Promise<TokenTotals>;
  /**
   * Context-window gauge of one thread: the latest `usedTokens` / `maxTokens` any provider turn
   * reported (not a sum). A field is `null` when no turn reported it.
   */
  context(threadId: string): Promise<{ usedTokens: number | null; maxTokens: number | null }>;
}
```

#### Members

- `summary`: Usage over a time range across all threads.
- `thread`: Token totals of one thread.
- `context`: Context-window gauge of one thread: the latest `usedTokens` / `maxTokens` any provider turn
reported (not a sum). A field is `null` when no turn reported it.

### `UsageRange`

Time range in epoch ms. Open ends mean "from the beginning" or "until now".

```ts
export interface UsageRange {
  from?: number;
  to?: number;
}
```

### `TokenTotals`

Token totals.

```ts
export interface TokenTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
}
```

### `UsageSummary`

Usage over a range.

```ts
export interface UsageSummary {
  range: UsageRange;
  totals: TokenTotals;
  byThread: Record<string, TokenTotals>;
  byProvider: Record<string, TokenTotals>;
}
```

## <a id="t3-ui"></a>t3.ui

DOM slot mounting across the application, toasts, modal dialogs, and theme tokens.

### `T3Ui`

UI mounting, toast and modal.

```ts
export interface T3Ui {
  /** Mounts UI in a slot. Dispose to remove it. */
  register(registration: UiSlotRegistration): T3Disposable;
  /** Shows a toast. */
  toast(options: ToastOptions): void;
  /** Opens a modal. Resolves with the index of the button pressed, or `-1` when dismissed. */
  modal(options: ModalOptions): Promise<number>;
  /** The app's current CSS custom properties (theme tokens), so plugin UI can match. */
  themeVars(): Record<string, string>;
}
```

#### Members

- `register`: Mounts UI in a slot. Dispose to remove it.
- `toast`: Shows a toast.
- `modal`: Opens a modal. Resolves with the index of the button pressed, or `-1` when dismissed.
- `themeVars`: The app's current CSS custom properties (theme tokens), so plugin UI can match.

### `UiSlotRegistration`

A piece of plugin UI. The plugin renders into `host` with whatever it likes.

```ts
export interface UiSlotRegistration {
  slot: UiSlotName;
  /** Unique within the plugin. */
  id: string;
  /** Tab or entry title, for slots that show one. */
  title?: string;
  /** Lower first. Default 0. */
  order?: number;
  /** Renders into `host`. May return a cleanup. */
  render(host: HTMLElement, context: UiSlotContext): void | (() => void);
}
```

#### Members

- `id`: Unique within the plugin.
- `title`: Tab or entry title, for slots that show one.
- `order`: Lower first. Default 0.
- `render`: Renders into `host`. May return a cleanup.

### `UiSlotName`

Where plugin UI can mount.

```ts
export type UiSlotName =
  | "sidebarSection"
  | "threadHeader"
  | "composerBanner"
  | "rightPanel"
  | "statusBar"
  | "settingsPage"
  | "timelineRowDecorator"
  | "contextMenuItem";
```

### `UiSlotContext`

Context a slot render function gets.

```ts
export interface UiSlotContext {
  slot: UiSlotName;
  /** Thread the slot belongs to, for thread-scoped slots. */
  threadId: string | null;
  /** Row record, for `timelineRowDecorator`. */
  record: TimelineRecord | null;
  /** Fires when the app theme changes. */
  onThemeChange(callback: () => void): Unsubscribe;
}
```

#### Members

- `threadId`: Thread the slot belongs to, for thread-scoped slots.
- `record`: Row record, for `timelineRowDecorator`.
- `onThemeChange`: Fires when the app theme changes.

### `ToastOptions`

A toast.

```ts
export interface ToastOptions {
  title?: string;
  message: string;
  kind?: "info" | "success" | "warning" | "error";
  /** 0 keeps it until dismissed. Default 5000. */
  durationMs?: number;
}
```

#### Members

- `durationMs`: 0 keeps it until dismissed. Default 5000.

### `ModalOptions`

A modal dialog.

```ts
export interface ModalOptions {
  title: string;
  /** Plain text body, or a function that renders into the body element. */
  body: string | ((host: HTMLElement) => void | (() => void));
  /** Button labels; the chosen index resolves the promise. Default `["OK"]`. */
  buttons?: string[];
}
```

#### Members

- `body`: Plain text body, or a function that renders into the body element.
- `buttons`: Button labels; the chosen index resolves the promise. Default `["OK"]`.

## <a id="t3-commands"></a>t3.commands

Command palette action registration and execution.

### `T3Commands`

Command palette entries.

```ts
export interface T3Commands {
  /** Adds a command. Dispose to remove it. */
  register(command: CommandRegistration): T3Disposable;
  /** Runs a command by global id (`<pluginId>:<id>`). */
  run(globalId: string, args?: JsonValue): Promise<void>;
  /** All registered commands (global id and title). */
  list(): Array<{ id: string; title: string; plugin: string }>;
}
```

#### Members

- `register`: Adds a command. Dispose to remove it.
- `run`: Runs a command by global id (`<pluginId>:<id>`).
- `list`: All registered commands (global id and title).

### `CommandRegistration`

A command palette entry.

```ts
export interface CommandRegistration {
  /** Unique within the plugin; the global id is `<pluginId>:<id>`. */
  id: string;
  title: string;
  description?: string;
  keywords?: string[];
  run(args?: JsonValue): void | Promise<void>;
}
```

#### Members

- `id`: Unique within the plugin; the global id is `<pluginId>:<id>`.

## <a id="t3-keybinds"></a>t3.keybinds

Keyboard shortcut bindings mapped to commands.

### `T3Keybinds`

Keyboard shortcuts.

```ts
export interface T3Keybinds {
  /** Binds a key. Dispose to remove it. */
  register(keybind: KeybindRegistration): T3Disposable;
  /** All registered keybinds of all plugins. */
  list(): Array<KeybindRegistration & { plugin: string }>;
}
```

#### Members

- `register`: Binds a key. Dispose to remove it.
- `list`: All registered keybinds of all plugins.

### `KeybindRegistration`

A keyboard shortcut bound to a command.

```ts
export interface KeybindRegistration {
  /** Unique within the plugin. */
  id: string;
  /** Chord such as `"mod+shift+k"`. */
  key: string;
  /** Global command id to run. */
  command: string;
  /** Optional context expression, as the app's shortcut system understands it. */
  when?: string;
}
```

#### Members

- `id`: Unique within the plugin.
- `key`: Chord such as `"mod+shift+k"`.
- `command`: Global command id to run.
- `when`: Optional context expression, as the app's shortcut system understands it.

## <a id="t3-patches"></a>t3.patches

Tier 3 raw chunk text patches for runtime code transformation.

### `T3Patches`

Tier 3: raw text patches. Needs the `patches` permission and a `main` entry for patches that apply on first load.

```ts
export interface T3Patches {
  /** Registers patches. They apply to chunks served after registration. Dispose to unregister. */
  register(patches: PluginPatch[]): T3Disposable;
}
```

#### Members

- `register`: Registers patches. They apply to chunks served after registration. Dispose to unregister.

### `PluginPatch`

A tier 3 text patch on an app chunk.

```ts
export interface PluginPatch {
  /** Text that must occur in exactly one chunk. */
  find: string;
  replacements: PluginPatchReplacement[];
}
```

#### Members

- `find`: Text that must occur in exactly one chunk.

### `PluginPatchReplacement`

One text replacement inside a chunk. `$self` in `replace` resolves to the plugin's global handle.

```ts
export interface PluginPatchReplacement {
  match: string | RegExp;
  replace: string;
}
```

## <a id="t3-internals"></a>t3.internals

Tier 2 handles into captured app singletons (router, atom registry, dispatcher).

### `T3Internals`

Tier 2: handles into app internals. They break when upstream refactors.

```ts
export interface T3Internals {
  /** The handle, or `null` when the capture did not run. */
  get<K extends keyof InternalHandles>(name: K): InternalHandles[K] | null;
  /** State of every capture. */
  status(): Record<keyof InternalHandles, InternalCaptureState>;
}
```

#### Members

- `get`: The handle, or `null` when the capture did not run.
- `status`: State of every capture.

### `InternalHandles`

Handles into app singletons, captured by first-party patches.

```ts
export interface InternalHandles {
  atomRegistry: unknown;
  router: unknown;
  shortcutDispatcher: unknown;
  settingsNav: unknown;
  commandPalette: unknown;
}
```

### `InternalCaptureState`

Tier 2 capture state, as `t3p doctor` reports it.

```ts
export type InternalCaptureState = "captured" | "fallback" | "missing";
```

## <a id="t3-storage"></a>t3.storage

Per-plugin isolated key-value JSON storage backed by the patcher home directory.

### `T3Storage`

Per-plugin key-value store, persisted by the main process. Values are JSON. 1 MiB per plugin.

```ts
export interface T3Storage {
  /** The stored value, or `undefined`. */
  get<T extends JsonValue = JsonValue>(key: string): Promise<T | undefined>;
  /** Stores a value. Rejects with {@link T3QuotaError} past the quota. */
  set(key: string, value: JsonValue): Promise<void>;
  /** Removes a key. */
  delete(key: string): Promise<void>;
  /** All keys, sorted. */
  keys(): Promise<string[]>;
  /** Removes everything. */
  clear(): Promise<void>;
  /** Bytes in use (serialized JSON, settings included) and the limit. */
  usage(): Promise<{ usedBytes: number; limitBytes: number }>;
}
```

#### Members

- `get`: The stored value, or `undefined`.
- `set`: Stores a value. Rejects with `T3QuotaError` past the quota.
- `delete`: Removes a key.
- `keys`: All keys, sorted.
- `clear`: Removes everything.
- `usage`: Bytes in use (serialized JSON, settings included) and the limit.

## <a id="t3-settings"></a>t3.settings

Schema-driven plugin configuration with built-in settings UI rendering.

### `T3Settings`

Typed settings that persist, emit change events and describe themselves for the settings UI.

```ts
export interface T3Settings {
  /**
   * Declares settings. Call it once in `start`. Re-declaring replaces earlier schemas; stored values
   * that no longer fit (wrong type, not in the enum list) fall back to the default.
   */
  define(schemas: SettingSchema[]): T3Disposable;
  /** Current value (stored or default). Throws for a key that was never defined. */
  get<T extends SettingValue = SettingValue>(key: string): T;
  /** Validates against the schema, persists, emits a change. Rejects on a type or range mismatch. */
  set(key: string, value: SettingValue): Promise<void>;
  /** Back to the default. */
  reset(key: string): Promise<void>;
  /** Fires after any setting of this plugin changes (by the plugin or by the settings page). */
  onChange(callback: (change: SettingChange) => void): Unsubscribe;
  /** This plugin's schemas, in definition order. */
  getSchemas(): SettingSchema[];
}
```

#### Members

- `define`: Declares settings. Call it once in `start`. Re-declaring replaces earlier schemas; stored values
that no longer fit (wrong type, not in the enum list) fall back to the default.
- `get`: Current value (stored or default). Throws for a key that was never defined.
- `set`: Validates against the schema, persists, emits a change. Rejects on a type or range mismatch.
- `reset`: Back to the default.
- `onChange`: Fires after any setting of this plugin changes (by the plugin or by the settings page).
- `getSchemas`: This plugin's schemas, in definition order.

### `SettingSchema`

The description of one setting. The settings page (WP-3D) renders from it.

```ts
export type SettingSchema = BooleanSettingSchema | StringSettingSchema | NumberSettingSchema | EnumSettingSchema;
```

### `SettingBase`

Common fields of a setting.

```ts
interface SettingBase {
  /** Unique within the plugin. */
  key: string;
  /** Short label for the settings page. */
  label: string;
  description?: string;
}
```

#### Members

- `key`: Unique within the plugin.
- `label`: Short label for the settings page.

### `BooleanSettingSchema`

```ts
export interface BooleanSettingSchema extends SettingBase {
  type: "boolean";
  default: boolean;
}
```

### `StringSettingSchema`

```ts
export interface StringSettingSchema extends SettingBase {
  type: "string";
  default: string;
}
```

### `NumberSettingSchema`

```ts
export interface NumberSettingSchema extends SettingBase {
  type: "number";
  default: number;
  min?: number;
  max?: number;
}
```

### `EnumSettingSchema`

```ts
export interface EnumSettingSchema extends SettingBase {
  type: "enum";
  default: string;
  /** Allowed values (at least one). */
  options: Array<{ value: string; label?: string }>;
}
```

#### Members

- `options`: Allowed values (at least one).

### `SettingValue`

Value type of a setting schema.

```ts
export type SettingValue = boolean | string | number;
```

### `SettingChange`

A change of a setting value.

```ts
export interface SettingChange {
  key: string;
  value: SettingValue;
  previous: SettingValue;
}
```

## <a id="t3-native"></a>t3.native

Permission-gated main process services: scoped filesystem reads, SQLite queries, log tailing, and process spawning.

### `T3Native`

Main-process services. Each call is attributed to this plugin and checked against its effective
permissions in the main process, and checked here against the manifest first. A call without the
permission rejects with `T3PermissionError`. Attribution is a convenience, not isolation
(docs/security.md section 4.5).

```ts
export interface T3Native {
  /** Needs `fs.read`. */
  fsRead(request: NativeFsReadRequest): Promise<NativeFsReadResult>;
  /** Needs `sqlite.read`. */
  sqliteQuery(request: NativeSqliteQueryRequest): Promise<NativeSqliteQueryResult>;
  /** Needs `log.tail`. */
  logTail(request: NativeLogTailRequest): Promise<NativeLogTailResult>;
  /** Needs `spawn`. */
  spawn(request: NativeSpawnRequest): Promise<NativeSpawnResult>;
  /** Calls this plugin's own main-side handler registered with `ctx.ipc.handle(name, fn)`. Needs the `main` entry. */
  invoke<T = unknown>(name: string, payload?: JsonValue): Promise<T>;
}
```

#### Members

- `fsRead`: Needs `fs.read`.
- `sqliteQuery`: Needs `sqlite.read`.
- `logTail`: Needs `log.tail`.
- `spawn`: Needs `spawn`.
- `invoke`: Calls this plugin's own main-side handler registered with `ctx.ipc.handle(name, fn)`. Needs the `main` entry.

### `NativeFsReadRequest`

`fs.read` request. `path` must lie in a granted root.

```ts
export interface NativeFsReadRequest {
  path: string;
  encoding?: "utf8" | "base64";
  /** Byte offset to start at (default 0). */
  offset?: number;
  /** Up to 4 MiB. */
  maxBytes?: number;
}
```

#### Members

- `offset`: Byte offset to start at (default 0).
- `maxBytes`: Up to 4 MiB.

### `NativeFsReadResult`

```ts
export interface NativeFsReadResult {
  path: string;
  size: number;
  offset: number;
  bytesRead: number;
  truncated: boolean;
  encoding: "utf8" | "base64";
  data: string;
}
```

### `NativeSqliteQueryRequest`

`sqlite.query` request: one read-only statement.

```ts
export interface NativeSqliteQueryRequest {
  path: string;
  sql: string;
  params?: Array<string | number | boolean | null>;
  /** Default 1000, at most 10000. */
  maxRows?: number;
  /** Default 5000, at most 30000. */
  timeoutMs?: number;
}
```

#### Members

- `maxRows`: Default 1000, at most 10000.
- `timeoutMs`: Default 5000, at most 30000.

### `NativeSqliteQueryResult`

```ts
export interface NativeSqliteQueryResult {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
  ms: number;
}
```

### `NativeLogTailRequest`

`log.tail` request.

```ts
export interface NativeLogTailRequest {
  path: string;
  /** Cursor from the previous call. Omit to get the last `maxBytes`. */
  cursor?: number;
  /** Up to 1 MiB. */
  maxBytes?: number;
}
```

#### Members

- `cursor`: Cursor from the previous call. Omit to get the last `maxBytes`.
- `maxBytes`: Up to 1 MiB.

### `NativeLogTailResult`

```ts
export interface NativeLogTailResult {
  path: string;
  data: string;
  cursor: number;
  size: number;
  reset: boolean;
  truncated: boolean;
}
```

### `NativeSpawnRequest`

`spawn` request: one allowlisted executable, argv array, no shell.

```ts
export interface NativeSpawnRequest {
  exe: string;
  args?: string[];
  /** Default 10000, at most 120000. */
  timeoutMs?: number;
  stdin?: string;
}
```

#### Members

- `timeoutMs`: Default 10000, at most 120000.

### `NativeSpawnResult`

```ts
export interface NativeSpawnResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  ms: number;
}
```

## <a id="t3-events"></a>t3.events

Application lifecycle hooks and inter-plugin event bus.

### `T3Events`

App lifecycle and plugin events.

```ts
export interface T3Events {
  /** Subscribes to a system event. */
  on<K extends keyof T3EventMap>(name: K, callback: (payload: T3EventMap[K]) => void): Unsubscribe;
  /** The plugin bus. */
  readonly bus: T3EventBus;
}
```

#### Members

- `on`: Subscribes to a system event.
- `bus`: The plugin bus.

### `T3EventMap`

System events and their payloads.

```ts
export interface T3EventMap {
  /** All enabled plugins finished their first load. Fires once per page load. */
  "app:ready": { plugins: string[] };
  /** The page is unloading. Last chance to flush. */
  "app:unload": Record<string, never>;
  /** The focused thread changed. `threadId` is `null` outside a thread. (Fired by WP-3B/3D once they can observe it.) */
  "thread:focus": { threadId: string | null };
  /** A plugin finished `start`. */
  "plugin:started": { id: string };
  /** A plugin was stopped (disabled, reloaded or unloaded). */
  "plugin:stopped": { id: string };
  /** A plugin failed to start or crashed in a hook. */
  "plugin:failed": { id: string; error: string };
}
```

#### Members

- `"app:ready"`: All enabled plugins finished their first load. Fires once per page load.
- `"app:unload"`: The page is unloading. Last chance to flush.
- `"thread:focus"`: The focused thread changed. `threadId` is `null` outside a thread. (Fired by WP-3B/3D once they can observe it.)
- `"plugin:started"`: A plugin finished `start`.
- `"plugin:stopped"`: A plugin was stopped (disabled, reloaded or unloaded).
- `"plugin:failed"`: A plugin failed to start or crashed in a hook.

### `T3EventBus`

A plugin-to-plugin bus, scoped by plugin id.

```ts
export interface T3EventBus {
  /** Emits `name` from this plugin to every listener. */
  emit(name: string, payload?: JsonValue): void;
  /** Listens to this plugin's own events. */
  on(name: string, callback: (payload: unknown) => void): Unsubscribe;
  /** Listens to events another plugin emits. The id need not be loaded yet. */
  onFrom(pluginId: string, name: string, callback: (payload: unknown) => void): Unsubscribe;
}
```

#### Members

- `emit`: Emits `name` from this plugin to every listener.
- `on`: Listens to this plugin's own events.
- `onFrom`: Listens to events another plugin emits. The id need not be loaded yet.

