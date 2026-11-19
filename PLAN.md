# T3-Patcher: implementation plan

Status: plan only, nothing built. Written 2026-11-18 against upstream `pingdotgg/t3code` commit `c2a7c5c` (desktop and server 0.1.10, the version installed on FOX).

Audience: a fresh master session. Read sections 1 to 5, then run the phases in section 7 in order. Each work package names the model that owns it.

## 1. Goal

A Vencord/Spicetify-style patcher for the T3 Code desktop app. It injects a plugin loader into the stock installed app, so plugins and mods survive upstream releases without a fork.

Plugins must be able to:

- read connected providers, their auth state and their rate limits
- change a thread's provider and model
- show exactly what a session is doing, when and why (full event timeline)
- read each session's prompt-cache state and show when it expires
- add UI anywhere in the app, add commands and keybindings, and patch app code when no API exists

## 2. Facts the design rests on

Verified in upstream source or on the installed app. File references are relative to the upstream repo.

**Desktop shell**

- Electron 44.10.1, electron-builder 26, electron-updater 6 (`apps/desktop/package.json`).
- Electron fuses are at defaults. Read from the installed exe: `EmbeddedAsarIntegrityValidation` off, `OnlyLoadAppFromAsar` off, `RunAsNode` on, `NodeOptions` on, `NodeCliInspectArguments` on. No startup self-check in `apps/desktop/src`.
- Main entry is `apps/desktop/dist-electron/boot.cjs`, which loads `main.cjs`. `app.asar` holds about 13 readable, unminified `.cjs` files.
- Main window: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` (`apps/desktop/src/window/DesktopWindow.ts:489-497`).
- The UI is served over a custom protocol, `t3code://app/`, by a handler in `apps/desktop/src/electron/ElectronProtocol.ts:69-135`. That handler also sets the CSP header: `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'`, `connect-src` open to any http/https/ws/wss.
- The UI files live in `resources/server.asar/apps/server/dist/client`: `index.html` plus 983 minified, hash-named ES module chunks. No source maps ship.
- The renderer sees one bridge, `window.desktopBridge`. Its IPC handlers reject any sender that is not the main window's main frame.
- The server is the Electron exe run with `ELECTRON_RUN_AS_NODE=1` on `server.asar/apps/server/dist/bin.mjs`. Port 3773 by default. `~/.t3/userdata/server-runtime.json` holds host and port, no token.
- Updates: electron-updater from GitHub releases, NSIS, channels `latest` and `nightly`. The install step is a full NSIS rerun. `T3CODE_DISABLE_AUTO_UPDATE=1` disables it.
- License is MIT, so vendoring type definitions from `packages/contracts` is allowed.

**Web client**

- React 19 with React Compiler, TanStack Router, Rolldown via vite-plus. Identifiers are mangled.
- No plugin, extension or registry system exists. Settings nav, command palette items, timeline row kinds and right-panel kinds are module-private constants.
- State: Effect atoms in one `appAtomRegistry` (`apps/web/src/rpc/atomRegistry.ts:5`) plus about 20 zustand stores. None are reachable from `window`.
- Stable anchors that upstream itself recommends for theming: about 293 `data-slot` attributes (`docs/user/appearance.md:66-67`).
- The shortcut dispatcher has a real runtime registry: `registerCommands` in `apps/web/src/shortcuts/dispatcher.ts:131`.

**Server API (already covers the four data goals, so the server needs no patch)**

- One WebSocket route, `GET /ws?orchestrationProtocol=2`, speaking Effect RPC with JSON frames. Schemas in `packages/contracts/src/rpc.ts` and `packages/contracts/src/orchestrationV2.ts`.
- Auth: a `wsTicket` from `POST /api/auth/websocket-ticket`, or a bearer token. The desktop renderer gets its bearer token from `window.desktopBridge.getLocalEnvironmentBearerToken()`.
- Providers and limits: `server.getConfig` and `subscribeServerConfig` return `ServerProvider[]`, each with `status`, `auth`, `models[]` and `usageLimits.windows[]` of `{kind, usedPercent, resetsAt, windowDurationMins}` (`packages/contracts/src/providerUsageLimits.ts:13-67`).
- Timeline: the store is event-sourced. `orchestration.subscribeThread({threadId, afterSequence})` streams a snapshot and then every event, each with `occurredAt`, `runId`, `providerInstanceId`. Turn items cover messages, reasoning, command execution, file changes, approvals, errors, compaction, handoffs and subagents.
- Switching: `orchestration.dispatchCommand` with `thread.model-selection.set` or `provider.switch`. The server rejects a provider change while a run is active (`OrchestratorProviderSelectionBusyError`).
- Prompt cache: each provider turn carries `tokenUsage.{cachedInputTokens, promptCacheTtlMs, promptCacheExpiresAt, updatedAt}` (`packages/contracts/src/orchestrationV2.ts:231-242`). Two gaps: Codex and other non-Claude providers report no TTL, and a Claude request served fully from cache reports no new TTL.
- Extra read-only sources on disk: `~/.t3/caches/<instanceId>.json` (provider snapshot with limits), `~/.t3/userdata/logs/provider/events.<threadId>.log` (raw provider frames), `~/.claude/projects/*.jsonl`, `~/.codex/sessions`.

**Settled by phase 0 (docs/spikes/WP-0C.md, WP-0D.md)**

- U1: **NO.** With `app.asar` present Electron 44 ignores `resources/app/`. The shim only runs if it IS `app.asar`. Fallback adopted as the design: a ~6 KB replacement `app.asar`, original renamed `_app.asar`, plus junction `_app.asar.unpacked` -> `app.asar.unpacked` (native modules fail without it).
- U2: **YES, NSIS wipes the whole install dir** (markers, extra folders, `_app.asar`, junction), also in updater mode (`--updated /S /D=...`). Repair after every update is mandatory and must run from outside the install dir.
- U3: **YES.** Wrapping `protocol.handle` for `t3code` rewrites HTML and chunks; CSP and Content-Type preserved; no code-cache staleness over 7 restarts. `session.registerPreloadScript` and `setPreloads` both run in the sandboxed window before the first app script. Injected inline and same-origin `t3code://app/...` scripts run; injected http(s) scripts are blocked by CSP. Asset responses carry no Content-Length.
- U4: **YES.** Frame shapes known (section 4a). A second socket with the desktop bearer is accepted via a ticket, alongside the app's own socket. 221 RPC methods (30 streams). `usageLimits` is optional per provider and has more fields than first listed (`id`, `label`, `modelIds`, `providerIds`, `resetCredits`, `unavailable`).
- Exe Authenticode signature stays `Valid` after replacing `app.asar` (the exe itself is unchanged).

## 3. Architecture

Four layers. No upstream file is edited in place: `app.asar` is renamed, a small replacement takes its name, and a junction is added.

```
resources/
  app.asar                REPLACED: ~6 KB asar holding the shim (package.json copied from the original, main -> index.js, plus index.js)
  _app.asar               the original app.asar, renamed (hash recorded in the install manifest)
  _app.asar.unpacked      junction -> app.asar.unpacked (fs.symlinkSync(..., 'junction'), no admin needed)
  server.asar             untouched
```
1. **Shim** (replacement `resources/app.asar`). Tiny and almost never changes. It must not touch `userData` before the real app is required (the path is wrong until main sets it). It requires the main runtime from `~/.t3-patcher/runtime/`, then `require`s `_app.asar`. If the runtime is missing or throws, it logs and starts the stock app. Patcher upgrades replace the runtime folder and never touch the install directory again.

2. **Main runtime** (Node, full privileges). Before upstream `main.cjs` runs it:
   - wraps `electron.protocol.handle` so every `t3code://` response passes through the patch engine (text patches on JS chunks, `index.html` injection, CSP header adjustment)
   - registers an extra preload script on the default session
   - starts the main-side plugin host and its IPC channels (prefix `t3p:`)
   - hooks the updater's quit-for-update event to schedule a repair

3. **Preload runtime** (sandboxed preload). Exposes `window.__t3p_native` through `contextBridge` and injects the renderer runtime into the main world before the app's first module runs.

4. **Renderer runtime** (main world). Plugin manager, the public API, UI slots, the settings page and the RPC client.

**Patch engine.** Vencord-style text patches applied when a chunk is served: each patch has a `find` string that must match exactly one chunk, plus one or more `match` regex and `replace` pairs. Results are cached on disk by chunk hash and patch-set hash. A patch that fails to match is disabled and reported; it never blocks the app.

**API stability tiers.** Every plugin declares the highest tier it uses, so users can see how fragile it is.

| Tier | Built on | Breaks when |
|---|---|---|
| 1, stable | server RPC and HTTP, files on disk, `data-slot` DOM anchors, theme CSS, own IPC | upstream changes its public contract |
| 2, internals | app singletons captured by first-party patches: atom registry, zustand stores, router, shortcut dispatcher, the app's RPC client | upstream refactors those modules |
| 3, raw patches | a plugin's own text patches | any change to the patched code |

First-party plugins stay on tier 1 wherever possible. Tier 2 captures live in one first-party module so one fix repairs every plugin.

**Surviving updates**

- An NSIS update wipes the install dir, so the shim never survives one. The runtime lives outside it (`~/.t3-patcher/`) and survives.
- Repair runs from a detached worker started OUTSIDE the install dir (the installer kills the app and locks files there). The main runtime spawns it when the updater is about to install; it waits for the installer to exit, re-detects the exe name (`T3 Code (Beta)` vs `(Nightly)` across channels) and re-applies the layout. Second trigger for manual installer runs: a logon scheduled task running `t3p repair --if-stale`. Both are untested until WP-5B.
- `t3p repair` does the same by hand; `t3p status` reports patched, unpatched, or stale-after-update (replacement hash differs and no `_app.asar`).
- The compat checker (WP-5A) downloads each new upstream release, runs every patch `find` against its chunks and reports which no longer match, before the user updates.

**Out of scope for v1**

- Patching the server process. The API covers the goals. An escape hatch exists (`NODE_OPTIONS=--import` set by the main runtime before the server spawns) and is documented, not built.
- The WSL backend copy, mobile, and the web-only (browser) client.
- macOS and Linux installers. The runtime stays platform-neutral; only the installer is Windows-first.

## 4a. RPC wire facts (from WP-0D)

- One JSON object per WebSocket text frame. Client: `{"_tag":"Request","id":N,"tag":"<method>","payload":{},"headers":[]}`, `Ack{requestId}` per received Chunk, `Interrupt{requestId}`, `Ping`. Server: `Chunk{requestId,values[]}`, `Exit{requestId,exit:Success|Failure}`, `Pong`. Numeric ids. Omit `frameParts` and the `accept*` payload flags.
- Auth: the renderer gets a bearer from `desktopBridge.getLocalEnvironmentBearerToken()`, POSTs `/api/auth/websocket-ticket/rpc` with `Authorization: Bearer`, opens `/ws?wsTicket=...&orchestrationProtocol=2`. Fresh ticket per (re)connect. The main process obtains the bearer by `executeJavaScript` on the bridge call, or over `t3p:` IPC. The bearer is a full-scope credential (orchestration, terminal, access): treat it as such in permissions.
- `sequence` is global per environment. Store the last seen value per subscription; resubscribing with `afterSequence` is gap-free.
- Busy switch: detect `cause.name == "OrchestratorProviderSelectionBusyError"` (outer tag is `OrchestrationV2DispatchCommandError`). The server accepts `provider.switch` to an uninstalled provider, so `switchProvider` must check `installed` and status itself.

## 4. Plugin API surface (target for v1)

Namespace `t3` in the renderer, `t3.native` backed by the main process.

- `t3.rpc`: `call(method, payload)`, `subscribe(method, payload, onItem)`, `http(path, init)`. Typed from vendored contracts.
- `t3.providers`: `list()`, `get(instanceId)`, `limits(instanceId)`, `onChange(cb)`, `refresh()`.
- `t3.threads`: `list()`, `current()`, `projection(threadId)`, `subscribe(threadId, cb)`, `dispatch(command)`, `setModel(threadId, selection)`, `switchProvider(threadId, selection)`.
- `t3.timeline`: normalized activity records per thread: `{at, kind, runId, provider, summary, cause, raw}`, where `cause` links an event to the item or command that triggered it.
- `t3.cache`: `state(threadId)` returning `{expiresAt, ttlMs, source: "reported" | "carried" | "assumed", lastRequestAt}`, `onExpiring(threadId, leadMs, cb)`. Rules in WP-6.
- `t3.usage`: `summary(range)`, per-thread token totals.
- `t3.ui`: slots `sidebarSection`, `threadHeader`, `composerBanner`, `rightPanel`, `statusBar`, `settingsPage`, `timelineRowDecorator`, `contextMenuItem`, plus `toast` and `modal`.
- `t3.commands` and `t3.keybinds`: command palette entries and shortcuts.
- `t3.patches`: register tier 3 text patches. `t3.internals`: tier 2 handles.
- `t3.storage` (per-plugin key-value), `t3.settings` (schema that renders its own settings UI).
- `t3.native`: scoped file reads, read-only SQLite on `statev2.sqlite`, log tailing, guarded `spawn`. Each needs a permission in the manifest.
- `t3.events`: app lifecycle, thread focus changes, plugin bus.

Plugin format: a folder in `~/.t3-patcher/plugins/<id>/` with `plugin.json` (`id`, `version`, `tier`, `permissions`, `t3Versions`, optional `main` and `renderer` entries) and prebuilt JS. Hot reload in dev mode.

## 5. Rules for the master session

**Testing never touches the live app on FOX.** The master session itself runs inside T3 Code on FOX. All patched-app runs happen on rig, against a separate T3 Code install with `T3CODE_HOME` pointing at a throwaway home. Load the `rig` skill first. Headless work (unit tests, the patch engine against extracted chunks, the compat checker) stays on FOX. Patching FOX's install happens only after phase 5 and only after Michael confirms.

**Models.** Run `orchestrator_capabilities` once before the first `delegate_task`. Targets as listed on 2026-11-18:

| Role | `target` | Use |
|---|---|---|
| Default worker | `{"providerInstanceId":"opencode","model":"opencode-go/deepseek-v4.1-flash"}` | every fully specified package. Up to 3 at once |
| Judgment worker | `{"providerInstanceId":"claudeAgent","model":"claude-sonnet-5-5"}` | spikes, UI checked on rig, packages with open design questions. 2 at once |
| Keystone and security | `{"providerInstanceId":"claudeAgent","model":"claude-opus-5-5","options":{"effort":"high"}}` | WP-2 only, or after a cheaper model failed twice. 1 at once, never xhigh |
| Reviewer | `{"providerInstanceId":"codex","model":"gpt-6.1-sol","options":{"reasoningEffort":"medium"}}` | two review gates only (after WP-2, after WP-4). GPT weekly limit was at 24% left, so nothing else |
| Spare | `{"providerInstanceId":"antigravity","model":"gemini-3.8-flash"}` | docs and example plugins only. Limits on the basic account are unknown; if a run is refused, move the package to DeepSeek and do not retry |

- If a listed model is missing, say so and stop. Do not switch providers silently.
- Never use DeepSeek V4 Pro.
- At most 4 sessions building at once.

**Briefs.** Each child sees only its brief. Every brief includes: this file's path and the section numbers to read, the exact files to create, the acceptance checks as commands, and these lines: use `isolation:"worktree"`; run builds and tests in the foreground; never end the turn while a build or test runs; commit on your branch, do not push; stop any process you started.

DeepSeek briefs also include the exact function signatures and one worked example of the expected output. If a DeepSeek package needs a design decision, it stops and reports instead of choosing.

**Review.** The master reads every child's diff and runs its acceptance checks before merging. Remove each worktree and branch after merging.

**Handoff.** At the end of each phase, update section 9 of this file and start a fresh master session from it.

## 6. Repository layout

```
X:\Dev\T3-Patcher\
  PLAN.md
  package.json, pnpm-workspace.yaml, tsconfig.base.json
  .upstream\                 shallow clone of pingdotgg/t3code at the supported tag (gitignored)
  packages\
    shim\                    resources/app content
    installer\               the `t3p` CLI: install, uninstall, repair, status, doctor
    patch-engine\            pure functions: find, match, replace, cache. No Electron imports
    main-runtime\            protocol wrap, preload registration, IPC, native services, plugin host
    preload-runtime\
    renderer-runtime\        plugin manager, t3 API, UI slots, settings page
    rpc-client\              Effect RPC JSON-frame client and auth
    api\                     public types and the plugin.json schema (`@t3p/api`)
    contracts-vendor\        type-only build of upstream packages/contracts, with its MIT notice
  plugins\
    provider-limits\  session-inspector\  cache-watch\  provider-switcher\  devtools\
  tools\
    compat\                  upstream release checker
    rig\                     scripts to install, launch and stop the test app on rig
  docs\
```

Language: TypeScript, bundled with tsdown to CJS for main and preload and to a single IIFE for the renderer. Tests with vitest.

## 7. Phases and work packages

Time is elapsed agent time for the named model, review included.

### Phase 0: spikes (about half a day, all in parallel)

No product code. Each spike writes its findings to `docs/spikes/<id>.md` with the commands used.

**WP-0A: repo bootstrap.** Owner: DeepSeek V4.1 Flash. About 30 minutes.
- `git init`, pnpm workspace, the empty packages from section 6, tsdown and vitest wired, lint, `.gitignore` with `.upstream`.
- Clone upstream at tag `v0.1.10` into `.upstream`.
- Accept: `pnpm install`, `pnpm -r build` and `pnpm -r test` pass on empty packages.

**WP-0B: test rig.** Owner: Sonnet 5.5. About 2 hours.
- Install stock T3 Code 0.1.10 on rig into a dedicated folder. Write `tools/rig/launch.ps1`, `stop.ps1` and `reset.ps1`, which start it with `T3CODE_HOME` set to a throwaway home, `T3CODE_DISABLE_AUTO_UPDATE=1` and `--remote-debugging-port`.
- Write `tools/rig/cdp-eval.mjs`: runs a JS expression in the main window over CDP and prints the result. Every later acceptance check uses it instead of screenshots.
- Accept: launch, `cdp-eval "document.title"` prints the title, stop leaves no process behind.

**WP-0C: loader spike (U1, U2, U3).** Owner: Sonnet 5.5. About 3 hours. Needs WP-0B.
- Hand-write a `resources/app/` shim on rig that logs and then loads the real main. Confirm load order.
- In the shim, wrap `protocol.handle`, append a marker comment to one JS chunk and a `<script>` to `index.html`. Confirm both arrive in the renderer and that code cache does not serve a stale chunk.
- Register a preload on the default session and confirm it runs in the sandboxed main window before the app's first script.
- Install a nightly over the top with the NSIS installer and record whether `resources/app/` survives.
- Accept: each of U1 to U3 answered yes or no with evidence. If U1 is no, the fallback is renaming `app.asar` to `_app.asar` and placing a small replacement `app.asar`. If U3 is no, the fallback is `session.protocol` interception or serving a patched client directory.

**WP-0D: RPC spike (U4).** Owner: Sonnet 5.5. About 2 hours. Needs WP-0B.
- Capture the app's WebSocket frames over CDP. Document the request, chunk and exit frame shapes and the id scheme.
- From a standalone Node script, get a ticket, open a second socket and call `server.getConfig` and `orchestration.subscribeThread`.
- Accept: the script prints the provider list with `usageLimits`, and live events for a thread. The doc states which auth path a renderer plugin should use.

**Gate 0 (master, Fable or whichever model runs the master session):** read the three spike docs, amend sections 3 and 4 if a fallback was needed, then continue.

### Phase 1: foundations (about 1 day, three packages in parallel)

**WP-1A: patch engine.** Owner: DeepSeek V4.1 Flash. About 3 hours.
- Pure library. `applyPatches(chunkName, source, patches)` returns `{code, applied[], failed[]}`. `find` must match exactly one chunk in a set. Supports string and regex `match`, `$1`-style and function replacements, and a `$self` placeholder that resolves to the plugin's global handle.
- Disk cache keyed by `sha256(source) + sha256(patch set)`.
- CLI `t3p-patch-test <clientDir> <patchFile>` that reports matches against an extracted client.
- Accept: vitest suite with at least these cases: single match, no match, ambiguous `find`, replacement that produces a syntax error (detected by parsing and rolled back), cache hit.
- The brief must contain the full type signatures and three example patches.

**WP-1B: installer CLI.** Owner: DeepSeek V4.1 Flash. About 3 hours.
- `t3p install [--path]`, `uninstall`, `repair`, `status`, `doctor`. Finds the install directory, refuses if the fuse layout or the app version is unknown unless `--force`, builds the replacement asar from the original `package.json`, renames `app.asar` to `_app.asar`, creates the `_app.asar.unpacked` junction, copies the runtime to `~/.t3-patcher/runtime`, and keeps a manifest of every file it wrote so uninstall is exact.
- Never edits an upstream file in place; the only upstream change is the rename of `app.asar`, and uninstall restores it exactly (manifest with hashes). Renaming a locked asar may need the app closed: document and handle.
- Accept: unit tests against a fake install tree; `status` output for patched, unpatched and stale-after-update trees.

**WP-1C: contracts vendor and RPC client.** Owner: Sonnet 5.5. About 5 hours. Needs WP-0D.
- `contracts-vendor`: a script that builds type declarations from `.upstream/packages/contracts` and records the upstream commit.
- `rpc-client`: frame encoder and decoder from the spike, `call`, `subscribe` with resubscribe from the last sequence after a reconnect, ticket refresh, typed method map.
- Accept: integration test on rig lists providers and streams one thread's events; unit tests for framing against captured fixtures.

### Phase 2: loader (about 1.5 days, serial)

**WP-2: shim, main runtime, preload runtime.** Owner: Opus 5.5, effort high. About 1 day. Needs WP-0C, WP-1A, WP-1B.

This is the keystone and the security boundary: it runs with full privileges inside an app that holds every provider token.

- Shim with the fail-open rule: any error starts the stock app and writes `~/.t3-patcher/logs/shim.log`.
- Main runtime: protocol wrap feeding the patch engine, `index.html` injection, CSP adjusted by the smallest change that works, preload registration, the `t3p:` IPC router with the same main-frame sender check upstream uses, the plugin host for `main` entries, the updater hook that schedules `t3p repair`.
- Native services behind permissions: file reads limited to declared roots, SQLite opened read-only, log tail, `spawn` off by default.
- Safe mode: `T3P_SAFE=1`, argv `--t3p-safe`, or `t3p safe` (marker file consumed by the next launch) loads no plugins and no patches. Shift-at-launch was dropped: reading key state cost 0.8-1.7 s per launch.
- Accept on rig, through `cdp-eval`: `window.__t3p_native` exists; a test patch changes a visible string; a main-side test plugin answers an IPC round trip; with the runtime folder deleted the stock app still starts; with a throwing plugin the app still starts and the error is logged.
- Deliver `docs/security.md`: the trust model, what a plugin can reach at each permission, and what is not defended.

**Gate 2 review.** Owner: GPT-6.1 Sol, effort medium. About 30 minutes. Reads the WP-2 diff and `docs/security.md` and looks for: privilege leaks from renderer to main, IPC handlers missing the sender check, path traversal in file roots, ways a failed patch could brick startup. The master fixes small findings itself and sends large ones back to Opus.

### Phase 3: renderer runtime and API (about 2 days, partly parallel)

**WP-3A: plugin manager and core API.** Owner: Sonnet 5.5. About 6 hours. Needs WP-2, WP-1C.
- Load order, enable and disable, hot reload, per-plugin error isolation, `t3.storage`, `t3.settings`, `t3.events`, `t3.rpc`, `t3.native`.
- Publish `@t3p/api` types.
- Accept: a sample plugin loads, persists a setting, calls `server.getConfig`, and survives a reload.

**WP-3B: data services.** Owner: DeepSeek V4.1 Flash. About 4 hours. Needs WP-3A's types (can start from the `api` package alone).
- `t3.providers`, `t3.threads`, `t3.usage` as thin typed wrappers over `t3.rpc`, each with a cached store and change events.
- `setModel` and `switchProvider` return a typed result that distinguishes success, `busy` (run active) and other errors.
- Accept: unit tests against recorded RPC fixtures from WP-1C.
- The brief lists each method, the RPC it wraps and the exact return type.

**WP-3C: timeline normalizer.** Owner: Sonnet 5.5. About 5 hours.
- Turns `subscribeThread` snapshots and events into `t3.timeline` records. Derives `cause` by linking turn items to their run, their runtime request (approval) and their parent item or subagent.
- Optional enrichment from `logs/provider/events.<threadId>.log` through `t3.native`.
- Accept: fixture tests covering a tool call with approval, a provider switch, a compaction, an error and a subagent run.

**WP-3D: UI slots.** Owner: Sonnet 5.5. About 1 day. Needs WP-3A.
- Tier 1 mounting: locate anchors by `data-slot`, mount plugin roots with a `MutationObserver`, re-mount after route changes. Slots listed in section 4.
- Tier 2 captures, each as one first-party patch with a DOM fallback: atom registry, router, shortcut dispatcher (`registerCommands`), settings nav arrays for a real "Plugins" settings page, command palette items.
- Plugins render into their own root. Ship a small helper for reusing the app's CSS variables so plugin UI matches the active theme.
- Accept on rig: a demo plugin shows one element in every slot; a command appears in the palette; a keybind fires; the Plugins settings page lists, toggles and configures plugins. Each tier 2 capture reports `captured` or `fallback` in `t3p doctor`.

**WP-3E: plugin SDK and template.** Owner: DeepSeek V4.1 Flash. About 2 hours.
- `create-t3p-plugin` scaffold, a build preset, `plugin.json` schema validation, a `t3p dev <plugin>` command that links a plugin folder and turns on hot reload.
- Accept: scaffold, build and load a hello-world plugin with three commands.

**Gate 3 review.** Owner: GPT-6.1 Sol, effort medium. About 30 minutes. Reviews `@t3p/api` only, as a public API freeze: naming, consistency, anything that would force a breaking change later. Skip this gate if the GPT limit is exhausted; the master does it instead.

### Phase 4: first-party plugins (about 1.5 days, up to 3 in parallel)

Each is a real plugin built only on the public API. Any API gap found here goes back to phase 3 as a fix, not into the plugin as a workaround.

**WP-4A: provider-limits.** Owner: DeepSeek V4.1 Flash. About 3 hours.
- Status bar chip and a panel: every provider instance, its auth state, each limit window with percent used and time to reset, reset credits, and a warning threshold setting.

**WP-4B: provider-switcher.** Owner: DeepSeek V4.1 Flash. About 3 hours.
- Thread-header control and command palette entries to change model or provider. Handles the `busy` result by offering to queue the switch for when the run ends. Optional rule: suggest a switch when the current provider passes a limit threshold.

**WP-4C: cache-watch.** Owner: Sonnet 5.5. About 5 hours.
- Implements the `t3.cache` rules and the UI.
- `reported`: latest provider turn has `promptCacheExpiresAt`.
- `carried`: the latest request was a full cache read with no TTL, so reuse the last reported TTL from the newer request time.
- `assumed`: provider reports no TTL; use a per-provider table from settings, clearly labelled as an estimate. Default values come from each provider's public docs at build time, with the source recorded next to each value.
- UI: countdown per thread in the sidebar and thread header, a list of all threads sorted by time to expiry, optional notification before expiry.
- Accept: fixture tests for the three sources; on rig, a Claude thread shows a countdown that matches the server's `promptCacheExpiresAt`.

**WP-4D: session-inspector.** Owner: Sonnet 5.5. About 1 day.
- Right-panel timeline for the current thread from `t3.timeline`: what happened, when, how long, which provider and model, and why (the cause chain). Filters by kind, a live "now doing" line, raw event view, export to JSON.
- An all-sessions view: every active thread with its current activity.

**WP-4E: devtools plugin.** Owner: DeepSeek V4.1 Flash. About 2 hours.
- Patch tester (try a `find` and `match` against live chunks), RPC console, slot outlines, plugin log viewer.

### Phase 5: update safety, docs, release (about 1 day)

**WP-5A: compat checker.** Owner: DeepSeek V4.1 Flash. About 3 hours.
- `tools/compat`: fetch a given upstream release, extract the client from `server.asar`, run all first-party patches, diff the RPC method list and the `data-slot` set against the supported version, print a report and exit non-zero on breakage.
- Accept: passes on 0.1.10; reports sensibly on the latest nightly.

**WP-5B: update survival test.** Owner: Sonnet 5.5. About 3 hours.
- On rig: patched 0.1.10, update to the newest release through the in-app updater, confirm the repair worker runs from outside the install dir, re-detects the exe name and plugins load. Also test the logon-task trigger after a manual installer run. Fix what breaks.

**WP-5C: docs.** Owner: Antigravity Gemini 3.8 Flash, DeepSeek V4.1 Flash if refused. About 2 hours.
- `README.md`, `docs/plugin-guide.md`, `docs/api.md` generated from the `@t3p/api` types, `docs/patching.md`, `docs/updating.md`.

**WP-5D: install on FOX.** Owner: master session, with Michael's explicit go-ahead. About 15 minutes.
- `t3p install`, restart T3 Code when Michael chooses, `t3p doctor`. Rollback is `t3p uninstall`.

## 8. Risks

| Risk | Handling |
|---|---|
| A fuse or integrity check is added upstream (EmbeddedAsarIntegrityValidation or OnlyLoadAppFromAsar on would break the replacement asar) | `t3p doctor` reads the fuses and refuses to install. Fallback is dev-mode loading through `VITE_DEV_SERVER_URL` with a local patched client; documented, not built |
| Minified chunks change every release | Tier 1 first. Tier 2 captures have DOM fallbacks. The compat checker flags breaks before updating |
| RPC protocol version bumps (`orchestrationProtocol`) | The client reads the version from `/.well-known/t3/environment` and refuses on mismatch; the contracts vendor is rebuilt per supported version |
| A plugin crashes the app | Fail-open shim, per-plugin error boundaries, safe mode |
| Malicious plugin | Permissions in the manifest and a prompt on first enable. This is a mod loader: a plugin granted `native` permissions is trusted code, and `docs/security.md` says so |
| 4.8 GB live SQLite in WAL mode | RPC is the default source. SQLite is read-only, opt-in, and never opened for write |
| Windows code signature | Replacing `app.asar` leaves the exe signature Valid (confirmed WP-0C). SmartScreen behaviour not observed |

## 9. Progress log

Update at the end of each phase.

- 2026-11-18: plan written. Nothing started.
- 2026-11-19: **Phase 0 done, Gate 0 passed.** Merged on `main`: WP-0A repo bootstrap (DeepSeek), WP-0B rig scripts in `tools/rig/` (Sonnet), WP-0C `docs/spikes/WP-0C.md` and `wp-0c/` shim code (Sonnet), WP-0D `docs/spikes/WP-0D.md` and `wp-0d/` client and fixtures (Sonnet). All worktrees and branches removed. Answers: U1 NO (replacement `app.asar` adopted; sections 2 and 3 amended), U2 YES (NSIS wipes the install dir; repair worker must live outside it), U3 YES, U4 YES (section 4a added). WP-1B, WP-2, WP-5B and the risk table amended. Known issues: `launch.ps1 -Env` with several values breaks under `pwsh -File`; stock T3 appends `<home>\bin` to rig's user PATH on every launch (stop.ps1 now removes it); a WP-0C cleanup bug briefly wiped rig's user PATH, restored (13 entries, REG_EXPAND_SZ, originals' `%VAR%` forms now literal). A populated `usageLimits` was never seen on a live socket (no provider login on rig): confirm in WP-1C and WP-4A. Rig state: slots 1-3 stopped, `G:\rig-run\t3patcher\base` pristine. Next: Phase 1 (WP-1A, WP-1B, WP-1C in parallel) from a fresh master session.
- 2026-11-19: **Phase 1 done.** Merged on `main`: WP-1A `@t3p/patch-engine` (DeepSeek, 33 tests), WP-1B `@t3p/installer` + `@t3p/shim` (DeepSeek, 38+2 tests; install/uninstall/repair/status/doctor, `T3P_HOME` override, shim is the 11-line fail-open template), WP-1C `@t3p/contracts-vendor` (type-only, 221 methods / 30 streams match the spike) + `@t3p/rpc-client` (Sonnet, 38 unit tests; rig integration `pnpm --filter @t3p/rpc-client test:rig` passed twice on slot 2, gap-free resume). Root `pnpm lint` and `pnpm -r build` and `pnpm -r test` are green (eslint now has node and browser globals). Notes for WP-2: the installer is only tested on fake trees; first real install is on a rig slot copy (needs a local-disk path, not the Q: share, for the junction: run `t3p` on rig itself or via the share carefully). `@t3p/patch-engine` index pulls `node:crypto` (main-side use only). `contracts-vendor` patches 5 giant upstream types (see its README); bump needs a check. Next: Phase 2 (WP-2, Opus 5.5 high), from a fresh master session.
- 2026-11-19: **Phase 2 done, Gate 2 passed.** WP-2 (Opus 5.5 high) merged: shim with `T3P_HOME`, `@t3p/main-runtime` (protocol wrap + patch index, `t3p:` IPC router with main-frame sender check, plugin host, permissioned fs.read/sqlite.read/log.tail/spawn, updater hook + repair worker), `@t3p/preload-runtime`, minimal `@t3p/renderer-runtime`, `docs/security.md`, `docs/wp-2-notes.md`, `tools/rig/patch-slot.ps1`. Rig evidence 1-11 all pass (startup overhead within noise: 649 vs 642 ms DCL). I re-verified on rig slot 3: patch, launch, `__t3p_native`, test patch, ping, unpatch restores the original asar hash. Gate 2 (GPT-6.1 Sol): no high findings; 4 medium fixed by the master: patch cache key now keeps patch order and predicate verdicts, cache entries are atomic and digest-checked; uninstall renames the replacement aside and restores it on failure (never leaves the app without app.asar), junction removed last; sqlite worker caps text cells (256 KiB) and total payload (8 MiB). Known accepted risks (docs/security.md section 3): a renderer plugin can read the bearer token and can name another plugin's id to use its native grants, so renderer-side permissions are a consent signal, not a boundary. Open: concurrent sqlite worker limit, function `replace` closures are hashed by source text only (replacers must be pure), real `before-quit-for-update` and renaming a locked `app.asar` untested until WP-5B. Next: Phase 3 (WP-3A..3E).
- 2026-11-19: **Phase 3 done, Gate 3 passed.** Merged: WP-3A (Sonnet: plugin manager, `t3.storage/settings/events/rpc/native`, `@t3p/api` `T3Api` types, hot reload, per-plugin isolation; rig: sample plugin loads, persists a setting across reload, `server.getConfig` works), WP-3B (DeepSeek: `t3.providers/threads/usage`, typed `ok|busy|unavailable|error` switch results), WP-3C (Sonnet: `@t3p/timeline` normalizer, cause links; wired as `t3.timeline`, `TimelineRecord` now owned by `@t3p/api`), WP-3D (Sonnet: UI slots, five tier-2 captures with fallbacks reported in `t3p doctor`, commands, keybinds, `t3.patches`, Plugins settings page; rig slot 2 evidence), WP-3E (DeepSeek: `create-t3p-plugin`, `@t3p/plugin-build`, plugin.json schema, `t3p dev`). I verified scaffold -> build -> load on rig slot 3. Gate 3 (GPT-6.1 Sol) found 3 BREAKING-IF-LATER items, all fixed by the master: errors now carry stable `code` plus `isT3Error` (no `instanceof` promise across bundles); manifest gets `t3pApi` (default "1", enforced in the host as `incompatible`, `apiCompatible`); the wire-type coupling to vendored contracts is documented as the tier 1 exception. Also `t3.rpc.state` is permission-gated. Deferred nice-to-haves: stream `onError/onComplete`, unary `signal/timeoutMs`, toast dismissal handle, structural `RpcError` export, `permissions?` typing done. Gaps: slots `threadHeader`, `composerBanner`, `timelineRowDecorator`, `contextMenuItem` never seen in a live DOM (rig profile has no sign-in); scaffold deps use "*" and only install once packages are published (use `workspace:*` in-repo); approval cause links only checked on synthetic fixtures. Next: Phase 4 (first-party plugins).
- 2026-11-19: **Phase 4 done.** All five first-party plugins merged, built only on the public API: `provider-limits` (4A, DeepSeek), `provider-switcher` (4B, DeepSeek), `cache-watch` + core `t3.cache` (4C, Sonnet), `session-inspector` (4D, Sonnet), `devtools` (4E, DeepSeek). Rig (Claude login connected on rig; test threads use `claude-haiku-4-5`): 4C live `t3.cache.state` equals the server's `promptCacheExpiresAt`; 4D live timeline, cause chain and all-sessions view on a real thread; master check on slot 1: all 5 plugins load, `provider-limits` chip shows the live Claude limit ("Claude 65% - in 2h 30m"), panels mount. Master-caused bug found by 4A/4B/4E and fixed: `t3pApi` range regex had lost its backslashes (`053dc82`, regression test). Cache rule from the live run: a full cache read is `cached >= input` (Claude `inputTokens` includes the cached part). API gaps for a Phase 3 follow-up (none blocks): no API to open the right dock; `ToastOptions` has no action button; no current-environment accessor; `enrichFromProviderLog` not on the public API; devtools `log.tail` grant needs the grant CLI to accept roots. Not seen live: thread-header controls (4B, 4C badge), approval chain, `carried`/`assumed` cache sources. Next: Phase 5 (compat checker, update-survival test, docs, FOX install only with Michael's go-ahead).
- 2026-11-19: **WP-5B done.** Real `before-quit-for-update` -> detached worker (node outside the install dir) -> real NSIS wipe -> repair verified on rig (nightly 4864 -> 4903); cancelled update and locked asar checked; the logon task did not exist and was added (`logon-task.ts`, `repairRecorded`). See `docs/wp-5b-notes.md`. Open: worker inherits the app listening sockets, one patch find fails on the 0.1.11 nightlies, real logon event untested.
- 2026-11-19: **WP-5A + WP-5C done, Phase 5 minus FOX install.** `tools/compat` (DeepSeek; own asar reader, 7-Zip NSIS extract, 50 tests) passes on 0.1.10; on nightly 4918 it found the `commandPalette` find broken (`N(e,t=i)` second param), fixed in captures.ts by master (find and replace tolerate a defaulted/second param), now PASS on both. Nightly adds 14 `issues.*`/`issueTrackers.*` RPC methods, no removals. Docs (Gemini): README, plugin-guide, api (generated by `pnpm docs:api`), patching, updating. Gaps: real logon event untested; detached worker holds listening sockets ~2 min; 5A edited main instead of its worktree (merged by master). WP-5D (FOX install) waits for Michael's go.
