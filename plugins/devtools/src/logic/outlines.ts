/**
 * Slot outlines. Selectors are the anchors documented in `docs/wp-3d-notes.md`;
 * mounted plugin roots already carry `data-t3p-plugin` / `data-t3p-slot`, so the
 * label is pure CSS (`attr()`), not a second DOM overlay that could drift.
 */

export interface SlotAnchor {
  slot: string;
  /** Stable attribute selectors, never minified classes. */
  selector: string;
  note?: string;
}

export const SLOT_ANCHORS: readonly SlotAnchor[] = [
  { slot: "sidebarSection", selector: '[data-slot="sidebar-content"]' },
  { slot: "threadHeader", selector: '[aria-label="Thread breadcrumb"]' },
  { slot: "composerBanner", selector: '[data-chat-composer-surface="true"]' },
  { slot: "rightPanel", selector: '[data-slot="sidebar-inset"]' },
  { slot: "statusBar", selector: "body", note: "upstream has no status bar; plugins get their own fixed bar" },
  { slot: "settingsPage", selector: '[data-t3p-slot-anchor="settingsPage"]' },
  { slot: "timelineRowDecorator", selector: "[data-timeline-row-id]" },
  { slot: "contextMenuItem", selector: '[data-slot="menu-popup"], [role="menu"]' },
];

/** Attribute set on `<html>` while outlines are on; every rule is scoped by it. */
export const OUTLINE_ATTR = "data-t3p-devtools-outlines";

/** `plugin · slot` for a root's dataset; `?` for a missing part. */
export function outlineLabel(attrs: { plugin?: string | null; slot?: string | null }): string {
  return `${attrs.plugin && attrs.plugin.length > 0 ? attrs.plugin : "?"} · ${attrs.slot && attrs.slot.length > 0 ? attrs.slot : "?"}`;
}

function colour(theme: Record<string, string>, name: string, fallback: string): string {
  const value = theme[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

/**
 * Stylesheet for the outline toggle. Colours come from the app's CSS variables
 * (`t3.ui.themeVars()` supplies concrete values when it can), so live theme
 * changes keep working without re-rendering.
 *
 * Outlines must never change layout. Plugin roots are not all in-flow: toasts,
 * modal overlays and the status bar are `position: fixed`, the dock is
 * `position: absolute`. Forcing `position: relative` on `[data-t3p-root]` (the old
 * label anchor) dropped those out of their fixed layer and into the page flow, which
 * covered or pushed the app, including the toggle that turned it off. So this sheet
 * only ever sets `outline` and `outline-offset`; the plugin label lives in the Slots
 * tab list instead of a pseudo element.
 */
export function buildOutlineCss(theme: Record<string, string> = {}): string {
  const accent = colour(theme, "--primary", "var(--primary, currentColor)");
  const warn = colour(theme, "--destructive", "var(--destructive, currentColor)");
  const scope = `html[${OUTLINE_ATTR}="1"]`;
  const outline = `outline: 1px dashed ${warn}; outline-offset: -1px;`;
  // A selector list must be scoped entry by entry, or the second selector would apply with outlines off.
  const anchorRules = SLOT_ANCHORS.map((anchor) =>
    anchor.selector
      .split(",")
      .map((part) => `${scope} ${part.trim()} { ${outline} }`)
      .join("\n"),
  ).join("\n");
  return [`${scope} [data-t3p-root] { outline: 1px solid ${accent}; outline-offset: -1px; }`, anchorRules].join("\n");
}
