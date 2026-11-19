# cache-watch

Prompt-cache countdown per thread. Plugin id `cache-watch`, tier 1, permission `rpc`.

- **Sidebar**: the five caches closest to expiring.
- **Thread header**: `Cache 59:24 reported` for the open thread.
- **Right panel "Cache"**: every recent thread (last 24 h, max 30), sorted by time to expiry.
- **Toast** `notifyLeadSeconds` before a cache expires (default 60, `0` = off).
- Label: `reported` (server gave the expiry), `carried` (last reported TTL reused after a request that read everything from cache), `estimate` (provider reports no TTL, per-provider default).
- Settings `ttlMinutesClaudeAgent`, `ttlMinutesCodex`: override the estimate (`0` = built-in default). They only change `estimate` rows. Applied inside the plugin, because `t3.cache` has no setter.

Build: `pnpm build` (`t3p-plugin-build`) then `t3p dev .`. Rules and sources: `docs/wp-4c-notes.md`.

## Re-warm cost

Each thread shows `~Nk ctx · re-warm ~$X` (status-bar popover rows, thread header tooltip) from
`t3.usage.context()`. Cost = context tokens / 1M x (cache write price - cache read price), using a
built-in table by model family (Claude Opus/Sonnet/Haiku, GPT/Codex). Unknown models show tokens
only. Override with the settings `cacheReadPerM` and `cacheWritePerM` ($ per 1M tokens, 0 = table).
All dollar figures are estimates (`~`). Hint: live cache = "warm: free"; expired and 50k+ context =
"cold: re-warm ~$X, new session ~$0"; under 50k = "cheap either way".
