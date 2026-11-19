# Releasing T3 Patcher

For maintainers. Users: see the README "Installation" section.

Two artifacts ship from one version number (`packages/installer/package.json`):

| Route | Artifact | Built by |
|---|---|---|
| A (primary) | `t3p.exe` + `t3p.exe.sha256` on the GitHub release | `.github/workflows/release.yml` on a `v*` tag |
| B | `t3-patcher` on npm | by hand with your npm login (never from CI) |
| Registry | `t3p-plugin-<id>-<version>.zip` per first-party plugin + `index.json` on the same GitHub release | `release.yml`, see [Plugin registry](#plugin-registry) |

## Cut a release

1. Pick the version. Set it in `packages/installer/package.json` (`version`). The release workflow fails if the tag is not exactly `v<that version>`.
2. `pnpm install --frozen-lockfile && pnpm -r build && pnpm -r test && pnpm lint` all exit 0. Revert `packages/contracts-vendor/UPSTREAM.json` (the build rewrites it) unless you changed the vendored contracts.
3. Commit, then tag and push the tag:
   ```sh
   git tag v0.1.0
   git push origin main v0.1.0
   ```
4. The **Release** workflow (windows-latest, Node 22) installs, builds, tests, lints, runs `pnpm build:exe`, checks the checksum and a `t3p.exe selftest`, then creates the GitHub release with generated notes and uploads `t3p.exe` and `t3p.exe.sha256`. The notes start with the install steps and the SmartScreen note ("unsigned: More info > Run anyway").
5. Commit the new plugin registry index (see [Plugin registry](#plugin-registry)).
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

The Browse tab and `t3p plugins install` read `registry/index.json` from `main` ([registry.md](registry.md)). The release workflow builds the first-party entries:

1. `node tools/registry/build-registry.mjs --write-index` zips every `plugins/*` folder except samples (`_*`) into `dist-registry/t3p-plugin-<id>-<version>.zip` (deterministic: fixed timestamps, sorted entries), computes SHA-256 and size, and writes `dist-registry/index.json` plus a commit-ready `registry/index.json` whose download URLs point at `https://github.com/watdafawx/t3-patcher/releases/download/v<version>/`.
2. `node tools/registry/validate-registry.mjs --strict` checks it.
3. The zips and `index.json` are uploaded to the release; `registry/index.json` is also kept as the workflow artifact `registry-index`.

The workflow never pushes. After the release is published:

```sh
gh run download <run-id> -n registry-index -D registry   # or download index.json from the release page into registry/
node tools/registry/validate-registry.mjs --strict --verify-downloads   # every zip downloads and matches its hash
git add registry/index.json && git commit -m "chore(registry): index for v0.1.3"
```

Users see the new versions once this commit is on `main`. Do not rebuild the index locally for a release: the hashes must be those of the zips CI uploaded. Third-party entries in `registry/index.json` are carried over unchanged.

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
