# artwork

Custom artwork behind the T3 Code sidebar header, plus a restyled logo. Tier 1, renderer only, **no permissions**.

<img src="../../docs/assets/screenshots/artwork-ocean.png" alt="Ocean background" width="320"> <img src="../../docs/assets/screenshots/artwork-aurora.png" alt="Aurora" width="320"> <img src="../../docs/assets/screenshots/artwork-logo.png" alt="Custom logo text" width="320">

## What it does

- **Backdrop** behind the title row, collapse button, arrows and Search row. Presets: **Aurora** (animated glow with faint rays), **Gradient** (angle), **Mesh glow**, **Image** (your own), **None**.
- **Ocean background** (off by default): a drifting field of letters behind the whole app, with click ripples. Separate from the sidebar preset, so it never replaces the aurora. See below.
- **Logo**: keep stock, custom text, custom image (height-fit), or hide the wordmark. Only the `T3 Code home` link's text/logo node is restyled; window controls, the collapse button and the back/forward arrows are never touched.
- **Main area glow** (off by default): a very faint same-style glow behind the top of the chat header.
- **Custom HTML/CSS** (off by default): write your own markup and CSS for the sidebar header or the whole app background instead of choosing a preset. See below.
- **Saved images**: pick a file (Settings > Plugins > Artwork images), it is downscaled to 1600 px, re-encoded as JPEG and saved by name. Switch by name there or with the command palette.

## Dock tab (live tuning)

Open the plugin dock (**Plugins** chip, bottom right, or command palette **Artwork: open panel**) and pick the **Artwork** tab. The dock does not cover the sidebar, so every change shows as you make it.

<img src="../../docs/assets/screenshots/artwork-panel.png" alt="Artwork dock tab" width="320">

- **Preset grid**: Aurora, Gradient, Mesh glow, Image and None, each a small live render in the current colors.
- **Color**: *Follow app accent* switch, or a fixed hue slider.
- **Look**: intensity, speed, fade height, blur, gradient angle, readability scrim, main glow. Sliders update the sidebar while you drag and save shortly after (they come from the generic `t3.ui.settingsPanel` helper, see `docs/plugin-authoring.md`).
- **Logo**: keep / text / image / hide, text and height, and the logo image picker.
- **Saved images**: thumbnail, Use, Delete, Add image.
- **Custom HTML / CSS**: see below.
- **Reset to defaults** resets every artwork setting (saved images and your custom code stay).

Everything goes through `t3.settings`, so Settings > Plugins stays in sync.

## Ocean background

Turn it on with the **Ocean background** switch (dock tab, section *Ocean background*, or Settings > Plugins > Artwork). Settings: on/off, **Ocean intensity**, **Ocean speed** (0 is a still frame), **Ocean ripples** (clicks and pointer glow). The glow follows the artwork Color setting (app accent by default); the letters use the app text color (`--foreground`), re-read every second, so dark, light and custom themes follow.

- A fixed full-viewport `<canvas id="t3p-ocean">` sits behind the app (`z-index:-1`, `pointer-events:none`). Pointer and click input are read from `window`, so the app never loses a click.
- The big opaque layers the app stacks over the page (body, the page wrappers) are made transparent while it runs; cards, menus and the composer keep their fills. The sidebar keeps its own background and the aurora.
- Pauses while the window is hidden, draws one still frame under `prefers-reduced-motion` or speed 0, and turning it off (or stopping the plugin) removes the canvas, style, listeners and animation frame.
- Code: `src/ocean.ts` (canvas engine), `src/model.ts` (`oceanParams`, `oceanPalette`), adapted from a user-supplied `ocean.js`.

## Custom HTML/CSS

<img src="../../docs/assets/screenshots/artwork-custom.png" alt="Custom HTML/CSS section of the Artwork dock tab" width="320">

Dock tab, section **Custom HTML / CSS**. Two targets, each with an enable switch, an HTML editor and a CSS editor (monospace, resizable):

| Target | Where it lives | While on it replaces |
|---|---|---|
| **Header / logo area** | absolute layer at the top of the sidebar column, behind the title row (`z-index:-1`) | the sidebar preset (Aurora, Gradient, Mesh, Image) |
| **App background** | fixed full-window layer behind the app, same slot as Ocean | the Ocean canvas (it comes back when you turn Custom off) |

- **Start from current preset** fills the editors with the active preset's generated markup and CSS (the background gets the same glow scaled to the window; the Ocean canvas cannot be exported as markup). Turning a target on with empty editors does this for you. **Reset to preset** asks, clears the editors and turns the target off, so the stock preset shows again.
- **Live preview**: typing applies after 250 ms. Invalid input is never applied: errors show under the editors with line numbers and the last good version stays on screen.
- In your CSS, `:root` (also `html`, `body`) is the container itself, already positioned, clipped and click-through. Everything else is prefixed with the container selector, so it cannot reach the dock, Settings or the app. `@media`, `@supports`, `@container`, `@layer` and `@keyframes` work (keyframe names are prefixed). Use app variables only (`var(--primary)`, `var(--foreground)`...): a hard-coded color shows a warning.
- Containment: the root has `pointer-events:none`, `overflow:hidden`, `isolation:isolate` and `contain:layout paint style`, protected from your CSS. Animations pause while the window is hidden and stop under reduced motion.

### Safety rules

- **HTML** is parsed with `DOMParser` and cleaned: `script, iframe, frame, object, embed, link, meta, base, form, input, button, textarea, select, style, template, canvas, audio, video` and svg `animate`/`set` are removed, as are every `on*` and `data-*` attribute, `srcset`, `name`, `tabindex` and similar. `href` keeps only `#fragment`; `src` keeps only `data:image/(png|jpeg|webp|gif|svg+xml)` (never `data:text/html` or `javascript:`). An inline `style` must pass the CSS rules or it is dropped. What was removed is listed as a warning. Ids are kept (SVG gradients need them), so pick unusual ones.
- **CSS** is rejected (with the reason) when it has `@import`, `@font-face`, `@namespace`, `@property`, `!important`, backslash escapes outside strings, `image-set()`/`src()`/`paint()`, `expression()`, `javascript:`, or a `url()` that is not `data:image/...` or `#fragment`. Limits: 40,000 characters of CSS and 20,000 of HTML per target.
- **Remote assets**: `http(s)://` urls in CSS and `<img src>` are blocked unless **Allow remote assets** (setting `allowRemoteAssets`, default off) is on. Remote files can track you and can change after you checked them.

### Storage, export and import

- The bundle is saved as one JSON value (`custom`) in the plugin storage, shortly after you stop typing. Storage is 1 MiB for the whole plugin, shared with saved images. The section shows how much the bundle uses; if a save would not fit, the editors keep working for this session, an error says "Not saved", and nothing is overwritten.
- **Copy bundle** puts `{"v":1,"header":{enabled,html,css},"background":{...}}` on the clipboard (if the clipboard is blocked, it opens in the paste box instead). **Paste bundle...** imports one: invalid JSON, a wrong version or oversized fields are refused and nothing changes; valid ones go through the same sanitizing as typed code.
- Turning a target off, or stopping/disabling the plugin, removes every node, style, attribute, timer and listener it added. The Ocean and the sidebar presets are never modified: Custom only hides them while it is on and valid.

## Switching

- Command palette: **Artwork: open panel**, **Artwork: switch preset** (choose), **Artwork: next preset** (cycle), **Artwork: switch image**.
- Settings > Plugins > Artwork: preset, intensity, speed, hue, fade height, blur, gradient angle, readability scrim, image name, main glow, logo mode, logo text, logo image height. Everything applies live, no reload.

## How it works

- The layer is an absolutely positioned, `pointer-events: none` div inserted as the first child of the sidebar's inner column (`[data-slot="sidebar-inner"]` first child, set to `isolation: isolate`) with `z-index: -1`, so all stock content stays above it, nothing shifts, and it copies the sidebar's corner radius. A `MutationObserver` re-attaches it if React re-renders.
- Colors are CSS only: the default accent is `var(--primary)` (hue-rotated with relative `oklch()` for the other glows), so dark, light and custom themes follow with no JS. Set Hue 0 to 360 to pin a color instead.
- A faint scrim made from `--sidebar` / `--background` sits under the title row so text stays readable on bright artwork (toggle: Readability scrim).
- Low CPU: transform-only animation, paused while the window is hidden, disabled for `prefers-reduced-motion` and when Speed is 0.

## Limits

- Plugin storage is 1 MiB, so a saved image gets `min(2 MB, space left)`. The encoder steps quality and size down to fit and shows an error toast if it still cannot.
- Only data URLs of png/jpeg/webp/gif made by the plugin are used as image sources.
- The logo node is attached to `a[aria-label="T3 Code home"]`. If a future T3 Code renames that label the logo options do nothing (the backdrop keeps working).

## Develop

```sh
pnpm --filter @t3p/artwork build
pnpm --filter @t3p/artwork test
```

Pure helpers (color math, preset to CSS variables, image sizing and byte budget, names) are in `src/model.ts` with tests. Custom mode: `src/custom-css.ts` (scoping and CSS rules), `src/custom-html.ts` (sanitizer), `src/custom.ts` (roots, apply and dispose), `src/custom-templates.ts` (preset to markup), `src/custom-panel.ts` (editors); tests in `test/custom*.test.ts`.
