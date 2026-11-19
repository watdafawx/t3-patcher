# devtools

Developer tools for [T3 Patcher](../../README.md): a read-only patch tester, an RPC console,
slot outlines and a plugin log viewer. Plugin id `devtools`, tier 1, `t3pApi` 1.

> **This is a developer tool, not a normal plugin.** The RPC console can send any server
> method with the renderer's full-scope bearer token (orchestration, terminal, access), and
> the log viewer reads `main.log`. Leave it disabled unless you are debugging.

**Disabled by default.** A plugin folder alone changes nothing: `~/.t3-patcher/state.json`
must enable it and grant what it declares. Nothing in this repo installs or enables it.

## Install and grants

```sh
pnpm --filter @t3p/devtools build
t3p dev plugins/devtools                 # link + enable it (dev mode, hot reload)
t3p grant devtools rpc
t3p grant devtools log.tail --root "~/.t3-patcher/logs"
```

`~` is the patcher home (`T3P_HOME` when set). Restart T3 Code after the first `t3p dev`;
later builds reload by themselves. The Plugins settings page can also toggle the plugin, but
it only grants `rpc` on enable, so the `log.tail` grant needs the CLI. Without it the Logs
tab shows the exact `t3p grant` line instead of lines.

## What the right-panel tabs do

### Patches (patch tester)

- Enter a `find` (a literal string, or `/regex/flags`) and one or more `match`/`replace`
  pairs, then **Run test**. It reports:
  - how many loaded chunks the find matches, and which ones (the find must match exactly
    one chunk; zero is `no match`, more than one is `ambiguous`);
  - every replacement's matched text and the replaced snippet with ~80 chars of context;
  - whether the patched text parses as an ES module.
- Rules copy `packages/patch-engine`: a string match replaces the first occurrence only, a
  regex keeps its own flags, `$1`/`$&`/`$$` behave like `String.prototype.replace`, and
  `$self` expands to `window.__t3p_plugins["devtools"]`. The parse check uses **acorn**
  (bundled, the same parser as the patch engine), so no app code is ever evaluated.
- **It never applies a patch.** Nothing is registered with `t3.patches`, no patch cache is
  touched, and the produced text is dropped after the report. The patch engine itself still
  rolls back a patch whose replacements or parse check fail.
- The public API has no "read a chunk" call, so the tester lists the module scripts the page
  loaded (`script[src]`, `link[rel=modulepreload]` and resource timings) and fetches them over
  the app origin (`t3code://app/assets/...`) with the page's own `fetch`. Consequence: chunks
  of routes that were never visited are not visible, and the text is the **served** text
  (already patched, where a patch applies), not the pristine file.

### RPC

- Method input is free text (the runtime has no method list to enumerate) with the typed
  `@t3p/rpc-client` methods as suggestions; a JSON payload editor (empty = `{}`); **Call** via
  `t3.rpc.call` with timing, result or error; and **Subscribe** via `t3.rpc.subscribe` with a
  live log capped at 500 items, a Stop button and the stream error/done state.
- Visible warning: every call runs with the full-scope bearer token; this is not a sandbox.
- A method whose name contains `dispatch`, `delete`, `remove`, `terminal` or `auth`
  (case-insensitive) additionally needs a second, explicit **Run anyway (full scope)** click.
- The socket state comes from `t3.rpc.state` / `onState`.

### Slots

- One toggle injects a single `<style>` element and sets `data-t3p-devtools-outlines="1"` on
  `<html>`: every `[data-t3p-root]` gets a solid outline and a CSS `attr()` label
  (`plugin · slot`); every slot anchor from `docs/wp-3d-notes.md` gets a dashed outline.
- Turning it off, disabling the plugin or stopping it removes the style element and the
  attribute. Colours follow the app's CSS variables (`--primary`, `--destructive`, ...) and
  are refreshed through `t3.ui.themeVars()` / `onThemeChange`.
- Counts per anchor and the mounted-root list refresh every 2 s while the tab is open.
- The command **Devtools: toggle slot outlines** flips the same state.

### Logs

- `t3.events` carries lifecycle events only and `t3.log` writes to the main log file, so the
  only public read path is `t3.native.logTail`. The manifest therefore declares
  `{"log.tail": {"roots": ["~/.t3-patcher/logs"]}}` — the smallest root that holds
  `main.log` — and this tab tails it every 2 s with a byte cursor.
- It keeps plugin-tagged lines only: `renderer:<id>` (a plugin's `t3.log`) and `plugin:<id>`
  (a main entry's logger). Filter by plugin, Pause/Resume, Refresh (also the command
  **Devtools: refresh plugin logs**) and Clear. The buffer is capped at the newest 500 lines.
- The renderer never receives log lines directly; this is a file read, attributed to this
  plugin by the `log.tail` grant (`docs/security.md` section 2).

## Permissions and tier

| | |
|---|---|
| `rpc` | `t3.rpc.call`, `subscribe`, `state` for the RPC console |
| `{"log.tail": {"roots": ["~/.t3-patcher/logs"]}}` | the plugin log viewer |

Tier **1** (stable): no `t3.patches`, no `t3.internals`, no `main` entry. The patch tester
reads chunks the same way any renderer code could; it only needs the DOM, `fetch` and the
shared RPC socket. The manifest declares no `main`/`patches`/`spawn`, so the runtime may
enable it from the Plugins page (with the `rpc` grant); the log grant still comes from the CLI.

## Build

```sh
pnpm --filter @t3p/devtools build   # t3p-plugin-build -> dist/renderer.js
pnpm --filter @t3p/devtools test    # pure logic + jsdom UI tests
```

`acorn` is bundled into the single ES module output, like every dependency of a renderer
plugin.
