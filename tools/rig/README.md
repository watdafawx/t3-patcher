# tools/rig: isolated stock T3 Code on rig

Test rig for patch spikes. Runs a **stock T3 Code 0.1.10** on rig's desktop in its own folder with a throwaway home.
Never touches the T3 Code on FOX or any T3 install on rig. Everything runs from FOX over `ssh rig`.

## Layout on rig (`G:\rig-run\t3patcher\`)

| Path | What |
|---|---|
| `dl\T3-Code-0.1.10-x64.exe` | official NSIS installer, sha256-checked. Never executed. |
| `base\` | pristine extracted app (7z of installer, then inner `app-64.7z`). Never launched. |
| `app-s<N>\` | slot copy of base. Spikes edit `app-s<N>\resources\`. |
| `home-s<N>\` | `T3CODE_HOME` for the slot (throwaway) |
| `appdata-s<N>\` | `APPDATA` override: Electron `userData` and single-instance lock are per slot |
| `p-s<N>` | `T3P_HOME` of a patched slot: `p-s<N>.t3-patcher` holds runtime, plugins, state, logs, cache, bin. Never the rig user's real `~.t3-patcher`. |
| `tools-s<N>` | installer bundle (`t3p.cjs`) + runtime files that `patch-slot.ps1` copies from FOX |
| `_launch-s<N>.cmd/.log` | generated launcher and app stdout/stderr |

## Ports (rig, localhost only)

| Slot | CDP (`--remote-debugging-port`) | T3 server (`T3CODE_PORT`) | scheduled task |
|---|---|---|---|
| 1 | 9333 | 3873 | `t3patcher-s1` |
| 2 | 9334 | 3874 | `t3patcher-s2` |
| N | 9333+N-1 | 3873+N-1 | `t3patcher-sN` |

CDP is bound with `--remote-debugging-address=127.0.0.1`; it is never exposed on the LAN.

## Commands (run on FOX)

```
pwsh -NoProfile -File tools/rig/install.ps1 [-Slot 1,2,3] [-Force] [-Reinstall] [-Version 0.1.10]   # idempotent
pwsh -NoProfile -File tools/rig/patch-slot.ps1 -Slot 1 [-Plugins] [-NoPlugins] [-RuntimeOnly] [-Unpatch]   # real t3p install/uninstall, run ON rig
pwsh -NoProfile -File tools/rig/launch.ps1  -Slot 1 [-Env 'A=1;B=2'] [-AppArgs '--x']    # starts on rig's desktop, waits for CDP, prints PIDs
node tools/rig/cdp-eval.mjs [--slot N] "document.title"
pwsh -NoProfile -File tools/rig/stop.ps1    -Slot 1      # or -All
pwsh -NoProfile -File tools/rig/reset.ps1   -Slot 1 [-Restore]   # stop + wipe home/appdata/p-s<N>/tools-s<N>; -Restore re-copies app-s<N> from base
```

Env set by `launch.ps1`: `T3CODE_HOME`, `APPDATA`, `T3CODE_PORT`, `T3CODE_DISABLE_AUTO_UPDATE=1`, `T3CODE_NO_BROWSER=1`, `T3P_HOME=G:
ig-run	3patcherp-s<N>` (harmless on a stock slot).

`-Env` takes `NAME=value` pairs split on `;`. Under `pwsh -File`, `-Env 'A=1','B=2'` arrives as ONE string, so it used to set `A` to `1,B=2`.

## Patching a slot (`patch-slot.ps1`)

Build on FOX first: `pnpm --filter t3-patcher --filter @t3p/main-runtime... build`. Then:

1. It stops the slot.
2. It copies `packages/installer/dist/standalone/t3p.cjs` and `packages/main-runtime/dist/*` (no maps) to `tools-s<N>` as plain files over `Q:`. No junctions over the share.
3. It runs `node tools-s<N>	3p.cjs install --path G:ig-run	3patcherpp-s<N> --runtime tools-s<N>untime --json` **on rig**, with `T3P_HOME=p-s<N>`.
ig-run	3patcherapp-s<N> --runtime tools-s<N>
untime --json` **on rig**, with `T3P_HOME=p-s<N>`.
4. It prints `EXIT`, `ASAR <sha256>` and `ORIG <sha256>` (the `_app.asar`).

- `-Plugins`: copies `packages/main-runtime/test-fixtures/plugins` + `state.json` (pre-granted) into `p-s<N>.t3-patcher`, plus `p-s<N>sread-roothello.txt` and `p-s<N>outside.txt` for the fs.read checks.
- `-NoPlugins` removes them.
- `-RuntimeOnly` only refreshes `p-s<N>.t3-patcher
untime` (fast loop).
- `-Unpatch` runs `t3p uninstall --purge`. The restored `app.asar` must hash to the stock `121df7c6...b113`.

To run other `t3p` commands on rig, set `T3P_HOME` in the same rig shell (the rig MCP PowerShell tool, or a script file). Quoting `$env:` through `ssh rig "..."` from bash drops it silently, and `t3p` then writes to the rig user's real home.

## Safety

- `stop.ps1` kills by **executable path** (under `G:\rig-run\t3patcher\app-s<N>\`) plus that slot's launcher `cmd.exe`. Never by name. Any other T3 Code on rig is untouched.
- `reset.ps1` refuses to delete anything outside `G:\rig-run\t3patcher\`.
- Why extraction and not the installer: the NSIS installer would write to `%LOCALAPPDATA%\Programs` and the uninstall registry key, i.e. could clobber a real T3 Code on rig. Extraction keeps the folder self-contained.
- Windows open on rig only (scheduled task `/IT`, same pattern as `X:\Dev\tools\run-on-rig.ps1`).

## Update-survival probe (WP-5B)

`probes/wp5b-updater/` is a rig-only plugin (grant `main` in `state.json`) with `t3p:plugin:wp5b-updater:update {installerParts, dirParts}`: it spawns an NSIS installer with `--updated /S /D=<dir>` and emits `before-quit-for-update` like electron-updater. Pass paths as segment arrays (NSIS needs backslashes). For a real wipe, install the slot from an NSIS installer (`/S /D=<slot dir>`), set `T3P_RIG_EXE='T3 Code (Nightly).exe'` for nightlies and use `patch-slot.ps1 -Force` for unsupported versions. See `docs/wp-5b-notes.md`.

## cdp-eval.mjs

`node tools/rig/cdp-eval.mjs [--slot N | --port P] [--list] [--target URLPREFIX] "<js>"`

- Picks the `page` target whose URL starts with `t3code://`, `Runtime.evaluate` with `awaitPromise` + `returnByValue`, prints the value as JSON.
- Exit 0 ok, 1 JS exception, 2 connect/usage error.
- **Transport = ssh tunnel (default).** It spawns `ssh -N -L 127.0.0.1:<free port>:127.0.0.1:<cdp port> rig`, waits for `/json/version`, and kills the ssh child in a `finally` plus `exit`/signal handlers. One tunnel per invocation, nothing left behind. (Node is installed on rig now, for `patch-slot.ps1`; `--direct` works there too.)
- `--direct [--host H]` skips the tunnel (for running on rig, or your own tunnel).

## Notes

- `\Rig\g\...` as a UNC path from pwsh on FOX resolved to a **local** `C:\Rig\g\...` during this work. The scripts use the mapped `Q:` drive (`Q:` = `\Rig\g`) for file copies instead.
- Disk: base ~0.85 GB + 0.85 GB per slot + 0.39 GB installer.

## perf/: background performance measurements (WP-13C)

Measures what a full-app background costs the app on a slot, over CDP. Results and method: `docs/artwork-perf.md`.

```sh
pwsh -NoProfile -File tools/rig/perf/maximize.ps1 -Slot 2          # maximize the slot window (4K, like a real desktop)
node tools/rig/perf/bg-perf.mjs --slot 2 --set baseline             # off + every preset with its defaults
node tools/rig/perf/bg-perf.mjs --slot 2 --set tiers --no-trace     # every preset at every quality tier
node tools/rig/perf/bg-perf.mjs --slot 2 --set ab --only ag,ag-still --repeat 2 --out res.json
node tools/rig/perf/layers.mjs --slot 2 --set '{"oceanOn":true,"bgKind":"drift"}'   # big composited layers and why (run from bash)
```

- `cdp.mjs`: ssh tunnel + minimal CDP client (`attach`, `evaluate`).
- `probe.js`: injected into the page. Records rAF gaps, long animation frames, Event Timing, key delay and key-to-frame time, and a fake streamed chat column (`#t3p-perf-stream`, a token every 30 ms) with a textarea to type into. It swallows window `blur` so the background keeps running while rig is not focused.
- `bg-perf.mjs`: per scenario: reset, apply settings via `__t3p.manager.setSetting`, settle, LayerTree snapshot, an idle and a work window (typing, wheel scrolling, streaming) without tracing, then the same with a trace (`--no-trace` skips it). Reports frame times, dropped frames, GPU and renderer process CPU (`SystemInfo.getProcessInfo`), busy ms per thread from the trace, layer count and memory.
- `scenarios.mjs`: the scenario sets. Add one by giving settings and optional `setup` JS.
- Rig is shared (Minecraft, Docker, other slots): compare rows of one run, use `--repeat`, and treat absolute numbers as rig-specific.
- A stored Custom HTML/CSS background takes over every preset; the driver warns when one is active.
