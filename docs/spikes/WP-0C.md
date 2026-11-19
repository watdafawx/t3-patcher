# WP-0C: loader spike (U1, U2, U3)

Run 2026-11-18 on rig against stock T3 Code 0.1.10 (Electron 44, slots 1 and 3 of `tools/rig`) and the newest nightly `0.1.11-nightly.20261118.4890`.
Code: `docs/spikes/wp-0c/` (`shim/`, `preload.js`, `run.ps1`, `u1-app-folder/`).

## Verdicts

| | Question | Answer |
|---|---|---|
| **U1** | Does Electron load `resources\app\` before `resources\app.asar` (fuse `OnlyLoadAppFromAsar` off)? | **NO.** `app.asar` wins. `resources\app\` is only used when `app.asar` is absent. The fallback (small replacement `app.asar`, original renamed `_app.asar`) **works**. |
| **U2** | Does an NSIS update delete extra files in `resources\`? | **YES.** The whole install dir is wiped: markers, `resources\app\`, `_app.asar`, the junction, unknown folders. Same in updater mode (`--updated /S /D=...`). |
| **U3** | Can a shim wrap `protocol.handle` before `main.cjs` and rewrite `t3code://` responses, with code cache, plus register a preload? | **YES**, all parts. No code-cache staleness seen. `registerPreloadScript` and `setPreloads` both work in the sandboxed main window. |

## Working approach (5 lines)

1. Replace `resources\app.asar` with a ~6 KB asar (`package.json` copied from the original with `main` -> `index.js`, plus the shim). Rename the original to `resources\_app.asar` and create junction `_app.asar.unpacked` -> `app.asar.unpacked`.
2. The shim wraps `electron.protocol.handle` (only for `t3code`) and `registerPreloadScript` on the default session in `app.whenReady`, then `require(resources\_app.asar)`. Everything is in try/catch (fail-open).
3. Rewrite only `text/html` and the matched chunk; return every other `Response` untouched. Copy headers, drop `content-length`.
4. A preload registered on the default session runs before the page: it exposes `__t3p_probe` and injects the main-world early script.
5. NSIS updates wipe the install dir, so repair after update is mandatory; the runtime lives outside it.

---

## U1: load order

### Setup facts

```
npx @electron/fuses read --app "T3 Code (Beta).exe"
  RunAsNode Enabled | EnableNodeOptionsEnvironmentVariable Enabled | EnableNodeCliInspectArguments Enabled
  EnableEmbeddedAsarIntegrityValidation Disabled | OnlyLoadAppFromAsar Disabled
```

Original `app.asar/package.json`: `"name":"t3code","version":"0.1.10","t3codeCommitHash":"7d32075e3757","main":"apps/desktop/dist-electron/boot.cjs"`. `boot.cjs` = `require("./compileCache.cjs"); require("./main.cjs")`.

### Test A: app\ folder AND app.asar present (slot 3, `u1-app-folder/` shim in `resources\app\`)

The shim writes `G:/rig-run/t3patcher/spike/wp0c-s3/shim.log` and prints `T3P-APPDIR-RAN` to stderr, then requires the real app.

```
ls resources:  app  app-update.yml  app.asar  app.asar.unpacked ...
launch.ps1 -Slot 3          -> slot 3: READY
ls spike/                   -> shim.log wp0c-s1          (no wp0c-s3 dir)
grep -c APPDIR _launch-s3.log -> 0
cdp-eval "document.title"   -> "T3 Code (Beta)"          (stock app started)
```
Result: the `app\` shim never ran. Electron picked `app.asar`. (Earlier runs with a hand-written shim in slot 1 gave the same result.)

### Test B: control, app.asar renamed to `_app.asar` (+ junction), `app\` shim present

```
mv resources/app.asar resources/_app.asar
mklink /J resources\_app.asar.unpacked resources\app.asar.unpacked
launch.ps1 -Slot 3 -Env 'T3P_REAL=_app.asar'
cat spike/wp0c-s3/shim.log -> 2026-11-18T21:45:46.751Z appdir-shim ran type=browser argv=["G:\\rig-run\\t3patcher\\app-s3\\T3 Code (Beta).exe",...]
grep -c APPDIR _launch-s3.log -> 1
cdp-eval "document.title" -> "T3 Code (Beta)"
```
So Electron 44 looks at `app.asar` first, then `app\`. (The exe holds `appSearchPaths` and the strings `app.asar`, `default_app.asar`.) The plan's section 3 layout does not work as written.

### Fallback: replacement `app.asar` (works)

Layout (slot 1):
```
resources\app.asar               6 KB   shim package.json + index.js
resources\_app.asar              20 MB  original, renamed
resources\_app.asar.unpacked     junction -> app.asar.unpacked
```
Evidence (shim.log from the first fallback run, slot 1):
```
2026-11-18T21:35:54.194Z FALLBACK shim type=browser argv=[... "--remote-debugging-port=9333" ...] appPath=G:\rig-run\t3patcher\app-s1\resources\app.asar name=t3code version=0.1.10 userData=C:\Users\USER\AppData\Roaming\t3code isPackaged=true
2026-11-18T21:35:54.476Z real app required; name=t3code version=0.1.10 userData=G:\rig-run\t3patcher\appdata-s1\t3code-v2
cdp-eval "document.title"                      -> "T3 Code (Beta)"
http://127.0.0.1:3873/.well-known/t3/environment -> 200 {"serverVersion":"0.1.10","orchestrationProtocolVersion":2,...}
desktopBridge: object, 82 keys; getUpdateState().currentVersion -> "0.1.10"
```

### Identity checks with the shim as entry

| Item | Result |
|---|---|
| `app.getAppPath()` | `...\resources\app.asar` (same as stock, because the replacement sits at that name) |
| `app.getVersion()` / `app.name` | `0.1.10` / `t3code` before main runs; main later calls `setName("T3 Code Beta")`. Version comes from the **shim's** package.json, so it must be copied from the original (it also carries `t3codeCommitHash`, read by the About panel via `appRoot/package.json`, `main.cjs:164504`). |
| userData | Before main runs: `C:\Users\USER\AppData\Roaming\t3code` (Electron ignores the `APPDATA` env override at that point). After `require` of the real app: `G:\rig-run\t3patcher\appdata-s1\t3code-v2` (main calls `setPath("userData")` synchronously). **The shim must not touch or create anything under `getPath('userData')` before the real app has been required.** |
| Auto-updater paths | `app-update.yml` is read from `process.resourcesPath` (unchanged). With updates enabled (`T3CODE_DISABLE_AUTO_UPDATE=0`) the log shows `checking for updates` ... `Update for version 0.1.10 is not available (latest version: 0.1.10, downgrade is disallowed).` |
| Native modules | **Need `_app.asar.unpacked`.** Without it (first attempt, no junction) startup logged `updates are off because the managed policy cannot be used ... this T3 Code install cannot load its registry reader; reinstall T3 Code` and `Clerk: createClerkBridge ... requires the optional @clerk/electron-passkeys package`. With the junction both messages are gone. A copy of the 9.6 MB folder would also work. |
| Exe signature | `Get-AuthenticodeSignature "T3 Code (Beta).exe"` on the patched slot: `Valid`, SHA256 identical to base (`EAC3D852...C7721`). |

### Other options seen (not built)

- `NODE_OPTIONS=--require shim.js`: fuse `EnableNodeOptionsEnvironmentVariable` is on, but it needs an env var at every launch (shortcuts, protocol handlers). Not robust.
- Do not rely on `resources\app\` at all.

### Recommendation (plan sections 3 and 7)

- Section 2, U1: "NO, `app.asar` is searched first".
- Section 3 diagram: replace the `app/` folder with the three-entry layout above (replacement `app.asar`, `_app.asar`, `_app.asar.unpacked` junction). The shim reads the original `package.json` from `_app.asar` at install time to build its own.
- WP-1B installer: create the junction with `fs.symlinkSync(target, path, 'junction')` (no admin needed on the same volume), keep a manifest, restore = delete replacement + junction + rename back. `t3p doctor` must verify `_app.asar` hash equals what the install recorded.
- Gate: only start WP-2 on this layout.

---

## U2: NSIS update behaviour

### Installer facts

- Config (`.upstream/scripts/build-desktop-artifact.ts:2969`): `nsis: { differentialPackage: true, include: "apps/desktop/resources/installer.nsh" }`. Everything else is electron-builder default: `oneClick: true`, `perMachine: false` (per-user), `deleteAppDataOnUninstall: false`. `installer.nsh` only customises the "app is running" messages and adds a Start Menu shortcut.
- Updater (`main.cjs:104870`): runs the installer with `["--updated", "/S" (silent), "--force-run", "/D=<installDirectory>", "--package-file=<cached package.7z>"]`.
- `app-update.yml` (0.1.10): `releaseType: release`, nightly: `releaseType: prerelease, channel: nightly`; both have `updaterCacheDirName: t3code-updater`, `publisherName: T3 Tools Inc`.
- Installers are Authenticode `Valid`, signer `CN=T3 Tools Inc, O=T3 Tools Inc`.

### Safety pre-checks (rig)

```
HKCU/HKLM/WOW6432 Uninstall: no key with DisplayName or InstallLocation matching T3 (403 keys before)
%LOCALAPPDATA%\Programs, C:\Program Files: no T3 folder. No T3 process outside G:\rig-run\t3patcher.
```
Slots were stopped first. The nightly installs as `T3 Code (Nightly).exe`, a different name from the slot apps `T3 Code (Beta).exe`.

### Run 1: 0.1.10 installer into the throwaway dir

```
Start-Process T3-Code-0.1.10-x64.exe -ArgumentList "/S","/D=G:\rig-run\t3patcher\nsis-test" -Wait   -> exit=0 (silent, no UI, no app launched)
```
It created, outside the install dir (all removed at the end):
```
HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\e9197887-efb3-55e0-985e-d6d3b5dd594a   (DisplayName "T3 Code (Beta) 0.1.10",
     UninstallString "G:\rig-run\t3patcher\nsis-test\Uninstall T3 Code (Beta).exe" /currentuser)
HKCU\Software\e9197887-efb3-55e0-985e-d6d3b5dd594a   (InstallLocation, ShortcutName)
%APPDATA%\Microsoft\Windows\Start Menu\Programs\T3 Code (Beta).lnk   and   %USERPROFILE%\Desktop\T3 Code (Beta).lnk
%LOCALAPPDATA%\t3code-updater\installer.exe   (390 MB copy of the installer)
```
The key GUID is derived from the appId, identical for stable and nightly. A real install on this account would share it, which is why nothing real existed on rig was a precondition.

### Added files, then update over the top

Added to `nsis-test`: `MARKER-root.txt`, `resources\MARKER-resources.txt`, `resources\app\{package.json,index.js}`, `resources\extra-dir\x.txt`, and the fallback layout (`app.asar` replaced by the 2 KB shim asar, original as `resources\_app.asar`, junction `_app.asar.unpacked`).

```
exe sig after adding them: Valid, hash EAC3D852B8C0C8F1917FF50A7CCB8092C4EC0087FB17342BB0813751301C7721 (unchanged)

Start-Process T3-Code-0.1.11-nightly.20261118.4890-x64.exe -ArgumentList "/S","/D=...\nsis-test" -Wait  -> exit=0 secs=14
resources after: app.asar.unpacked node_modules resource-monitor server.asar.unpacked app-update.yml app.asar(20500809) elevate.exe server.asar ...
MARKER-root.txt            exists=False
resources\MARKER-resources.txt exists=False
resources\app\index.js     exists=False
resources\extra-dir\x.txt  exists=False
resources\_app.asar        exists=False   (junction gone too)
root: "T3 Code (Beta).exe" and its uninstaller removed, "T3 Code (Nightly).exe" + "Uninstall T3 Code (Nightly).exe" installed.
```

Second pass in true updater mode (re-created the markers and `resources\app\`, then `--updated /S /D=...` with the same installer, as `doInstall` does):
```
before: app,app.asar.unpacked,extra-dir,node_modules,...,MARKER-resources.txt,...
exit=0
after : app.asar.unpacked,node_modules,resource-monitor,server.asar.unpacked,app-update.yml,app.asar,elevate.exe,server.asar,wsl-runtime.tar.gz,wsl-runtime.tar.gz.sha256
all four markers exists=False
```
Result: **everything not shipped is deleted**, the update replaces the entire folder.

### Running app

Started `T3 Code (Nightly).exe` from `nsis-test` (own home/ports), put a marker in the root, ran `--updated /S /D=...` while it ran: exit 0 in 15 s, **the installer closed the running app by itself** (silent, no prompt), the marker was gone. So: the installer does not need the app closed, it kills it. Any repair helper that runs from the install dir (e.g. the Electron exe in node mode) will be killed and will also hold a file lock; it must run from outside the install dir.

### Other facts

- Stable -> nightly in the same dir works: new exe name, same registry key (now `DisplayName "T3 Code (Nightly) 0.1.11-nightly.20261118.4890"`), shortcuts renamed.
- No UAC (per-user). `Uninstall ... /currentuser /S` removed the dir, both registry keys and both shortcuts. `%LOCALAPPDATA%\t3code-updater` is left behind (removed by hand).
- Signature: `Get-AuthenticodeSignature` on `T3 Code (Beta).exe` and `T3 Code (Nightly).exe` = `Valid` (CN=T3 Tools Inc) before and after adding `resources\app\`, `_app.asar`, the junction and the replacement `app.asar`. Authenticode covers only the PE file, and `EnableEmbeddedAsarIntegrityValidation` is off. SmartScreen itself cannot be queried from a script; installed files written locally carry no Mark-of-the-Web, and the PE files are untouched (Smart App Control checks PE/`.node`/`.dll`, which we do not modify).
- The downloaded nightly installer is Valid (signer T3 Tools Inc). Its hash is not listed in the release `SHA256SUMS`.

### Recommendation

- Section 2, U2: "YES, NSIS wipes the install dir on every update, in updater mode too".
- Section 3 "Surviving updates": the shim cannot survive; **repair is the only mechanism**. The app is killed by the installer, so repair must be: (a) triggered before quit by the main runtime, spawning a worker **outside the install dir** (copy of a node binary in `~/.t3-patcher/bin`, or system `powershell.exe`), detached with `stdio: 'ignore'`; (b) the worker waits until the installer process exits, then reads the **new** `app-update.yml` / exe name (channel can change: Beta -> Nightly), and re-applies. Not tested here (the updater path needs a real signed update feed); WP-5B covers it.
- Add a second trigger: a Run-key or Task Scheduler "on logon" repair, because a user can also run the installer by hand (no running app involved).
- WP-1B: `t3p status` must detect "install replaced" (hash of `app.asar` != recorded replacement, no `_app.asar`) and treat it as `stale-after-update`.
- Must-know for tests: each launch of a slot app appends `<home>\bin` to the **user** PATH (HKCU) via the desktop CLI install (`desktop-cli-command`, `onPath: true`). `tools/rig` should clean that (see gotchas).

---

## U3: protocol wrap, code cache, preload

### What main registers (observed through the wrapper)

```
registerSchemesAsPrivileged [{"scheme":"t3code","privileges":{"standard":true,"secure":true,"supportFetchAPI":true,"corsEnabled":true,"stream":true,"codeCache":true}},{"scheme":"t3code-dev",...no codeCache}]
registerSchemesAsPrivileged [{"scheme":"t3code","privileges":{"standard":true,"secure":true,"supportFetchAPI":true,"corsEnabled":true,"stream":true}}]    <- 2nd call (main.cjs:164869), no codeCache
protocol.handle(t3code) wrapped
```
Two separate calls register `t3code`; the second omits `codeCache`. Code cache files for t3code chunks are still written (`Code Cache\js` grew during the runs), so Chromium honours it. The shim must not call `registerSchemesAsPrivileged` itself (it must run before ready; wrapping it only to observe is fine).

### Results, run 1 (slot 1, chunk `index-CG-aocM4.js`, tag v1)

`cdp-eval` of `probe.js` in the main window:
```
title "T3 Code (Beta)", __t3p_test 1, __t3p_early 1, __t3p_early_dom 1, __t3p_chunk_tag "v1"
__t3p_probe {"ok":true,"t":46.4,"contextIsolated":true,"sandboxed":true,"isMainFrame":true}
__t3p_order [["early-executeJavaScript",46.5],["early-dom-script",55.3],["index.html",55.4],["chunk",88.7]]
desktopBridge: object (82 keys), __clerk_internal_electron_passkeys: object
fetch('t3code://app/assets/index-CG-aocM4.js') text ends with:  ...window.__t3p_chunk_tag="v1";\n/*T3P_MARKER*/
fetch('t3code://app/') -> content-type text/html, content-security-policy preserved, body contains __t3p_test=1 BEFORE "const LIGHT_BACKGROUND" (the first original script)
```
Original response headers (shim log): only `content-security-policy=default-src 'self'; script-src 'self' 'unsafe-inline' ...` and `content-type`. **There is no Content-Length** on asset responses (`new Response(Uint8Array, {headers:{content-type}})`), so there is nothing to fix up; the shim still deletes it defensively. Untouched responses are returned as the same `Response` object (still streaming); only `text/html` and the matched chunk are buffered (`response.text()`).

(a) marker, (b) html injection before other scripts, (c) other responses untouched with CSP kept: **all pass**.

### Code cache / staleness test

Chunk `main-fgzYaqEM.js` (1,118,100 chars patched, loaded at startup). The app was fully restarted each run (`launch.ps1` stops, then starts; `userData` and `Code Cache` kept). Config changed between runs:

| Run | tag | marker | page `__t3p_chunk_tag` | fetched text end |
|---|---|---|---|---|
| R1 | v1 | `/*T3P_MARKER*/` | v1 | `..."v1";\n/*T3P_MARKER*/` |
| R2 | v1 | same (cache warm) | v1 | same |
| R3 | v1 | same | v1 | same |
| R4 | **v2** | same length (len 1118100 both) | **v2** | `..."v2";\n/*T3P_MARKER*/` |
| R5 | v3-longer-tag | `/*T3P_MARKER_LONGER_TEXT*/` (len 1118123) | **v3-longer-tag** | `...\n/*T3P_MARKER_LONGER_TEXT*/` |
| R6 | v4 | `/*T3P_MARKER*/` | **v4** | `..."v4";\n/*T3P_MARKER*/` |
| R7 | patch off (`chunk: none.js`) | | **undefined**, fetched text = original (len 1117977, ends `sourceMappingURL=main-fgzYaqEM.js.map`) | |

The tag is a string literal in the top-level code of the module, so a stale V8 code cache of an older body would have shown the old tag, in particular R4 (same length, which is the case where V8's length-based source check could not tell the versions apart). It did not. `Code Cache\js` shows separate entries of ~555 KB for the stock body (`93fe2336...`, 23:27) and the patched one (`1e1fb977...`), i.e. patched and unpatched sources do not share an entry. **Conclusion: no staleness from the `codeCache` privilege or Chromium's cache in 7 restarts.** Unknown: whether the entry is keyed by content or invalidated by the (changing) response time; either way the behaviour we need holds. `t3p doctor` can offer clearing `userData\Code Cache\js` as a reset lever if staleness ever shows up.

### CSP-affecting injection

Injected next to the inline script (`ext` list), on index.html with the app's own CSP (`script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://clerk.t3.codes https://challenges.cloudflare.com`):

| Injected | Result |
|---|---|
| `<script>` inline | runs (`'unsafe-inline'`) |
| `<script src="t3code://app/__t3p/ext.js">` (route served by the shim itself, never reaches the original handler) | **runs** (`__t3p_ext_virtual: 1`, order shows `ext-virtual` before `chunk`) |
| `<script src="t3code://app/assets/search-CTfj9FjD.js">` (real asset) | requested and allowed, no violation (an ES module run as classic script is a SyntaxError, irrelevant to CSP) |
| `<script src="http://127.0.0.1:3873/x-ext.js">` | **blocked**: `securitypolicyviolation` `script-src-elem` |
| `<script src="https://example.com/x.js">` | **blocked** `script-src-elem` |

So: inline and same-origin `t3code://` are allowed, any other origin is blocked. No CSP edit is needed for the loader; plugin code must be served from `t3code://app/__t3p/...` (shim route) or inline. If a plugin ever needs external scripts the CSP header on the rewritten response is where to change it (delete or edit `content-security-policy` in the cloned `Headers`).

### Preload

Both APIs worked. The shim calls `registerPreloadScript` (default) or `setPreloads` (`-PreloadApi setPreloads`) inside `app.whenReady().then(...)`, registered before main creates the window.

```
registerPreloadScript ok id=4a5c8cf9-... G:\rig-run\t3patcher\spike\wp0c-s1\preload.js
setPreloads ok G:\rig-run\t3patcher\spike\wp0c-s1\preload.js          (second run)
{"early":1,"dom":1,"probe":{"ok":true,"t":39.1,"contextIsolated":true,"sandboxed":true,"isMainFrame":true},
 "order":["early-executeJavaScript@39","early-dom-script@46","index.html@46","chunk@79"],"bridge":"object","bridgeKeys":82}
window.desktopBridge.getAppBranding() -> {"baseName":"T3 Code","stageLabel":"Beta","displayName":"T3 Code (Beta)"}
```
- The preload runs in the sandboxed, context-isolated main window before any page script. `contextBridge.exposeInMainWorld('__t3p_probe', ...)` works.
- Two ways to run main-world code at document start both worked: `webFrame.executeJavaScript` (earliest, ~39-53 ms) and a `<script>` node created in the preload and prepended to `documentElement` (the CSP allows it because of `'unsafe-inline'`). Both ran before the injected index.html script and before the first module.
- The app's own preload still works (`desktopBridge` with 82 keys, Clerk bridge present).
- `type: 'frame'` preloads also run in sub-frames; the spike guards with `location.protocol === 't3code:'`. Webviews use other partitions and are not covered by a default-session preload.

### Recommendation (plan sections 3 and 7)

- U3 is **yes**; the protocol approach needs no fallback.
- Section 3: say "wrap `protocol.handle`" (the property is writable; wrapping must be installed before main runs, `handle` is called after ready) and use `session.defaultSession.registerPreloadScript({type:'frame', filePath})` from `app.whenReady()`.
- Patch engine must (1) delete `content-length` and `content-encoding` when it changes a body (asset responses have neither, but the dev proxy path copies upstream headers), (2) buffer only matched responses, (3) match chunks by content (`find`), not file name, because hashes change per release (`index-CG-aocM4.js` is 0.1.10-only).
- Plugin code delivery: serve runtime/plugin files from a shim-owned route `t3code://app/__t3p/*`, not external URLs.

---

## Gotchas

1. Shell-heredoc string escapes: `'G:\\rig...'` written through the tool layer turned into `\r`/`\t` escapes and silently failed (logs went to a bogus path, which first looked like "app/ not loaded"). Use forward slashes in JS paths.
2. `pwsh -File` flattens `string[]` params to one comma-joined string (`-Ext a,b`, `-Env a,b`). `run.ps1` splits on commas; `launch.ps1 -Env` with several values is broken the same way (one value works).
3. `T3CODE_DISABLE_AUTO_UPDATE` is parsed as a boolean option: set `=0` to enable the updater, an empty value still counts as disabled.
4. **rig PATH pollution**: every slot app launch appends `G:\rig-run\t3patcher\home-sN\bin` to rig's user PATH (`desktop-cli-command`, `onPath: true`). Entries for s1, s2, s3 and the test home were present. WP-0C removed its own (s1, s3, nsis); `home-s2\bin` is left for the other agent. `tools/rig/launch.ps1` should remove the entry on `reset/stop` (or find the env/setting that disables CLI install).
   **Incident during cleanup:** my PATH-cleanup one-liner on rig used an invalid regex, the filter threw, and `SetEnvironmentVariable("Path", "", "User")` wiped rig's user `Path` for about a minute. Restored from the value printed earlier in the session (14 entries, now `REG_EXPAND_SZ`, entries are literal expanded paths, `home-s2\bin` kept). If rig's user PATH ever looks different from `C:\Users\USER\.cargo\bin;...;copilot-shim`, that is why. Lesson: never write PATH from a pipeline that can throw.
5. Second CDP oddity: once, right after launch with updates enabled, port 9333 answered with `Edg/157` and then nothing; not investigated.
6. `app.getPath('userData')` is wrong before the real app has run (see U1).
7. `registerSchemesAsPrivileged` is called twice by upstream code (the 2nd without `codeCache`); do not assume the first call is the only one when adding schemes.

## Cleanup done at the end of the spike

`stop.ps1 -Slot 1`, `-Slot 3`; `reset.ps1 -Slot 1 -Restore` and `-Slot 3 -Restore` (pristine, no `_app.asar`, no junction, no `app\`); `nsis-test` uninstalled with its own uninstaller, folder and both registry keys and both shortcuts verified gone; `%LOCALAPPDATA%\t3code-updater` removed; scheduled task `t3patcher-nsis` deleted; `home-nsis`, `appdata-nsis`, spike dirs and the downloaded nightly installer deleted; PATH entries for s1, s3, nsis removed. `G:\rig-run\t3patcher\base` untouched.

## Final code

Files in `docs/spikes/wp-0c/`: `shim/package.json` (original package.json with `main: "index.js"`), `shim/index.js`, `preload.js`, `run.ps1`, `u1-app-folder/`. Usage on FOX:

```
pwsh -NoProfile -File docs/spikes/wp-0c/run.ps1 -Slot 1 -Chunk main-fgzYaqEM.js -Tag v1 [-Marker '/*T3P_MARKER*/'] [-Ext 'src1,src2'] [-PreloadApi setPreloads] [-LogAll]
node tools/rig/cdp-eval.mjs --slot 1 "window.__t3p_chunk_tag"
```
`run.ps1` rewrites `app.asar` on slot N (first run renames the original to `_app.asar` and makes the junction), writes `config.json` (re-read on every request) and `preload.js` into `G:\rig-run\t3patcher\spike\wp0c-sN\`, then launches. Undo with `tools/rig/reset.ps1 -Slot N -Restore`.

### shim/index.js (entry of the replacement app.asar)

```js
'use strict';
// WP-0C spike shim. Lives as the entry of a REPLACEMENT resources/app.asar (the original is renamed _app.asar).
// Fail-open: any error in the patch layer is logged and the stock app still starts.
const fs = require('fs');
const path = require('path');
const electron = require('electron');

const DIR = process.env.T3P_SPIKE_DIR || 'G:/rig-run/t3patcher/spike/wp0c';
const T0 = Date.now();
function log(msg) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(path.join(DIR, 'shim.log'), `${new Date().toISOString()} [${process.type}] ${msg}\n`);
  } catch (e) { try { process.stderr.write('T3P-LOGFAIL ' + e.message + '\n'); } catch {} }
}
// config is re-read on every request so a run can change marker/tag without repacking the asar
function cfg() {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8')); } catch { return {}; }
}

function install() {
  const { app, protocol, session } = electron;
  log(`shim start argv=${JSON.stringify(process.argv)} appPath=${app.getAppPath()} name=${app.name} version=${app.getVersion()} userData=${app.getPath('userData')} isPackaged=${app.isPackaged}`);

  // ---- observe the scheme privileges main registers (read only)
  const origPriv = protocol.registerSchemesAsPrivileged.bind(protocol);
  protocol.registerSchemesAsPrivileged = (schemes) => {
    log('registerSchemesAsPrivileged ' + JSON.stringify(schemes));
    return origPriv(schemes);
  };

  // ---- wrap protocol.handle for t3code
  const origHandle = protocol.handle.bind(protocol);
  protocol.handle = (scheme, handler) => {
    if (scheme !== 't3code') return origHandle(scheme, handler);
    log('protocol.handle(t3code) wrapped');
    return origHandle(scheme, async (request) => {
      // virtual route served entirely by the shim (CSP external-script test)
      try {
        const u = new URL(request.url);
        if (u.host === 'app' && u.pathname === '/__t3p/ext.js') {
          return new Response('(window.__t3p_order=window.__t3p_order||[]).push(["ext-virtual",performance.now()]);window.__t3p_ext_virtual=1;',
            { headers: { 'content-type': 'text/javascript; charset=utf-8' } });
        }
      } catch {}
      const response = await handler(request);
      if (cfg().logAll) log('req ' + new URL(request.url).pathname + ' ' + response.status + ' ' + (response.headers.get('content-type') || ''));
      try { return await patch(request, response); } catch (e) { log('patch error ' + (e && e.stack)); return response; }
    });
  };

  async function patch(request, response) {
    if (request.method !== 'GET' || response.status !== 200) return response;
    const u = new URL(request.url);
    const c = cfg();
    const ct = response.headers.get('content-type') || '';
    const isHtml = /text\/html/i.test(ct);
    const isChunk = !!c.chunk && u.pathname === '/assets/' + c.chunk;
    if (!isHtml && !isChunk) return response; // untouched: same Response object, still streaming
    const before = [...response.headers.entries()].map(([k, v]) => `${k}=${v.slice(0, 40)}`).join('|');
    let text = await response.text();
    const origLen = text.length;
    if (isHtml) {
      let inject = '<script>window.__t3p_test=1;(window.__t3p_order=window.__t3p_order||[]).push(["index.html",performance.now()]);</script>';
      for (const src of [].concat(c.ext || [])) inject += `<script src="${src}"></script>`;
      const i = text.indexOf('<script');
      text = i >= 0 ? text.slice(0, i) + inject + '\n    ' + text.slice(i) : text + inject;
    } else {
      text += `\n;(window.__t3p_order=window.__t3p_order||[]).push(["chunk",performance.now()]);window.__t3p_chunk_tag=${JSON.stringify(c.tag || '')};\n${c.marker || '/*T3P_MARKER*/'}`;
    }
    const headers = new Headers(response.headers);
    headers.delete('content-length'); // body size changed; let Response compute
    log(`patched ${u.pathname} ${origLen}->${text.length} origHeaders=[${before}]`);
    return new Response(text, { status: response.status, statusText: response.statusText, headers });
  }

  // ---- preload on the default session
  app.whenReady().then(() => {
    const c = cfg();
    const file = c.preload || path.join(DIR, 'preload.js');
    const ses = session.defaultSession;
    try {
      if (c.preloadApi === 'setPreloads') { ses.setPreloads([file]); log('setPreloads ok ' + file); }
      else { const id = ses.registerPreloadScript({ type: 'frame', filePath: file }); log('registerPreloadScript ok id=' + id + ' ' + file); }
    } catch (e) { log('preload registration failed ' + (e && e.stack)); }
  });
}

try { install(); } catch (e) { log('install failed (fail-open): ' + (e && e.stack)); }
require(path.join(process.resourcesPath, '_app.asar'));
log(`real app required after ${Date.now() - T0}ms; name=${electron.app.name} userData=${electron.app.getPath('userData')}`);
```

### preload.js

```js
// WP-0C extra preload (registered on session.defaultSession). Runs in the sandboxed preload world.
const { contextBridge, webFrame } = require('electron');
if (location.protocol === 't3code:') {
  const t = performance.now();
  contextBridge.exposeInMainWorld('__t3p_probe', { ok: true, t, contextIsolated: process.contextIsolated, sandboxed: process.sandboxed, isMainFrame: process.isMainFrame });
  const code = `window.__t3p_early=1;(window.__t3p_order=window.__t3p_order||[]).push(["early-executeJavaScript",performance.now()]);`;
  try { webFrame.executeJavaScript(code); } catch (e) { contextBridge.exposeInMainWorld('__t3p_probe_err', String(e)); }
  // variant B: DOM-injected <script> as soon as documentElement exists
  const inject = () => {
    const s = document.createElement('script');
    s.textContent = `document.addEventListener('securitypolicyviolation',e=>{(window.__t3p_csp=window.__t3p_csp||[]).push([e.blockedURI,e.violatedDirective])});window.__t3p_early_dom=1;(window.__t3p_order=window.__t3p_order||[]).push(["early-dom-script",performance.now()]);`;
    (document.head || document.documentElement).prepend(s);
    s.remove();
  };
  if (document.documentElement) inject();
  else new MutationObserver((_, o) => { if (document.documentElement) { o.disconnect(); inject(); } }).observe(document, { childList: true });
}
```
