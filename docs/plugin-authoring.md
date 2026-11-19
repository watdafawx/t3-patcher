# Plugin authoring

A T3 Patcher plugin is a folder with a `plugin.json` manifest and a prebuilt renderer
entry (an ES module). The plugin runs inside the T3 Code renderer and gets a frozen,
per-plugin `t3` object with the API in [`packages/api/src/t3.ts`](../packages/api/src/t3.ts).

## Three commands

```sh
npx create-t3p-plugin my-plugin     # 1. scaffold
cd my-plugin && pnpm i && pnpm build # 2. build -> dist/renderer.js
t3p dev .                            # 3. link + enable + hot reload
```

Restart T3 Code once after the first `t3p dev`. After that, every `pnpm build` reloads
the plugin by itself (the WP-3A dev watcher watches the linked folder).

`npx create-t3p-plugin` takes `--id`, `--name` and `--tier`:

```sh
create-t3p-plugin my-plugin --id com.example.my-plugin --name "My plugin" --tier 1
```

The folder must be new or empty; nothing is ever overwritten. Options are validated
before a single file is written.

> The packages are not published yet. Run from inside this repo's pnpm workspace (for example
> from `plugins/`), the scaffold writes `"workspace:*"` for `@t3p/api` and
> `@t3p/plugin-build`, so pnpm links them. Anywhere else it writes the placeholder `"^0.0.0"`;
> install those packages from a registry (or link them) first.

### What the scaffold writes

| File | Purpose |
|---|---|
| `plugin.json` | Manifest (id, name, version, tier, permissions, `t3Versions`, `renderer`) |
| `src/index.ts` | TypeScript entry: `export default { start(t3), stop() }` |
| `tsconfig.json` | Strict, `moduleResolution: "bundler"`, DOM libs |
| `package.json` | `build` = `t3p-plugin-build`, `dev` = `t3p-plugin-build --watch`, `typecheck` |
| `README.md` | Short guide for the plugin |
| `.gitignore` | `node_modules/`, `dist/` |

The hello-world entry registers one setting (`greeting`) and writes a line to the
patcher log:

```ts
import type { PluginModule, SettingSchema, T3Api } from "@t3p/api";

const settings: SettingSchema[] = [
  { key: "greeting", type: "string", default: "hello", label: "Greeting" },
];

const plugin: PluginModule = {
  start(t3: T3Api) {
    const schemas = t3.settings.define(settings);
    t3.log("info", `${t3.plugin.id}: ${t3.settings.get<string>("greeting")}`);
    return () => schemas.dispose();
  },
};

export default plugin;
```

Plugin settings show up on the Plugins page, at **Settings > Plugins** in T3 Code (the last entry in the Settings sidebar, under Archive).

### Settings in a dock tab

Settings > Plugins covers the sidebar, so a plugin that styles the app is hard to tune there. Put its settings in a `rightPanel` dock tab instead: the dock sits beside the app and every change shows live. `t3.ui.settingsPanel(host, options?)` renders the controls from your `t3.settings.define` schemas, so you write no form code:

```ts
const tab = t3.ui.register({
  slot: "rightPanel",
  id: "tune",
  title: "My plugin",
  render(host) {
    const panel = t3.ui.settingsPanel(host, {
      keys: ["size", "tint", "enabled"], // order and subset (default: every setting)
      onLive: (key, value) => preview(key, value), // slider moves, before the debounced write
    });
    return () => panel.dispose();
  },
});
t3.commands.register({ id: "open", title: "My plugin: open panel", run: () => t3.ui.dock.open("tune") });
```

- One compact 12px row per setting: switch, select, slider (`type: "range"`), number or text field, plus a reset button that shows when the value differs from the default.
- Edits go through `t3.settings.set`, so Settings > Plugins stays in sync, and the controls follow changes made there. Slider drags update the readout at once and write after `debounceMs` (default 120); releasing the slider writes immediately.
- `onLive(key, value)` fires for every slider move. Use it to preview without waiting for the write.
- Add your own widgets (preview swatches, file pickers) next to the helper in the same tab.

`type: "range"` is a number shown as a slider: `{ key, type: "range", default, min, max, step?, label }` (`min` and `max` required). Values are validated like `number`, and the Plugins page renders it as a slider too.

## The build preset

`t3p-plugin-build` (package `@t3p/plugin-build`) is the only supported build:

```sh
t3p-plugin-build [--root DIR] [--entry src/index.ts] [--out-dir dist] [--watch]
```

- Validates `plugin.json` with the same rules as `@t3p/api` (`validateManifest`) and
  fails before building when it is invalid.
- Bundles one entry with tsdown/rolldown to `dist/renderer.js`: **ESM, one file,
  every dependency inlined**.
- Fails when the bundle still has a bare/external import. A renderer plugin cannot
  use `node:*` modules or load an unbundled package. `@t3p/api` is for **types only**
  (it is erased at build time); importing its runtime helpers is not a supported path
  for plugins.
- The folder-name rule is not applied here, because a dev plugin may live in any
  folder and be linked into `plugins/<id>/` (see below).

`pnpm dev` runs the same command with `--watch`.

## The manifest

Schema: [`packages/api/schema/plugin.schema.json`](../packages/api/schema/plugin.schema.json)
(Draft 7; point `$schema` at it from an editor if you copy it into your project).
`packages/api/test/schema.test.ts` fails when the schema and the validator disagree.

| Field | Required | Rules |
|---|---|---|
| `id` | yes | Lowercase `[a-z0-9-]` segments separated by dots, max 64 chars. Must equal the folder name inside `plugins/` and must not be a Windows reserved name (`con`, `nul`, `com1`, ...). |
| `version` | yes | Semver (`1.0.0`, `1.2.3-beta.1+build.7`). |
| `tier` | yes | `1`, `2` or `3` (see below). |
| `t3Versions` | yes | Non-empty array of T3 Code patterns: `"0.1.10"`, `"0.1.x"`, `"x.x.x"` or `"*"`. |
| `permissions` | no (default empty) | Array of permission entries, see below. |
| `name`, `description`, `author` | no | Strings, max 512 chars. `name` defaults to the id. |
| `renderer` | no | Plugin-relative path to the renderer ES module, `.js`/`.cjs`/`.mjs`. The preset writes `dist/renderer.js`. |
| `main` | no | Plugin-relative path to a main-process entry. Requires the `main` permission. |

Unknown top-level keys are a validation *warning*, not an error (forward compatibility).
Entry paths use forward slashes, no `..`, no drive letters or colons, no Windows
reserved segments.

## Tiers

Every plugin declares the highest tier it uses, so users can see how fragile it is.

| Tier | Built on | Breaks when |
|---|---|---|
| 1, stable | server RPC and HTTP, files on disk, `data-slot` DOM anchors, theme CSS, own IPC | upstream changes its public contract |
| 2, internals | app singletons captured by first-party patches: atom registry, zustand stores, router, shortcut dispatcher, the app's RPC client | upstream refactors those modules |
| 3, raw patches | the plugin's own text patches | any change to the patched code |

Prefer tier 1. The manifest only *declares* the tier; it does not grant anything.

## Permissions

The names come from [`packages/api/src/permissions.ts`](../packages/api/src/permissions.ts).
A plugin receives only what it **declares** in `plugin.json` **and** the user
**grants** (`t3p grant <id> <permission>`), so the effective set is the intersection.
Granting is a consent signal, not a security boundary once a plugin runs in the
renderer; see [`docs/security.md`](security.md) section 3.

| Permission | Form | What it allows |
|---|---|---|
| `main` | `"main"` | A `main` entry, and `t3.native.invoke` into your own main-side handlers (`ctx.ipc.handle(name, fn)`). |
| `patches` | `"patches"` | Tier 3 text patches (`t3.patches`), and patches that must apply on first load (also needs `main`). |
| `rpc` | `"rpc"` | `t3.rpc.call`, `subscribe` and `http` against the T3 server, using the shared bearer-authenticated socket. |
| `guard` | `"guard"` | `t3.threads.beforeStart` (and `ctx.threads.beforeStart` in a main entry): see, block or redirect every turn start, delegated sub-sessions included. Grant with `t3p grant <id> guard`; the plugins page does not grant it. See [`docs/patching.md`](patching.md) "Server guard". |
| `fs.read` | `{ "fs.read": { "roots": ["~/.t3/caches"] } }` | `t3.native.fsRead` under the listed roots. |
| `sqlite.read` | `{ "sqlite.read": { "roots": ["~/.t3"] } }` | Read-only queries through `t3.native.sqliteQuery` (`statev2.sqlite`; never opened for write). |
| `log.tail` | `{ "log.tail": { "roots": ["~/logs"] } }` | `t3.native.logTail` under the listed roots. |
| `spawn` | `{ "spawn": { "allow": ["C:/Tools/git.exe"] } }` | `t3.native.spawn` of exactly the listed executables, argv arrays, no shell. |

Scope paths are absolute (`C:/x`, `/x`) or start with `~/`, at most 1024 chars and 32
entries. No UNC or device paths, no NUL.

Grants live in `<T3P_HOME>/.t3-patcher/state.json`. The renderer refuses to enable a
plugin that declares `main`, `patches` or `spawn`; use `t3p enable <id>` (and
`t3p grant`) for those. Disabling a main plugin needs a restart.

## Dev workflow

`t3p dev <plugin-folder>`:

1. Reads `<folder>/plugin.json` and validates it (without requiring the folder name
   to equal the id).
2. Links the folder into `~/.t3-patcher/plugins/<id>/` — a **junction on Windows**
   (`fs.symlinkSync(..., "junction")`, no admin needed), a directory symlink elsewhere.
3. Enables the plugin in `state.json`.
4. Switches dev mode on by writing `~/.t3-patcher/dev-mode`, the persistent marker the
   main runtime reads (the same switch as `T3P_DEV=1` but persisting across launches).
   Dev mode starts the WP-3A directory watcher and exposes `t3.__dev.reload(id)`.

`T3P_HOME` overrides the patcher home (default: your OS home), for both `t3p dev` and
the app. `t3p dev --unlink <id>` removes the link, disables the plugin, and removes the
dev-mode marker once no dev links remain. The source folder is never touched.

Safety rules:

- A real (non-link) `plugins/<id>` folder is **never** overwritten by `t3p dev` or
  deleted by `--unlink`; both refuse and leave it alone.
- An existing link that points at a **different** folder is refused; run
  `t3p dev --unlink <id>` first.
- Re-running `t3p dev <folder>` for the same link is a no-op ("already linked").

While dev mode is on, the watcher reloads a plugin when any file in its folder changes
(debounced `.git` and `node_modules` are ignored). `pnpm dev` keeps `dist/renderer.js`
fresh; `pnpm build` once is enough for a one-off change. Settings and storage survive
reloads.

## API namespaces

`start(t3)` receives a frozen `T3Api`. All types are exported from `@t3p/api`; the
single source of truth is [`packages/api/src/t3.ts`](../packages/api/src/t3.ts).

| Namespace | Status at WP-3E | What it does |
|---|---|---|
| `t3.rpc` | live (needs `rpc`) | `call`, `subscribe` (resubscribes after reconnects), `http`, connection `state` |
| `t3.providers` | stub (WP-3B) | provider list, auth state, usage limits, change events |
| `t3.threads` | stub (WP-3B) | list, current, projection, subscribe, `setModel`, `switchProvider` with `ok`/`busy`/`unavailable` results |
| `t3.timeline` | live (needs `rpc`) | normalized per-thread activity records with causes; `enrichFromProviderLog(records, logText)` (pure) merges provider-log frames |
| `t3.environment` | live | `current()`: `{id, label}` of the active environment (id from the route, label from the desktop bridge for the local one; `null` when unknown) |
| `t3.cache` | stub (WP-4C) | prompt-cache state and expiry notifications |
| `t3.usage` | stub (WP-3B) | token totals by range, thread and provider |
| `t3.ui` | live | slots, toast (optional `actions` buttons), modal, theme variables, `dock.open/close/toggle/isOpen` for the `rightPanel` dock, `settingsPanel(host)` live controls from your settings schemas |
| `t3.commands` | stub (WP-3D) | command palette entries |
| `t3.keybinds` | stub (WP-3D) | keyboard shortcuts bound to commands |
| `t3.patches` | stub (WP-3D, needs `patches`) | tier 3 text patches |
| `t3.internals` | stub (WP-3D) | tier 2 handles into app singletons |
| `t3.storage` | live | per-plugin JSON key-value store, 1 MiB quota |
| `t3.settings` | live | typed settings with schema, persistence and change events |
| `t3.native` | live (per-call permissions) | scoped file reads, read-only SQLite, log tail, spawn, own main handlers |
| `t3.events` | live | app/plugin lifecycle events and a plugin-to-plugin bus |

Root members: `t3.apiVersion` (`"1.0"`), `t3.id`, `t3.plugin` (`{id, version, tier}`),
`t3.log(level, message)` and, in dev mode, `t3.__dev.reload(id)`.

A stub keeps its final signature and throws `T3NotImplementedError` naming the owning
work package, so a missing feature fails at the call site instead of silently doing
nothing.

## UI style

Make injected UI look native in every theme: use the shared `t3p-*` classes and app CSS
vars only. See [ui-style.md](ui-style.md).

## Examples and references

- Minimal plugin without a build step: [`plugins/_sample-hello`](../plugins/_sample-hello).
- Manifest validator: [`packages/api/src/manifest.ts`](../packages/api/src/manifest.ts).
- JSON Schema: [`packages/api/schema/plugin.schema.json`](../packages/api/schema/plugin.schema.json).
- Build preset: [`packages/plugin-build`](../packages/plugin-build).
- Scaffolder: [`packages/create-t3p-plugin`](../packages/create-t3p-plugin).
- Trust model and the limits of renderer permissions: [`docs/security.md`](security.md).
- WP-3E transcript and implementation notes: [`docs/wp-3e-notes.md`](wp-3e-notes.md).
