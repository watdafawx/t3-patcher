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
- **Status bar list.** The chip "Warm N" (N = threads actively kept warm, "Warm —" when none) opens a popover listing every watched thread: title (click to open), project, provider/model, cache state with time left, a live next-ping countdown (a 1 s timer runs only while the popover is open), pings sent / max, and the last ping note. Per row: **Pause/Resume**, **Stop watching**, **Open thread**. Header: **Stop all** and **Settings**. Soonest ping first; paused, then settled threads (dimmed, "settled: paused") last. Esc or an outside click closes it.
- **Sidebar icon.** A small flame on each sidebar thread row that has a watch (dimmed when paused or settled), tooltip e.g. `Kept warm: next ping in 4m · 3/20 pings`. Built on the new `threadListDecorator` slot.
- Archiving or deleting a thread drops its watch. Pause is kept across restarts.
