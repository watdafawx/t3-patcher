# Provider switcher

A [T3 Patcher](../docs/plugin-authoring.md) plugin that changes the focused thread's model or
provider from the thread header or the command palette. Plugin id: `provider-switcher`, tier 1,
permission `rpc`, `t3pApi` `"1"`.

Everything goes through the public `t3` API (`packages/api/src/t3.ts`); the plugin renders no
patches, reads no internals and opens no second RPC socket.

## What it does

| Piece | Where | Behaviour |
|---|---|---|
| Header control | `threadHeader` slot | Shows the focused thread's provider and model (`Claude · Opus 5.5`). A click opens the menu. |
| Menu | plugin-rendered panel | Every provider instance with its models. Only installed, enabled, ready/warning providers are selectable; the rest stay listed, disabled, with the reason (`not installed`, `signed out`, `disabled`, ...). The current model is marked and sorted first in its group. |
| Switch | menu, favourites, suggestion | Same provider calls `t3.threads.setModel`; another provider calls `t3.threads.switchProvider`. |
| Result handling | shared | `ok` → success toast. `busy` → a modal offering **Switch when the run ends**. `unavailable` / `error` → toast with the server's message. |
| Switch-when-idle queue | `src/queue.ts` | One `t3.threads.subscribe` on the queued thread; when no run is active it retries **once**. A retry that is busy again gives up with a toast (no loop). The header shows `Queued: <model>` with a **Cancel** button. Cancelling, focusing another thread or queueing a second switch ends the wait. |
| Commands | `t3.commands` | `Switch model…` and `Switch provider…` open the same menu centred on screen. One `Switch to <model>` command per favourite. |
| Usage-limit suggestion | `src/suggestion-rule.ts` | Optional. When the current provider's worst usage window reaches the threshold, offers the least-used usable provider once per thread per crossing. |

The worst window is the provider's highest `usedPercent` across all of its windows (model-scoped
windows count too); a provider that reports no window is never suggested over a measured one, and
the current provider must report at least one window.

## Settings

| Key | Type | Default | Meaning |
|---|---|---|---|
| `favourites` | string | `""` | One `instanceId:model` per line (`claudeAgent:claude-sonnet-5-5`). Blank lines and `#` comments are ignored; each unique line becomes a palette command. |
| `suggestOnLimit` | boolean | `false` | Turn the usage-limit suggestion on. |
| `limitThreshold` | number | `90` | Percent of the worst usage window that triggers the suggestion. |

## The busy result

The server rejects a provider change while a run is active
(`OrchestratorProviderSelectionBusyError`), which `t3.threads` reports as `{status: "busy"}`. The
plugin then asks whether to queue the switch, watches the thread's run statuses
(`run.created` / `run.updated` pinned against the projection snapshot) and retries exactly once when
the thread is idle. If that retry is busy too, the switch is dropped with a warning toast: a loop
against a thread that keeps starting runs would never settle.

## Theme

The plugin renders in the app's own document, so it styles itself with the app's CSS custom
properties (`var(--popover)`, `var(--foreground)`, `var(--border)`, `var(--radius)`,
`var(--font-sans)`, ...). `t3.ui.themeVars()` supplies the fallback inside each `var()`, so a token
the app does not define still resolves to the current theme. No stylesheet is injected and nothing
global is styled; every element the plugin adds carries `data-t3p-plugin="provider-switcher"`.

## Teardown

Slot registrations, commands and listeners are registered through `t3` and disposed by the runtime.
The queue owns one thread subscription and one listener set; `start` returns a cleanup that disposes
them, so disabling or hot-reloading the plugin leaves no stream, timer or element behind.

## API notes and gaps

- **Toast has no action button.** `t3.ui.toast` takes a title and a message only, so the
  actionable usage-limit suggestion is a `t3.ui.modal` with `["Dismiss", "Switch"]`. A toast is used
  for the outcome only. This is a gap in `@t3p/api` (`ToastOptions` has no action), reported rather
  than worked around.
- **No live event for "the model changed".** The header repaints from the thread stream's
  `thread.model-selection.set` and `provider.switch` events plus `t3.providers.onChange` and
  `thread:focus`.
- **`options` on a selection.** Selections carry `{instanceId, model}` only: provider-specific
  options (reasoning effort and so on) are left to the server's defaults for the chosen model.
- **Wire shapes.** Provider models, usage limits and the thread projection are read through the
  type-only wire shapes the API documents as the tier 1 exception; the mapping lives in
  `src/map.ts` alone.

## Layout

| File | Purpose |
|---|---|
| `src/index.ts` | Entry: settings, queue, header, commands, suggestion rule |
| `src/queue.ts` | Queue-until-idle controller over `t3.threads` |
| `src/switch.ts` | One switch plus result handling (`ok` / `busy` / `unavailable` / `error`) |
| `src/logic/grouping.ts` | Pure: usability, model grouping, `setModel` vs `switchProvider` |
| `src/logic/queue.ts` | Pure: the queue state machine |
| `src/logic/runs.ts` | Pure: which runs are active (idle detection) |
| `src/logic/suggest.ts` | Pure: worst window, least-used provider, one-per-crossing gate |
| `src/logic/favourites.ts` | Pure: parse the `favourites` setting |
| `src/ui/menu.ts` | The model menu panel |
| `src/ui/header.ts` | The thread-header control and pending indicator |
| `src/ui/open-menu.ts` | Menu + switch wiring shared by the header and the palette |

## Build and test

```sh
pnpm install
pnpm build       # t3p-plugin-build -> dist/renderer.js
pnpm test        # vitest: grouping, queue, runs, suggestion, favourites, controller
pnpm typecheck   # tsc --noEmit
```

The build validates `plugin.json` first and bundles `src/index.ts` into one ES module. `@t3p/api` is
types only; the bundle has no external imports.

Load it with `t3p dev .`, grant the permission the manifest asks for, and restart T3 Code once:

```sh
t3p dev .                        # link the folder into ~/.t3-patcher/plugins/provider-switcher and enable it
t3p grant provider-switcher rpc  # declared in plugin.json; the user grants it separately
```

`pnpm build` reloads the plugin by itself while dev mode is on.
