# Provider limits

A [T3 Patcher](https://github.com/pingdotgg/t3code) plugin. Plugin id: `provider-limits`,
tier 1, permission `rpc` only. It runs entirely on the public `t3` API
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

## Settings (Plugins settings page)

| Key | Type | Default | Meaning |
|---|---|---|---|
| `warnThreshold` | number (0-100) | 80 | Used percent at which a window is `warn`. |
| `criticalThreshold` | number (0-100) | 95 | Used percent at which a window is `critical`. |
| `showChip` | boolean | true | Show the status bar chip. |
| `refreshSeconds` | number (5-3600) | 60 | How often to call `t3.providers.refresh()`. |

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
