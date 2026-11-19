# WP-3D notes: UI slots, tier 2 captures, commands, keybinds, patches, Plugins page

Target: T3 Code 0.1.10 (hash router `t3code://app/#/...`, TanStack Router, React).

## Code map

| Piece | File |
|---|---|
| Shell (composes everything, `$self` target `t3p.core`) | `packages/renderer-runtime/src/shell.ts` |
| Slot engine (anchors, MutationObserver, dock) | `.../src/ui/slots.ts` |
| Toast, modal | `.../src/ui/overlays.ts` |
| themeVars | `.../src/ui/theme.ts` |
| Plugins page | `.../src/ui/plugins-page.ts` |
| DOM fallbacks (nav, palette) | `.../src/ui/fallbacks.ts` |
| Commands, keybinds | `.../src/commands.ts`, `.../src/keybinds.ts` |
| Capture hub (renderer side) | `.../src/internals.ts` |
| Capture patches (main side) | `packages/main-runtime/src/patches/captures.ts` |
| Status file writer | `packages/main-runtime/src/internals/status.ts` |
| Plugin patch IPC parsing | `packages/main-runtime/src/patches/wire.ts` |
| Doctor checks | `packages/installer/src/doctor.ts` (`internalsChecks`) |
| Demo plugin | `plugins/_demo-slots` (copy to a folder named `demo-slots`) |

`createT3` (`t3.ts`) takes an optional `shell`; with it, `ui/commands/keybinds/patches/internals` are the real ones (merged over the stubs).
`stubs.ts` still lists those five (dead code now, left to avoid a merge fight with WP-3B).

## Why no Shadow DOM

Plugin UI renders into a plain `div` in the app's own document. The app's theme is CSS custom properties on `:root`/`.dark`
(`--background`, `--foreground`, `--border`, ...). Custom properties inherit through the light DOM, so
`color: var(--foreground)` just works and follows theme changes. A shadow root would cut off the app's Tailwind
utilities and force plugins to re-inject styles. Cost: plugin CSS can leak, so roots carry `data-t3p-root`, `data-t3p-plugin`,
`data-t3p-slot`, `data-t3p-id`, and plugins should scope selectors under them.

## Slot anchors

Found by `data-slot` / stable attributes, never by minified classes. `SlotEngine.sync()` runs from a `MutationObserver` on
`<html>` (childList, subtree; own mutations ignored) plus `hashchange`/`popstate`, debounced 40 ms. Mounts whose anchor or container
left the document are torn down (plugin cleanup runs) and rebuilt when the anchor returns, so UI survives route changes and React re-renders.
One container per (slot, anchor); each registration gets its own root, ordered by `order` (CSS `order`).

| Slot | Anchor | Placement |
|---|---|---|
| sidebarSection | `[data-slot="sidebar-content"]` | appended |
| threadHeader | `[aria-label="Thread breadcrumb"]` | container after its `header` |
| composerBanner | `[data-chat-composer-surface="true"]` | before the composer card |
| rightPanel | `[data-slot="sidebar-inset"]` | own dock (tabs per registration, collapsed, "Plugins" toggle). Upstream has no right panel |
| statusBar | `document.body` | own fixed 22 px bar. Upstream has no status bar |
| settingsPage | `[data-t3p-slot-anchor="settingsPage"]` | area at the bottom of the Plugins page |
| timelineRowDecorator | `[data-timeline-row-id]` (max 400) | appended in the row; `ctx.record` is `null` (WP-3C record lookup not wired) |
| contextMenuItem | `[data-slot="menu-popup"]`, `[role="menu"]` (visible) | appended |

`ctx.threadId`: captured router `state.matches[].params.threadId`, else the hash `#/<env>/<thread>`. `thread:focus` is emitted by the shell on change.

## Tier 2 captures

Each is ONE built-in patch set (owner `t3p.core`), `T3P_CAPTURES_OFF=name,name|all` switches them off (used to prove fallbacks). The patched app code calls
`window.__t3p_plugins["t3p.core"].capture(name, value)`. Status `captured|fallback|failed` is reported to main (`t3p:internals:report`),
merged with the patch engine's verdict (a failed patch turns `captured` into `failed`) and written to `<T3P_HOME>/.t3-patcher/internals-status.json`.
`t3p doctor` prints one `internal: <name>` line per capture (`failed` fails the check; no file yet is ok).
`t3.internals.get(name)` returns the handle or null; `status()` maps failed/pending to `missing`.

| Capture | Patch target (0.1.10) | Fallback |
|---|---|---|
| atomRegistry | `utils-*.js`: `X=createRegistry();function Provider(...)`. Also captures React `createElement` | none (`failed`); Plugins route needs it |
| router | main chunk: `return createRouter({routeTree,history,...})` | `location.hash` navigation |
| shortcutDispatcher | `dispatcher-*.js`: `registerCommands` | guarded document keydown (ignores inputs/editable targets) |
| settingsNav | main chunk route map (adds `ChatSettingsPluginsRoute`, cloned from About), `settingsSearch-*.js` label/group, `_chat.settings-*.js` icon map | nav button injected after "About" + overlay page |
| commandPalette | `commandPaletteBus-*.js`: `filterCommandPaletteGroups` input gets a `t3p-commands` group | group injected into the open `[data-slot="command-list"]` |

Gotchas: minified identifiers contain `$` (use `[\w$]`); the cloned route must set `isRoot = false` after construction or TanStack never matches it; the dispatcher
treats any `onKeyDown` result other than `false` as consumed, so the keybind handler returns `false` when nothing matched.

## Commands, keybinds, patches

- `t3.commands`: global id `<plugin>:<id>`; entries appear in the palette. Built-in `t3p.core:open-plugins`.
- `t3.keybinds`: chord `mod+shift+k` (`mod` = Cmd on macOS, Ctrl elsewhere). Dispatcher mode when captured (runs from editable targets only for chords with ctrl/meta/alt), else document mode.
- `t3.patches.register`: needs the `patches` permission (checked in the renderer for the error and again in main via `host.permissionsFor`). Regexes travel as `{regex:{source,flags}}`, bounded and compiled in main (`wire.ts`), owner forced to the calling plugin, unregistered on scope dispose. Patches apply to chunks served after registration.

## Plugins page

Route `/settings/plugins` (nav "Plugins" in the More group). Cards: name, version, tier, status, error, `trusted` pill. Enable switch only for plugins whose manifest declares none of
main/patches/spawn (WP-3A rule; others use `t3p enable`). Each started plugin's `t3.settings` schemas render as switch/select/number/text with Reset.

## Rig evidence (slot 2, stock 0.1.10, fresh unauthenticated profile, demo plugin `demo-slots`)

All via `tools/rig/cdp-eval.mjs --slot 2`.

1. Captures, normal run: `window.__t3p.internals.detail()` -> all five `captured`; `t3p doctor` (run on rig with `T3P_HOME`): five `ok internal: X: captured: app object captured by patch`.
2. Mounted roots (`window.__t3p.ui.mounted()`): on the welcome/settings screens `sidebarSection@div[data-slot=sidebar-content]`, `rightPanel@main[data-slot=sidebar-inset]`, `statusBar@body`, and on the Plugins page `settingsPage`. 4 `[data-t3p-plugin=demo-slots]` roots.
3. Palette: Ctrl+K (captured dispatcher) lists "Plugins: open settings page" and "Demo: say hello"; clicking it ran the command (`__t3p_demo.count` 1, toast shown).
4. Keybind `alt+shift+h` fired through the dispatcher (`keybindMode()` = `dispatcher`, count 2).
5. Plugins page at `#/settings/plugins`: route matches `/_chat/settings/plugins`, card lists name/version/tier/status; toggle off -> roots 0 and status `inactive`; toggle on -> 4 roots, `started`; the "Loud" switch changed the setting (`getSetting` true).
6. Fallbacks (`T3P_CAPTURES_OFF=router,shortcutDispatcher,settingsNav,commandPalette`): statuses `router/shortcutDispatcher/settingsNav/commandPalette = fallback`, atomRegistry `captured`; doctor shows `fallback: ...` for those four; DOM palette group listed both commands; document keydown fallback ran the command (`mode` = `document`); injected "Plugins" nav button opened the overlay page with the card.
7. `tools/rig/stop.ps1 -Slot 2`: slot clean.

## Gaps

- NOT exercised on rig: `threadHeader`, `composerBanner`, `timelineRowDecorator`, `contextMenuItem`, and the thread-id path. The fresh profile has no environment, project or thread (no sign-in), so those anchors never exist. Anchors were taken from the 0.1.10 client source, not seen in a live DOM. Unit tests (jsdom) cover the engine mechanics only for sidebarSection/rightPanel/statusBar.
- `timelineRowDecorator` gives `record: null`.
- Palette items use `icon: null`; it rendered without crashing, but item styling vs. native items was not compared visually.
- `doctor` "exe signature" fails on rig (no Authenticode output); unrelated.
- The third settingsNav patch (`settingsSearch-*.js`, lazy chunk) shows `pending` until that chunk loads; the capture still reports `captured` from the main-chunk patch.
- Dead stubs for the five namespaces remain in `stubs.ts` (WP-3B edits that file).
- `window.__t3p.ui` and `window.__t3p.internals` are diagnostics, not part of `@t3p/api`.
