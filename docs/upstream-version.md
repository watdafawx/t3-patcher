# Upstream version

Supported upstream: `pingdotgg/t3code`, tag `v0.1.10`.

| Field | Value |
|---|---|
| Tag | `v0.1.10` |
| Commit | `7d32075e3757ded707914e2450c3e392a9665765` |
| Clone | `git clone --depth 1 --branch v0.1.10 https://github.com/pingdotgg/t3code .upstream` |
| Checked out | 2026-11-18 |

Tag resolution: `git ls-remote --tags https://github.com/pingdotgg/t3code` lists `refs/tags/v0.1.10` pointing at `7d32075e…`, so the tag from the plan exists and no fallback tag was needed. The same commit is also tagged `v0.1.10-nightly.20261116.4800`; those `-nightly.*` and `-preview.*` tags are release-candidate train tags, not the supported stable release.

Bump procedure:

1. Pick the new tag.
2. `git -C .upstream fetch --depth 1 origin tag <tag> && git -C .upstream checkout --detach <tag>` (or delete `.upstream` and re-clone).
3. Update the table above with the new tag, commit and date.
4. Rebuild `packages/contracts-vendor` (WP-1C) and re-run the compat checker (`tools/compat`, WP-5A) before declaring the new version supported.

`.upstream` is gitignored; it is a working reference only and never vendored into the repo.
