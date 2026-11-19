import { buildOutlineCss, OUTLINE_ATTR } from "../logic/outlines.js";

export interface OutlineThemeSource {
  ui: { themeVars(): Record<string, string> };
}

/**
 * Owns the single outline style element and the `<html>` attribute every rule is
 * scoped by. Teardown removes both, whether it comes from the toggle, the plugin
 * stop or a tab unmount.
 */
export class OutlineController {
  private style: HTMLStyleElement | null = null;
  #enabled = false;

  constructor(private readonly api?: OutlineThemeSource) {}

  get enabled(): boolean {
    return this.#enabled;
  }

  /** The injected style element, when outlines are on (for tests and diagnostics). */
  get element(): HTMLStyleElement | null {
    return this.style;
  }

  set(enabled: boolean): void {
    this.#enabled = enabled;
    if (!enabled) {
      this.remove();
      return;
    }
    let vars: Record<string, string> = {};
    if (this.api) {
      try {
        vars = this.api.ui.themeVars();
      } catch {
        vars = {};
      }
    }
    const style = document.createElement("style");
    style.dataset.t3pDevtools = "slot-outlines";
    style.textContent = buildOutlineCss(vars);
    this.remove();
    this.style = style;
    document.documentElement.setAttribute(OUTLINE_ATTR, "1");
    document.head.append(style);
  }

  toggle(): boolean {
    this.set(!this.#enabled);
    return this.#enabled;
  }

  dispose(): void {
    this.#enabled = false;
    this.remove();
  }

  private remove(): void {
    this.style?.remove();
    this.style = null;
    try {
      document.documentElement.removeAttribute(OUTLINE_ATTR);
    } catch {
      // the document may be gone during unload
    }
  }
}
