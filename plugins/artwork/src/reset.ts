import type { T3Api } from "@t3p/api";

import { CUSTOM_IDS, type CustomId, type CustomTarget } from "./custom.js";

/** Every artwork setting the reset touches (schema defaults come back through `settings.reset`). */
export const RESET_KEYS = ["preset", "intensity", "speed", "hue", "fadeHeight", "blur", "angle", "scrim", "artworkName", "mainGlow", "oceanOn", "oceanIntensity", "oceanSpeed", "oceanRipples", "bgKind", "bgIntensity", "bgSpeed", "bgDensity", "bgDim", "bgBlur", "bgPointer", "bgFollowAccent", "bgLowPower", "bgQuality", "bgPauseWhileTyping", "logoMode", "logoText", "logoHeight", "allowRemoteAssets"];

export interface ResetCustom {
  update(id: CustomId, patch: Partial<CustomTarget>): unknown;
}

/**
 * Resets every setting to its default, turns Custom HTML/CSS off (Ocean is off by default, so the
 * `oceanOn` reset covers it) and, only when `clearCustom` is set, empties the custom markup and CSS too.
 * Saved images and the logo image are kept.
 */
export async function resetAllArtwork(t3: T3Api, custom: ResetCustom, clearCustom: boolean): Promise<void> {
  for (const id of CUSTOM_IDS) custom.update(id, clearCustom ? { enabled: false, html: "", css: "" } : { enabled: false });
  await Promise.all(RESET_KEYS.map((key) => t3.settings.reset(key).catch(() => undefined)));
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string> = {}, ...kids: Array<Node | string>): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) node.setAttribute(k, v);
  node.append(...kids);
  return node;
};

/**
 * The "Reset all to defaults" control: one button, then an inline "Really reset?" row with an
 * "also clear custom HTML/CSS" tick. Nothing changes until the second click.
 */
export function mountResetAll(host: HTMLElement, t3: T3Api, custom: ResetCustom, onDone?: () => void): () => void {
  const box = el("div", { class: "t3p-art-reset", "data-t3p-reset-all": "" });
  const start = el("button", { type: "button", class: "t3p-btn", "data-t3p-reset-start": "" }, "Reset all to defaults");
  const confirm = el("div", { class: "t3p-art-reset-confirm", "data-t3p-reset-confirm": "", hidden: "" });
  const tick = el("input", { type: "checkbox", class: "t3p-switch", "aria-label": "Also clear custom HTML/CSS", "data-t3p-reset-clear": "" });
  const row = el("div", { class: "t3p-art-ln" }, el("label", {}, "Also clear custom HTML/CSS"), tick);
  const hint = el("div", { class: "t3p-meta" }, "Resets every Artwork setting and turns Custom HTML/CSS and the app background off. Saved images stay. Custom code is kept unless you tick the box.");
  const yes = el("button", { type: "button", class: "t3p-btn", "data-primary": "", "data-t3p-reset-yes": "" }, "Really reset?");
  const no = el("button", { type: "button", class: "t3p-btn", "data-variant": "ghost", "data-t3p-reset-no": "" }, "Cancel");
  confirm.append(hint, row, el("div", { class: "t3p-art-foot" }, yes, no));
  box.append(start, confirm);
  host.appendChild(box);

  const close = (): void => {
    confirm.hidden = true;
    start.hidden = false;
    tick.checked = false;
  };
  start.addEventListener("click", () => {
    start.hidden = true;
    confirm.hidden = false;
    yes.focus();
  });
  no.addEventListener("click", close);
  box.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Escape" && !confirm.hidden) close();
  });
  yes.addEventListener("click", () => {
    const clear = tick.checked;
    close();
    void resetAllArtwork(t3, custom, clear).then(() => {
      t3.ui.toast({ title: "Artwork", message: clear ? "Reset to defaults. Custom code cleared." : "Reset to defaults.", kind: "success" });
      onDone?.();
    });
  });
  return () => box.remove();
}
