# __NAME__

A [T3 Patcher](https://github.com/pingdotgg/t3code) plugin. Plugin id: `__ID__`.

It registers one setting (`greeting`) and writes a line to the T3 Patcher log on start.

## Build

```sh
pnpm install
pnpm build          # t3p-plugin-build -> dist/renderer.js
pnpm typecheck      # optional
```

`pnpm build` validates `plugin.json` first and then bundles `src/index.ts` into one
ES module, `dist/renderer.js`. Every dependency is inlined: a renderer plugin cannot
`import` a package that is not bundled and cannot use `node:*` modules. `@t3p/api`
is for types only.

## Load it into T3 Code

```sh
t3p dev .           # link this folder into ~/.t3-patcher/plugins/__ID__ and enable it
pnpm dev            # optional: rebuild on change (t3p dev turns hot reload on)
```

Restart T3 Code after the first `t3p dev`, then edit `src/index.ts` and run
`pnpm build`; the plugin reloads by itself. `t3p dev --unlink __ID__` removes the link.

## Layout

| File | Purpose |
|---|---|
| `plugin.json` | Manifest: id, version, tier, permissions, entry points. Schema: `packages/api/schema/plugin.schema.json` |
| `src/index.ts` | Entry: default export with `start(t3)` and optional `stop()` |
| `dist/renderer.js` | Build output, loaded by the T3 Patcher renderer runtime |

The `t3` object passed to `start` is typed in `packages/api/src/t3.ts`. Its namespaces:
`rpc`, `providers`, `threads`, `timeline`, `cache`, `usage`, `ui`, `commands`,
`keybinds`, `patches`, `internals`, `storage`, `settings`, `native`, `events`,
plus `log`, `id`, `plugin`, `apiVersion` and (dev mode only) `__dev`.

See `docs/plugin-authoring.md` for manifest fields, tiers and permissions.
