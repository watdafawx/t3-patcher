# Session inspector

A [T3 Patcher](../../README.md) plugin. Id `session-inspector`, tier 1, permission `rpc`, `t3pApi` 1.

A panel in the right-hand dock ("Plugins" toggle, tab **Inspector**) with two tabs.

## Timeline tab (current thread)

- **Now line** at the top: the latest in-progress thing. Waiting for approval / input, running a command or tool, streaming a reply, run in progress, or idle (with the age of the last event). Click it to jump to that record.
- **Rows**: time, how long, provider and model, kind icon, summary, and the relation to its cause. Durations come from `raw.startedAt`/`completedAt` of turn items, from start/end pairs (run, subagent) and from request to resolution (approvals). A leading `▸` marks a span that is still open and grows live.
- **Why**: click a row. The detail pane lists its cause chain up to the root (`↑ approval for`, `↑ in run`, `↑ triggered by`, ...). Click a hop to scroll to that record (filters are cleared when they hide it).
- **Raw event**: collapsible JSON of `record.raw`.
- **Filters**: kind groups (messages, tools / commands, approvals, errors, provider / model, subagents, runs, other) and a text filter (summary, kind, provider, status).
- **Export JSON**: downloads the current (filtered or full) timeline with durations and `raw` as `session-<thread>-<time>.json` (Blob + anchor click).
- Follows the thread you open (`thread:focus`). The list is windowed (fixed 26 px rows): only the visible rows plus a few more exist in the DOM, so thousands of records stay smooth. It sticks to the tail until you scroll up.

## All sessions tab

Every non-archived thread from `t3.threads.list()`: title, current activity line, provider and model, age of the last event. Click a row to open the thread through the hash route `#/<environmentId>/<threadId>`.
The list is re-read every 5 s while the tab is open.

**Subscription cap: 6** (`MAX_SUBSCRIPTIONS` in `src/store.ts`). A thread timeline is subscribed only when it is shown (the current thread, always first) or running while the All sessions tab is open. Anything over the cap shows `Running (not tracked: subscription cap reached)`; idle threads show `Idle` and the age from the shell's `updatedAt`. Leaving the tab releases the extra subscriptions.

## Layout

| Path | What |
|---|---|
| `src/logic/` | Pure modules: `filter`, `durations`, `chain`, `nowdoing`, `models`, `export`, `window`, `route` |
| `src/store.ts` | `ThreadFeed` (records upserted by id) and `FeedPool` (the cap) |
| `src/ui/panel.ts` | DOM panel (no framework, no `innerHTML`; record text is always `textContent`) |
| `test/` | vitest. `logic.test.ts` on the `@t3p/timeline` fixtures, `panel.test.ts` in jsdom |

## Theme

CSS only: colours are `--si-*` variables resolved from `t3.ui.themeVars()` (`--foreground`, `--border`, ...) with `var(--app-var, fallback)` when a token is missing, refreshed on theme change.

## Build, test, load

```sh
pnpm build        # t3p-plugin-build -> dist/renderer.js
pnpm test         # vitest (logic + jsdom panel)
t3p dev .         # link + enable (grant rpc: t3p grant session-inspector rpc)
```

## Not done

- **Provider-log enrichment is skipped.** `enrichFromProviderLog` lives in `@t3p/timeline` but the public `@t3p/api` / `t3` does not expose it (and a plugin bundle may not import the timeline package at runtime without duplicating the normalizer). No `fs.read` / `log.tail` permission is requested. Needs an additive API (for example `t3.timeline.enrich(threadId)`).
- **Environment id.** The API has no "current environment" accessor. The id for `#/<env>/<thread>` is taken from the row's `raw.environmentId` when present, else from the last thread route seen in `location.hash`. Before any thread was opened (and with no `environmentId` on the row) a click shows a hint instead of navigating.
- A tool row of a run that crashed without a terminal status keeps counting as "open" only while its run is open; a dead run is shown as idle.
