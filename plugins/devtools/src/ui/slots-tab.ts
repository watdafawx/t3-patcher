import type { Unsubscribe } from "@t3p/api";

import { outlineLabel, SLOT_ANCHORS } from "../logic/outlines.js";
import { clear, h } from "./dom.js";
import type { OutlineController } from "./outline-controller.js";
import { CSS } from "./styles.js";
import { bindTheme, type ThemeSource } from "./theme.js";

export interface SlotsTabApi extends ThemeSource {
  log(level: "debug" | "info" | "warn" | "error", message: string): void;
}

export interface SlotsTabOptions {
  api: SlotsTabApi;
  outlines: OutlineController;
  onThemeChange?: (cb: () => void) => Unsubscribe;
}

export interface Tab {
  dispose(): void;
}

const REFRESH_MS = 2000;

export function mountSlotsTab(host: HTMLElement, opts: SlotsTabOptions): Tab {
  const root = h("div", { class: "t3p-dt", data: { t3pDevtools: "slot-outlines" } });
  const style = h("style", { text: CSS });
  host.append(style, root);
  const cleanups: Array<() => void> = [];
  cleanups.push(bindTheme(root, opts.api, opts.onThemeChange));
  cleanups.push(
    opts.onThemeChange?.(() => {
      if (opts.outlines.enabled) opts.outlines.set(true);
    }) ?? (() => undefined),
  );
  let disposed = false;

  root.append(
    h("h4", { text: "Slot outlines" }),
    h("p", {
      class: "dt-note",
      text:
        "Outlines every mounted plugin root (listed below as plugin · slot) and every slot anchor from docs/wp-3d-notes.md. " +
        "Outline only, layout never changes. Escape or the palette command \"Devtools: toggle slot outlines\" turns it off. One injected style element; turning it off or stopping the plugin removes it.",
    }),
  );

  const toggle = h("input", { type: "checkbox", attrs: { "aria-label": "Show slot outlines" } });
  toggle.checked = opts.outlines.enabled;
  const toggleRow = h("label", { class: "dt-row" }, toggle, h("span", { text: "Show outlines" }));
  const refresh = h("button", { class: "dt-btn", text: "Refresh counts", attrs: { type: "button" } });
  root.append(h("div", { class: "dt-row" }, toggleRow, refresh));

  const rootsBox = h("div", { class: "dt-stack", attrs: { "data-role": "roots" } });
  const anchorsBox = h("div", { class: "dt-stack", attrs: { "data-role": "anchors" } });
  root.append(rootsBox, anchorsBox);

  const render = (): void => {
    if (disposed) return;
    clear(rootsBox);
    const roots = Array.from(document.querySelectorAll<HTMLElement>("[data-t3p-root]"));
    rootsBox.append(h("span", { class: "dt-note", text: `Mounted plugin roots: ${roots.length}` }));
    for (const element of roots) {
      const label = outlineLabel({ plugin: element.dataset.t3pPlugin, slot: element.dataset.t3pSlot });
      rootsBox.append(h("div", { class: "dt-row" }, h("span", { class: "dt-badge", text: label }), h("span", { class: "dt-note", text: element.dataset.t3pId ? `#${element.dataset.t3pId}` : "" })));
    }

    clear(anchorsBox);
    anchorsBox.append(h("span", { class: "dt-note", text: "Slot anchors" }));
    for (const anchor of SLOT_ANCHORS) {
      let count = 0;
      try {
        count = document.querySelectorAll(anchor.selector).length;
      } catch {
        count = 0;
      }
      anchorsBox.append(
        h("div", { class: "dt-anchor" }, h("code", { class: "dt-mono", text: anchor.selector }), h("span", { class: "dt-note", text: `${anchor.slot} · ${count}` })),
      );
      if (anchor.note) anchorsBox.append(h("span", { class: "dt-note", text: anchor.note }));
    }
  };

  const unsubscribe = opts.outlines.onChange((enabled) => {
    toggle.checked = enabled;
  });
  cleanups.push(unsubscribe);
  toggle.addEventListener("change", () => {
    opts.outlines.set(toggle.checked);
    render();
  });
  refresh.addEventListener("click", render);

  const timer = setInterval(render, REFRESH_MS);
  cleanups.push(() => clearInterval(timer));
  render();

  return {
    dispose() {
      disposed = true;
      for (const cleanup of cleanups.splice(0)) cleanup();
      style.remove();
      root.remove();
    },
  };
}
