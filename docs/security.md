# T3 Patcher security model

Scope: the loader delivered in WP-2. This covers the shim, the main runtime (`~/.t3-patcher/runtime/main.cjs`), the preload bridge, the renderer bootstrap, native services, the updater hook and the repair worker. It was checked against T3 Code 0.1.10 (Electron 44.10.1, Node 24.22.1).

T3 Patcher is a mod loader. It runs inside an app that holds every provider token and can run commands through its server. Read this file as "what a plugin can reach", not "what a plugin cannot do". Most permissions are equivalent to running code as the user, and this file says which ones.

Gate 2 reviewers: section 9 lists what is deliberately not defended.

## 1. Trust model

| Party | Trusted? | Why |
|---|---|---|
| The user's OS account | Trust root | `~/.t3-patcher/` (runtime, `state.json`, plugins, `bin/`) is writable by the user, and so is the T3 Code install dir. Anything that runs as the user can replace the runtime and own the app. T3 Patcher does not try to defend against the user's own account. |
| T3 Code itself (stock code) | Trusted | It is the host. The loader keeps its hardening (sandbox, contextIsolation, CSP, `will-attach-webview` gate, sender checks on `desktop:*` IPC) and does not loosen any of it. |
| The runtime (`main.cjs`, `preload.cjs`, `renderer.js`, workers) | Trusted | It is installed by `t3p install` from this repo. |
| Plugin with a `main` entry, or granted `patches` or `spawn` | **Trusted code** | Same power as the app's main process, or as arbitrary code run as the user. See section 2. |
| Plugin with only a `renderer` entry | **Trusted with the user's T3 session** | Its code runs in the main world of `t3code://app`, the same world as the app's UI. It can do anything the UI can, including reading the full-scope bearer token (section 3). |
| Web content in the in-app preview browser | Untrusted | It lives in `<webview>` guests on separate `t3code-preview-*` sessions. Our preload never runs there (measured, section 4.4). |
| Remote sites, files a plugin reads, SQLite contents, log contents | Untrusted data | Native services return them as data. Nothing in the runtime evaluates them. |

Where a plugin sits:

- On disk: `~/.t3-patcher/plugins/<id>/` with `plugin.json`.
- What the user granted: `~/.t3-patcher/state.json`.
- Effective permissions are **declared ∩ granted** (`effectivePermissions` in `@t3p/api`):
  - Scoped roots keep only granted roots that lie inside a declared root.
  - `spawn` keeps only granted executables equal to a declared one.
  - A plugin that is not `enabled` in `state.json` loads nothing.
- Today the user grants through the CLI: `t3p enable <id>`, `t3p grant <id> <perm> [--root R]... [--allow EXE]...`, `t3p revoke`, `t3p disable`. A first-enable prompt is WP-3A's job.

`~` in a scope path expands to the patcher home: `T3P_HOME` if set, else the OS home.

## 2. Permissions

| Permission | What the plugin gets | Equivalent to |
|---|---|---|
| (none, renderer entry only) | Its `renderer` file is served from `t3code://app/__t3p/plugins/<id>/...` and loaded by `renderer.js` into the app's main world. | Everything the T3 Code UI can do: all RPC methods, `window.desktopBridge`, the bearer token (section 3). |
| `main` | Its `main` entry is `require`d in Electron's main process, and `activate(ctx)` runs with a 5 s timeout. `ctx` adds `ipc.handle` (only its own `t3p:plugin:<id>:*` channels), `emit`, `log`, the `native` services it holds, and `patches` if granted. | **Trusted code**: full Node and Electron in the main process. The `ctx` object is a convenience, not a sandbox. `require` is not restricted. |
| `patches` (needs `main`) | `ctx.patches.register([...])`: string find/replace on the app's client JS chunks, served through the wrapped `t3code://` protocol. | **Trusted code**: it rewrites the UI's code, so it gets everything the renderer has. |
| `guard` | `t3.threads.beforeStart` / `ctx.threads.beforeStart`: sees the first 200 characters of every message, new thread and delegated task before it runs (plus thread ids, provider, model, source), and can hold it (up to 5 min), block it or move it to another provider/model. | Reading what the user and agents send, and stopping or rerouting it. A renderer plugin could read messages anyway (section 1); `guard` adds holding and rerouting server-side commands, including agent-driven ones the UI never shows. Granted only with `t3p grant <id> guard`. The server hook it rides on is first-party: the pipe it uses carries a per-start random token that the backend env drops at once (docs/patching.md "Server guard"). |
| `fs.read` `{roots}` | `t3p:native:fs.read`: reads a file inside a root, up to 4 MiB per call, with offset and utf8/base64. | Reading every file under those roots. |
| `sqlite.read` `{roots}` | `t3p:native:sqlite.query`: one read statement on a `.db`/`.sqlite`/`.sqlite3` file inside a root. Up to 10,000 rows (default 1,000), timeout up to 30 s (default 5 s, counted from when the query starts). At most 4 queries run at once across all plugins; up to 64 more wait in a queue and further ones are refused. | Reading those databases. Cannot write (section 5.2). |
| `log.tail` `{roots}` | `t3p:native:log.tail`: tail of a file inside a root with a byte cursor, up to 1 MiB per call (default 64 KiB), resets on truncation. | Reading those files. |
| `spawn` `{allow}` | `t3p:native:spawn`: runs one allowlisted `.exe`/`.com` with an argv array. No shell, hidden window, scrubbed env, cwd = patcher home, timeout up to 120 s (default 10 s), 1 MiB output cap. | **Trusted code**: whatever those executables can do as the user. Granting `cmd.exe`, `powershell.exe`, `node.exe` or any interpreter is granting arbitrary code execution. |

Native services exist only for a plugin that holds the permission. `createNativeServices` builds a per-plugin object, and a missing key means the service was not granted. `sqlite.read` is also missing when the runtime has no query launcher (fail closed).

## 3. The bearer token

The desktop renderer gets its server credential from `window.desktopBridge.getLocalEnvironmentBearerToken()`. That bearer is **full scope**: orchestration, terminal and access. Terminal access means running commands as the user.

- `desktopBridge` lives in the app's main world. Every renderer plugin, and every patched chunk, can call it. No permission gates this, and none can while plugin code shares the UI's JavaScript world.
- WP-3A will expose `t3.rpc`. Gating RPC methods there (for example, needing a permission for terminal or provider-switch methods) is **API hygiene and a consent signal, not a security boundary**. Renderer code can skip `t3.rpc` and call `desktopBridge` or the app's own RPC client directly.
- Consequence: enabling any plugin with a renderer entry means trusting it with the user's T3 Code session. The WP-3A enable prompt should say so in plain words.
- A real boundary would need plugin renderer code outside the main world: a sandboxed cross-origin iframe or a separate webContents talking to the app through a narrow channel. That is out of scope for WP-2 and is recorded as a risk in `docs/wp-2-notes.md`.

## 4. IPC: renderer → main

### 4.1 Bridge (preload)

- `preload.cjs` is registered on the default session with `session.registerPreloadScript({ type: "frame" })`, falling back to `setPreloads`.
- It exposes `window.__t3p_native = Object.freeze({ version, invoke, on })` through `contextBridge`.
- `invoke` accepts only allowlisted channels, so nothing else can be sent:
  - the fixed `t3p:ping`, `t3p:log`, `t3p:plugins:list`;
  - `t3p:native:fs.read`, `t3p:native:sqlite.query`, `t3p:native:log.tail`, `t3p:native:spawn`;
  - `t3p:plugin:<id>:<name>`.
- `on` accepts only `t3p:event` and `t3p:plugin-event`.
- The page never sees `ipcRenderer`. Upstream's `desktop:*` channels are not reachable through this bridge. Rig check: `invoke("desktop:get-bearer")` → `channel desktop:get-bearer is not allowed`, rejected in the preload, never sent.

### 4.2 Router (main)

`createIpcRouter` wraps every handler. Each call runs these checks in order:

1. **Sender check** (`createSenderCheck`), the same rule upstream uses:
   - `event.sender.id` equals the tracked main window's `webContents.id`;
   - `event.senderFrame` is that window's main frame;
   - the frame URL's origin is `t3code://app`.
   - Anything else gets `t3p: rejected (sender)`, including another window, a subframe, a main frame that navigated away, a destroyed or unknown window, and the dev server origin.
2. **One payload**, validated by a strict schema (`ipc/schema.ts`):
   - unknown keys and prototype-carrying objects are rejected;
   - JSON values are size-capped and cycles are refused.
3. Handler. The result goes back as **plain JSON** (`toWire`): a JSON round trip with a 32 MB cap. Functions, Promises, class instances and BigInts never cross the boundary.
4. Errors cross as a short `t3p: ...` message, never a stack. Expected denials are logged at WARN.

The router refuses to register a channel that is not `t3p:`-prefixed and allowlisted, and refuses duplicates. So a plugin cannot take over `desktop:*` or another plugin's namespace.

### 4.3 Which window is the main window

Electron 44's `webContents.getLastWebPreferences()` does **not** report `preload` (measured on rig). So the tracker classifies each created `BrowserWindow` lazily:

- If Electron reports a preload, the window is main when the preload is `_app.asar/.../preload.cjs`.
- Otherwise the window is main when `webviewTag === true`. In T3 Code 0.1.10 that is only the main window. PIP, splash and overlay windows load `data:` URLs without it.
- No preferences, or a throw, means "not main". The newest live main window wins, and destroyed windows are pruned.

This fails closed. If an upstream update gives another window `webviewTag`, that window would still have to pass the main-frame and `t3code://app` origin checks.

### 4.4 Frames, webviews, iframes (measured on rig, slot 3)

| Context | Has `__t3p_native`? | Can call it? |
|---|---|---|
| Main window, main frame | yes | yes |
| `<webview>` guest (upstream only allows `t3code-preview-*` partitions, which are separate sessions) | no (`undefined`) | no |
| `<webview>` on the default session | upstream's `will-attach-webview` refuses it (no `dom-ready`) | no |
| Same-origin iframe (`about:blank`) created by main-world code | no own bridge | **yes, via `parent.__t3p_native`**. The call comes from the main frame's bridge and is accepted. |
| Sandboxed or cross-origin iframe | no | no (`parent` access → `SecurityError`) |

The same-origin iframe row is not a privilege gain. Only code that already runs in the main world of `t3code://app` can create such a frame, and that code can call the bridge directly.

### 4.5 Plugin attribution is not isolation

Renderer native calls carry `{ plugin: "<id>" }`. Main looks up that plugin's effective permissions and runs the call with that plugin's services only. The id is **self-declared by the renderer**. All renderer plugins share one world, so any renderer code can name any loaded plugin. Effectively, renderer-side native access is the **union** of the native grants of all loaded plugins.

What attribution does give:

- a plugin that was never granted anything cannot widen the set;
- `ghost` (not loaded) and `disabled` plugins get nothing;
- the logs say which grant was used.

## 5. Native services

### 5.1 Path defences (`fs.read`, `sqlite.read`, `log.tail`, plugin file route)

`native/path-guard.ts`. Both stages must pass.

1. **Lexical** (pure, `path.win32` rules on Windows). Rejects:
   - non-strings, empty or over-4096-char paths;
   - NUL and control characters, and `< > " | ? *`;
   - UNC and device namespaces (`\\server`, `\\?\`, `\\.\`, `\??\`);
   - drive-relative paths (`C:foo`);
   - `.`/`..` segments (rejected outright, not normalized away);
   - `:` inside a segment (NTFS alternate data streams such as `::$DATA`);
   - trailing dots and spaces;
   - reserved device names (`CON`, `NUL`, `COM1`, `LPT¹`, `CONIN$`, ...), with or without an extension.

   Then it normalizes and checks containment case-insensitively on Windows. A root matches whole segments only: `C:\x` does not contain `C:\xy`.
2. **Real path**: `realpathSync.native` of the target and of every root, then containment again. This follows symlinks, junctions and other reparse points, and expands 8.3 short names. A missing file is rejected.

Tests:

- `packages/main-runtime/test/path-guard.test.ts`:
  - the table-driven lexical cases;
  - the realpath stage: a fake symlink escaping, a real junction outside the root (created in the test), a junction staying inside, the long-path form of a real path;
  - URL segment decoding (no encoded separators or dot segments).
- `native.test.ts`: per service (outside root, traversal, directories, non-database extensions).

Rig evidence (10) on slot 1:

| Request | Result |
|---|---|
| File inside the granted root | ok |
| `~` path | ok |
| File outside the root | `path is outside every granted root` |
| Traversal | `'.' or '..' segment` |
| `\\?\` | `path must be absolute with a drive letter` |
| `::$DATA` | `':' in a path segment` |
| Call by a plugin without the grant | `fs.read is not granted to after-renderer` |

### 5.2 SQLite

- Each query runs in **its own process**:
  - Electron `utilityProcess.fork` of `sqlite-worker.cjs`, started after `app.whenReady()`, with a scrubbed env;
  - in tests, `child_process.fork`.
- On timeout the process is killed. `worker.terminate()` was measured unable to stop a query stuck in SQLite's C code (it hung more than 2 minutes), so threads were not enough.
- The database is opened `readOnly: true, allowExtension: false` with `PRAGMA query_only=1`.
- The statement check (`checkSelect`), as defence in depth:
  - one statement (only a trailing `;`);
  - no `--` or `/*` comments;
  - must start with `SELECT` or `WITH`;
  - no write or schema keywords outside string literals.
- Parameters are scalars only.
- Test: the database file is byte-identical after queries.

### 5.3 Spawn

- Off unless granted with an allowlist.
- The executable must be lexically clean, `.exe`/`.com` only. No `.bat`/`.cmd`, because `cmd.exe` re-parses their arguments.
- Its real path must equal the real path of an allowlisted entry.
- `shell: false`, argv verbatim (up to 64 args, 8 KiB each, no NUL), `windowsHide`.
- The env is scrubbed to a fixed list (`SystemRoot`, `PATH`, `TEMP`, ...). Provider tokens and `ELECTRON_*`/`NODE_*` variables are not passed.
- cwd = patcher home. Timeout kills the process. Output is capped.

## 6. Patches, protocol and CSP

- The runtime wraps `protocol.handle("t3code", ...)` before the app registers it. It calls the app's handler and post-processes only:
  - `index.html`: inserts `<script src="/__t3p/renderer.js">` before the first script;
  - JS chunks that have patches assigned.
- Every other response object is returned untouched (no buffering).
- If a transform throws or returns null, or the patch decision throws, the **original bytes** are served.
- `t3code://app/__t3p/renderer.js` and `/__t3p/plugins/<id>/<path>` are answered by the runtime:
  - GET/HEAD only;
  - plugin files only for plugins whose renderer may load, only inside that plugin's folder (path guard);
  - everything else below `/__t3p/` is a 404.
- **CSP is unchanged.** The bootstrap and plugin files are same-origin (`'self'`), so the stock policy already allows them. Measured on rig with the runtime loaded: `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://clerk.t3.codes https://challenges.cloudflare.com`, and `eval` still throws `EvalError`.
- The chunk index (984 chunks, about 40 M chars, 205 ms first scan) and patched outputs are cached under `~/.t3-patcher/cache/`, keyed by content hash. A changed patch gets a new cache entry (evidence 9).

## 7. Fail-open

The app must always start.

| Failure | Behaviour | Evidence |
|---|---|---|
| Runtime folder or `main.cjs` missing | Shim logs `runtime missing: ... (stock app)`, starts the stock app | rig (5a) |
| `main.cjs` throws or does not parse | Shim logs `runtime failed (fail-open): ...` with stack, starts the stock app | rig (5b) |
| A boot step throws | `guard()` logs it, skips that step, continues | unit tests |
| Plugin `activate()` throws or exceeds 5 s | Plugin marked failed. Its IPC handlers, patches and renderer are unregistered. Others continue. | rig (6): `throw-main` failed, `throw-renderer` contained, others active |
| Renderer plugin throws on start | `renderer.js` catches it per plugin and records it in `loadResults` | rig (6) |
| A plugin fails to start 3 times in a row (renderer `start()` throws or rejects, main `activate()` fails, or an uncaught error attributed to it within 10 s of start) | Counter in `health.json`; at the threshold the plugin is disabled in `state.json` with `disabledReason: "crash-loop"`; toast on next load. Never in dev mode. See 7.1 | unit tests |
| Patch transform fails | Original chunk served | unit tests |
| Patch `find` text no longer present (upstream changed) | Patch reports 0 replacements, app unchanged | unit tests, `patchReport` |

Limits:

- A main plugin that blocks synchronously (an infinite loop at `require` or in `activate`) hangs the main process. A 5 s timeout cannot pre-empt synchronous code. `main` is trusted code.
- A patch can produce valid but wrong JS that breaks the UI. Recovery: safe mode (section 8), then `t3p disable <id>`.
- Activation is sequential with a 5 s cap each. N hanging plugins delay the first patched chunk by up to N × 5 s.

### 7.1 Crash-loop guard

Goal: a plugin that fails on every launch must not keep failing forever.

- **Counter.** `~/.t3-patcher/health.json` (`{ "version": 1, "plugins": { "<id>": { "failures": n, "lastError": "..." } } }`) is owned by the main process. The renderer reports through `t3p:plugin-health` `{plugin, ok, error?}`; the host validates the id and ignores unknown plugins.
- **What counts as a failed start (+1).**
  - renderer `start()` (or the import) throws, rejects or times out;
  - the main entry fails to load, has no `activate`, throws or times out;
  - an uncaught `error` or `unhandledrejection` on the page whose stack contains the plugin's file URL (`/__t3p/plugins/<id>/`) within 10 s of its start.
- **Reset.** A 10 s window with no failure resets the counter to 0. A main-only plugin is reset by a host timer, a renderer plugin by the renderer's `ok: true` report.
- **Limit of attribution.** Plugin code shares one JS world (section 4.5). An error thrown from a callback that app code runs later, or from a chunk without a plugin frame in its stack, cannot be attributed and is not counted. Only start failures and errors with a plugin stack frame count.
- **Trip.** At `threshold` (default 3, `T3P_CRASH_LOOP_THRESHOLD`) the host sets `enabled: false` and `disabledReason: "crash-loop"` for the plugin in `state.json` (optional field, older files and older runtimes ignore it), logs it, and marks the record `disabled`. The next load shows a persistent toast "<plugin> was disabled after 3 failed starts. Re-enable with: t3p enable <id>" and the Plugins page card shows the reason.
- **Recovery.** `t3p enable <id>` clears the counter and the reason. `t3p plugins` shows the reason; `t3p doctor` reports a warning (exit code stays 0) on its "crash-loop guard" check while any plugin is disabled this way. Enabling from the Plugins page also clears the counter.
- **Dev mode** (`t3p dev` marker or `T3P_DEV=1`): failures are counted and logged but the plugin is never disabled, so editing a plugin live cannot lock it out.
- Counter failures never block startup: an unreadable or malformed `health.json` is treated as empty.

## 8. Safe mode

- Triggers, checked by both the shim and the runtime:
  - `T3P_SAFE=1`;
  - `--t3p-safe` on the command line;
  - the one-shot marker `~/.t3-patcher/safe-mode`, written by `t3p safe` and removed by the first start that sees it. `t3p safe --off` removes it.
- In safe mode the shim does not load the runtime at all, so there are no plugins, no patches, no preload and no injection.
- Rig evidence (7):
  - `T3P_SAFE=1` → `__t3p` and `__t3p_native` undefined, stock string shown;
  - `t3p safe` → the next start is safe, the marker is gone, and the start after that loads the runtime again.
- **Holding Shift is not implemented.** The plan asked for it. Electron's main process has no keyboard-state API before a window exists, and spawning a helper to read key state cost:
  - 1418–1725 ms warm and about 22 s cold (PowerShell `Add-Type` + `GetAsyncKeyState`);
  - 822–865 ms for bare `powershell` alone.

  That is on every launch, which is not acceptable for a check that is almost always negative. The CLI marker replaces it.

## 9. Updater hook and repair worker

- The runtime hooks `autoUpdater` `before-quit-for-update` once.
- It spawns `repair-worker.cjs` **detached**, from `~/.t3-patcher/runtime/`. Never from the install dir, because NSIS wipes it.
- Interpreter choice:
  1. the first `node.exe` on `PATH` that is not inside the install dir;
  2. otherwise `~/.t3-patcher/bin/t3p-node.exe`, a copy of the app's own Electron exe plus `icudtl.dat` and `v8_context_snapshot.bin` (about 257 MB). It is copied by `t3p install` only when no node is on PATH, and run with `ELECTRON_RUN_AS_NODE=1` and `ELECTRON_NO_ASAR=1`. It needs the RunAsNode fuse, which is on in 0.1.10 and checked by `t3p doctor`.
- The worker gets the app's env with `T3P_HOME` set and `NODE_OPTIONS`/`ELECTRON_RUN_AS_NODE` removed.
- The worker:
  1. waits for the app's pid to exit;
  2. waits until the layout is `stale` (stock `app.asar` while the manifest lists the install) and `app.asar` has been unchanged for 10 s;
  3. runs `repair --if-stale` with the bundled installer, retrying while the restarted app holds the files.

  A layout that stays `patched` for 2 minutes means the update was cancelled: the worker does nothing. Log: `~/.t3-patcher/logs/repair.log`.
- Trust:
  - The worker runs as the user with the user's `PATH`. A planted `node.exe` earlier on `PATH` runs as the user. That needs the user's rights already (section 1).
  - The worker only re-applies the layout. It does not download anything.
  - Rig evidence (11) ran this flow with the real worker under the Electron copy against a running app.

## 10. Not defended (explicit)

- Anything running as the user: it can edit `~/.t3-patcher/`, `state.json`, the runtime, or the install dir.
- Plugins with `main`, `patches` or `spawn`: these are trusted code by design.
- Renderer plugins reading the bearer token or driving RPC directly (section 3). WP-3A's `t3.rpc` gating does not change this.
- Renderer plugins impersonating each other in native calls (section 4.5).
- Data a granted plugin reads and sends elsewhere. The loader gives no network filtering; the app's CSP `connect-src` is the only limit, and only for renderer code.
- Hard links inside a granted root pointing at files elsewhere (same volume): realpath does not reveal them.
- Time-of-check/time-of-use swaps of a path component between the check and the open, by something with the user's rights.
- A synchronous hang in a main plugin (section 7).
- Upstream changes: a new window with `webviewTag`, a new main-world API, or a changed `will-attach-webview` gate. The compat checker (WP-5A) and Gate reviews must re-check these on every upstream bump.
- Supply chain of plugins: there is no signing. Install only what you trust.
