# Provider limits

A [T3 Patcher](https://github.com/pingdotgg/t3code) plugin. Plugin id: `provider-limits`,
tier 1, permissions `rpc` and `guard` (the turn guard; without `guard` the rest works and the guard stays off). It runs entirely on the public `t3` API
([`packages/api/src/t3.ts`](../../packages/api/src/t3.ts)).

Every provider instance from `t3.providers.list()`, its auth state and each usage-limit
window, with live reset countdowns, a worst-case status bar chip, and warn/critical toasts.

## What it adds

| Surface | Behaviour |
|---|---|
| Status bar chip | Worst window across every provider instance: `Codex 76% · in 4d 15h`. Colored by threshold (ok/warn/critical). Click opens the panel. Hidden when `showChip` is off. |
| Panel | One card per provider instance: label + instance id, status, auth state, enabled/installed/version, every window (label, kind, percent bar, live countdown, window duration), reset credits, and the `unavailable` note. Providers without `usageLimits` show `no limit data`; an empty window list shows `no windows reported`. |
| `rightPanel` dock | The same panel, mounted in the T3 Patcher "Plugins" dock (collapsed there until its toggle is pressed). |
| Toast | Once when a window first rises into warn or critical. Not repeated while it stays there; a drop back to `ok` arms it again. The first snapshot only seeds the state, so a reload does not replay old alerts. |

Commands (command palette):

- **Provider limits: refresh now** — `t3.providers.refresh()` and a toast with the result.
- **Provider limits: open panel** — opens the panel as a modal.

The status bar chip and the `open panel` command both open the panel as a modal: the public
API (`t3.ui.register`, `t3.ui.modal`) has no call that expands the right-panel dock or
activates one of its tabs, so the panel content is mounted in the dock for permanent use
and in a modal for one click. The modal body and the dock share one renderer and one
subscription, and both are unmounted when the plugin stops or the modal closes.

## Turn guard: low-quota prompt

Before a message, new thread or delegated task starts on a provider with less than
`guardThresholdPercent` left in any window (session or weekly, the lower wins), the plugin asks
what to do. Needs `t3p grant provider-limits guard`.

The prompt (title `<Provider> is almost out (4% left)`, the reset time, the proposed switch):

| Button | Result |
|---|---|
| **Switch to `<model>`** (primary) | The turn starts on that model (and provider). Remembered for the thread for 10 minutes. |
| **Keep going** | The turn runs as sent. Remembered for the thread for 10 minutes. |
| **Cancel** | The send is blocked with a reason. Not remembered. |

Closing the prompt without a button (click on the toast body, or the composer leaving the screen) is
**Keep going**: a stray click never throws a message away. If nobody answers before the guard
timeout (118 s) the turn is allowed, the prompt is removed and nothing is remembered. One prompt
per thread: a second send while it is open shares its answer.

**Where it shows** (`guardPresentation`): `toast` (default) is a persistent toast in the bottom-right
stack. `composer` docks a `t3p-banner` right above the prompt box through the `composerBanner` slot
(slide and fade up in 180 ms, ease-out, and the same on exit; instant under reduced motion). If no
composer is on screen it falls back to the toast.

**Which model it proposes**:

1. `guardFallback` (optional override, `<provider instance>:<model>` or a bare model), if set.
2. Your **favorite models**, in your order. They are read from the server settings:
   `t3.rpc.call("server.getConfig", {}).settings.favorites` (`[{ provider, model }]`), the list the
   model picker's star edits. An unmigrated server reports `null`, treated as no favorites.
3. Then the default model of each other provider.

Each candidate is judged by its own provider: skipped when that provider is also under the threshold,
signed out, errored, disabled, missing, or no longer offers the model. A provider that reports no
limit data is allowed but ranked after every candidate with known headroom. The toast says why it
picked it (`next favorite with 62% left`). When nothing has headroom it says
`No favorite has headroom: gpt-6.1-sol 1%, ...` and offers only Keep going and Cancel.
Turning `guardUseFavorites` off skips step 2.

## Settings (Plugins settings page)

| Key | Type | Default | Meaning |
|---|---|---|---|
| `warnThreshold` | number (0-100) | 80 | Used percent at which a window is `warn`. |
| `criticalThreshold` | number (0-100) | 95 | Used percent at which a window is `critical`. |
| `showChip` | boolean | true | Show the status bar chip. |
| `refreshSeconds` | number (5-3600) | 60 | How often to call `t3.providers.refresh()`. |
| `guardThresholdPercent` | number (0-100) | 5 | Ask before a turn when the provider has less than this left. 0 = guard off. |
| `guardUseFavorites` | boolean | true | Propose your favorite models (then provider defaults) as the switch target. |
| `guardFallback` | string | empty | Optional override tried first: `<provider instance>:<model>`. |
| `guardPresentation` | `toast` \| `composer` | `toast` | Show the prompt as a toast or as a banner above the composer. |

Changing a threshold re-classifies immediately without firing a toast (a toast is a
crossing, not a settings change). Changing the interval restarts the timer.

## Build

```sh
pnpm install            # from the repo root
pnpm --filter @t3p/provider-limits build    # t3p-plugin-build -> dist/renderer.js
pnpm --filter @t3p/provider-limits test     # vitest unit tests (pure logic)
```

`t3p-plugin-build` validates `plugin.json`, then bundles `src/index.ts` into one ES module,
`dist/renderer.js`, with every dependency inlined. `@t3p/api` is types only.

## Load it into T3 Code

```sh
t3p dev plugins/provider-limits    # link, enable and turn on hot reload
```

or copy the folder to `<T3P_HOME>/.t3-patcher/plugins/provider-limits/` (the folder name
must equal the manifest id) and enable it with `t3p enable provider-limits`. The plugin
needs the `rpc` permission declared (it is) and granted.

## Layout

| File | Purpose |
|---|---|
| `plugin.json` | Manifest: id, version, tier 1, `permissions: ["rpc"]`, `renderer: dist/renderer.js`. `t3pApi` is omitted, which means `"1"` (the validator default). |
| `src/index.ts` | Plugin entry: settings, snapshot store, timers, chip/panel slots, commands, teardown. |
| `src/model.ts` | Pure: `chooseFallback` (favorites, limits, override), favorites parsing, remaining percent. |
| `src/guard.ts` | Pure: guard evaluation, prompt text, answer to decision, per-thread memory. |
| `src/prompt.ts` | Prompt flow: toast or composer banner, one pending per thread, timeout. |
| `src/banner.ts` | Composer banner DOM and its enter/leave state machine. |
| `src/limits.ts` | Pure: threshold classification, formatting, worst-case selection, provider view model. |
| `src/crossings.ts` | Pure: rising-crossing detection for the toasts. |
| `src/panel.ts` | DOM rendering of the chip and the panel. |
| `src/theme.ts` | `var(...)` theme tokens from `t3.ui.themeVars()`, with threshold accent fallbacks. |
| `test/*.test.ts` | Vitest suite for the pure modules, on synthetic snapshots from the WP-0D fixtures. |

## Behaviour notes

- **Percent scale.** `usedPercent` is a percentage in `0..100`, not a fraction. Verified in
  `.upstream/packages/contracts/src/providerUsageLimits.ts` (vendored as
  `packages/contracts-vendor`): `ServerProviderUsageWindow.usedPercent` is
  `isBetween({ minimum: 0, maximum: 100 })`. The UI clamps and rounds for display.
- **Missing data.** A provider with no `usageLimits` is not an error: it shows
  `no limit data`. `usageLimits.unavailable` (`unsupported` or `probeFailed`) is shown as
  `limits unavailable (<reason>)`, with the server's message when present. Providers with
  no windows do not win the chip; with no windows anywhere the chip reads `Limits: no data`.
- **Resets in the past.** `resetsAt` at or before the current time renders
  `reset overdue` rather than a negative countdown. `resetsAt` absent renders
  `no reset time`.
- **Timers.** One 1 s tick refreshes the countdowns; one interval calls
  `t3.providers.refresh()` every `refreshSeconds`. Both are cleared by the cleanup returned
  from `start()` and by `stop()`, and the provider/settings subscriptions and every `t3`
  registration are disposed with the plugin.
- **Theme.** Text, borders and surfaces are app CSS variables; the only literal colors are
  the three threshold accents, and only as `var(--success|--warning|--destructive, #...)`
  fallbacks for a theme that does not define them.
