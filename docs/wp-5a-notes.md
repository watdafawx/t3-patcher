# WP-5A notes: compat checker

`tools/compat` (`@t3p/compat`) compares an upstream T3 Code release against the
supported one (`docs/upstream-version.md`, currently `v0.1.10`). It answers three
questions and exits non-zero when the answer matters for us:

1. **Patch finds**: every first-party patch `find` must still match exactly one
   chunk of the shipped client. Zero means the patched code moved, more than one
   means the anchor is no longer unique; either way the runtime would disable the
   patch.
2. **RPC methods**: which wire methods the release no longer has (exact check)
   and which it added (heuristic check), plus which of them first-party code
   names.
3. **`data-slot` anchors**: which anchors the release no longer renders and
   which of those our slot engine selects on.

Accepted on 2026-11-19: **passes on `v0.1.10`**, and on the newest nightly
(`v0.1.11-nightly.20261119.4918`) it runs to completion and reports one broken
patch find and 14 new methods instead of crashing.

## Usage

```powershell
pnpm --filter @t3p/compat build
pnpm --filter @t3p/compat compat -- --version v0.1.10
pnpm --filter @t3p/compat compat -- --version latest
pnpm --filter @t3p/compat compat -- --version nightly
pnpm --filter @t3p/compat compat -- --version C:\x\server.asar
pnpm --filter @t3p/compat compat -- --version C:\x\client        # extracted client dir
pnpm --filter @t3p/compat compat -- --version v0.1.11-nightly.20261118.4903 --json
```

`--` after `compat` is pnpm's separator; the CLI also takes a bare argument as
`--version`.

### Flags

| Flag | Meaning |
|---|---|
| `--version <tag\|latest\|nightly\|path>` | release tag to fetch, or a path to a `server.asar`/`app.asar` or an extracted client dir (the one holding `index.html`) |
| `--asar <path>` / `--server-asar <path>` | check an existing archive, no fetching |
| `--dir <path>` | check an extracted client dir |
| `--installer <path>` | use a local Windows NSIS installer instead of downloading one |
| `--from-git` | with a tag: `git clone --depth 1 --branch <tag>` instead of the installer. RPC list comes from `packages/contracts/src`; **patch finds are skipped** (a source tree holds no built client) |
| `--cache <dir>` | download/extract cache (default `tools/compat/.cache`, gitignored) |
| `--no-cache` | throwaway temp dir |
| `--keep-installer` | keep the downloaded installer (removed after extraction by default) |
| `--seven-zip <path>` | 7-Zip binary (else `T3P_7Z`, `PATH`, `Program Files`) |
| `--clean` | delete the cache and exit |
| `--patch-file <path>` | extra patch finds (repeatable): JSON array of `{name?, plugin?, find \| findRegex:{source,flags?}}` |
| `--no-plugins` | skip `plugins/*/patches.json` discovery |
| `--no-patches` | skip the patch checks (API-surface-only run) |
| `--rpc-baseline <path>` / `--slots-baseline <path>` | override the committed baselines |
| `--update-baseline` | record the target as the supported version (see below) |
| `--repo <path>` | repository root (default: three levels above the built CLI) |
| `--json` | machine-readable report |
| `--quiet` | only the last report line |

Exit codes: `0` compatible, `1` breakage, `2` usage or input error.

## Where the client comes from

Windows users run the NSIS installer, so that is the artifact the checker reads:

1. The asset list is parsed from `https://github.com/pingdotgg/t3code/releases/expanded_assets/<tag>`
   (the HTML asset list). `api.github.com` is unreachable from FOX, `github.com`
   and `release-assets.githubusercontent.com` are not.
2. `latest` resolves through the `releases/latest` redirect; `nightly` picks the
   newest `v*-nightly.*` tag from `releases.atom` (newer than what `git ls-remote`
   had: the feed showed `v0.1.11-nightly.20261119.4918`).
3. `T3-Code-<version>-x64.exe` is downloaded (about 380 MB) into the cache.
4. 7-Zip reads the NSIS container without running it: `7z x` gives
   `$PLUGINSDIR/app-64.7z`, then `7z e ... resources/server.asar` gives the
   256 MB `server.asar`.
5. `server.asar` is cached as `.cache/<tag>/server.asar`; the installer is
   deleted unless `--keep-installer` is passed. A re-run of the same tag is
   offline and instant.

There is no portable Windows zip: `T3-Code-<version>-x64.zip` is the **macOS**
zip (232 MB, `.app` tree). It contains only `Contents/Resources/app.asar` and no
`server.asar`, so it cannot be used as a shortcut. macOS/Linux artifacts are out
of scope (`PLAN.md` section 3).

The client is `apps/server/dist/client` inside `server.asar`: `index.html` plus
~985 JS chunks (38.2 MB) on 0.1.10, 1003 chunks (46.7 MB) on the nightly. Chunks
are read straight out of the archive; nothing is written to disk except
`server.asar`.

### Reading the asar

`@electron/asar` 4.3.2 (the version `@t3p/installer` uses) **cannot read the
archives Electron 44 ships**: they carry an extra preamble word (a three-field
pickle, header JSON at byte 16) and every `extractFile` call fails with
"was not found in this archive". `src/asar.ts` is a small reader that handles
both the old layout (JSON at byte 8, what 4x-era writers produce) and the new
one, plus `unpacked: true` entries through `<asar>.unpacked/`. This is also why
`packages/installer` would need the same change if it ever has to read a stock
archive (it only reads `package.json` from an asar it wrote itself, so it does
not hit the bug today).

## What is checked

### Patch finds

`src/patches.ts` scans each chunk and reports `ok`, `no-match` (0 chunks) or
`ambiguous` (>1 chunk) per find, with the chunk list, the find text and where it
came from.

Two sources:

- **Core captures**: imported from `@t3p/main-runtime/patch-catalog`, a new ESM
  entry (`dist/patch-catalog.mjs`) built from
  `packages/main-runtime/src/patches/captures.ts`. The checker therefore runs the
  exact `find`s the runtime ships; there is no copy to drift.
- **Plugin patches**: `plugins/<id>/patches.json` if a plugin ever ships one, plus
  `--patch-file`. All five first-party plugins register no patches today, so the
  core captures are the whole list (7 finds over 5 captures: atomRegistry, router,
  shortcutDispatcher, settingsNav ×3, commandPalette).
- `builtinPatches()` (the `T3P_TEST_PATCH` string) is deliberately not included:
  it is a rig-only test patch, not a product patch.

### RPC methods

Baseline: `baseline/rpc-methods.json`, 221 methods (30 streams), taken from the
WP-0D live-socket capture (`docs/spikes/wp-0d/fixtures/methods.json`, which
`packages/contracts-vendor` cross-checks on every build) with the tag and commit
from `docs/upstream-version.md`.

Evidence: the shipped server bundle, `apps/server/dist/**/*.mjs` (37 files,
19.8 MB on 0.1.10), read from the archive.

- **Removed** (exact, gates the exit code): a baseline method must still occur as
  a quoted string. Wire names survive minification verbatim (the server keeps
  `x_METHODS` maps), so this has no false positives, including nested names such
  as `provider.auth.cancel` and hyphenated ones such as
  `provider.chatgpt.import-profile`.
- **Added** (heuristic): entries of the form `ident: "namespace.method"` that sit
  in a table which already holds baseline methods (clustered by 120 characters of
  proximity, at least 75% of the table in the baseline, 3+ entries). Tables of
  keyboard command ids (`sidebar.toggle`, `terminal.new`, …) and event names are
  filtered out this way. The cost: a brand-new namespace is not reported until it
  appears next to a known method. On the nightly it reported the new
  `issues.*`/`issueTrackers.*` methods, which is the intended behaviour.
- **Used by us**: `usedMethods()` scans `packages/*/src` and `plugins/*/src`
  (tests excluded) for string literals that are in the baseline. A removal of one
  of those fails the run. Today: 12 methods.

### `data-slot`

Baseline: `baseline/data-slots.json`, 203 anchors extracted from the 0.1.10
client (the plan's "about 293" counted occurrences, not distinct values).

`extractSlots()` reads both shapes the built client uses — `"data-slot":"x"` in a
props object and `data-slot="x"` in an HTML string, in any quote style — from the
JS chunks and `index.html`. `requiredSlots()` collects the values our own code
selects on (`[data-slot="sidebar-content"]` and friends: 7 today). A removed
anchor that we select on fails the run; all other additions/removals are
reported.

### Baselines and `--update-baseline`

`--update-baseline` rewrites both files and stamps them with the target tag and
commit. It is deliberately conservative for RPC: it writes a full list only from
the contracts source (`--from-git`) or from a bundle diff with no removals
(entries = old baseline − removed + added); otherwise it refuses, because a
bundle-only "added" list is a heuristic. Slot baselines are written whenever the
target produced anchors.

Bump procedure for a new supported version (`docs/upstream-version.md`): fetch it,
`--update-baseline`, review the diff, then rebuild `packages/contracts-vendor`
and fix whatever the report lists.

## Results on 2026-11-19

`v0.1.10` — pass:

```
Patches: 7 finds: 7 ok, 0 broken
RPC methods: removed none, added none, 12 used all present
data-slots: removed none, added none, 7 used all present
Result: PASS
```

`v0.1.11-nightly.20261119.4918` — fail, one real break:

```
BROKEN  commandPalette  0 chunks
         /function [\w$]+\(([\w$]+)\)\{if\(\1\.allOptions&&\1\.isInSubmenu\)\{let\{allOptions:/
RPC methods: removed none, added 14 (issueTrackers.*, issues.*)
data-slots: removed none, added none
Result: FAIL (1 broken patch find)
```

The palette function still exists; its optional second parameter changed from a
default object (`t={}`) to a module constant (`t=i`), so the find no longer
matches. That is exactly the kind of refactor the checker is for: the
`commandPalette` capture would have been disabled and the DOM fallback used.

## Limits / known gaps

- **7-Zip is required** for the installer path. Without it, pass `--server-asar`
  (if someone extracted it) or `--from-git`. Nothing in the tool executes the
  installer.
- **Download size**: ~380 MB per new version, `server.asar` ~256 MB cached. Use
  `--clean` when done; the cache is gitignored. `--clean` is best effort: it
  clears the read-only bits a `git clone` leaves behind and, if another process
  (an antivirus scan of the 256 MB archive, typically) still holds a file, it
  names the paths it could not delete instead of failing.
- **macOS/Linux** artifacts are not read. The mac zip has no `server.asar`.
- **Method kinds are not diffed** (unary vs stream). The baseline records them,
  but the bundle does not make the flag readable without a lot of guessing.
  Payload schemas are not compared at all — that is `contracts-vendor`'s job.
- **Added methods are a heuristic** (above). Removals, which gate the exit code,
  are exact.
- **`data-slot` values computed at runtime** (passed through variables) are
  invisible to a text scan. All 203 baseline values are literals in the chunks.
- **Source mode** (`--from-git`) reports `data-slot` differences as
  informational: source-level literals differ from the built client (199 vs 203,
  because some values arrive through props/constants), so they are shown but
  cannot fail the run.
- **Our own source scan** looks for literals in `packages/*/src` and
  `plugins/*/src` only; a method name assembled at runtime would be missed.
- Unit tests never touch the network: the asar reader, zip/7z guards, scanners,
  report and the `runCompat` orchestration run against generated fixtures
  (`tools/compat/test/fixtures/*.txt|jsonl`).
