# WP-5B: update survival on rig

Rig slot 2, 2026-11-19. Upstream has no stable release newer than 0.1.10, so the update ran between two nightlies (`0.1.11-nightly.20261118.4864` -> `.4903`), both `T3 Code (Nightly).exe`, same NSIS appId.

## What was tested and the evidence

| # | Check | Result |
|---|---|---|
| 1 | Patch with `tools/rig/patch-slot.ps1 -Slot 2 -Plugins -Force` on a real NSIS-installed nightly (`/S /D=<slot dir>`, so the uninstall key is registered and NSIS really wipes the dir on update). | pass. 5 patches applied, 1 failed (see "Patch finds"), `test-plugin` active. |
| 2 | Real `before-quit-for-update` trigger. | pass. The in-app updater cannot be used (no newer stable; upstream sets `autoInstallOnAppQuit=false`, so `quitAndInstall` is the only install path and it does emit the event: checked in the 0.1.10 bundle). `tools/rig/probes/wp5b-updater` is a rig-only plugin that does what `BaseUpdater.quitAndInstall(silent)` does: spawn the real installer (`--updated /S /D=...`), emit `autoUpdater` `before-quit-for-update`, `app.quit()`. App log: `[updater] before-quit-for-update: an update is being installed`, then `repair worker spawned: C:\Program Files\nodejs\node.exe G:\...\p-s2\.t3-patcher\runtime\repair-worker.cjs --install-dir ... --pid 25800`. |
| 3 | Worker runs from outside the install dir and survives the NSIS wipe. | pass. Interpreter `C:\Program Files\nodejs\node.exe`, script in `p-s2\.t3-patcher\runtime`, cwd = T3P home. `repair.log`: `app pid 25800 exited` (t+1 s), installer done (about 12 s), `installer: building replacement asar`, junction re-created, `repair done`, `finished: repaired` at t+24 s. |
| 4 | After the update: `t3p status` = patched, new version, plugins load. | pass. `status`: `0.1.11-nightly.20261118.4903`, `layout: patched`, hashes match, junction ok; manifest `appVersion` updated. Relaunched: `appVersion 0.1.11-nightly.20261118.4903`, `test-plugin` active, echo handler answers over CDP. |
| 5 | Cancelled update (hook fires, installer never lands). | pass. Worker waits the 2 min settle time, logs `layout is still patched (no update was installed)`, exits `already-patched`. |
| 6 | Manual installer run with the app closed, then the logon task. | pass after the fix below. Installer (4864 over 4903) left `layout: stale`. `schtasks /Run /TN t3patcher-repair-s2` (same action as the logon trigger) -> `logon-repair.log`: `[{"installDir":"...app-s2","result":"repaired"}]`, task Last Result 0, status `patched`. A real logon event was not exercised, only the task action. |
| 7 | Renaming a locked `app.asar`. | pass. A running app holds `app.asar` without share-delete: `Rename-Item` fails ("being used by another process"). `t3p install` on a stock slot with the app running exits 1 (`AppRunningError`), the layout stays `unpatched` and intact, nothing left behind. In the update flow this is the "NSIS `--force-run` restarted the app" retry loop in `runRepairLoop` (unit tests). Not run live: `--force-run` relaunches the app with rig's real APPDATA and `T3P_HOME`, so the probe omits it. |

## Bugs found and fixed

1. **The logon scheduled task did not exist.** PLAN.md section 3 promised it, but nothing in the repo registered one. Fixed:
   - `packages/installer/src/logon-task.ts`: `ensureLogonTask` copies the running `t3p.cjs` to `<home>/.t3-patcher/t3p.cjs`, writes `<home>/.t3-patcher/repair-logon.cmd` (sets `T3P_HOME` when overridden, picks `node.exe` or the `bin\t3p-node.exe` Electron copy with `ELECTRON_RUN_AS_NODE`/`ELECTRON_NO_ASAR`, logs to `logs\logon-repair.log`) and registers a per-user `ONLOGON` task (`/RL LIMITED`, no admin needed on rig). Name `t3-patcher-repair`, or `T3P_TASK_NAME`. Everything lives outside the T3 Code dir.
   - CLI: `t3p install` registers it (skipped when not running from the `.cjs` bundle, off Windows, or with `--no-logon-task`); `t3p uninstall` removes it when the manifest is empty.
2. **`t3p repair --if-stale` with no `--path` relied on auto-detection**, which fails or picks the wrong install when several exist, or after an update rewrote the registry. Now `repairRecorded` repairs every stale install in the manifest; detection is the fallback only when the manifest is empty.
3. Rig tooling: `patch-slot.ps1` sets a per-slot `T3P_TASK_NAME` and has `-Force`; `lib.ps1` honours `T3P_RIG_EXE` for nightly slots.

Tests: `packages/installer/test/logon-task.test.ts` (task arguments, wrapper content with/without the Electron copy, skips, failure, removal, `repairRecorded` stale/noop/empty manifest).

## Observations, not fixed

- **The detached worker inherits the app's listening sockets.** While the worker lived, the CDP port (9334) stayed in LISTEN owned by the dead app pid, so a relaunch on that port failed until the worker exited (2 min). libuv spawns with handle inheritance on Windows. T3's server runs in a child process, so a normal restart is not blocked, but any listener opened by the main process is. Fix idea: start the worker through the scheduled task (`schtasks /Run`) instead of `spawn`.
- A dir holding both `T3 Code (Beta).exe` and `T3 Code (Nightly).exe` (cross-channel install into one dir, which NSIS does not clean because the appIds differ) is `broken` after an update (stale `_app.asar` hash mismatch) and `inspectInstall` picks the first exe alphabetically. Not a normal flow; the worker logs `broken` and stops.
- NSIS `/D=` needs real backslashes; forward slashes silently created `G:\rig-runt3patcherapp-s2` (removed). The probe now joins segments itself.
- NSIS installs register an uninstall key and shortcuts for the rig user. All removed after the test (key, 2 `.lnk`, installers in `dl\`, slot 2 restored from `base`, task deleted).
- PLAN.md says NSIS wipes the dir (U2). Confirmed only for a registered same-appId install; an unregistered dir is overwritten in place.

## Patch finds on the newer release (report only)

On both `0.1.11-nightly.20261118.4864` and `.4903`, one `t3p.core` patch fails with `no-match`: `/function [\w$]+\(([\w$]+)\)\{if\(\1\.allOptions&&\1\.isInSubmenu\)\{let\{allOptions:/` (command palette, `commandPaletteBus` chunk). The other 5 apply. Not fixed here.

## Remaining

- Real logon event (log off/on rig's user); only `schtasks /Run` was done.
- Live `--force-run` busy-retry path (unit tests only).
- Socket inheritance above.
- `t3p install` on FOX (WP-5D) now also registers the logon task `t3-patcher-repair`; `t3p uninstall` removes it.
