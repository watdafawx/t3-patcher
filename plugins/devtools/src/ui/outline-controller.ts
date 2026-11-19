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
  readonly #listeners = new Set<(enabled: boolean) => void>();

  /** Escape always turns outlines off, wherever focus is (capture phase, so no app handler can swallow it). */
  readonly #onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && this.#enabled) this.set(false);
  };

  constructor(private readonly api?: OutlineThemeSource) {}

  get enabled(): boolean {
    return this.#enabled;
  }

  /** The injected style element, when outlines are on (for tests and diagnostics). */
  get element(): HTMLStyleElement | null {
    return this.style;
  }

  /** Fires after every enable/disable so a checkbox can follow a palette or Escape toggle. */
  onChange(listener: (enabled: boolean) => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  set(enabled: boolean): void {
    const changed = enabled !== this.#enabled;
    this.#enabled = enabled;
    if (!enabled) {
      this.remove();
      window.removeEventListener("keydown", this.#onKey, true);
      if (changed) this.emit();
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
    window.addEventListener("keydown", this.#onKey, true);
    if (changed) this.emit();
  }

  private emit(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(this.#enabled);
      } catch {
        // a listener must not block turning outlines off
      }
    }
  }

  toggle(): boolean {
    this.set(!this.#enabled);
    return this.#enabled;
  }

  dispose(): void {
    this.#enabled = false;
    window.removeEventListener("keydown", this.#onKey, true);
    this.remove();
    this.#listeners.clear();
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
