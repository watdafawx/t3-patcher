/**
 * DOM helpers shared by every full-app background (the presets and the Custom background).
 */

/** Id prefix of the throwaway color probe; the activity monitor ignores mutations of nodes with a `t3p-` id. */
export const COLOR_PROBE_ID = "t3p-color-probe";

/**
 * True for a computed background color that fully covers what is behind it. Semi-transparent layers (a modal
 * backdrop such as `rgba(0, 0, 0, 0.32)`, a frosted header) are never cleared: they are meant to tint the page.
 */
export function isOpaqueColor(bg: string): boolean {
  const c = bg.trim().toLowerCase();
  if (!c || c === "transparent") return false;
  const rgba = /^rgba\(([^)]*)\)$/.exec(c);
  if (rgba) {
    const parts = rgba[1]!.split(/[\s,/]+/).filter(Boolean);
    return parts.length === 4 && Number(parts[3]) >= 1;
  }
  // Modern syntax: `rgb(1 2 3 / 0.5)`, `oklch(0.2 0.01 250 / 50%)`, `color(srgb 1 1 1 / 0.4)`.
  const alpha = /\/\s*([\d.]+)(%?)\s*\)$/.exec(c);
  if (alpha) return alpha[2] === "%" ? Number(alpha[1]) >= 100 : Number(alpha[1]) >= 1;
  return true;
}

/** Marks the opaque, viewport-sized layers stacked over `anchor` with `attr`, so the background shows through them. */
export function markSurfaces(anchor: Element, attr: string): void {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (!(vw > 0 && vh > 0) || typeof document.elementsFromPoint !== "function") return;
  for (const fx of [0.5, 0.3, 0.7]) {
    for (const fy of [0.5, 0.3, 0.7]) {
      for (const el of document.elementsFromPoint(vw * fx, vh * fy)) {
        if (el === anchor || el === document.documentElement || el === document.body || el.hasAttribute(attr)) continue;
        if (el.closest("[data-t3p-root]")) continue;
        const r = el.getBoundingClientRect();
        if (r.width * r.height < vw * vh * 0.35) continue;
        if (isOpaqueColor(getComputedStyle(el).backgroundColor)) el.setAttribute(attr, "");
      }
    }
  }
}

/** Removes `attr` from every element that has it. */
export function unmarkSurfaces(attr: string): void {
  for (const el of Array.from(document.querySelectorAll(`[${attr}]`))) el.removeAttribute(attr);
}

/** Computes any CSS color expression (`var()`, `oklch()`, relative colors) to the browser's computed color string. */
export function computedColor(expr: string): string {
  const probe = document.createElement("i");
  probe.id = COLOR_PROBE_ID;
  probe.style.cssText = `position:fixed;left:-9999px;top:0;width:0;height:0;pointer-events:none;color:${expr}`;
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}
