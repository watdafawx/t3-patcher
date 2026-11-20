# Releasing T3 Patcher

For maintainers. Users: see the README "Installation" section.

Two artifacts ship from one version number (`packages/installer/package.json`); the plugin registry has its own release line and version numbers:

| Route | Artifact | Built by |
|---|---|---|
| A (primary) | `t3p.exe` + `t3p.exe.sha256` on the GitHub release | `.github/workflows/release.yml` on a `v*` tag |
| B | `t3-patcher` on npm | by hand with your npm login (never from CI) |
| Registry | `t3p-plugin-<id>-<version>.zip` per first-party plugin + `index.json` on the rolling `plugin-registry` release | `.github/workflows/registry.yml` on `main`, see [Plugin registry](#plugin-registry) |

## Cut a release

1. Pick the version. Set it in `packages/installer/package.json` (`version`). The release workflow fails if the tag is not exactly `v<that version>`.
2. `pnpm install --frozen-lockfile && pnpm -r build && pnpm -r test && pnpm lint` all exit 0. Revert `packages/contracts-vendor/UPSTREAM.json` (the build rewrites it) unless you changed the vendored contracts.
3. Commit, then tag and push the tag:
   ```sh
   git tag v0.1.0
   git push origin main v0.1.0
   ```
4. The **Release** workflow (windows-latest, Node 22) installs, builds, tests, lints, runs `pnpm build:exe`, checks the checksum and a `t3p.exe selftest`, then creates the GitHub release with generated notes and uploads `t3p.exe` and `t3p.exe.sha256`. The notes start with the install steps and the SmartScreen note ("unsigned: More info > Run anyway"). Users on a single-file exe can then run `t3p update` (it reads `releases/latest` and the two assets above).
5. Plugin assets are not part of a patcher release: the **Plugin registry** workflow publishes them on `main` (see [Plugin registry](#plugin-registry)).
6. Open the release page, check the notes, and download the exe once to smoke test it (`t3p.exe --version`, `t3p.exe status`) on a machine you do not mind.
7. Publish to npm (needs your npm login; CI never publishes):
   ```sh
   npm login                    # once; the @t3p scope must be yours
   cd packages/installer
   pnpm publish --access public --dry-run   # inspect the file list first
   pnpm publish --access public
   ```
   `prepack` builds the runtime and copies it to `packages/installer/runtime/` (gitignored) so the package works without the repo. Use `pnpm publish`, not `npm publish`: pnpm rewrites the `workspace:*` devDependencies.
   Check the tarball any time without publishing: `cd packages/installer && npm pack --dry-run` (expect `dist/*`, `runtime/*`, `package.json`, `README.md`; no `dist/standalone`, no maps).

## Plugin registry

The Browse tab and `t3p plugins install/update` read `registry/index.json` from `main` ([registry.md](registry.md)). **Patcher releases and plugin releases are separate.** Plugin zips and their index live on one rolling GitHub release, tag `plugin-registry`, which is created by `.github/workflows/registry.yml` and never versioned. A plugin update therefore needs no patcher version bump, no `v*` tag and no exe rebuild.

The workflow runs on every push to `main` that touches `plugins/**`, `packages/api/**`, `packages/plugin-build/**`, `tools/registry/**` or `pnpm-lock.yaml` (or by hand). It:

1. runs `node tools/registry/build-registry.mjs --base-url https://github.com/watdafawx/t3-patcher/releases/download/plugin-registry`, which zips every `plugins/*` folder except samples (`_*`) into `dist-registry/t3p-plugin-<id>-<version>.zip` (deterministic: fixed timestamps, sorted entries), computes SHA-256 and size, and writes `dist-registry/index.json` whose download URLs point at the rolling release.
2. `node tools/registry/validate-registry.mjs --strict dist-registry/index.json`
3. creates the `plugin-registry` release if missing (`--latest=false`, so patcher releases keep "Latest"), then uploads every zip and `index.json` with `--clobber`.
4. downloads them again (`--verify-downloads`) to prove the published hashes match, and keeps `dist-registry/index.json` as the `registry-index` artifact.

The workflow never pushes. Commit the new index so clients read it:

```sh
gh run download <run-id> -n registry-index -D registry
# that writes registry/index.json
node tools/registry/validate-registry.mjs --strict --verify-downloads
git add registry/index.json && git commit -m "chore(registry): plugin index"
```

Rules that keep this safe:

- **Never replace an existing zip asset.** Filenames carry the plugin version and installed clients pin the SHA-256. The workflow uploads only new names (`index.json` is the only `--clobber`), then verifies the published downloads, so a changed build under an old version fails the job instead of breaking clients: bump the plugin version.
- **Bump the plugin version** (`plugins/<id>/plugin.json` + `package.json`) with every change you want users to receive. `t3p plugins update` compares versions; an unchanged version is a no-op even if the zip changed.
- Commit the index only after the workflow run published the matching assets. Old zips stay in place, so the previous index keeps working meanwhile.
- The local `pnpm registry:build` writes the same commit-ready `registry/index.json` for review, but the workflow's artifact is authoritative (its hashes describe the assets actually uploaded).
- Third-party entries in `registry/index.json` are carried over unchanged.

## How `t3p.exe` is built (`pnpm build:exe`)

`tools/build-exe.mjs` (about 80 lines, no extra tooling except the `postject` devDependency):

1. Builds `t3-patcher` and `@t3p/main-runtime` with their dependencies (`--skip-build` reuses existing output).
2. The main script is `packages/installer/dist/standalone/t3p.cjs`: the whole CLI in one file, with the shim text (`@t3p/shim`), `@t3p/api`, `@electron/asar` and `@electron/fuses` bundled in.
3. The runtime folder (`packages/main-runtime/dist`: `main.cjs`, `preload.cjs`, `renderer.js`, `repair-worker.cjs`, `server-hook.mjs`, `sqlite-worker.cjs`, the patch catalogs) is packed into one gzip asset, `runtime.pack.gz` (source maps and `.d.mts` files left out; about 340 KB). Format and code: `packages/installer/src/runtime-pack.ts`.
4. `node --experimental-sea-config` builds the SEA blob (main script plus that asset). The build copies the running `node.exe` to `dist-exe/t3p.exe` and `postject` injects the blob (`NODE_SEA_BLOB`). Injecting also drops Node's own Authenticode signature (the file reads as "not signed", never as a broken signature).
5. Writes `dist-exe/t3p.exe.sha256` (`sha256sum` format), then smoke tests the result: `--version` and `selftest` (which proves the embedded runtime unpacks).

At run time `install` calls `defaultRuntimeSource()`: inside the exe it reads the asset through `node:sea` and unpacks it to a temp folder (deleted on exit); in the monorepo it uses `packages/main-runtime/dist`; from the npm package it uses the staged `runtime/` folder. `--runtime DIR` always wins.

### Why Node SEA

- **Official and maintained by Node** (`node:sea`, asset API, Node 22+). No third-party packer to go stale.
- **Real Node, not a re-implementation**: the CLI already depends on `node:fs`, `child_process`, `readline` and the asar/fuses libraries; they run unchanged.
- **Assets are first class** (`sea.getRawAsset`), so the runtime travels inside the exe with no side files.
- Alternatives rejected: `pkg` (archived, old Node targets), `nexe` (builds Node from source, slow and fragile), Bun/Deno compile (a different runtime, so every `node:` API in the installer would need re-verifying), Electron-packager (200 MB+).
- Cost: the exe is a full Node binary, about 84 MB. Node 22 vs 24 make a few MB of difference. It cannot be made much smaller without risky binary packers (UPX makes antivirus scanners suspicious).

The workflow pins Node 22 (the minimum), so the shipped exe contains a Node 22 runtime. Build locally on Node 22 or newer; `pnpm build:exe` works on Windows only for a real `t3p.exe`.

## Verify a download

```powershell
certutil -hashfile t3p.exe SHA256
Get-Content t3p.exe.sha256
```

The two hashes must match (the file is `<hash> *t3p.exe`). In Git Bash: `sha256sum -c t3p.exe.sha256`.

## Notes

- The exe is **not code-signed**. SmartScreen shows "Windows protected your PC" until the file builds reputation or is signed; users click **More info > Run anyway**. Signing later means adding a signing step to `release.yml` after `build:exe` and before the checksum is taken (the checksum must be of the signed file).
- Double-click detection: with no arguments, a console on stdin and stdout, and `explorer.exe` as parent process, the exe shows the guided menu. A terminal with no arguments prints help. `T3P_MENU=1` forces the menu and `T3P_MENU=0` forces help (for testing).
- The logon repair task works with the exe: it copies itself to `~/.t3-patcher/t3p.exe` and the task runs `t3p.exe repair --if-stale`, so no Node is needed anywhere.
- `dist-exe/` is gitignored. Delete it when you are done; it is about 84 MB.
