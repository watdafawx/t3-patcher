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
 * `position: relative` on a plugin root is a deliberate dev-tool cost: the label
 * needs an anchor. It disappears together with the style element.
 */
export function buildOutlineCss(theme: Record<string, string> = {}): string {
  const accent = colour(theme, "--primary", "var(--primary, currentColor)");
  const warn = colour(theme, "--destructive", "var(--destructive, currentColor)");
  const labelBg = colour(theme, "--background", "var(--background, canvas)");
  const scope = `html[${OUTLINE_ATTR}="1"]`;
  const outline = `outline: 1px dashed ${warn}; outline-offset: -1px;`;
  // A selector list must be scoped entry by entry, or the second selector would apply with outlines off.
  const anchorRules = SLOT_ANCHORS.map((anchor) =>
    anchor.selector
      .split(",")
      .map((part) => `${scope} ${part.trim()} { ${outline} }`)
      .join("\n"),
  ).join("\n");
  return [
    `${scope} [data-t3p-root] { position: relative; outline: 1px solid ${accent}; outline-offset: -1px; }`,
    `${scope} [data-t3p-root]::before {`,
    `  content: attr(data-t3p-plugin) " · " attr(data-t3p-slot);`,
    `  position: absolute; top: 0; left: 0; transform: translateY(-100%);`,
    `  font: 10px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;`,
    `  color: ${accent}; background: ${labelBg}; padding: 0 3px;`,
    `  border: 1px solid ${accent}; border-radius: 3px;`,
    `  white-space: nowrap; pointer-events: none; z-index: 2147483000;`,
    `}`,
    anchorRules,
  ].join("\n");
}
