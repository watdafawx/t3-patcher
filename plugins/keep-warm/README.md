# keep-warm

Keeps a thread's prompt cache warm while you are away. Port of the idea behind the Claude Code mod
[Cache Keep-Warm](https://github.com/andreichiritescu/claude-code-cache-keep-warm), rebuilt on the public T3 Patcher API
(`t3.cache`, `t3.threads`, `t3.ui`, `t3.settings`, `t3.storage`; permission `rpc` only).

- Click **Keep warm** in the thread header. Click again to stop.
- About 8 minutes before the cache would expire, the plugin sends one short message (`Keep-warm ping. Reply with just "ok". Use no tools.`) with the thread's own model. Unlike the Claude Code original, this ping is a visible message in the thread: T3 Code has no way to re-send a request outside the conversation.
- It never wakes a cold cache, never pings while a run is active, and skips caches shorter than 30 minutes.
- It stops after 20 pings in a row. Any real activity in the thread resets the count.
- **Settled threads are never kept warm.** A thread in T3's Settled section gets no pings; the header button reads "Settled: not kept warm" and is disabled (tooltip explains). A stored watch is kept, not deleted: it resumes if you un-settle the thread. Settling mid-countdown cancels the next ping. Power users can opt in with the `keepWarmSettled` setting (default off).
- Settings (Settings > Plugins): lead minutes, max pings, minimum cache length, also keep settled threads warm.
- Which threads are kept warm is stored per plugin and survives restarts.
