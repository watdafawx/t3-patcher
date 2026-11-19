import type { Unsubscribe } from "@t3p/api";

/** Custom properties the app is known to define (shadcn style tokens). Used when no stylesheet can be read. */
const KNOWN = [
  "background", "foreground", "card", "card-foreground", "popover", "popover-foreground", "primary", "primary-foreground",
  "secondary", "secondary-foreground", "muted", "muted-foreground", "accent", "accent-foreground", "destructive",
  "destructive-foreground", "border", "input", "ring", "info", "success", "warning", "radius",
  "sidebar", "sidebar-foreground", "sidebar-border", "sidebar-accent", "sidebar-icon-color", "font-sans", "font-mono",
].map((n) => `--${n}`);

/**
 * Theme access for plugin UI. Plugins render in the app's own document (no Shadow DOM), so every CSS
 * variable already applies to their elements: `color: var(--foreground)` just works. `values()` is for
 * code that needs the resolved value (a canvas, a chart library).
 */
export class Theme {
  #names: string[] | null = null;
  readonly #listeners = new Set<() => void>();
  #observer: MutationObserver | null = null;
  #last = "";
  #timer: ReturnType<typeof setTimeout> | null = null;

  /** Names of every custom property declared on `:root`, `html`, `body` or a theme class in a readable stylesheet. */
  names(): string[] {
    if (this.#names) return this.#names;
    const found = new Set<string>(KNOWN);
    try {
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList;
        try {
          rules = sheet.cssRules;
        } catch {
          continue; // cross-origin sheet
        }
        for (const rule of Array.from(rules)) collect(rule, found);
      }
    } catch {
      // keep the known list
    }
    this.#names = [...found].sort();
    return this.#names;
  }

  /** Current resolved value of every theme variable (empty values are left out). */
  values(): Record<string, string> {
    const style = getComputedStyle(document.documentElement);
    const out: Record<string, string> = {};
    for (const name of this.names()) {
      const value = style.getPropertyValue(name).trim();
      if (value) out[name] = value;
    }
    return out;
  }

  /** Fires after the theme changes (class, style or data attributes on `<html>`/`<body>`, or a stylesheet swap). */
  onChange(callback: () => void): Unsubscribe {
    this.#listeners.add(callback);
    this.#watch();
    return () => {
      this.#listeners.delete(callback);
      if (this.#listeners.size === 0) this.#unwatch();
    };
  }

  #watch(): void {
    if (this.#observer || typeof MutationObserver === "undefined") return;
    this.#last = this.#signature();
    this.#observer = new MutationObserver(() => {
      if (this.#timer) return;
      this.#timer = setTimeout(() => {
        this.#timer = null;
        const now = this.#signature();
        if (now === this.#last) return;
        this.#last = now;
        this.#names = null;
        for (const fn of [...this.#listeners]) {
          try {
            fn();
          } catch {
            // one listener must not stop the others
          }
        }
      }, 50);
    });
    const options = { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-color-scheme"] };
    this.#observer.observe(document.documentElement, options);
    if (document.body) this.#observer.observe(document.body, options);
  }

  #unwatch(): void {
    this.#observer?.disconnect();
    this.#observer = null;
  }

  #signature(): string {
    const style = getComputedStyle(document.documentElement);
    return `${document.documentElement.className}|${style.getPropertyValue("--background")}|${style.getPropertyValue("--foreground")}|${style.getPropertyValue("--primary")}`;
  }
}

function collect(rule: CSSRule, into: Set<string>): void {
  const style = rule as CSSStyleRule;
  if (typeof style.selectorText === "string" && /(^|[\s,])(:root|html|body|\.dark|\.light|\[data-theme[^\]]*\])/.test(style.selectorText) && style.style) {
    for (let i = 0; i < style.style.length; i += 1) {
      const name = style.style.item(i);
      if (name.startsWith("--")) into.add(name);
    }
  }
  const nested = (rule as CSSGroupingRule).cssRules;
  if (nested) for (const child of Array.from(nested)) collect(child, into);
}
