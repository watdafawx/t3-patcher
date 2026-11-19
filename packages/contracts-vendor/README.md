# @t3p/contracts-vendor

Type-only vendor of upstream `packages/contracts` (T3 Code). Use as `import type { ... } from "@t3p/contracts-vendor"`.
Nothing runtime ships: the build emits `.d.ts` only (`dist/index.d.ts` plus one `.d.ts` per upstream module), so plugin bundles never include `effect`.

- Upstream: see `UPSTREAM.json` (`tag`, `commit`, `builtAt`), source of truth `docs/upstream-version.md`.
- License: upstream is MIT, notice in `LICENSE-UPSTREAM.md`.

## How it is built (`pnpm build`, `scripts/build.mjs`)

1. Locate `.upstream` (arg `--upstream`, env `T3P_UPSTREAM`, `<repo>/.upstream`, then `X:/Dev/T3-Patcher/.upstream` for git worktrees). HEAD must equal the commit in `docs/upstream-version.md`.
2. Copy `packages/contracts/src` (no `*.test.ts`) to `dist/_src` (gitignored). Upstream uses `workspace:`/`catalog:` deps, so it is not installed in place; its only dependency, `effect`, is a devDependency here at the exact upstream catalog version (`4.1.3`) for declaration resolution.
3. Apply `scripts/vendor-patches.mjs` to the copy. Each patch must match exactly once or the build fails (so an upstream bump that moves code is noticed):
   - `environmentHttp.ts` is dropped (its HttpApi class is too big for tsc to serialise, TS7056; plugins never use it).
   - `WsRpcGroup` and `OrchestrationV2RpcSchemas` are typed `any` (same reason; method typing lives in `@t3p/rpc-client`).
   - `OrchestrationV2ThreadStreamItem` gets a hand-written wire-shape type (`OrchestrationV2ThreadStreamItemShape`, built from the named upstream types) instead of the inferred one.
4. `tsc -p tsconfig.vendor.json` (`emitDeclarationOnly`, `rewriteRelativeImportExtensions`) writes `dist/`.
5. Write `UPSTREAM.json` and `dist/methods.json` (`{tag, kind: "unary"|"stream"}` per RPC method, extracted from the `Rpc.make` registrations); compare with `docs/spikes/wp-0d/fixtures/methods.json` and print differences.

Choice record: full declaration emit works for everything except the five giant inferred types above, so no hand-copied subset is needed. Output is about 11 MB of `.d.ts` (78 files), not committed.

## Reading the types

Schemas are Effect v4 schema values. For the wire (JSON) shape use `(typeof X)["Encoded"]`; `X["Type"]` is the decoded form (branded ids, `DateTime.Utc`), which a plugin talking raw JSON does not get.
