# UI style for plugins

Plugin UI renders into the app's document (no Shadow DOM), so app CSS variables apply and
dark, light and custom themes work with no extra code. Rule: **never hard-code colors.**

## Token rules

1. Colors come only from app vars, with a neutral fallback inside `var()`:
   `color: var(--foreground, inherit)`, `border: 1px solid var(--border, currentColor)`.
2. Read vars **live** (`var(--x, fb)` in the CSS or inline style). Never copy the computed
   value into JS: it goes stale when the user switches theme.
3. Text in a tone (success, warning, error, info) uses the `-foreground` token
   (`--warning-foreground`), not the plain tone. Plain tone is for dots, bars and borders.
4. Surfaces: `--popover` (menus, toasts), `--card` (cards), `--background`. Muted text:
   `--muted-foreground`. Borders: `--border`; field borders: `--input`; focus: `--ring`.
5. Radius: `var(--control-radius, .5rem)` for controls, `var(--radius-lg, var(--radius, .5rem))`
   for cards and popovers.
6. Sizes match stock: buttons and inputs 28px (compact 24px, chip 20px), body text 12px
   (`text-xs`), meta text 11px, `font-variant-numeric: tabular-nums` on numbers.
7. Do not add scrollbar rules (the app's thin 6px scrollbar is global). Do not set z-index
   above the shared classes.

## Shared classes

Defined once in the shell style (`packages/renderer-runtime/src/ui/dom.ts`). Use them
instead of writing CSS.

| Class | Use |
|---|---|
| `t3p-glass` | Translucent blurred surface (stock dropdown look). Combine with a popover or modal. |
| `t3p-popover` | Fixed floating panel above the app. Supports `[hidden]`. |
| `t3p-toast` / `t3p-toasts` | Toast and its stack. `data-kind="success\|warning\|error"` adds a tone bar. |
| `t3p-overlay` / `t3p-modal` | Backdrop and dialog. |
| `t3p-btn` | 28px outline button. `data-primary` filled, `data-variant="ghost"` borderless. |
| `t3p-chip` | Ghost-muted inline button (status bar). `data-compact` 20px, `data-tone` colors the text. |
| `t3p-badge` / `t3p-pill` | 18px status badge. `data-tone` for success, warning, error, info. |
| `t3p-input` | 28px text field with the stock focus ring. |
| `t3p-switch` | Toggle switch. |
| `t3p-menu-item` | Row in a menu with hover and focus-visible. |
| `t3p-meta` | 11px muted caption or group heading. |
| `t3p-card` | Bordered card surface. |
| `t3p-statusbar`, `t3p-dock*`, `t3p-tab` | Shell chrome. Plugins get these through slots, do not build them. |

## Example

```ts
const pop = document.createElement("div");
pop.className = "t3p-popover t3p-glass";
const btn = document.createElement("button");
btn.className = "t3p-btn";
btn.textContent = "Refresh";
const note = document.createElement("div");
note.className = "t3p-meta";
note.style.color = "var(--warning-foreground, currentColor)";
```

Layout is owned by the shell: status bar 22px at the bottom, dock below the app header,
thread header slot is an inline row. Fill your slot, do not position yourself.
