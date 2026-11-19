# WP-2 notes: shim, main runtime, preload runtime

Branch `t3/wp-2-runtime-security-boundary`. Target: T3 Code 0.1.10 (Electron 44.10.1, Node 24.22.1, Chrome 152). The security model is in `docs/security.md`; this file records measurements, plan amendments, decisions and the rig evidence.

## 1. What was built

| Package | Output | What |
|---|---|---|
| `@t3p/shim` | template embedded in the replacement `app.asar` | Fail-open loader: safe mode (env, flag, one-shot marker), else `require(~/.t3-patcher/runtime/main.cjs)`, then always `require(_app.asar)`. Logs to `logs/shim.log`. |
| `@t3p/main-runtime` | `dist/main.cjs`, `preload.cjs`, `renderer.js`, `repair-worker.cjs`, `sqlite-worker.cjs` | See boot order below. |
| `@t3p/preload-runtime` | bundled into `dist/preload.cjs` | Frozen `window.__t3p_native` {`invoke`, `version`, `on`} with channel allowlists. |
| `@t3p/renderer-runtime` | bundled into `dist/renderer.js` | IIFE `window.__t3p` (`version`, `ready`, `loadResults`, `plugins`), `__t3p_order` markers, plugin renderer loader with per-plugin error isolation. |
| `@t3p/installer` | `dist/standalone/t3p.cjs` (one-file CJS bundle) | New commands: `plugins`, `grant`, `revoke`, `enable`, `disable`, `safe [--off]`, `--worker-node auto\|copy\|skip`; worker-node copy; uninstall `--purge` also removes `bin/`. |
| `tools/rig` | `patch-slot.ps1`, `probes/` | Real installer on rig per slot with `T3P_HOME=p-s<N>`; launch/reset changes (see `tools/rig/README.md`). |

Main runtime boot order (`packages/main-runtime/src/index.ts`). Every step is wrapped in `guard()`, so a throw is logged and skipped.

1. Logger. Safe mode check: in safe mode, return.
2. Patch registry with the built-ins, chunk index, patch service.
3. Main-window tracker (`browser-window-created`) and IPC router with the sender check.
4. sqlite launcher (`utilityProcess`), native services per plugin, plugin host.
5. Core IPC channels.
6. Plugin host `loadAll` (main entries activate, 5 s timeout each).
7. Protocol wrap of `t3code` (index.html injection, chunk patches, `/__t3p/` routes), which waits for plugin activation before the first chunk decision.
8. Preload registration on `whenReady`.
9. Updater hook.

CSP is not touched.

## 2. Measurements

| What | Result | Where |
|---|---|---|
| Runtime boot (main.log) | Loaded at process uptime 22–23 ms; `runtime boot took 12–14 ms` (7 runs; 15–22 ms in early runs before caching) | rig slot 1 |
| Startup overhead, patched + 4 test plugins vs stock | navStart +5 ms, DCL +7, FCP +2, load +14 (medians, n=5). Run-to-run noise ±30 ms, so no measurable regression. Table in section 5. | rig slots 1 and 2 |
| Chunk index first scan | 984 chunks, 39,964,803 chars, 1 find, 205 ms. Then served from `cache/chunk-index.json`. | rig slot 1 |
| Shift-key detection at launch | `Add-Type` + `GetAsyncKeyState` via PowerShell: 1418–1725 ms warm, about 22 s cold; bare `powershell` start 822–865 ms. **Not viable** on every launch. | rig, measured earlier in WP-2 |
| `worker_threads` `terminate()` on a query stuck in SQLite C code | Did not return in more than 2 minutes. The thread cannot be pre-empted. | FOX unit probe (deleted) |
| Electron-as-node minimal file set | exe + `icudtl.dat` + `v8_context_snapshot.bin` = 257 MB (245,843,632 + 10,824,576 + 742,456 bytes). `ffmpeg.dll` and `snapshot_blob.bin` are not needed. `original-fs` works. | rig |
| Electron 44 `webContents.getLastWebPreferences()` keys | allowRunningInsecureContent, contextIsolation, disableDialogs, disablePopups, enableBlinkFeatures, experimentalFeatures, javascript, nodeIntegration, nodeIntegrationInSubFrames, nodeIntegrationInWorker, safeDialogs, safeDialogsMessage, sandbox, webSecurity, webviewTag. **No `preload`.** | rig slot 1 |
| Main window prefs | `webviewTag: true`, sandbox, contextIsolation; loads `t3code://app`. PIP, splash and overlays load `data:` URLs and have no `webviewTag`. | rig + upstream source |
| Main window timing (main.log) | created at 566 / 586 ms, ready-to-show at 914 / 1021 ms since process start | rig slot 1 |

## 3. Plan amendments and decisions

Decisions that change nothing in the plan's security boundary were made here and are listed so Gate 2 can check them.

1. **Safe mode without Shift.** The plan says "holding Shift at launch". It was measured as not viable (section 2). It is replaced by `T3P_SAFE=1`, `--t3p-safe`, and `t3p safe`, which writes a one-shot marker that the next start consumes. Both the shim and the runtime check all three. Amend PLAN.md WP-2.
2. **CSP unchanged.** The plan allowed "CSP adjusted by the smallest change that works". The smallest change is none: the bootstrap and plugin files are served same-origin from `t3code://app/__t3p/...`, which `script-src 'self'` already allows.
3. **Main window classification.** Electron 44 does not report `preload`, so the tracker uses the preload when present, else `webviewTag === true`. It classifies lazily (prefs are not ready at `browser-window-created`) and fails closed. If upstream changes this, a webview-enabled second window still has to pass the main-frame and origin checks.
4. **IPC results are plain JSON** (`toWire`, 32 MB cap). Structured clone failed on rig ("An object could not be cloned" from a Promise in the result) and would let class instances cross.
5. **sqlite: one process per query.** `utilityProcess.fork` in Electron (after `whenReady`), `child_process.fork` in tests. The process is killed on timeout and gets a scrubbed env. Costs about 50–100 ms per query. Without a launcher the service is absent (fail closed). Statement check: one statement, no comments, SELECT/WITH only, plus `readOnly` + `query_only`.
6. **spawn:** `.exe`/`.com` only (no `.bat`/`.cmd`), cwd = patcher home, env allowlist.
7. **`~` in scope paths = patcher home** (`T3P_HOME` or the OS home). This keeps tests and rig slots self-contained and is the same as the OS home in normal use.
8. **Renderer native calls carry plugin attribution, not isolation** (security.md 4.5). Renderer plugins share one JS world; real isolation is out of scope.
9. **A failed main entry drops its renderer, IPC handlers and patches.** A plugin is all or nothing.
10. **Plugin patches apply only if registered during activation.** The protocol wrap waits for `loadAll` before the first chunk decision; later registrations affect chunks not yet served.
11. **Repair worker interpreter:** the first `node.exe` on PATH outside the install dir, else `~/.t3-patcher/bin/t3p-node.exe` (Electron copy, about 257 MB, copied only when no node is on PATH, or with `--worker-node copy`). It relies on the RunAsNode fuse.
12. **Repair worker reads `app.asar` as a plain file** under Electron-as-node: `process.noAsar = true` in the worker and `ELECTRON_NO_ASAR=1` from the hook. Found on rig (section 4); without it the worker never repairs.
13. **`uninstall --purge`** removes `runtime/` and `bin/` and keeps user data (`plugins/`, `state.json`, `logs/`, `cache/`).
14. **The test patch is opt-in** (`T3P_TEST_PATCH=1`, optional `T3P_TEST_PATCH_TEXT`). Its default target is `Use T3 Code on your phone`, visible on the welcome screen of a fresh 0.1.10 profile.
15. **Bearer token:** full scope and reachable by every renderer plugin. WP-3A `t3.rpc` gating is a consent signal, not a boundary (security.md section 3). This is not a change to the plan's boundary: the plan already puts renderer plugins in the main world. Flagged for Gate 2 and the WP-3A enable prompt.

## 4. Bugs found on rig (all fixed, with tests)

| Symptom | Cause | Fix | Commit |
|---|---|---|---|
| Every native call `t3p: rejected (sender)` / no main window | `getLastWebPreferences()` has no `preload` in Electron 44 | lazy classifier, `webviewTag` marker | `acda53c` |
| `t3p:plugins:list` → `An object could not be cloned` / `plugins: {}` | handler returned a Promise inside the result | await + `toWire` JSON results | `acda53c` |
| Expected denials logged as ERROR with stacks | router logged every throw as an error | `t3p:` errors log at WARN without a stack | `acda53c` |
| Repair worker under `t3p-node.exe` polls forever: `ENOENT, not found in ...\app.asar` | Electron's asar fs layer intercepts `*.asar` paths in run-as-node | `process.noAsar` + `ELECTRON_NO_ASAR=1` | `6c81ad7` |
| `launch.ps1 -Env 'A=1','B=2'` set `A` to `1,B=2` | `pwsh -File` passes a comma list as one string | split on `;` | `513d059` |

## 5. Rig evidence

Setup, from FOX:

```
pnpm --filter @t3p/installer --filter @t3p/main-runtime... build
pwsh -NoProfile -File tools/rig/patch-slot.ps1 -Slot 1 -Plugins
```

The install ran on rig with `T3P_HOME=G:\rig-run\t3patcher\p-s1`:

- `originalAsarSha256 121df7c6953dfa25a2f2e26a7c6fc599481ed59eec8cfb190c511fdf3f29b113`
- `replacementAsarSha256 07f279d2980299810ef47a8dfa5d2a240db169bb18b35c73d8378492b83188d1`
- `workerNode system-node`, runtime 5 files.

Test plugins are from `packages/main-runtime/test-fixtures/plugins`:

| Plugin | Entries | Grants |
|---|---|---|
| `test-plugin` | main + renderer | `main`, `patches`, `fs.read` on `~/fsread-root` |
| `after-renderer` | renderer | none |
| `throw-main` | main that throws, + renderer | `main` |
| `throw-renderer` | renderer that throws | none |

Every check below runs after `pwsh -NoProfile -File tools/rig/launch.ps1 -Slot N [-Env ...]` and is read through `node tools/rig/cdp-eval.mjs --slot N "<expr>"`. Outputs are verbatim.

### (1) `window.__t3p_native` exists, is frozen, bootstrap ran: PASS

```
node tools/rig/cdp-eval.mjs --slot 1 "JSON.stringify({native: typeof window.__t3p_native, nativeKeys: window.__t3p_native && Object.keys(window.__t3p_native), version: window.__t3p && window.__t3p.version, order: window.__t3p_order, frozen: Object.isFrozen(window.__t3p_native), desktopBridge: typeof window.desktopBridge})"
{"native":"object","nativeKeys":["version","invoke","on"],"version":"0.1.0","order":[["t3p-renderer",100.2],["t3p-ready",107]],"frozen":true,"desktopBridge":"object"}
```

Upstream's `desktopBridge` is still there and unchanged.

### (2) Test patch changes a visible string: PASS

Before (no env): `"Phone\nUse T3 Code on your phone"`.

```
pwsh -NoProfile -File tools/rig/launch.ps1 -Slot 1 -Env 'T3P_TEST_PATCH=1'
node tools/rig/cdp-eval.mjs --slot 1 "JSON.stringify({ hasPatched: document.body.innerText.includes('T3P TEST PATCH'), hasOriginal: document.body.innerText.includes('Use T3 Code on your phone'), phoneBlock: (document.body.innerText.match(/Phone\n[^\n]*/) || [''])[0] })"
{"hasPatched":true,"hasOriginal":false,"phoneBlock":"Phone\nT3P TEST PATCH"}
```

main.log:

- `chunk index: scanned 984 chunks (39964803 chars) for 1 find(s) in 205 ms`
- `patch applied: t3p.core find=Use T3 Code on your phone in assets/welcome-Kik81_s2.js (1 replacement(s))`

### (3) Main-side plugin answers an IPC round trip: PASS

```
node tools/rig/cdp-eval.mjs --slot 1 "(async () => { await window.__t3p.ready; const list = await window.__t3p_native.invoke('t3p:plugins:list'); const echo = await window.__t3p_native.invoke('t3p:plugin:test-plugin:echo', {x:1}); return JSON.stringify({ list: list.map(p => [p.id, p.status, p.errors]), echo, loadResults: window.__t3p.loadResults, testPlugin: window.__t3p_test_plugin, after: window.__t3p_after_renderer }); })()"
echo {"echo":{"x":1},"from":"test-plugin","native":["fsRead"],"patches":true}
```

The echo shows that `test-plugin` received only `fsRead` among the native services, plus `patches`.

### (4) IPC sender check: PASS (unit tests + rig frame probe)

Rejection of another webContents, a subframe, a navigated or other origin, a missing frame and a destroyed window: `packages/main-runtime/test/ipc.test.ts`:

- "sender check": 5 cases;
- "ipc router": `t3p: rejected (sender)`;
- "main window tracker": classifier and lazy tracker.

On rig no second window or default-session webview can reach the bridge at all, so the rig part shows reachability instead:

```
pwsh -NoProfile -File tools/rig/patch-slot.ps1 -Slot 3; pwsh -NoProfile -File tools/rig/launch.ps1 -Slot 3
node tools/rig/cdp-eval.mjs --slot 3 --timeout 40000 "$(cat tools/rig/probes/frames.js)"
{"main":"ok v0.1.0","webviewGuest":"undefined / undefined","webviewGuestId":3,"iframeOwn":"undefined","iframeViaParent":"accepted (main frame bridge) v0.1.0","sandboxedIframe":{"t3pProbe":"blocked: SecurityError","own":"undefined"}}
```

- A `<webview>` on the default session got no `dom-ready`: upstream's `will-attach-webview` refuses every partition except `t3code-preview-*`.
- Preview-partition guests have no bridge.
- Same-origin iframes can use the parent's bridge. That is a documented limitation, not an escalation (security.md 4.4).
- CSP still blocks `eval` with the runtime loaded: an earlier probe version got `EvalError ... 'unsafe-eval' is not an allowed source of script`.

### (5) Runtime missing or broken: stock app starts: PASS

(5a) `p-s1\.t3-patcher\runtime\main.cjs` renamed away, then `launch.ps1 -Slot 1 -Env 'T3P_TEST_PATCH=1'`:

```
{"url":"t3code://app/#/welcome","t3p":"undefined","native":"undefined","desktopBridge":"object","phone":"PhoneUse T3 Code on your phoneSet up"}
shim.log: 2026-11-19T00:00:50.012Z runtime missing: G:\rig-run\t3patcher\p-s1\.t3-patcher\runtime\main.cjs (stock app)
```

(5b) `main.cjs` replaced by `throw new Error("corrupt runtime on purpose"); this is not js {`:

```
{"url":"t3code://app/#/welcome","t3p":"undefined","native":"undefined","desktopBridge":"object"}
shim.log: 2026-11-19T00:01:24.135Z runtime failed (fail-open): G:\rig-run\t3patcher\p-s1\.t3-patcher\runtime\main.cjs:1   (+ SyntaxError stack)
```

The original `main.cjs` was restored afterwards.

### (6) Throwing plugins: app starts, errors logged, others unaffected: PASS

Same command as (3):

- `list`:
  - `after-renderer` loaded;
  - `test-plugin` active;
  - `throw-main` failed with `activate failed: throw-main: activate exploded on purpose` and `rendererUrl` null;
  - `throw-renderer` loaded.
- `loadResults`:

  ```
  [{"id":"after-renderer","ok":true},{"id":"test-plugin","ok":true},{"id":"throw-renderer","ok":false,"error":"Error: throw-renderer: start exploded on purpose"}]
  ```
- `__t3p_test_plugin` = `{"started":true,"id":"test-plugin"}` and `__t3p_after_renderer` = `{"started":true,"id":"after-renderer"}`, so the renderer after the thrower still ran.

### (7) Safe mode: PASS

(7a) Env:

```
pwsh -NoProfile -File tools/rig/launch.ps1 -Slot 1 -Env 'T3P_TEST_PATCH=1;T3P_SAFE=1'
{"native":"undefined","t3p":"undefined","testPlugin":"undefined","phoneBlock":"Phone\nUse T3 Code on your phone"}
shim.log: 2026-11-18T23:57:15.767Z safe mode: runtime not loaded     (no new main.log lines)
```

(7b) One-shot marker. Run on rig (rig MCP PowerShell):

```
$env:T3P_HOME = 'G:\rig-run\t3patcher\p-s1'; node 'G:\rig-run\t3patcher\tools-s1\t3p.cjs' safe
next T3 Code start runs in safe mode (no plugins, no patches): G:\rig-run\t3patcher\p-s1\.t3-patcher\safe-mode
```

| Launch | `typeof __t3p` / `typeof __t3p_native` | shim.log |
|---|---|---|
| 1 | `undefined undefined` | `2026-11-18T23:59:48.928Z safe mode: runtime not loaded`; marker left: False |
| 2 | `object object` | runtime is back |

### (8) Unpatch restores the stock app byte for byte: PASS

```
pwsh -NoProfile -File tools/rig/patch-slot.ps1 -Slot 1 -Unpatch
EXIT 0
{ "ok": true, "installDir": "G:\\rig-run\\t3patcher\\app-s1" }
ASAR 121df7c6953dfa25a2f2e26a7c6fc599481ed59eec8cfb190c511fdf3f29b113
```

- The hash equals the original.
- `_app.asar` is gone, and `app.asar.unpacked` is a plain directory again (no junction).
- Launch afterwards: `{"url":"t3code://app/#/welcome","t3p":"undefined","native":"undefined","desktopBridge":"object"}`.

### (9) Changed patch text: re-applied, cache keyed by content: PASS

```
pwsh -NoProfile -File tools/rig/launch.ps1 -Slot 1 -Env 'T3P_TEST_PATCH=1;T3P_TEST_PATCH_TEXT=T3P PATCH V2'
phoneBlock "Phone\nT3P PATCH V2"
```

The chunk index was served from cache (no rescan). `cache/patches` then held 4 files: the old entry is kept and the new one added.

### (10) fs.read path defences and grant scoping: PASS

```
node tools/rig/cdp-eval.mjs --slot 1 "$(cat tools/rig/probes/fsread.js)"
```

| Request | Result |
|---|---|
| inside | `OK inside the granted root` |
| tilde (`~/fsread-root/hello.txt`) | `OK inside the granted root` |
| outside | `ERR path is outside every granted root` |
| traversal | `ERR '.' or '..' segment` |
| devicePath (`\\?\...`) | `ERR path must be absolute with a drive letter` |
| ads (`::$DATA`) | `ERR ':' in a path segment` |
| otherPluginNoGrant | `ERR fs.read is not granted to after-renderer` |
| notAllowlisted (`desktop:get-bearer`) | `ERR t3p: channel desktop:get-bearer is not allowed` (preload allowlist; never sent to main) |

### (11) Updater hook → detached repair worker → `t3p repair --if-stale`: PASS

- Hook trigger (`before-quit-for-update` → detached spawn, env, interpreter choice, never from the install dir): unit tests in `packages/main-runtime/test/updater.test.ts`. Rig has no update server.
- Repair loop: unit tests in the same file. They cover the pid wait, settle, busy retry, cancelled update, timeouts and errors.
- Real worker on rig, slot 3:

```
# on rig, T3P_HOME=G:\rig-run\t3patcher\p-s3
node tools-s3\t3p.cjs install --path G:\rig-run\t3patcher\app-s3 --runtime tools-s3\runtime --worker-node copy --json   -> "workerNode": "copied"
```

Before the fix, the worker under `t3p-node.exe` logged `status failed (install still being written?): Error: ENOENT,  not found in G:\rig-run\t3patcher\app-s3\resources\app.asar` once a second. Probe:

| Mode | Result |
|---|---|
| Default | ERR |
| `process.noAsar=true` | `true 20198279` |
| `ELECTRON_NO_ASAR=1` | `true 20198279` |

Fixed in `6c81ad7`.

Simulation note: overwriting only `app.asar` while leaving `_app.asar` and the junction gives layout `broken`. That is by design: it is a hash mismatch and the installer will not guess. A faithful NSIS-update simulation (junction removed, `_app.asar` deleted, stock `app.asar` copied in) gives `stale`.

Live run, worker started on the app's pid while the app ran (`ELECTRON_RUN_AS_NODE=1`, `ELECTRON_NO_ASAR=1`, as the hook sets them):

```
00:14:18.137Z INFO  repair worker started (pid 14540) for G:\rig-run\t3patcher\app-s3, waiting for app pid 21644
00:14:25.142Z INFO  app pid 21644 exited; waiting for the update to land          <- tools/rig/stop.ps1 -Slot 3
                    (00:14:33.351Z simulated NSIS update)
00:14:44.599Z INFO  installer: building replacement asar at G:\rig-run\t3patcher\app-s3\resources\app.asar.t3p-new
00:14:44.615Z INFO  installer: junction G:\rig-run\t3patcher\app-s3\resources\_app.asar.unpacked -> G:\rig-run\t3patcher\app-s3\resources\app.asar.unpacked
00:14:44.635Z INFO  repair done: patched layout restored; it takes effect on the next app start
ASAR 07f279d2980299810ef47a8dfa5d2a240db169bb18b35c73d8378492b83188d1   ORIG 121df7c6953dfa25a2f2e26a7c6fc599481ed59eec8cfb190c511fdf3f29b113
relaunch: {"t3p":"object","native":"object"}
```

A dead-pid run with `process.noAsar` only (no env) also ended `repair worker finished: repaired`, exit 0.

`t3p repair --if-stale` on the patched install → `"noop"`, exit 0.

### Startup overhead

Measured with `pwsh -NoProfile -File tools/rig/probes/measure-startup.ps1 -Slot N -Runs 5 -Label X`. Values are ms from the main process `CreationDate` to the main page's navigation timings, run 0 discarded. Each cell is median [min–max].

| Config | navStart | DCL | FCP | load |
|---|---|---|---|---|
| A: slot 1 patched + 4 test plugins | 569 [559–596] | 649 [642–692] | 848 [835–904] | 802 [798–843] |
| B: slot 1 shim only (runtime hidden) | 578 [549–610] | 666 [623–696] | 858 [801–886] | 811 [752–833] |
| C: slot 2 stock, unpatched | 564 [556–571] | 642 [632–653] | 846 [804–864] | 788 [761–807] |

## 6. Rig incident

The first `t3p safe` attempt went through `ssh rig "powershell -Command \"\$env:T3P_HOME=...\""` from bash. The quoting dropped the assignment, and `t3p` wrote `C:\Users\<rig user>\.t3-patcher\safe-mode` into the rig user's real home.

- That file was the only content and was created by that call.
- It was removed at once, and the directory no longer exists.

All later env-dependent rig commands ran through the rig MCP PowerShell tool. `tools/rig/README.md` now warns about this.

## 7. Open items and risks

- **Renderer plugins hold the full-scope bearer** (security.md 3). Isolation would need plugin renderer code outside the main world. Decide in WP-3A whether the enable prompt is enough.
- **Renderer native attribution is self-declared** (security.md 4.5). Grants to any plugin with a renderer are usable by all renderer code.
- **Renaming `app.asar` while the app runs** (for repair while T3 Code is open) was not tested. The worker treats locked files as `busy` and retries for up to 2 h.
- The hook trigger itself (`before-quit-for-update`) was not seen on a real update. It needs a real 0.1.x → 0.1.y update on rig when upstream ships one.
- `getLastWebPreferences()` keys and the `webviewTag` marker are Electron- and upstream-version specific. Add both to the WP-5A compat checker.
- Main plugins that block synchronously hang startup (trusted code; security.md 7).
