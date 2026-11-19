# WP-4C notes: `t3.cache` and cache-watch

## Rules (`packages/renderer-runtime/src/cache-rules.ts`, pure)

Input: thread projection (`providerTurns[].tokenUsage`: `inputTokens`, `cachedInputTokens`, `promptCacheTtlMs`, `promptCacheExpiresAt`, `updatedAt`). Evaluated on the latest turn (by request time = `tokenUsage.updatedAt`, else `completedAt`, `startedAt`; then ordinal).

1. **reported**: latest turn has `promptCacheExpiresAt` -> use it. `ttlMs` = `promptCacheTtlMs`, else `expires - request`.
2. **carried**: no expiry, and the request was a full cache read -> take the TTL of the most recent earlier turn of the SAME provider that reported one, `expiresAt = lastRequestAt + ttl`.
3. **assumed**: otherwise `lastRequestAt + default[provider]`. Provider with no default: `expiresAt: null`.
4. No provider turn -> `null`.

Full read: `cachedInputTokens > 0` and (`inputTokens` 0/absent or `cachedInputTokens >= inputTokens`). The live run (below) showed T3 Code's Claude `inputTokens` INCLUDES the cached part (input 52922, cached 44764), so "input is 0" alone would never match.

Provider = `providerThreads[].driver` of the turn's provider thread (fallback thread `providerInstanceId`). Carry never crosses a provider switch.

Clock skew: a request time more than 60 s ahead of the local clock is clamped to now for carried/assumed arithmetic. `reported.expiresAt` passes through (server absolute time; consumer compares with its own clock).

## Assumed defaults (ESTIMATES)

| Driver | TTL | Source | Fetched |
|---|---|---|---|
| `claudeAgent` | 5 min | https://platform.claude.com/docs/en/build-with-claude/prompt-caching: "By default, the cache has a 5-minute lifetime. The cache is refreshed for no additional cost each time the cached content is used." (1 h option exists, never assumed) | 2026-11-19 |
| `codex` | 5 min | https://developers.openai.com/api/docs/guides/prompt-caching: "Entries typically remain active for around 5 to 10 minutes of inactivity, up to one hour." Low end used so the countdown errs early. | 2026-11-19 |

Other drivers: no default, `expiresAt: null`. Same values sit in code comments.

## Decisions

- **Assumed table is not settable from a plugin.** The frozen `T3Cache` has no setter, so the table lives in the runtime. cache-watch applies its own override on top for `source: "assumed"` states (`lastRequestAt + minutes`), and settings feed that. `t3.cache.state` itself always returns the built-in default.
- **No second subscription.** `CacheStore` reuses the shared shell thread store (`threadStore`, one `subscribeShell` per renderer) to see a thread's `updatedAt` change and refetches `orchestration.getThreadProjection` (min 2 s apart, max age 30 s). `t3.timeline` does not keep token usage, so it cannot feed this.
- `state()` on an unknown thread or a dropped socket resolves `null`, never throws (except permission/argument errors).
- `onExpiring` polls (every <= 15 s, so an extended expiry is noticed), fires once per distinct `expiresAt`, never for an already expired cache, stops on scope dispose.
- The plugin shows `?` for unknown expiry and `expired` after the time passed.

## Evidence

Unit tests: `renderer-runtime/test/cache-rules.test.ts` (reported, carried incl. skipped turns, cached>=input, assumed, unknown provider, no usage, expired, skew, provider switch both ways, out-of-order turns), `cache.test.ts` (store, one fetch + one shell subscription, onExpiring once, no fire when expired, dispose leaves 0 timers, permission, unknown thread -> null), `plugins/cache-watch/test/model.test.ts`.

Countdown math vs a recorded-shape fixture: `test/fixtures/cache-projection-claude.json` is HAND-BUILT from the WP-0D projection shape plus the schema's tokenUsage fields, not a capture; tested to give carried 1 h from the newest request and 59:30 / 30:00 / 0 left at three moments.

Rig, slot 2, patched 0.1.10, plugin copied to `p-s2/.t3-patcher/plugins/cache-watch`, `t3p enable` + `grant rpc` with `T3P_HOME` set:
1. Plugin loads (`loadResults ok`). Sidebar section and rightPanel mount on `#/settings/general` (the sidebar anchor does not exist on `#/welcome`). `t3.cache.state("no-such-thread")` -> `null`, no error (a throwaway probe plugin on the slot, removed after).
2. **Live Claude check** (master unblocked a Claude login on rig): created a thread (`claudeAgent`, `claude-sonnet-5-5`) through `orchestration.dispatchCommand` (`thread.create`, `message.dispatch`), two tiny prompts.
   - Turn 1 projection: `promptCacheTtlMs 3600000`, `promptCacheExpiresAt 2026-11-19T04:15:04.836Z`, `updatedAt 03:15:04.898Z`. `t3.cache.state` -> `{expiresAt: 1795061704836 (= 04:15:04.836Z), ttlMs 3600000, source "reported", lastRequestAt 1795058104898}`: equal to the server value.
   - Turn 2: `promptCacheExpiresAt 04:15:48.684Z`, state `expiresAt 1795061748684`, same: equal. Cache extended by the read, as the docs say.
   - UI text from the mounted roots at that moment: sidebar `Prompt cache / wp4c cache probe / 59:24 reported`, rightPanel `wp4c cache probe 59:24 reported` (consistent with 04:15:48 minus now).
3. Both live turns reported a TTL, so the **carried** and **assumed** paths were NOT exercised live (fixture tests only).
4. `tools/rig/stop.ps1 -Slot 2`: clean.

## Not verified

- `threadHeader` slot: no thread route was opened in the app window (threads were created over RPC, not navigated to), so the header badge was not seen live.
- Toast before expiry: only unit-tested with fake timers; waiting 1 h on a real cache was skipped to save usage.
- Codex: not installed on the rig, so the `assumed` default for it is docs-based only.

## Rig test threads

Always use `claude-haiku-4-5` (the Haiku the rig provider offers; no effort option) for threads created on rig for testing (the maintainer's rule, 2026-11-19): they do no real work.
