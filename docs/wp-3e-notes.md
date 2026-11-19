# WP-3E notes: plugin SDK, scaffold and `t3p dev`

Branch `t3/wp-3e-plugin-sdk`. Builds and tests in the foreground on FOX; no rig run
(the master loads a scaffolded plugin on rig).

## What shipped

| Piece | Where |
|---|---|
| Scaffolder (`create-t3p-plugin`, bin `create-t3p-plugin`) | `packages/create-t3p-plugin` (`src/scaffold.ts`, `src/cli.ts`, `templates/`) |
| Build preset (`@t3p/plugin-build`, bin `t3p-plugin-build`) | `packages/plugin-build` (`src/build.ts`, `src/cli.ts`) |
| `plugin.json` JSON Schema | `packages/api/schema/plugin.schema.json` (exported as `@t3p/api/plugin.schema.json`) |
| Schema/validator agreement test (ajv, 82 cases) | `packages/api/test/schema.test.ts` |
| `t3p dev` / `t3p dev --unlink` | `packages/installer/src/dev.ts`, wired in `src/cli.ts` |
| Dev-mode marker in the main runtime | `packages/main-runtime/src/dev-mode.ts`, `paths.ts`, `index.ts` |
| Docs | `docs/plugin-authoring.md` (this file has the transcript) |

Scaffold output: `plugin.json`, `src/index.ts` (default-export `PluginModule`, registers a
`greeting` setting and logs), `tsconfig.json`, `package.json` (`build` = `t3p-plugin-build`,
`dev` = `t3p-plugin-build --watch`), `README.md`, `.gitignore`. Templates are plain
`.tpl` files with `__ID__`, `__NAME__`, `__NAME_JSON__`, `__VERSION__`, `__TIER__`
tokens; everything is rendered in memory before the first write, so a bad id or tier
never leaves a half-written folder. An existing folder is only used when empty.

## Decisions (and why)

1. **Dev mode gets a persistent marker, not just an env var.** WP-3A gated the watcher on
   `T3P_DEV=1`, which a CLI cannot set for a future app launch. `t3p dev` writes
   `<T3P_HOME>/.t3-patcher/dev-mode`; `detectDevMode` reads `T3P_DEV=1` **or** the marker.
   The watcher, `t3p:plugins:list.dev` and `t3.__dev` are unchanged. Unlike the safe-mode
   marker this one is not consumed; `t3p dev --unlink` removes it when the last dev link
   goes away.
2. **Junction listing fix.** `readdirSync(..., {withFileTypes:true}).isDirectory()` is
   `false` for a Windows junction, so WP-3A's watcher and `t3p plugins` would have skipped
   every dev link. Both now use `statSync` (follows links). `PluginHost` already used
   `statSync`, so loading needed no change.
3. **Link safety.** `t3p dev` refuses to touch a real `plugins/<id>` folder, and refuses to
   repoint an existing link at a different folder (run `--unlink` first). Re-linking the
   same folder is a no-op. `--unlink` refuses to delete a real folder.
4. **The build preset does not apply the folder-name rule.** `validateManifest` normally
   requires folder == id; a dev plugin lives anywhere and is linked as `plugins/<id>`.
   `checkManifest` calls it without `folderName`. The app's host still validates against
   the linked folder name, so a mismatch is caught at load time.
5. **No external imports.** The bundle is ESM, single file, `deps.alwaysBundle: [/.*/]`,
   and a post-build scan rejects any remaining static import, re-export, `require` or
   dynamic `import`. `@t3p/api` is documented as types-only.
6. **The schema is hand-written and locked to the validator by test.** The validator stays
   untouched; `schema.test.ts` runs an 82-case table (valid and invalid manifests) through
   both sides and fails on any disagreement. A validator change without a schema update
   breaks the test.
7. **Generated `package.json` depends on `"*"`** for `@t3p/api` and `@t3p/plugin-build`.
   `0.0.0` satisfies `*`, so pnpm links the workspace packages inside this repo, and a
   future published version would resolve too. The packages are not published yet, so a
   scaffold outside this repo cannot `pnpm i` them until they are (noted in the docs).
8. **Schema lives in `@t3p/api`**, next to the validator, and is exported as
   `@t3p/api/plugin.schema.json`. `ajv` is a devDependency of `@t3p/api` (tests only).

## Tests

| Package | Added | Suite total |
|---|---|---|
| `@t3p/api` | `test/schema.test.ts` (82) | 117 |
| `@t3p/plugin-build` | `test/build.test.ts` (11) | 11 |
| `create-t3p-plugin` | `test/scaffold.test.ts` (6), `test/end-to-end.test.ts` (1) | 7 |
| `@t3p/installer` | `test/dev.test.ts` (9, includes the real CLI) | 57 |
| `@t3p/main-runtime` | `test/dev-mode.test.ts` (3), junction case in `plugin-manager.test.ts` | 195 |

The end-to-end test scaffolds into a temp dir, runs the built `t3p-plugin-build` CLI,
asserts `validateManifest(...).ok` and `dist/renderer.js`, then runs the built `t3p` CLI
with a fake `T3P_HOME` and checks the junction, `state.json`, `dev-mode`, `t3p plugins`
and `--unlink`. It requires `pnpm -r build` first, like the existing installer CLI tests.

## Acceptance

```
pnpm -r build    exit 0
pnpm -r test     exit 0   (api 117, plugin-build 11, create-t3p-plugin 7, installer 57, main-runtime 195, others unchanged)
pnpm lint        exit 0
```

`packages/contracts-vendor/UPSTREAM.json` had a `builtAt`-only change from the build;
reverted.

## Transcript: scaffold -> build -> `t3p dev` with a fake T3P_HOME

Run on FOX against the built `dist/` CLIs. `%TEMP%` is
`C:\Users\USER\AppData\Local\Temp`. The scaffolded folder was outside the workspace,
so `pnpm install` was not run inside it; the preset and the CLI were invoked from the
repo's build output, which is what `npx create-t3p-plugin` / a globally installed `t3p`
would do.

```
> node packages\create-t3p-plugin\dist\cli.mjs %TEMP%\t3p-wp3e-demo\my-plugin --name "Demo plugin"
created C:\Users\USER\AppData\Local\Temp\t3p-wp3e-demo\my-plugin (id my-plugin, tier 1)
  C:\Users\USER\AppData\Local\Temp\t3p-wp3e-demo\my-plugin\.gitignore
  C:\Users\USER\AppData\Local\Temp\t3p-wp3e-demo\my-plugin\package.json
  C:\Users\USER\AppData\Local\Temp\t3p-wp3e-demo\my-plugin\plugin.json
  C:\Users\USER\AppData\Local\Temp\t3p-wp3e-demo\my-plugin\README.md
  C:\Users\USER\AppData\Local\Temp\t3p-wp3e-demo\my-plugin\src\index.ts
  C:\Users\USER\AppData\Local\Temp\t3p-wp3e-demo\my-plugin\tsconfig.json
next:
  cd C:\Users\USER\AppData\Local\Temp\t3p-wp3e-demo\my-plugin
  pnpm install
  pnpm build
  t3p dev .

> node packages\plugin-build\dist\cli.mjs --root %TEMP%\t3p-wp3e-demo\my-plugin
built my-plugin@0.1.0: dist/renderer.js (tier 1)

> Get-Content %TEMP%\t3p-wp3e-demo\my-plugin\plugin.json
{
  "id": "my-plugin",
  "name": "Demo plugin",
  "description": "A T3 Patcher plugin.",
  "version": "0.1.0",
  "tier": 1,
  "permissions": [],
  "t3Versions": ["*"],
  "renderer": "dist/renderer.js"
}

> Get-ChildItem %TEMP%\t3p-wp3e-demo\my-plugin\dist | Select-Object Name,Length
Name       Length
----       ------
renderer.js    674

> $env:T3P_HOME = "%TEMP%\t3p-wp3e-home"
> node packages\installer\dist\cli.mjs dev %TEMP%\t3p-wp3e-demo\my-plugin
linked my-plugin: C:\Users\USER\AppData\Local\Temp\t3p-wp3e-home\.t3-patcher\plugins\my-plugin -> C:\Users\USER\AppData\Local\Temp\t3p-wp3e-demo\my-plugin
enabled my-plugin in C:\Users\USER\AppData\Local\Temp\t3p-wp3e-home\.t3-patcher\state.json
hot reload on: C:\Users\USER\AppData\Local\Temp\t3p-wp3e-home\.t3-patcher\dev-mode (T3P_DEV=1 also works)
restart T3 Code; after that every build reloads the plugin

> node packages\installer\dist\cli.mjs plugins
on   my-plugin@0.1.0
     declared: {}
     granted:  {}

> node -e "const fs=require('fs');const p=process.env.T3P_HOME+'/.t3-patcher/plugins/my-plugin';console.log(JSON.stringify({isSymbolicLink:fs.lstatSync(p).isSymbolicLink(),target:fs.realpathSync(p)},null,2))"
{
  "isSymbolicLink": true,
  "target": "C:\\Users\\USER\\AppData\\Local\\Temp\\t3p-wp3e-demo\\my-plugin"
}

> Get-Content %TEMP%\t3p-wp3e-home\.t3-patcher\state.json
{
  "version": 1,
  "plugins": {
    "my-plugin": {
      "enabled": true,
      "granted": []
    }
  }
}

> Get-Content %TEMP%\t3p-wp3e-home\.t3-patcher\dev-mode
{
  "version": 1,
  "plugins": [
    "my-plugin"
  ],
  "updatedAt": "2026-11-19T02:45:10.565Z"
}

> node packages\installer\dist\cli.mjs dev --unlink my-plugin
unlinked my-plugin: C:\Users\USER\AppData\Local\Temp\t3p-wp3e-home\.t3-patcher\plugins\my-plugin removed, plugin disabled
hot reload off: no dev links left, removed C:\Users\USER\AppData\Local\Temp\t3p-wp3e-home\.t3-patcher\dev-mode

> node -e "...check link, marker, source..."
{"link":false,"marker":false,"source":true}
```

The Windows junction is reported as a symbolic link by Node's `lstatSync().isSymbolicLink()`;
that is the portable assertion used in the tests.

## Notes for the master / next work

- **Rig load not run** (per brief). To try it: scaffold, `pnpm build`, copy the folder
  into the rig slot's `.t3-patcher/plugins/<id>` (or run `t3p dev` on rig with
  `T3P_HOME` set to the slot home), write `dev-mode`, launch, then look for the plugin
  log line and `window.__t3p.loadResults`.
- Watch mode (`t3p-plugin-build --watch`) is implemented through tsdown's watch handle
  but not covered by a test; it is a thin loop around the same build.
- `t3p dev` prints "restart T3 Code" because the watcher starts at boot. If the app is
  already running in dev mode, re-running `t3p dev` for a new plugin still needs a
  restart for the new folder to be watched.
- The schema is the editor-facing copy only; no runtime code reads it. Keep the table in
  `packages/api/test/schema.test.ts` growing when the validator gains rules.
- The three packages (`create-t3p-plugin`, `@t3p/plugin-build`, and the schema export)
  are unpublished/private like the rest of the workspace.
