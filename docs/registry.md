# Plugin registry

The registry is one JSON file, [`registry/index.json`](../registry/index.json), in this repo. T3 Patcher reads it to show the **Browse** tab in Settings > Plugins and for `t3p plugins search|info|install|update`. Each entry points at a zip on a GitHub release and pins it by SHA-256.

- Default URL: `https://raw.githubusercontent.com/watdafawx/t3-patcher/main/registry/index.json`.
- Override with the `T3P_REGISTRY_URL` environment variable, or `"registryUrl"` in `~/.t3-patcher/config.json`. The environment variable wins. The URL must be https.
- For local tests only: `T3P_REGISTRY_ALLOW_INSECURE_LOCAL=1` also allows `http://127.0.0.1` and `http://localhost` (index and downloads). Nothing else.

What installing does, and what the registry does and does not protect against: [security.md section 4.7](security.md#47-installing-from-the-registry).

## Using it

In the app: Settings > Plugins > **Browse**. Search, filter by tag, open a plugin, press **Install**. A T3 Patcher dialog (not the plugin's) shows the plugin, its id, version, author, download URL, hash and every permission it declares. **Cancel** is the default. **Install and review permissions** installs and opens the plugin on the Installed tab at its permissions.

From a terminal:

```sh
t3p plugins search <text> [--tag <tag>]   # or `t3p plugins list` for everything
t3p plugins info <id>
t3p plugins install <id> [--yes]          # prints permissions, asks you to type y
t3p plugins update <id> | --all
t3p plugins uninstall <id>
t3p plugins list --installed              # same as plain `t3p plugins`
```

Every install is **disabled with no permissions granted**. Enable it and grant permissions on the Installed tab or with `t3p enable <id>` and `t3p grant <id> <permission>`. Updates keep the plugin's enabled flag, grants, settings and stored data. Uninstall removes the plugin folder and its `state.json` entry; settings and stored data (`~/.t3-patcher/storage/<id>.json`) are kept. A plugin linked with `t3p dev` is never touched by install, update or uninstall.

## Entry fields

`registry/index.json` is `{ "schemaVersion": 1, "plugins": [ ... ] }`. JSON schema: [`packages/api/schema/registry.schema.json`](../packages/api/schema/registry.schema.json). The same rules run in `validateRegistry` (`@t3p/api`), in the app, in the CLI and in CI.

| Field | Required | Rule |
|---|---|---|
| `id` | yes | Plugin id (`a-z0-9.-`, starts with a letter or digit, at most 64). Unique in the index. Must equal `plugin.json` `id` |
| `name` | yes | At most 80 characters |
| `description` | yes | At most 512 characters. One or two plain sentences |
| `author` | yes | Person or organisation, at most 100 characters |
| `homepage` | yes | https URL |
| `version` | yes | Semver (`1.2.3`, optional `-pre`). Must equal `plugin.json` `version` |
| `apiVersion` | yes | Plugin API range the plugin needs: `"1"`, `"1.x"` or `"1.2"` |
| `permissions` | yes | Exactly the `permissions` array of `plugin.json`, scopes included (order does not matter). `[]` for none |
| `tags` | yes | Up to 8 lowercase tags (`a-z0-9-`, at most 24 characters each) |
| `download` | yes | `{ "url": https URL, "sha256": 64 lowercase hex, "size": bytes (at most 25 MB) }` |
| `icon` | no | https URL of a square PNG, SVG or JPEG |
| `screenshots` | no | Up to 6 https URLs |
| `minRuntime` | no | Lowest T3 Patcher runtime version, semver |
| `source` | no | https URL of the source code. Required for third-party plugins by review (below) |
| `license` | no | SPDX id, for example `MIT`. Required for third-party plugins by review |

Unknown fields are a warning in the app and an error in CI (`--strict`).

## Release assets

The download is a GitHub release asset named `t3p-plugin-<id>-<version>.zip`. Downloads follow redirects only to `github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com` (where GitHub serves release assets) or the registry's own host, all over https. Anything else is refused.

### Zip layout

```
plugin.json          at the zip root, not in a folder
README.md            optional (README*, LICENSE*, NOTICE*)
dist/...             built code (the manifest's renderer and main entries)
assets/...           optional images, fonts, data
*.cjs, *.ps1         only for main-process plugins that load them from the plugin root
```

The installer refuses a zip that has any of: `..` or absolute paths, drive letters or backslashes, Windows reserved names (`CON`, `aux`...), alternate data streams, symlinks or other special files, encryption, compression other than store or deflate, ZIP64, duplicate names (case-insensitive), more than 500 entries, more than 50 MB unpacked, a compression ratio over 200:1 (for entries over 1 MB unpacked), or a size or CRC that does not match. No source maps, `node_modules`, tests or source are needed; keep them out.

Nothing in the zip runs during install: no install scripts, no `package.json` scripts, no native modules are loaded. Code runs only after the user enables the plugin.

### SHA-256

Hash the exact file you uploaded:

```sh
# Windows
certutil -hashfile t3p-plugin-my-plugin-1.0.0.zip SHA256
# PowerShell
(Get-FileHash t3p-plugin-my-plugin-1.0.0.zip -Algorithm SHA256).Hash.ToLower()
# macOS / Linux
shasum -a 256 t3p-plugin-my-plugin-1.0.0.zip
```

Put the lowercase hex in `download.sha256` and the file size in bytes in `download.size`. If you re-upload the asset, the hash changes and installs fail until the index is updated: that is the point.

## Submitting a plugin (pull request)

1. Publish a GitHub release in your plugin's repo with the zip attached (layout above).
2. Fork this repo, add your entry to `registry/index.json` (keep the list sorted by `id`), and run:
   ```sh
   pnpm install --frozen-lockfile && pnpm -r build
   node tools/registry/validate-registry.mjs --strict
   node tools/registry/validate-registry.mjs --verify-downloads   # downloads and checks every zip
   ```
3. Open a pull request titled `registry: add <id> <version>` (or `update`). CI runs the same validator.

### Review checklist

Maintainers check every new entry and every update against this list. Fill it in the PR description.

- [ ] **Source link.** `source` points at public source code, and the release zip is built from it (a tag or commit is named in the PR).
- [ ] **License.** `license` is set and the repo has a matching LICENSE file.
- [ ] **No obfuscation.** The code in `dist/` is readable (bundled or minified is fine; packed, encrypted or `eval`-loaded code is not).
- [ ] **Minimal permissions.** Each declared permission is needed and explained in the README. `main`, `patches` and `spawn` need a clear reason; `spawn` and `fs.read` scopes are as narrow as possible.
- [ ] **No network surprises.** Every host the plugin contacts is listed in the README.
- [ ] **Metadata matches.** `id`, `version` and `permissions` equal the zip's `plugin.json` (the installer refuses a mismatch anyway).
- [ ] **Zip layout.** `plugin.json` at the root; no `node_modules`, source maps or secrets.
- [ ] **Hash.** `--verify-downloads` passes.
- [ ] **Screenshots** (optional) show the plugin with demo data only.

An update is reviewed like a new entry: the diff between the two tagged sources, and any new permission.

## First-party plugins

`tools/registry/build-registry.mjs` builds the first-party entries from `plugins/*` (folders starting with `_` are samples and skipped). It is part of the release workflow, see [release.md](release.md#plugin-registry). Run it by hand after `pnpm -r build`:

```sh
node tools/registry/build-registry.mjs                  # zips + index.json into dist-registry/
node tools/registry/build-registry.mjs --write-index    # also rewrites registry/index.json (commit it)
node tools/registry/build-registry.mjs --base-url http://127.0.0.1:8787   # a local test registry
```

The zips are deterministic (fixed timestamps, sorted entries), so the same build gives the same hashes. Curated fields of an existing entry (tags, homepage, icon, screenshots, author, license) are kept; third-party entries are left alone.
