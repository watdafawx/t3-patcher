# T3 Patcher: agent and contributor guide

T3 Patcher is a Vencord/Spicetify-style mod loader for the **T3 Code** Electron desktop app (Windows first). It injects a runtime and a plugin system into the stock install without forking it. Read this file first, then the doc for the task at hand.

## Repo map

| Path | What it is |
|---|---|
| `packages/api` | `@t3p/api`: the public plugin API types (`T3Api` in `src/t3.ts`), manifest schema, permissions |
| `packages/shim` | the ~6 KB replacement `app.asar` (fail-open bootstrap) |
| `packages/installer` | `t3p` CLI: install, uninstall, status, doctor, repair, enable, grant, dev |
| `packages/main-runtime` | Electron main-process runtime: protocol wrap, plugin host, patch application, dev watcher |
| `packages/preload-runtime` | preload bridge (IPC to the renderer) |
| `packages/renderer-runtime` | runs in the page: plugin manager, `t3` API, UI slots and shared styles (`src/ui/`) |
| `packages/patch-engine` | pure library: plan and apply text patches to client chunks, Acorn-verified |
| `packages/rpc-client`, `timeline`, `contracts-vendor` | server RPC client, activity normalisation, vendored upstream contracts |
| `packages/plugin-build`, `create-t3p-plugin` | build preset and scaffolder for plugin authors |
| `plugins/*` | first-party plugins (cache-watch, keep-warm, provider-limits, provider-switcher, session-inspector, devtools, artwork, notes, media) and two samples (`_sample-hello`, `_demo-slots`) |
| `tools/compat` | compatibility checker: runs every capture and patch against an upstream release |
| `tools/rig` | scripts to run a patched app on a spare Windows machine with a debug port (optional) |
| `docs/` | all documentation; `docs/api.md` is generated |

## Set up

Needs Node 22+ and pnpm 9.

```sh
pnpm install
pnpm -r build
pnpm -r test
pnpm lint
pnpm typecheck
```

All four must exit 0 before you commit. `pnpm -r build` rewrites `packages/contracts-vendor/UPSTREAM.json`: revert that file unless you changed the vendored contracts.

## Install into a real T3 Code

```sh
node packages/installer/dist/cli.mjs install      # or the `t3p` bin once linked
t3p status
t3p uninstall                                      # restores the stock app exactly
```

Close T3 Code first. The shim keeps the original as `_app.asar`; the runtime lives in `~/.t3-patcher/runtime`. If a T3 update overwrites the shim, a repair worker plus a logon task put it back. See `docs/updating.md`.

Release artifacts: `pnpm build:exe` builds the single-file `dist-exe/t3p.exe` (Node SEA, no Node needed on the user's PC); `t3-patcher` is also publishable to npm. Both documented in `docs/release.md`. Never publish or tag without the maintainer.

## Write a plugin

A plugin is a folder with `plugin.json` plus a built ES module (`dist/renderer.js`). Full guide: `docs/plugin-authoring.md`. Quick path:

```sh
npx create-t3p-plugin my-plugin   # scaffold (inside this repo, run it from plugins/)
cd my-plugin && pnpm i && pnpm build
t3p dev .                         # link, enable, hot reload
```

Minimal entry:

```ts
import type { PluginModule } from "@t3p/api";

const plugin: PluginModule = {
  start(t3) {
    const reg = t3.ui.register({ slot: "statusBar", id: "hello", render(host) { host.textContent = "hello"; } });
    return () => reg.dispose();   // always clean up
  },
};
export default plugin;
```

Rules that matter:

- **Tiers.** Tier 1 uses stable surfaces (server RPC, files, `data-slot` DOM anchors, CSS variables). Tier 2 uses captured app internals (`t3.internals`). Tier 3 uses raw text patches. Prefer the lowest tier that works. See `docs/patching.md`.
- **Permissions** are declared in `plugin.json` and granted by the user (`t3p grant <id> <permission>`): `rpc`, `embed.youtube`, `fs.read`, `sqlite.read`, `log.tail`, `spawn`, `main`, `patches`. Ask for the minimum.
- **API namespaces** on `t3`: rpc, providers, threads, timeline, environment, cache, usage, ui, commands, keybinds, patches, internals, storage, settings, native, events. Reference: `docs/api.md` (generated, do not edit by hand; run `pnpm docs:api`).
- **UI slots**: sidebarSection, threadHeader, composerBanner, rightPanel, statusBar, settingsPage, timelineRowDecorator, contextMenuItem, threadDetails (extra section in the stock thread details popover; `t3.ui.threadDetails.hide([...labels])` hides stock rows).
- **Styling.** Use the shared `t3p-*` classes and the app's CSS variables only, never hard-coded colours. See `docs/ui-style.md`.
- **Hot reload**: with dev mode on (`t3p dev` writes a marker, or set `T3P_DEV=1`), saving files in a linked plugin reloads it; new plugins, enable/disable and removals are picked up live. Main-process plugin code cannot be unloaded in place, so restart the app for `main` entries. Changing the core renderer runtime reloads the page after `pnpm dev:sync`.

## Patch anything

When no API covers it, add a text patch to a client chunk (needs the `patches` permission):

```ts
t3.patches.register([{
  plugin: "my-plugin",
  find: "unique string found in exactly one chunk",
  replacement: { match: /(function \w+\(e\)\{)/, replace: "$1$self.onCall(e);" },
}]);
```

- `find` must match **exactly one** chunk (zero is `no-match`, several is `ambiguous`).
- `$self` expands to your plugin's handle (`window.__t3p_plugins[<id>]`).
- Output is parsed with Acorn; a patch that breaks syntax is rolled back and reported, never applied. A failing patch never takes the app down.
- Write finds against stable anchors (string literals, property names), not minified single-letter names.
- Check against real releases with the compat checker:

```sh
pnpm --filter @t3p/compat compat -- --version v0.1.10    # a release tag
pnpm --filter @t3p/compat compat -- --version nightly
pnpm --filter @t3p/compat compat -- --version <path-to-extracted-app> --update-baseline   # only when the diff is expected
```

Full mechanics (engine, caching, protocol interception, safety): `docs/patching.md`.

## Conventions

- TypeScript, ESM, strict. Tests use Vitest next to the code. Add a test for every behaviour change.
- Small commits, conventional prefixes (`feat(ui):`, `fix(dev):`). Do not push to main without green build, test and lint.
- Shell heredocs and some scripting languages drop backslashes: write files containing regexes with an editor tool, not a heredoc.
- Never edit files inside an installed T3 Code. Everything goes through the shim and runtime, and `t3p uninstall` must always restore the stock app.
- Treat `.upstream/` (a local checkout of the T3 Code source, gitignored) as read-only reference.

## More docs

`README.md` (install quick start, CLI reference), `docs/release.md` (tagging a release, building `t3p.exe`, npm publish), `docs/plugin-authoring.md`, `docs/patching.md`, `docs/api.md`, `docs/ui-style.md`, `docs/updating.md`, `docs/security.md`. `PLAN.md` and `docs/wp-*-notes.md` are historical design notes.
