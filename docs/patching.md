# Patching mechanics

This document explains the architecture of the T3 Patcher patch engine, stability tiers, chunk interception, runtime captures, and safety guarantees.

## API stability tiers

To balance capability with resilience against upstream releases, T3 Patcher defines three stability tiers. Every plugin declares its highest tier in `plugin.json`.

| Tier | Basis | Failure modes | Resilience |
|---|---|---|---|
| **Tier 1 (Stable)** | Server Effect RPC and HTTP endpoints, files on disk, `data-slot` DOM anchors, CSS custom properties, and native IPC. | Breaks only if upstream introduces breaking changes to its public server protocol or DOM slot structure. | Highest. First-party plugins operate on Tier 1 wherever possible. |
| **Tier 2 (Internals)** | Application singletons captured via first-party patches: `atomRegistry`, zustand stores, TanStack router, shortcut dispatcher, and settings navigation. | Breaks when upstream refactors the internal modules or variables defining these singletons. | Moderate. All captures are maintained centrally in the patcher runtime with automatic DOM fallbacks. |
| **Tier 3 (Raw patches)** | Custom string or regular expression text replacements applied directly to client JavaScript chunks. | Breaks when target code in minified chunks changes. | Fragile. Intended only for functionality that cannot be achieved via Tier 1 or Tier 2. Requires the `patches` permission. |

## Patch format

Patches are defined using the `Patch` interface from `@t3p/patch-engine`:

```ts
interface Replacement {
  match: string | RegExp;
  replace: string | ((substring: string, ...args: any[]) => string);
}

interface Patch {
  plugin: string;
  find: string | RegExp;
  replacement: Replacement | Replacement[];
  predicate?: () => boolean;
}
```

### Key properties

- **`plugin`**: The identifier of the owning plugin (for example, `"t3p.core"` for built-in captures, or a plugin ID).
- **`find`**: A string literal or regular expression used exclusively to locate the target chunk.
  - **Uniqueness rule**: `find` must match **exactly one chunk** across the entire extracted client chunk directory.
  - If `find` matches zero chunks, the engine reports a `no-match` failure.
  - If `find` matches two or more chunks, the engine reports an `ambiguous` failure.
- **`replacement`**: One or more replacement rules applied to the chunk located by `find`.
  - **String `match`**: Performs an exact substring match and replaces the first occurrence only.
  - **RegExp `match`**: Evaluates using the supplied regular expression flags (such as `/g` for global replacements).
  - **String `replace`**: Supports standard JavaScript replacement patterns (`$1`..`$9`, `$&`, `$$`), as well as `$self`.
  - **`$self` expansion**: The token `$self` automatically expands to the plugin's global handle: `window.__t3p_plugins[<pluginId>]`.
  - **Function `replace`**: Allows dynamic transformation via a pure replacement callback.
- **`predicate`**: An optional condition evaluated before planning or applying. If it returns false or throws, the patch is skipped and marked as `predicate`.

## How the patch engine works

The patch engine (`@t3p/patch-engine`) operates as a pure library with no dependencies on Electron.

```
+-------------------------------------------------------------+
|                     Client Chunks (984)                     |
+-------------------------------------------------------------+
                               |
                               v
                     +-------------------+
                     |    planPatches    | <--- Match 'find' to exactly
                     +-------------------+      one chunk per patch
                               |
                               v
                     +-------------------+
                     |   applyPatches    | <--- Apply replacements,
                     +-------------------+      verify with Acorn AST
                               |
                               v
                     +-------------------+
                     |    Disk Cache     | <--- sha256(source) +
                     +-------------------+      sha256(patch set)
```

1. **Chunk indexing and planning**:
   - The engine scans the application's client chunks located in `resources/server.asar/apps/server/dist/client/`.
   - `planPatches(chunks, patches)` evaluates each patch's `find` pattern against all chunks to establish a 1:1 chunk-to-patch mapping.
   - The initial scan indexes approximately 984 chunks (~40 MB of JavaScript) in roughly 200 ms and stores the result in `<T3P_HOME>/.t3-patcher/cache/chunk-index.json`.

2. **Patch application**:
   - `applyPatches(chunkName, source, patches)` processes the assigned patches in order.
   - Each replacement transforms the working code buffer.
   - If any replacement within a patch fails to match, that patch is rolled back and marked `replacement-no-match`.

3. **Disk caching**:
   - Transformed chunks are written to `<T3P_HOME>/.t3-patcher/cache/`, keyed by the SHA-256 hash of the input source combined with the SHA-256 hash of the active patch definitions.
   - Subsequent requests for the same chunk content and patch set are served instantly from disk cache.

## Protocol interception and injection

The patcher intercepts client assets in Electron's main process (`@t3p/main-runtime`):

- **Protocol wrap**: The runtime wraps Electron's `protocol.handle("t3code", ...)` before the application registers its default handler.
- **HTML injection**: When `index.html` is requested from `t3code://app/`, the runtime injects `<script src="/__t3p/renderer.js">` before the first script tag.
- **Chunk patching**: When a JavaScript chunk is requested, the runtime invokes the patch engine if patches are assigned to that chunk.
- **Synthetic endpoints**:
  - `t3code://app/__t3p/renderer.js`: Serves the bundled renderer runtime.
  - `t3code://app/__t3p/plugins/<id>/...`: Serves enabled plugin assets directly from the plugin directory on disk.
- **CSP compliance**: The stock Content Security Policy specifies `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'`. Because all runtime and plugin files are served same-origin under `t3code://app/__t3p/`, the security policy remains unmodified and enforced.

## Safety of replace patches

T3 Patcher prevents invalid or broken patches from breaking the host application:

1. **Acorn syntax parsing**:
   - After applying replacements to a chunk, the patch engine parses the output using Acorn:
     ```ts
     parse(workingCode, { ecmaVersion: "latest", sourceType: "module" });
     ```
   - If the code fails to parse as valid ECMAScript, the engine immediately discards the changes, restores the chunk to its pre-patch state, and logs a `syntax-error` failure.

2. **Atomicity and non-fatal degradation**:
   - Each patch is atomic. A failure in one patch does not prevent subsequent patches on the same chunk from running.
   - If a chunk's transforms fail entirely, the original, unmodified chunk is served to the application. The app continues running with stock behavior.

3. **Safe mode emergency recovery**:
   - If a patch produces syntactically valid code that triggers a runtime logical error in the UI, safe mode can be engaged:
     - Run `t3p safe` from the command line.
     - Set the environment variable `T3P_SAFE=1`.
     - Pass `--t3p-safe` when starting the application.
   - In safe mode, the shim skips runtime loading completely, running pure stock T3 Code.

## Runtime captures (Tier 2)

Tier 2 captures allow plugins to interact with internal application singletons that are not exposed on `window`. These are implemented via first-party patches owned by `t3p.core`.

When the patched modules initialize, they invoke `window.__t3p_plugins["t3p.core"].capture(name, value)`.

| Capture | Module target (0.1.10) | Captured object | Fallback mechanism |
|---|---|---|---|
| `atomRegistry` | `utils-*.js` | Effect atom registry (`createRegistry()`) and React `createElement` | None (`failed`). Required for mounting the native settings route. |
| `router` | Main entry chunk | TanStack Router instance (`createRouter`) | `location.hash` and `window.addEventListener("hashchange")` navigation. |
| `shortcutDispatcher` | `dispatcher-*.js` | Keyboard shortcut registry (`registerCommands`) | Document-level `keydown` listener that checks active element focus. |
| `settingsNav` | Main chunk and settings chunks | Settings routes and navigation entries | Injected DOM button in the settings sidebar opening an overlay modal. |
| `commandPalette` | `commandPaletteBus-*.js` | Command palette group filter | MutationObserver injecting command items directly into `[data-slot="command-list"]`. |

### Status monitoring and fallback reporting

- The renderer runtime reports capture states (`captured`, `fallback`, or `failed`) back to the main process via `t3p:internals:report`.
- The main runtime records these states in `<T3P_HOME>/.t3-patcher/internals-status.json`.
- The CLI command `t3p doctor` validates the health of all five captures and flags any `failed` status.
- Testing fallbacks: Running the application with `T3P_CAPTURES_OFF=all` (or specific capture names) disables the capture patches, activating and verifying the DOM fallbacks.

## Server guard (turn-start hook, WP-6C)

The only patch that runs in the **T3 server process** instead of the client. It lets a plugin
see, block or redirect every command that starts a provider turn, including delegated
sub-sessions an agent starts with `delegate_task`. Plugin API: `t3.threads.beforeStart` (renderer)
and `ctx.threads.beforeStart` (main plugins), both behind the `guard` permission. Spike and
measurements: [`docs/wp-6c-notes.md`](wp-6c-notes.md).

### Chokepoint

`Orchestrator.dispatchWithReceipt` (upstream `apps/server/src/orchestration-v2/Orchestrator.ts`).
Every orchestration command passes it: the web/mobile RPC, the MCP tools agents call
(`delegate_task`, thread tools), thread launches and the server's own reactors. Guarded commands:

| Command | When | `ctx.kind` |
|---|---|---|
| `message.dispatch` | a user or agent message, and server continuations (restart, usage-limit, manual, steer, delegated completion, idle compaction) | `message` |
| `thread.create` with `initialMessage` | a new thread with its first message | `thread-create` |
| `delegated_task.request` | a delegated sub-session | `delegate` |

Every other command passes without delay.

### Mechanics

1. **Spawn wrap** (main runtime, `src/guard/spawn-wrap.ts`). The desktop `main.cjs` starts the
   backend as `<Electron exe> [--require <compile cache>] <resources>/server.asar/apps/server/dist/bin.mjs --bootstrap-fd 3`
   with `ELECTRON_RUN_AS_NODE=1`, through `child_process.spawn`, captured once when `main.cjs` loads.
   The runtime loads first and wraps `spawn`; for that one spawn it prepends
   `--import=<file URL of runtime/server-hook.mjs>` and adds `T3P_GUARD_PIPE` / `T3P_GUARD_TOKEN`
   to its env. WSL backends (spawned through `wsl.exe`) are not touched.
2. **Server hook** (`runtime/server-hook.mjs`, `src/guard/server-hook.ts`). Runs only on the main
   thread of the server entry, removes the two env vars at once (so provider processes never
   inherit them), and registers a synchronous `module.registerHooks` load hook (Node 24 in
   Electron 44). The hook rewrites `apps/server/dist/runtimeLayer-*.mjs` as it loads.
3. **The patch** (`src/guard/server-patch.ts`, `applyServerGuardPatch`). Anchor
   `const dispatchWithReceipt = <fnUntraced>(function* (<command>) {`; it also needs the chunk's
   `tryPromise` import binding and its `OrchestratorDispatchError` class, each found exactly once.
   The injected statement:

   ```js
   /*t3p:server-guard*/if (globalThis.__t3pServerGuard && globalThis.__t3pServerGuard.wants(command))
     command = yield* tryPromise({
       try: () => globalThis.__t3pServerGuard.check(command),
       catch: (cause) => new OrchestratorDispatchError({ commandId: command.commandId, commandType: command.type, cause: String(cause && cause.message || cause) }),
     });
   ```

   Any anchor missing or ambiguous: the chunk loads unpatched and the hook logs a warning to the
   server's stderr (`[t3p guard]`, captured in T3's backend log).
4. **Pipe** (`src/guard/pipe.ts`). `__t3pServerGuard.check` sends `{id, token, ctx}` as one JSON
   line over a named pipe (`\.\pipe\t3p-guard-<pid>-<random>`; a unix socket elsewhere) to the main
   process; a wrong token closes the connection.
5. **Broker** (`src/guard/broker.ts`). Main-plugin handlers run first, in load order. If renderer
   plugins registered (`t3p:guard:register`), the main process pushes
   `t3p:event {type:"guard-request", id, ctx}` and waits for `t3p:guard:answer`; the renderer runs its
   handlers in plugin load order (and fills `provider`/`model` from the thread list when the command
   named none, `modelSource: "thread"`). A page reload sends `t3p:guard:unregister {}`, which drops
   every registration and allows what was pending.

### Decisions

- `allow` (or no answer): the command runs unchanged.
- `block`: `check` rejects, the patched code fails with `OrchestratorDispatchError(cause: reason)`.
  The client's dispatch RPC fails with `OrchestrationV2DispatchCommandError` carrying the reason
  (via the server's `userFacingDispatchErrorMessage`); an agent's `delegate_task` call returns
  `Unable to create delegated task: <reason>`. Nothing hangs.
- `modify`: the command gets `modelSelection: {instanceId, model}` (model options dropped). On an
  existing thread the server applies its normal rules for a model or provider change.
- Handlers of one plugin chain: each sees the context as earlier `modify` answers left it; the first
  `block` wins.

### Fail-open and limits

- Every failure allows: no pipe, a crashed main process, garbage answers, a throwing handler, a
  handler past its timeout (default 120 s, 1 s..5 min), no window to ask, a renderer reload. The
  server side has its own hard cap (5.5 min).
- Commands of one thread keep their order: a second message waits until the first is decided, so a
  message held by a modal cannot be overtaken. Other threads are not delayed.
- `T3P_GUARD=0` turns the whole guard off (no spawn change). Safe mode never installs it.
- Only the local backend is guarded. A WSL backend or a remote/linked environment runs its own
  server process that the runtime does not start.
- The compat checker runs `applyServerGuardPatch` on every server chunk of the target
  (`serverGuard` in the patch list); it must apply to exactly one.

## ACP providers and the MCP Relay (`serverRelay`)

The same `server-hook.mjs` load hook patches `apps/server/dist/runtimeLayer-*.mjs`
(`src/guard/relay-acp-patch.ts`, `applyServerRelayPatch`). T3 builds one MCP list per ACP session in
`sessionMcpServers(initializeResult, activationOptions)` and passes only its own `t3-code` server;
harness-level config files are never read for those sessions (Antigravity, Copilot and the other
ACP adapters).

- The patch inserts a `pick()` call at the top of `sessionMcpServers`; the picker
  (`src/guard/relay-acp.ts`, installed as `globalThis.__t3pRelayAcp`) reads
  `~/.t3-patcher/mcp-relay/config.json` on every session and appends a `t3-relay` HTTP server next
  to `t3-code`.
- Only acts when the agent advertises `mcpCapabilities.http` **and** T3 supplied HTTP servers
  (its `mcpOverHttp` flavors). A missing relay config, an stdio-only agent, or a chunk that does not
  match leaves T3's list untouched.
- `T3P_RELAY_ACP=0` turns it off; `T3P_MCP_RELAY_URL` overrides the URL; `T3P_MCP_RELAY_CONFIG`
  points at another config file.
- The compat checker reports `serverRelay` (`serverRelayFinding`) next to `serverGuard` and
  `serverMcpTools`.



The same `server-hook.mjs` load hook also patches `apps/server/dist/server-*.mjs` (`src/guard/mcp-patch.ts`,
`applyServerMcpPatch`) inside `layerToolExposure` to register custom T3 Patcher MCP tools directly on
T3 Code's `McpServer` (`globalThis.__t3pMcpTools`, `src/guard/mcp-tools.ts`).

- **`t3_provider_limits`**: read-only MCP tool letting any model connected to T3's MCP server check
  configured providers' usage limits, remaining percentage (`remainingPercent`, `minRemainingPercent`),
  and reset times (`resetsAt`, `resetsInSeconds`).
  - Optional inputs: `provider` (filter by `instanceId`, `driver`, or `displayName`), `refresh`
    (re-probe live limits via `ProviderRegistry`), `includeDisabled` (include disabled providers when
    unfiltered).
  - Non-deferred MCP clients list it automatically; deferred clients (`tool_search`) discover it via
    `server.tools`.
- **Fail-open & opt-out**: if any anchor is missing or ambiguous, `server-*.mjs` loads unpatched.
  `T3P_MCP_TOOLS=0` disables the MCP tool registration without affecting the turn guard (and
  `T3P_GUARD=0` disables the turn guard without affecting `t3_provider_limits`).
- The compat checker verifies `applyServerMcpPatch` on every target (`serverMcpTools` in the patch list).
