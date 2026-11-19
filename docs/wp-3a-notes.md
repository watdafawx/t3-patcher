# WP-3A notes: renderer plugin manager and core `t3` API

Branch `t3/wp-3a-plugin-manager-t3-api`. Gate 3 freezes the API in `packages/api/src/t3.ts`.

## What shipped

| Piece | Where |
|---|---|
| Public API types (`T3Api` and every namespace), `PluginModule`, errors | `packages/api/src/t3.ts`, `errors.ts` |
| Plugin manager, per-plugin `t3`, namespaces | `packages/renderer-runtime/src/` (`manager.ts`, `t3.ts`, `scope.ts`, `events.ts`, `storage.ts`, `rpc.ts`, `native.ts`, `stubs.ts`) |
| Main side: storage store, enable/disable/load order, dev watcher | `packages/main-runtime/src/storage/store.ts`, `plugins/host.ts`, `plugins/dev-watch.ts`, `ipc/channels.ts` |
| Sample plugin (not published) | `plugins/_sample-hello` (manifest id `sample-hello`; plugin ids cannot start with `_`, so the rig copy lives in folder `sample-hello`) |

Implemented: `t3.storage`, `t3.settings`, `t3.events`, `t3.rpc`, `t3.native`, `t3.id`, `t3.plugin`, `t3.log`, `t3.apiVersion` (`"1.0"`), `t3.__dev` (dev mode only).
Stubs (final typed signatures, runtime throws `T3NotImplementedError` naming the owner): `providers`, `threads`, `usage` (WP-3B), `timeline` (WP-3C), `cache` (WP-4C), `ui`, `commands`, `keybinds`, `patches`, `internals` (WP-3D).
Stubs throw synchronously, also for async-typed methods, so a missing feature fails at the call site.

## Decisions

1. **`rpc` is a new bare permission** (`PERMISSION_NAMES`, `PermissionSet.rpc`). A plugin gets `t3.rpc` only if declared in `plugin.json` and granted in `state.json` (`effective = declared ∩ granted`). This is a consent signal, not a boundary: the bearer is reachable from the renderer (security.md 3), so a hostile plugin can bypass the check. Documented, not hidden.
2. **Renderer cannot enable plugins that declare `main`, `patches` or `spawn`.** `t3p:plugins:set-enabled` refuses; the CLI (`t3p enable`) is the only path. Disabling such a plugin persists but sets `restartRequired` (main code cannot be unloaded). `grantRpc: true` on enable only grants `rpc`, and only when declared.
3. **Load order**: ids sorted; `loadOrder?: string[]` in `state.json` overrides (listed ids first in that order, rest sorted). The main process applies it in `list`, the renderer loads in list order. `setLoadOrder` rewrites state atomically (`writeStateFile`, re-read before write).
4. **Storage** lives in main: `~/.t3-patcher/storage/<id>.json` (`{kv, settings}`), 1 MiB per plugin for both areas together, atomic write, keys validated, `__proto__` blocked. Deleting and clearing are allowed past quota. Channel: `t3p:storage:read|write`, main-frame sender check as every `t3p:` channel, plugin must be loaded. The plugin id in the request is attribution, not isolation (security.md 4.5): plugins share a renderer.
5. **Settings** persist in the same file (`settings` area). Stored values that no longer fit the schema fall back to the default. `define` can be called more than once; keys are unique per plugin.
6. **Storage failure** (IPC broken) degrades to memory with a `warn` log, so a plugin still starts.
7. **`t3` is frozen per plugin**, carries the id, and every registration goes through a `Scope`. After `stop` the stale `t3` throws `stopped` on new registrations and storage writes. Teardown order: returned cleanup, `stop()`, scope dispose (listeners, settings listeners, rpc subscriptions and state listeners).
8. **start() timeout 5 s** (also for the dynamic import). A failed plugin is marked `failed`, its partial registrations are disposed, others continue.
9. **Hot reload** re-imports `…/r.js?t3pv=<n>` (the virtual route ignores the query). Only the plugin entry is busted, static imports inside the plugin are not. Triggers: `t3p:event {type:"plugin-files-changed", plugin}` (dev only) or `t3.__dev.reload(id)`. Dev = `T3P_DEV=1` in the main process; `t3p:plugins:list` reports `dev`.
10. **One shared `RpcClient`** for all plugins, created on first `t3.rpc` use from `getLocalEnvironmentBootstraps()` (URL only; the `bootstrapToken` is never read) and bearer from `getLocalEnvironmentBearerToken()`. `connect()` retries 20 x 500 ms: plugins start before the T3 server answers on a cold start (found on rig, see evidence). `t3.rpc.http` accepts only paths starting with a single `/`.
11. **Main plugin disable needs restart**; renderer-only plugins stop live.

## API reference (implemented namespaces)

All types exported from `@t3p/api`. `Unsubscribe = () => void`. Errors: `T3PermissionError(plugin, permission, detail?)`, `T3QuotaError(plugin, limitBytes)`, `T3NotImplementedError(api, owner)`.

### Plugin entry

```ts
interface PluginModule { start(t3: T3Api): void | PluginCleanup | Promise<void | PluginCleanup>; stop?(): void | Promise<void> }
```
Named exports or `default` export. `PluginCleanup = () => void | Promise<void>`.

### `t3.storage` (no permission needed)

```ts
get<T extends JsonValue>(key: string): Promise<T | undefined>   // returns a copy
set(key: string, value: JsonValue): Promise<void>               // rejects undefined; T3QuotaError over 1 MiB
delete(key: string): Promise<void>
keys(): Promise<string[]>                                         // sorted
clear(): Promise<void>
usage(): Promise<{ usedBytes: number; limitBytes: number }>
```
Writes of one plugin are serialized in call order.

### `t3.settings` (no permission needed)

```ts
type SettingSchema = { key; type: "boolean"|"string"|"number"|"enum"; default; label: string; description?: string; min?/max? (number); options?: {value; label?}[] (enum) }
define(schemas: SettingSchema[]): T3Disposable
get<T>(key: string): T                       // sync; throws if key not defined
set(key: string, value: SettingValue): Promise<void>   // validates type, range, enum; no event if unchanged
reset(key: string): Promise<void>
onChange(cb: (c: { key; value; previous }) => void): Unsubscribe
getSchemas(): SettingSchema[]
```

### `t3.events` (no permission needed)

```ts
on<K extends keyof T3EventMap>(name: K, cb): Unsubscribe
bus.emit(name: string, payload?: JsonValue): void            // emitted as `<own id>:<name>`
bus.on(name, cb): Unsubscribe                                // own events
bus.onFrom(pluginId, name, cb): Unsubscribe                  // another plugin's events (also main-side plugins)
```
`T3EventMap`: `app:ready {plugins}`, `app:unload {}`, `thread:focus {threadId}` (fired by WP-3B), `plugin:started {id}`, `plugin:stopped {id}`, `plugin:failed {id, error}`. Listener errors are isolated.

### `t3.rpc` (permission `rpc`)

```ts
call<M extends keyof RpcMethods>(method: M, payload): Promise<result>
subscribe<M extends keyof RpcStreams>(method, payload, onItem, options?): { cancel(): void; done: Promise<void> }
http(path: string, init?: RequestInit): Promise<Response>    // bearer added, path must start with one `/`
readonly state: "idle" | "open" | "closed"
onState(cb): Unsubscribe
```
Types come from `@t3p/rpc-client`. Subscriptions are cancelled when the plugin stops. Without the permission every member throws `T3PermissionError`.

### `t3.native` (permissions per call)

| Method | Needs | IPC |
|---|---|---|
| `fsRead({path, ...})` | `fs.read` | `t3p:native:fs.read` |
| `sqliteQuery({path, sql, ...})` | `sqlite.read` | `t3p:native:sqlite.query` |
| `logTail({path, cursor?, ...})` | `log.tail` | `t3p:native:log.tail` |
| `spawn({exe, args?, ...})` | `spawn` | `t3p:native:spawn` |
| `invoke(name, payload?)` | `main` | `t3p:plugin:<id>:<name>` (handler registered by the plugin's main part) |

Checked renderer-side (`T3PermissionError` before anything is sent) and again in main. The plugin id sent is always the caller's; a spoofed `plugin` field in the request is overwritten.

### Dev

`t3.__dev.reload(pluginId): Promise<void>` exists only when the main process reports `dev`.

## `window.__t3p` (for WP-3D settings/manager UI)

`window.__t3p.manager` (frozen facade):

```ts
list(): ManagedPlugin[]       // { id, name, version, tier, hostStatus, status: "started"|"failed"|"inactive"|..., error, hasRenderer, declared, effective, restartRequired }
enable(id, { grantRpc? }) / disable(id) → { restartRequired } / reload(id) / setLoadOrder(order)
schemas(id) / getSetting(id, key) / setSetting(id, key, value) / resetSetting(id, key)
onChange(cb)                  // fires on any list/status/settings change
```
Also `loadResults`, `events` (plugin bus), `version` (renderer runtime, 0.2.0), `dev` (getter).

## IPC added

| Channel | Purpose |
|---|---|
| `t3p:plugins:set-enabled` `{id, enabled, grantRpc?}` | persist enable, returns `{status, restartRequired}` |
| `t3p:plugins:set-load-order` `{order}` | persist `loadOrder` |
| `t3p:storage:read` `{plugin, area}` / `t3p:storage:write` `{plugin, area, op, key?, value?}` | storage and settings |
| `t3p:plugins:list` | now also returns `dev`, per-plugin `tier`, `declared`, `restartRequired` |
| `t3p:event` (push) `{type:"plugin-files-changed", plugin}` | dev watcher |

All in the preload allowlist (`packages/api/src/ipc.ts`).

## Notes for next work packages

- **WP-3B** (providers, threads, usage): replace the stubs in `packages/renderer-runtime/src/stubs.ts` and wire them in `t3.ts` (`createT3`). Use the shared client: `SharedRpc` in `rpc.ts` (`ready()` gives `{client, base}`); gate on the `rpc` permission like `createRpcApi`. Fire `thread:focus` through the shared events bus. Do not add a second `RpcClient`.
- **WP-3C** (timeline): same replacement point. Persist through `t3p:storage` or a new main channel with the same sender check and quota discipline.
- **WP-3D** (ui, commands, keybinds, patches, internals): build the settings page on `window.__t3p.manager` and `getSchemas()`. Register everything through the plugin `Scope` (`scope.ts`) so stop disposes it. `patches` must stay behind the `patches` permission and the main-side gate.
- **WP-3E**: the sample plugin `plugins/_sample-hello` is a minimal template; keep it unpublished.
- **WP-4C** (`t3.cache`): owner of the `cache` stub.
- Anything changing a type in `t3.ts` after Gate 3 is a breaking change; bump `T3_API_VERSION`.

## Rig evidence (slot 1, stock T3 Code 0.1.10, FOX never touched)

```
pnpm -r build                    exit 0
pnpm -r test                     exit 0   (renderer-runtime 48, main-runtime 191, installer 48, ...)
pnpm lint                        exit 0
pwsh -NoProfile -File tools/rig/patch-slot.ps1 -Slot 1
  → EXIT 0, ASAR 07f279d2…188d1 (patched), ORIG 121df7c6…b113 (stock)
copy plugins/_sample-hello → p-s1\.t3-patcher\plugins\sample-hello ; state.json {"sample-hello":{"enabled":true,"granted":["rpc"]}}
pwsh -NoProfile -File tools/rig/launch.ps1 -Slot 1      → READY Chrome/152.0.7977.169
```

First run found a real bug: `RpcError: environment probe failed: Failed to fetch` because plugins start before the T3 server is up. A later `reload` worked. Fix: retry connect (decision 10). Evidence after the fix:

```
cdp-eval --slot 1 "JSON.stringify({load:window.__t3p.loadResults, sample:globalThis.__t3p_sample})"
→ {"load":[{"id":"sample-hello","ok":true}],
   "sample":{"starts":4,"greeting":"hello",
             "rpc":{"keys":["environment","auth","cwd","hostname","keybindingsConfigPath","keybindings","issues","providers"]},
             "rpcError":null}}            # t3.rpc.call('server.getConfig', {}) on a cold start

cdp-eval … "manager.setSetting('sample-hello','greeting','persisted-ok'); location.reload()"
cdp-eval … (after window reload)
→ {"load":[{"id":"sample-hello","ok":true}],"sample":{"starts":5,"greeting":"persisted-ok","rpc":{…8 keys…},"rpcError":null}}

cat Q:\rig-run\t3patcher\p-s1\.t3-patcher\storage\sample-hello.json
→ {"kv":{},"settings":{"count":5,"greeting":"persisted-ok"}}

pwsh -NoProfile -File tools/rig/stop.ps1 -Slot 1   → slot 1 clean, no t3patcher process left on rig
```

`starts` counts every plugin start (the sample increments a persisted `count` setting): it grew 1 → 2 → 3 → 4 → 5 across relaunches, reload and window reload, so settings persist across all three. The `rpc` result on the window reload shows the permission grant survives too.
