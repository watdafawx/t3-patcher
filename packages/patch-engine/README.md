# @t3p/patch-engine

Vencord-style text patches for the T3 Code client chunks. Pure TypeScript, no
Electron imports. Applied when a chunk is served; a failed patch is reported and
never blocks the app.

## Usage

```ts
import { applyPatchSet, applyPatchesCached, PatchCache, planPatches } from "@t3p/patch-engine";

const patches = [
  {
    plugin: "t3p.core",
    find: "function foo(){", // must match exactly one chunk
    replacement: [
      { match: /return 'old'/, replace: "return 'new'" },
      { match: "bar()", replace: "$self.hook(1)" }, // $self = window.__t3p_plugins["t3p.core"]
    ],
    predicate: () => true, // optional: false / throw => skipped, reason "predicate"
  },
];

// Against a chunk set (name -> source), find the owning chunk for each patch:
const { results, failed, applied } = applyPatchSet(chunks, patches);

// Or one known chunk, with the disk cache:
const cache = new PatchCache(dir);
const result = applyPatchesCached(cache, "assets/index-abc.js", source, patches);
```

- `applyPatches(chunkName, source, patches)` -> `{ code, applied, failed }`.
  Each patch is atomic: a missing `match` or a result that no longer parses as
  an ES module rolls that patch back; patches after it still apply.
- `planPatches(chunks, patches)` -> `{ byChunk, failed }`. Zero matching chunks
  is `no-match`, several are `ambiguous`.
- `PatchCache` keys results by `sha256(source)-sha256(patchSet)` and stores
  `<dir>/<2 hex>/<key>.js` plus a `<key>.json` `{applied, failed}` sidecar.
  `applyPatchesCached` returns the cached result when present (`cached: true`)
  and only caches results in which something applied.

Replacement strings support `$1`.. and `$&` like `String.prototype.replace`,
`$$` for a literal `$`, and `$self` for the plugin's global handle. A string
`match` replaces the first occurrence; a RegExp uses its own flags.

## CLI: t3p-patch-test

```sh
t3p-patch-test <clientDir> <patchFile> [--json]
```

Reads every `.js`/`.mjs` under `clientDir` (chunk name = relative path with
forward slashes). `patchFile` is either a `.mjs`/`.js` module whose default
export is `Patch[]`, or a `.json` array:

```json
[
  {
    "plugin": "t3p.core",
    "find": "function foo(){",
    "findRegex": { "source": "...", "flags": "" },
    "replacement": [
      { "match": "return 'old'", "matchRegex": { "source": "...", "flags": "g" }, "replace": "return 'new'" }
    ]
  }
]
```

`find`/`findRegex` are alternatives; each replacement needs `match` or
`matchRegex`, plus a string `replace`. Prints `OK <chunk> (N replacements)` and
`FAIL <reason> ...` lines. Exit codes: `0` all applied, `1` any failed, `2`
usage or input error. `--json` prints `{applied, failed}`.

## Development

```sh
pnpm --filter @t3p/patch-engine build
pnpm --filter @t3p/patch-engine test
```
