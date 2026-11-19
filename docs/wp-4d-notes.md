# WP-4D notes: session-inspector

Plugin `plugins/session-inspector` (id `session-inspector`, tier 1, permission `rpc`). See its README for behaviour.

## Acceptance

- `pnpm -r build`, `pnpm -r test`, `pnpm lint`: exit 0 (plugin: 47 tests, 28 pure logic on the `@t3p/timeline` fixtures, 19 jsdom panel).
- jsdom (`test/panel.test.ts`) drives the panel on fixture timelines: render, expand a cause chain (resolved approval to user message, 5 hops), click a hop, filters (group and text), raw JSON, JSON export (full and filtered), 5000-record windowing (<60 DOM rows), live records and the now-line, `thread:focus`, all-sessions rows, subscription cap, empty state, list failure, dispose (DOM, subscriptions, timers), theme refresh, no HTML injection.

## Decisions

- Subscription cap: 6 (`MAX_SUBSCRIPTIONS`). Shown thread first, then running threads while the All sessions tab is open.
- Model per row is derived (records carry only `provider`): run `modelSelection`, else last switch event.
- Duration: item `startedAt`/`completedAt`; run/subagent start to end; approval request to resolution. Open spans grow live.
- Provider-log enrichment skipped: `enrichFromProviderLog` is not on the public `t3` API. No `fs.read`/`log.tail` requested.

## API gaps

1. No `t3.timeline.enrich` (or similar) for provider-log enrichment.
2. No current-environment accessor. The `#/<env>/<thread>` route needs the environment id; the plugin uses `raw.environmentId` of a thread row if present, else the env of the last thread route seen. Real shell rows: not checked for `environmentId` (only one thread existed).
3. `t3.ui` has no way to open the right dock; the panel is behind the dock's "Plugins" toggle.

## Rig evidence (slot 3, stock 0.1.10, patched with `tools/rig/patch-slot.ps1`)

Plugin copied to `p-s3/.t3-patcher/plugins/session-inspector`, `t3p enable` + `t3p grant session-inspector rpc` with `T3P_HOME` set in the same rig shell.

1. Fresh profile: `loadResults` has `session-inspector ok`; `__t3p.ui.mounted()` shows `rightPanel@main[data-slot=sidebar-inset]`.
2. Claude login on rig (master): `t3.providers.list()` shows `claudeAgent` ready, authenticated (Claude Max).
3. Test-only helper plugin `si-probe` (in the slot's plugin dir only, not in the repo) stored `t3` on `globalThis.__si_t3` so cdp-eval could call RPC. Not part of the deliverable.
4. Live run: `projects.ensureScratch`, `thread.create` (haiku, approval-required), `message.dispatch` ("run `echo hello-inspector`"), hash navigated to `#/<env>/<thread>`:
   - Panel followed the thread: 0 records and `empty` before the prompt.
   - Sampled 4 s after dispatch: now-line `running`, `Running: Tool PowerShell`, 4 records.
   - Final 8 records: `run.start, message.user, reasoning, tool, reasoning, message.assistant, checkpoint, run.end`; run `7.0 s`, tool `1.0 s`, provider/model column `claudeAgent · claude-haiku-4-5`.
   - Cause chains (real): tool: `in run` then `triggered by` user message; assistant message: same; `run.end`: `ends` run.start then `triggered by` user message. Clicking the last hop selected `message.user`.
   - Raw event: 1189 chars JSON of the tool turn item.
   - No approval request arose (the PowerShell tool ran without one under `approval-required`), so the approval chain and the `approval` now-line state were NOT seen live (jsdom covers them).
5. Bug found live and fixed: the 1 s tick skipped re-rendering while idle, so "Idle just now" never aged. Now re-renders every tick. After redeploy and relaunch, history replay from the server rendered the same 8 records and `Idle 1m ago`.
6. All sessions tab: one row `si live check | Idle | claudeAgent · claude-haiku-4-5 | 1m ago`, current marked, footer `1 active thread · 1/6 timelines tracked`. From `#/welcome`, clicking the row navigated to `#/<env>/<thread>` (env from the last seen thread route).
7. Model rule: master asked for `claude-haiku-5-5` at low effort. The slot's `providers.list()` offers only `claude-haiku-4-5` (option `thinking`, no effort) and no haiku 5.5. The single test thread used `claude-haiku-4-5` (created before the instruction arrived); no Sonnet/Opus was used, and no further Claude threads were created after the instruction. Master decides whether to allow haiku-4-5 for more runs.
8. `tools/rig/stop.ps1 -Slot 3`: run at the end.

## Not verified live

- Approval chain and `Waiting for approval` now-line (no approval occurred).
- Subagent and provider-switch chains (jsdom/fixtures only).
- Visual look of the dock (no screenshot taken; the dock is collapsed by default).
- `environmentId` on real thread-list rows.
