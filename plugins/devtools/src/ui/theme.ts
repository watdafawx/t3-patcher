import type { Unsubscribe } from "@t3p/api";

import { THEME_MAP } from "./styles.js";

export interface ThemeSource {
  ui: { themeVars(): Record<string, string> };
}

/** Points the plugin root's own variables at the app's theme tokens (live `var()` references). */
export function applyTheme(root: HTMLElement): void {
  // Live references, never copies: a copied value goes stale the moment the app switches theme.
  for (const [mine, app, fallback] of THEME_MAP) root.style.setProperty(mine, `var(${app}, ${fallback})`);
}

/** Re-applies the theme on the app's theme changes; returns the unsubscribe. */
export function bindTheme(root: HTMLElement, _api: ThemeSource, onThemeChange?: (cb: () => void) => Unsubscribe): Unsubscribe {
  const apply = (): void => {
    applyTheme(root);
  };
  apply();
  return onThemeChange ? onThemeChange(apply) : () => undefined;
}
