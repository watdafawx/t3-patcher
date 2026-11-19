# Updating and survival

This document explains how T3 Patcher survives upstream application updates, how the background repair worker and scheduled tasks operate, how to interpret `t3p status`, manual repair procedures, uninstallation rollback, and the upstream compatibility checker.

## How updates affect the patcher

T3 Code uses `electron-updater` with the Nullsoft Scriptable Install System (NSIS) on Windows. During an application update (both automatic in-app updates and manual installer reruns), NSIS replaces the entire application directory (`%LOCALAPPDATA%\Programs\T3 Code`):

- The replacement `resources/app.asar` (the shim) is overwritten with the new stock `app.asar`.
- The renamed original `resources/_app.asar` is deleted.
- The directory junction `resources/_app.asar.unpacked` is deleted.

To survive this update process, T3 Patcher separates runtime code and state from the application directory:

- The patcher runtime, plugin bundles, configuration (`state.json`), and install records (`manifest.json`) live in `<T3P_HOME>/.t3-patcher/` (defaulting to `%USERPROFILE%/.t3-patcher/`).
- Because `<T3P_HOME>/.t3-patcher/` is outside the installation directory, it remains untouched when NSIS runs.

## Update survival mechanism

T3 Patcher uses two automated triggers to re-apply the patcher layout after an update:

```
[In-App Update Trigger]
  autoUpdater 'before-quit-for-update'
           |
           v
  Spawn detached repair-worker.cjs (from ~/.t3-patcher/runtime/)
           |
           v
  Wait for T3 Code process to exit
           |
           v
  Wait for NSIS to write new stock app.asar
           |
           v
  Execute `t3p repair --if-stale`

[External / Manual Installer Trigger]
  Windows Logon Scheduled Task
           |
           v
  Execute `t3p repair --if-stale` at user login
```

### 1. The background repair worker

When T3 Code's auto-updater prepares to restart the application, the patcher's main runtime intercepts the `autoUpdater.on("before-quit-for-update")` event:

1. **Detached process spawn**:
   - The runtime spawns `repair-worker.cjs` as an independent, detached process.
   - The worker is launched from `<T3P_HOME>/.t3-patcher/runtime/repair-worker.cjs`, ensuring it is never locked or deleted when NSIS clears the install directory.

2. **Interpreter selection**:
   - The hook first searches for a system `node.exe` on `PATH` outside the T3 Code install directory.
   - If no external Node.js binary is found, it uses `<T3P_HOME>/.t3-patcher/bin/t3p-node.exe`, a standalone copy of the Electron executable configured with `ELECTRON_RUN_AS_NODE=1` and `ELECTRON_NO_ASAR=1`.
   - The worker explicitly sets `process.noAsar = true` to prevent Electron's asar virtual filesystem from intercepting file read operations on `app.asar`.

3. **Execution flow**:
   - **Wait for exit**: The worker waits for the old application process (by PID) to terminate.
   - **Wait for NSIS**: The worker polls until `t3p status` reports `stale` and the newly written `resources/app.asar` file size remains stable for 10 seconds.
   - **Re-apply layout**: The worker invokes `repair --if-stale` using the bundled installer. If the newly launched app temporarily holds file locks, the worker retries with backoff.
   - **Timeout guard**: If the application remains `patched` for 2 minutes (indicating the update was cancelled by the user), the worker exits cleanly without making changes.
   - All worker activity is logged to `<T3P_HOME>/.t3-patcher/logs/repair.log`.

### 2. Windows logon task

For manual updates where the user runs a downloaded NSIS installer directly (bypassing `autoUpdater`), a Windows scheduled task configured at installation runs:

```sh
t3p repair --if-stale
```

This task runs at user logon, detects if an update wiped the shim, and restores the patcher layout before the user starts working.

## Layout states (`t3p status`)

The command `t3p status` evaluates the installation layout against `<T3P_HOME>/.t3-patcher/manifest.json`. It reports one of five states:

| Layout state | Description | Manifest | Exit code |
|---|---|---|---|
| `patched` | The installation is fully patched. `resources/app.asar` matches the recorded replacement hash, `resources/_app.asar` matches the recorded original hash, and the unpacked junction is valid. | Present | 0 |
| `unpatched` | The installation is stock T3 Code. `resources/app.asar` is the original stock archive, and no `_app.asar` or patcher files exist. | Absent | 0 |
| `stale` | An upstream update occurred. A new stock `resources/app.asar` is present, `resources/_app.asar` was removed by the updater, and a patcher manifest entry still exists. | Present | 1 |
| `broken` | The installation directory is in an inconsistent state (for example, `app.asar` missing, hash mismatches, or invalid junction symlinks). | Present/Absent | 1 |
| `unknown` | No T3 Code installation could be located at the target or default path. | Any | 1 |

Example `t3p status` output:

```
install:  C:\Users\User\AppData\Local\Programs\T3 Code
exe:      C:\Users\User\AppData\Local\Programs\T3 Code\T3 Code.exe
version:  0.1.10 (stable)
layout:   patched
manifest: present
  - manifest entry found (appVersion 0.1.10)
  - replacement asar hash matches the manifest
  - original asar hash matches the manifest
  - junction resolves to resources/app.asar.unpacked
```

## Manual repair

If an automatic repair did not trigger or failed to complete, you can repair the layout manually:

```sh
t3p repair
```

Flags:
- `--if-stale`: Only proceeds if `t3p status` reports `stale`. If the installation is already `patched` or `unpatched`, it exits cleanly as a no-op.
- `--path DIR`: Target a specific T3 Code installation folder.
- `--force`: Bypass version checks if updating to an unverified release.
- `--worker-node auto|copy|skip`: Update the standalone repair interpreter in `<T3P_HOME>/.t3-patcher/bin/`.

When repairing a `stale` install, `t3p repair` automatically allows unsupported versions by default (`allowUnsupportedVersion: true`), under the assumption that the user intentionally updated upstream. It still validates that Electron fuses remain safe.

## Rollback via uninstall

To completely remove T3 Patcher and return to stock T3 Code:

```sh
t3p uninstall
```

The uninstaller executes an exact restoration:

1. Validates that `resources/app.asar` matches the recorded replacement hash in `manifest.json`.
2. Deletes the replacement `app.asar`.
3. Safely removes the `resources/_app.asar.unpacked` junction without deleting any files in `resources/app.asar.unpacked`.
4. Renames `resources/_app.asar` back to `resources/app.asar`.
5. Removes the installation entry from `manifest.json`.

To remove the runtime code directory and standalone binaries as well:

```sh
t3p uninstall --purge
```

`--purge` removes `<T3P_HOME>/.t3-patcher/runtime/` and `<T3P_HOME>/.t3-patcher/bin/`. User data, including `<T3P_HOME>/.t3-patcher/plugins/`, `state.json`, and logs, is preserved.

## Upstream compatibility checker (`tools/compat`)

The compatibility checker (`tools/compat`) is a standalone tool designed to evaluate upstream T3 Code releases before updating.

### Purpose

When upstream publishes a new release tag or nightly build:
- Minified JavaScript chunk names and variable hashes change.
- Server Effect RPC method contracts may change.
- DOM `data-slot` attributes may be added, renamed, or moved.

The compat checker validates that T3 Patcher's patches and plugins will function on the new release without breaking startup.

### Operations (per PLAN.md)

1. **Extraction**: Downloads or unpacks the target upstream release and extracts `resources/server.asar/apps/server/dist/client/`.
2. **Patch dry run**: Executes `planPatches` with all registered first-party and capture patches against the new chunk set, confirming that every patch's `find` pattern still matches **exactly one** chunk.
3. **RPC contract diff**: Compares the new release's RPC methods and stream definitions against `@t3p/contracts-vendor`.
4. **Slot anchor verification**: Scans extracted chunks for the presence of standard UI `data-slot` anchors (e.g. `sidebar-content`, `sidebar-inset`, `menu-popup`).
5. **Exit status**: Outputs a human-readable report and exits non-zero if any patch `find` fails to match or becomes ambiguous.

```sh
# Check a release (latest, nightly, a tag, or a local .asar / client dir)
pnpm --filter @t3p/compat compat -- --version v0.1.10
pnpm --filter @t3p/compat compat -- --version nightly --json
```

Exit 0 means every first-party patch `find` still matches exactly one chunk. Exit 1 lists the broken finds, plus added or removed RPC methods and `data-slot` anchors. It needs 7-Zip to read the installer. See [tools/compat/README.md](../tools/compat/README.md) for all flags.
