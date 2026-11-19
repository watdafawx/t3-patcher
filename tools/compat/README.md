# @t3p/compat

Upstream release checker for T3 Patcher. It fetches a T3 Code release, pulls the
web client out of `server.asar`, and answers three questions:

1. does every first-party patch `find` still match exactly one chunk?
2. which RPC methods were added or removed?
3. which `data-slot` anchors were added or removed?

Exit code 0 when nothing our code depends on broke, 1 when it did, 2 for a usage
or input error. `docs/wp-5a-notes.md` has the long version (what works, every
flag, limits).

```powershell
pnpm --filter @t3p/compat build
pnpm --filter @t3p/compat compat -- --version v0.1.10          # supported release
pnpm --filter @t3p/compat compat -- --version nightly --json   # newest nightly
pnpm --filter @t3p/compat compat -- --version C:\path\server.asar
```

Needs 7-Zip for the Windows installer (`T3P_7Z` or `--seven-zip` if it is not on
PATH). Downloads land in `tools/compat/.cache/<tag>/` (gitignored); `--clean`
removes them. The baselines live in `baseline/` and are regenerated with
`--update-baseline`.
