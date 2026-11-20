import { bgIds } from "./bg-base.js";
import { BG_KINDS } from "./bg-model.js";

/**
 * The dim overlay: ONE fixed, click-through element between the full-app background and the app UI.
 * It is a flat layer in the app's own `--background` colour with a constant opacity, so it costs
 * nothing per frame (no filter, no backdrop-filter, no JS loop). It exists only while a background
 * preset is running and the dim is above 0, and `stop()` removes it. Custom HTML/CSS takes over the
 * background by turning the preset off, which removes the dim with it.
 */

export const DIM_ID = "t3p-bg-dim";
/** Roots of the four presets: the dim sits right after whichever one runs. */
const ROOT_SELECTOR = BG_KINDS.map((k) => `#${bgIds(k).root}`).join(",");

export interface BgDimHost {
  /** True while a background preset is running (its canvas is mounted). */
  active(): boolean;
  /** Overlay opacity 0 to 0.8. */
  opacity(): number;
}

export class BgDim {
  #el: HTMLElement | null = null;

  constructor(private readonly host: BgDimHost) {}

  get element(): HTMLElement | null {
    return this.#el;
  }

  /** Creates, retunes, repositions or removes the overlay. Cheap, call it on every setting change. */
  update(): void {
    const opacity = this.host.opacity();
    if (!this.host.active() || !(opacity > 0)) {
      this.stop();
      return;
    }
    if (!this.#el) {
      const el = document.createElement("div");
      el.id = DIM_ID;
      el.setAttribute("aria-hidden", "true");
      el.style.cssText = "position:fixed;inset:0;z-index:-1;pointer-events:none;background:var(--background,#000);contain:strict;will-change:opacity";
      this.#el = el;
    }
    this.#el.style.opacity = String(opacity);
    // Same z-index as the presets, so DOM order decides: right after the running preset.
    const anchor = document.querySelector(ROOT_SELECTOR);
    if (anchor) {
      if (anchor.nextElementSibling !== this.#el) anchor.after(this.#el);
    } else if (this.#el.parentElement !== document.body) document.body.insertBefore(this.#el, document.body.firstChild);
  }

  stop(): void {
    this.#el?.remove();
    this.#el = null;
  }
}
