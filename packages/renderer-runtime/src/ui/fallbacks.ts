import type { CommandRegistry } from "../commands.js";
import type { InternalsHub } from "../internals.js";
import { ensureStyles, h } from "./dom.js";

export interface FallbackDeps {
  hub: InternalsHub;
  commands: CommandRegistry;
  /** Shows the Plugins page as an overlay (settingsNav fallback). */
  openPluginsPage(): void;
}

/**
 * DOM substitutes for captures that did not run (patch missing, app version changed):
 * - settingsNav: a "Plugins" button next to the settings navigation, opening the page as an overlay.
 * - commandPalette: a "Plugins" group appended to the open palette list, filtered by the typed query.
 * Both are inert while the matching capture is present.
 */
export class Fallbacks {
  #observer: MutationObserver | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #paletteSig = "";

  constructor(private readonly deps: FallbackDeps) {
    deps.hub.substitute("settingsNav", "DOM nav button + overlay page (route not registered)");
    deps.hub.substitute("commandPalette", "DOM group injected into the open command palette");
    deps.hub.substitute("router", "location.hash navigation");
    deps.commands.onChange(() => this.schedule());
  }

  start(): void {
    if (this.#observer || typeof MutationObserver === "undefined") return;
    ensureStyles();
    this.#observer = new MutationObserver((records) => {
      if (records.every((r) => r.target instanceof Element && r.target.closest("[data-t3p-fallback]"))) return;
      this.schedule();
    });
    this.#observer.observe(document.documentElement, { childList: true, subtree: true, characterData: false });
    document.addEventListener("input", () => this.schedule(), true);
    this.schedule();
  }

  schedule(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      try {
        this.syncNav();
        this.syncPalette();
      } catch {
        // fallbacks are best effort
      }
    }, 60);
  }

  private syncNav(): void {
    if (this.deps.hub.has("settingsNav")) {
      document.querySelectorAll("[data-t3p-fallback=nav]").forEach((n) => n.remove());
      return;
    }
    // Upstream settings nav: sidebar menu buttons (no hrefs). Anchor on the one labelled "About" (last core entry).
    const about = Array.from(document.querySelectorAll('[data-slot="sidebar-menu-button"]')).find((b) => b.textContent?.trim() === "About");
    if (!about) return;
    const row = about.closest('[data-slot="sidebar-menu-item"]') ?? about;
    if (document.querySelector("[data-t3p-fallback=nav]")) return;
    const button = h("button", { class: about.className, type: "button", "data-t3p-fallback": "nav", onClick: () => this.deps.openPluginsPage() }, "Plugins");
    row.after(button);
  }

  private syncPalette(): void {
    if (this.deps.hub.has("commandPalette")) {
      document.querySelectorAll("[data-t3p-fallback=palette]").forEach((n) => n.remove());
      return;
    }
    const list = document.querySelector('[data-slot="command-list"]');
    if (!list) {
      this.#paletteSig = "";
      return;
    }
    const input = document.querySelector('[data-slot="command-input"]') as HTMLInputElement | null;
    const raw = input?.value ?? "";
    const query = raw.replace(/^>/, "").trim().toLowerCase();
    const items = this.deps.commands.paletteItems().filter((item) => query === "" || item.searchTerms.some((t) => t.toLowerCase().includes(query)));
    const sig = `${this.deps.commands.version}|${query}|${items.length}`;
    const existing = list.querySelector("[data-t3p-fallback=palette]");
    if (existing && sig === this.#paletteSig) return;
    existing?.remove();
    this.#paletteSig = sig;
    if (items.length === 0) return;
    const group = h("div", { class: "t3p-palette-group", role: "group", "aria-label": "Plugins", "data-t3p-fallback": "palette" }, h("div", { class: "t3p-palette-label" }, "Plugins"));
    for (const item of items) {
      group.appendChild(
        h("button", {
          class: "t3p-palette-item",
          type: "button",
          "data-t3p-command": item.value,
          onClick: () => {
            void item.run();
            input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
          },
        }, item.title, item.description ? ` — ${item.description}` : ""),
      );
    }
    list.appendChild(group);
  }

  dispose(): void {
    this.#observer?.disconnect();
    this.#observer = null;
    document.querySelectorAll("[data-t3p-fallback]").forEach((n) => n.remove());
  }
}
