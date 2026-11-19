/**
 * Theme plumbing. The plugin renders in the app's own document (no Shadow DOM), so every
 * app CSS custom property already applies. This module builds `var(...)` references, with
 * `t3.ui.themeVars()` only deciding whether a token needs a fallback.
 *
 * No literal colors: threshold accents fall back to `currentColor` for a theme that does not
 * define `--success` / `--warning` / `--destructive`.
 */

import type { LimitLevel } from "./limits.js";

export interface ThemeTokens {
  text: string;
  mutedText: string;
  border: string;
  surface: string;
  track: string;
  radius: string;
  mono: string;
  accent: Record<LimitLevel, string>;
  /** Same levels for text: the app's `-foreground` tone keeps contrast in light themes. */
  accentText: Record<LimitLevel, string>;
}

const ACCENT_TOKEN: Record<LimitLevel, string> = {
  ok: "--success",
  warn: "--warning",
  critical: "--destructive",
};

const ACCENT_FALLBACK: Record<LimitLevel, string> = {
  ok: "currentColor",
  warn: "currentColor",
  critical: "currentColor",
};

/**
 * Builds the token set for a render pass. `vars` is `t3.ui.themeVars()`: a theme value that
 * exists is referenced as-is, otherwise the `var()` keeps the token with a fallback so a
 * theme switch still works without a re-render.
 */
export function themeTokens(vars: Record<string, string>): ThemeTokens {
  const ref = (name: string, fallback: string): string =>
    vars[name]?.trim() ? `var(${name})` : `var(${name}, ${fallback})`;

  return {
    text: ref("--foreground", "inherit"),
    mutedText: ref("--muted-foreground", "inherit"),
    border: ref("--border", "currentColor"),
    surface: ref("--card", "transparent"),
    track: ref("--input", "color-mix(in srgb, currentColor 14%, transparent)"),
    radius: "var(--radius-lg, var(--radius, .5rem))",
    mono: ref("--font-mono", "ui-monospace, monospace"),
    accent: {
      ok: ref(ACCENT_TOKEN.ok, ACCENT_FALLBACK.ok),
      warn: ref(ACCENT_TOKEN.warn, ACCENT_FALLBACK.warn),
      critical: ref(ACCENT_TOKEN.critical, ACCENT_FALLBACK.critical),
    },
    accentText: {
      ok: ref(`${ACCENT_TOKEN.ok}-foreground`, `var(${ACCENT_TOKEN.ok}, currentColor)`),
      warn: ref(`${ACCENT_TOKEN.warn}-foreground`, `var(${ACCENT_TOKEN.warn}, currentColor)`),
      critical: ref(`${ACCENT_TOKEN.critical}-foreground`, `var(${ACCENT_TOKEN.critical}, currentColor)`),
    },
  };
}
