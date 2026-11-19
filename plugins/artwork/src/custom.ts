import { MAX_CSS, scopeCss } from "./custom-css.js";
import { MAX_HTML, sanitizeHtml } from "./custom-html.js";
import { markSurfaces } from "./ocean.js";

/**
 * Custom HTML/CSS mode. Two targets, each one plugin-owned root element:
 * - `header`: absolute layer at the top of the sidebar column (replaces the sidebar preset while on)
 * - `background`: fixed full-window layer behind the app (replaces the Ocean while on)
 * Everything the user writes lives inside its root, sanitized and scoped. Nothing else is touched.
 */

export const CUSTOM_IDS = ["header", "background"] as const;
export type CustomId = (typeof CUSTOM_IDS)[number];
export const CUSTOM_LABELS: Record<CustomId, string> = { header: "Header / logo area", background: "App background" };

export interface CustomTarget {
  enabled: boolean;
  html: string;
  css: string;
}
export interface CustomBundle {
  v: 1;
  header: CustomTarget;
  background: CustomTarget;
}
export interface TargetView extends CustomTarget {
  errors: string[];
  warnings: string[];
  /** A valid version is on screen right now. */
  applied: boolean;
}

export const CUSTOM_KEY = "custom";
export const CUSTOM_STYLE_ID = "t3p-art-custom-style";
export const BG_ATTR = "data-t3p-cbg";
export const BG_CLEAR_ATTR = "data-t3p-cbg-clear";
const SURFACE_POLL_MS = 1000;

const emptyTarget = (): CustomTarget => ({ enabled: false, html: "", css: "" });
export const emptyBundle = (): CustomBundle => ({ v: 1, header: emptyTarget(), background: emptyTarget() });

function toTarget(raw: unknown): CustomTarget | string {
  if (raw === undefined) return emptyTarget();
  if (!raw || typeof raw !== "object") return "a target is not an object";
  const t = raw as Record<string, unknown>;
  if (t.html !== undefined && typeof t.html !== "string") return "html must be text";
  if (t.css !== undefined && typeof t.css !== "string") return "css must be text";
  const html = (t.html as string | undefined) ?? "";
  const css = (t.css as string | undefined) ?? "";
  if (html.length > MAX_HTML) return `html is longer than ${MAX_HTML} characters`;
  if (css.length > MAX_CSS) return `css is longer than ${MAX_CSS} characters`;
  return { enabled: t.enabled === true, html, css };
}

/** Parses a stored or pasted bundle (JSON text or object). Never throws. */
export function parseBundle(raw: unknown): { bundle?: CustomBundle; error?: string } {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { error: "That is not valid JSON." };
    }
  }
  if (!value || typeof value !== "object" || (value as { v?: unknown }).v !== 1) return { error: 'Not an Artwork custom bundle (expected {"v":1,"header":...,"background":...}).' };
  const out = emptyBundle();
  for (const id of CUSTOM_IDS) {
    const t = toTarget((value as Record<string, unknown>)[id]);
    if (typeof t === "string") return { error: `${CUSTOM_LABELS[id]}: ${t}.` };
    out[id] = t;
  }
  return { bundle: out };
}

export const serializeBundle = (bundle: CustomBundle): string => JSON.stringify(bundle);

const BASE_CSS = `
[data-t3p-custom="header"]{top:0;left:0;right:0;height:var(--t3p-art-height,190px)}
[data-t3p-custom][data-t3p-custom][data-t3p-custom]{pointer-events:none!important;z-index:-1!important;overflow:hidden!important;contain:layout paint style!important;isolation:isolate!important;box-sizing:border-box!important;margin:0!important}
[data-t3p-custom="header"][data-t3p-custom][data-t3p-custom]{position:absolute!important}
[data-t3p-custom="background"][data-t3p-custom][data-t3p-custom]{position:fixed!important;inset:0!important;width:auto!important;height:auto!important}
[data-t3p-custom][data-t3p-custom][data-t3p-custom] *{pointer-events:none!important}
[data-t3p-custom][data-paused][data-paused][data-paused] *{animation-play-state:paused!important}
@media (prefers-reduced-motion:reduce){[data-t3p-custom][data-t3p-custom][data-t3p-custom] *{animation:none!important}}
html[${BG_ATTR}]{background-color:var(--background,canvas)!important}
html[${BG_ATTR}] body,html[${BG_ATTR}] #root,html[${BG_ATTR}] [data-slot="sidebar-wrapper"],html[${BG_ATTR}] [data-slot="sidebar-inset"]{background-color:transparent!important}
html[${BG_ATTR}] [${BG_CLEAR_ATTR}]{background-color:transparent!important}
`;

export interface CustomOptions {
  allowRemote(): boolean;
}

export class CustomLayers {
  #targets: CustomBundle = emptyBundle();
  #views: Record<CustomId, { errors: string[]; warnings: string[]; applied: boolean }> = {
    header: { errors: [], warnings: [], applied: false },
    background: { errors: [], warnings: [], applied: false },
  };
  #roots: Record<CustomId, HTMLElement | null> = { header: null, background: null };
  #headerHost: HTMLElement | null = null;
  #style: HTMLStyleElement | null = null;
  #poll: ReturnType<typeof setInterval> | null = null;
  #listeners = new Set<() => void>();
  #disposed = false;

  constructor(private readonly options: CustomOptions) {
    document.addEventListener("visibilitychange", this.#onVisibility);
  }

  onChange(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  bundle(): CustomBundle {
    return { v: 1, header: { ...this.#targets.header }, background: { ...this.#targets.background } };
  }

  /** True while a valid custom version of `id` is shown. The caller then lets Custom take over. */
  active(id: CustomId): boolean {
    return this.#targets[id].enabled && this.#views[id].applied;
  }

  view(id: CustomId): TargetView {
    return { ...this.#targets[id], ...this.#views[id], errors: [...this.#views[id].errors], warnings: [...this.#views[id].warnings] };
  }

  /** Replaces everything (stored bundle or import). */
  load(bundle: CustomBundle): void {
    this.#targets = { v: 1, header: { ...bundle.header }, background: { ...bundle.background } };
    for (const id of CUSTOM_IDS) this.#render(id);
    this.#emit();
  }

  update(id: CustomId, patch: Partial<CustomTarget>): TargetView {
    this.#targets[id] = { ...this.#targets[id], ...patch };
    this.#render(id);
    this.#emit();
    return this.view(id);
  }

  /** Re-checks both targets, e.g. after the "allow remote assets" setting changed. */
  revalidate(): void {
    for (const id of CUSTOM_IDS) this.#render(id);
    this.#emit();
  }

  /** Attaches the roots that should be shown. Cheap, called on every DOM mutation. */
  ensure(headerHost: HTMLElement | null): void {
    if (this.#disposed) return;
    this.#headerHost = headerHost;
    this.#mount();
  }

  dispose(): void {
    this.#disposed = true;
    document.removeEventListener("visibilitychange", this.#onVisibility);
    for (const id of CUSTOM_IDS) {
      this.#roots[id]?.remove();
      this.#roots[id] = null;
      this.#views[id].applied = false;
    }
    this.#stopSurfaces();
    this.#style?.remove();
    this.#style = null;
    this.#listeners.clear();
  }

  // ---- internals -----------------------------------------------------------------------------------

  #emit(): void {
    for (const fn of [...this.#listeners]) fn();
  }

  readonly #onVisibility = (): void => {
    for (const id of CUSTOM_IDS) this.#roots[id]?.toggleAttribute("data-paused", document.hidden);
  };

  /** Validates `id`. On errors the last good version stays on screen and nothing broken is applied. */
  #render(id: CustomId): void {
    const t = this.#targets[id];
    const allowRemote = this.options.allowRemote();
    const css = scopeCss(t.css, { scope: `[data-t3p-custom="${id}"]`, prefix: `t3pc-${id}-`, allowRemote });
    const html = sanitizeHtml(t.html, { allowRemote });
    const errors = [...css.errors, ...html.errors];
    const warnings = [...css.warnings, ...(html.removed.length > 0 ? [`removed unsafe markup: ${html.removed.join(", ")}`] : [])];
    const view = this.#views[id];
    view.errors = errors;
    view.warnings = warnings;
    if (!t.enabled) {
      this.#roots[id]?.remove();
      this.#roots[id] = null;
      view.applied = false;
    } else if (errors.length === 0) {
      const root = this.#roots[id] ?? this.#makeRoot(id);
      const style = document.createElement("style");
      style.textContent = css.css;
      root.replaceChildren(style, ...Array.from(html.body.childNodes).map((n) => document.importNode(n, true)));
      view.applied = true;
    }
    this.#mount();
  }

  #makeRoot(id: CustomId): HTMLElement {
    const root = document.createElement("div");
    root.setAttribute("data-t3p-custom", id);
    root.setAttribute("aria-hidden", "true");
    if (document.hidden) root.setAttribute("data-paused", "");
    this.#roots[id] = root;
    return root;
  }

  #mount(): void {
    if (this.#disposed) return;
    const header = this.#roots.header;
    const bg = this.#roots.background;
    if ((header || bg) && !this.#style) {
      this.#style = document.createElement("style");
      this.#style.id = CUSTOM_STYLE_ID;
      this.#style.textContent = BASE_CSS;
      document.head.appendChild(this.#style);
    }
    if (header && this.#headerHost && header.parentElement !== this.#headerHost) this.#headerHost.insertBefore(header, this.#headerHost.firstChild);
    if (bg && bg.parentElement !== document.body) document.body.insertBefore(bg, document.body.firstChild);
    if (bg) this.#startSurfaces(bg);
    else this.#stopSurfaces();
    if (!header && !bg && this.#style) {
      this.#style.remove();
      this.#style = null;
    }
  }

  #startSurfaces(anchor: HTMLElement): void {
    if (this.#poll) return;
    document.documentElement.setAttribute(BG_ATTR, "");
    markSurfaces(anchor, BG_CLEAR_ATTR);
    this.#poll = setInterval(() => {
      const root = this.#roots.background;
      if (root) markSurfaces(root, BG_CLEAR_ATTR);
    }, SURFACE_POLL_MS);
  }

  #stopSurfaces(): void {
    if (this.#poll) clearInterval(this.#poll);
    this.#poll = null;
    document.documentElement.removeAttribute(BG_ATTR);
    for (const el of Array.from(document.querySelectorAll(`[${BG_CLEAR_ATTR}]`))) el.removeAttribute(BG_CLEAR_ATTR);
  }
}
