import type { T3UiDock, UiSlotContext, UiSlotName, UiSlotRegistration } from "@t3p/api";

import { ensureStyles, h } from "./dom.js";
import type { Theme } from "./theme.js";

/**
 * Slot anchors (upstream T3 Code 0.1.x client). Each slot finds its anchor by a `data-slot` or other
 * stable attribute, never by a minified class. See docs/wp-3d-notes.md.
 *
 * `find()` returns the anchor elements and `place()` puts the plugin container next to / inside it.
 * One container per (slot, anchor); each registration gets its own plain `div` root inside it.
 */
interface SlotDef {
  find(): Element[];
  place(anchor: Element, container: HTMLElement): void;
  /** Key of the anchor, for per-anchor context (row id). */
  key?(anchor: Element): string;
}

export const SLOT_NAMES: readonly UiSlotName[] = ["sidebarSection", "threadHeader", "composerBanner", "rightPanel", "statusBar", "settingsPage", "timelineRowDecorator", "contextMenuItem", "threadDetails", "threadListDecorator"];

const CARD = "[data-thread-details-card]";

/** Normalised label text for matching stock rows. */
function norm(text: string | null): string {
  return (text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Stock sections of the card (ours excluded), all siblings under the card's items container. */
function stockSections(card: Element): HTMLElement[] {
  const all = Array.from(card.querySelectorAll("section")).filter((s) => !s.closest("[data-t3p-container]")) as HTMLElement[];
  const parent = all[0]?.parentElement;
  return all.filter((s) => s.parentElement === parent);
}

const MAX_ROWS = 400;

function visible(el: Element): boolean {
  return (el as HTMLElement).getClientRects().length > 0 || !("getClientRects" in el);
}

const DEFS: Record<UiSlotName, SlotDef> = {
  // `[data-slot="sidebar-content"]`: the scrolling body of the left sidebar.
  sidebarSection: {
    find: () => Array.from(document.querySelectorAll('[data-slot="sidebar-content"]')).slice(0, 1),
    place: (anchor, container) => anchor.appendChild(container),
  },
  // The thread breadcrumb (`aria-label="Thread breadcrumb"`) lives in the chat header: mount inline right after it.
  threadHeader: {
    find: () => Array.from(document.querySelectorAll('[aria-label="Thread breadcrumb"]')).slice(0, 1),
    place: (anchor, container) => anchor.after(container),
  },
  // `[data-chat-composer-surface="true"]` is the composer card: mount right above it.
  composerBanner: {
    find: () => Array.from(document.querySelectorAll('[data-chat-composer-surface="true"]')).slice(0, 1),
    place: (anchor, container) => anchor.before(container),
  },
  // Own dock inside `[data-slot="sidebar-inset"]` (the main area next to the sidebar). Upstream has no right panel anchor.
  rightPanel: {
    find: () => Array.from(document.querySelectorAll('[data-slot="sidebar-inset"]')).slice(0, 1),
    place: (anchor, container) => {
      const el = anchor as HTMLElement;
      if (getComputedStyle(el).position === "static") el.style.position = "relative";
      el.appendChild(container);
    },
  },
  // Upstream has no status bar: own fixed bar on the body.
  statusBar: {
    find: () => (document.body ? [document.body] : []),
    place: (anchor, container) => anchor.appendChild(container),
  },
  // The Plugins settings page marks its extension area with `data-t3p-slot-anchor="settingsPage"`.
  settingsPage: {
    find: () => Array.from(document.querySelectorAll('[data-t3p-slot-anchor="settingsPage"]')),
    place: (anchor, container) => anchor.appendChild(container),
  },
  // `[data-timeline-row-id]` is one row of the thread timeline.
  timelineRowDecorator: {
    find: () => Array.from(document.querySelectorAll("[data-timeline-row-id]")).slice(0, MAX_ROWS),
    place: (anchor, container) => anchor.appendChild(container),
    key: (anchor) => anchor.getAttribute("data-timeline-row-id") ?? "",
  },
  // `li[data-thread-item="<environmentId>:<threadId>"]` is one sidebar thread row (SidebarThreadRow.tsx). Our container goes
  // inside the row surface (`[data-sidebar-row]`, `position:relative`), absolutely placed so the row never shifts.
  threadListDecorator: {
    find: () => Array.from(document.querySelectorAll("li[data-thread-item]")).slice(0, MAX_ROWS),
    place: (anchor, container) => {
      const surface = anchor.querySelector("[data-sidebar-row]") ?? anchor;
      if (container.parentElement !== surface) surface.appendChild(container);
    },
    key: (anchor) => anchor.getAttribute("data-thread-item") ?? "",
  },
  // Open menus: `[data-slot="menu-popup"]` (base-ui) or any `[role="menu"]`.
  contextMenuItem: {
    find: () => Array.from(document.querySelectorAll('[data-slot="menu-popup"],[role="menu"]')).filter(visible),
    place: (anchor, container) => anchor.appendChild(container),
  },
  // The stock thread details popover (`[data-thread-details-card]`, exists only while open): our section goes
  // after the last stock section, before the "Choose what to show" row. Idempotent, so sync can re-run it.
  threadDetails: {
    find: () => Array.from(document.querySelectorAll(CARD)).slice(0, 1),
    place: (anchor, container) => {
      const last = stockSections(anchor).at(-1);
      if (last) {
        if (last.nextElementSibling !== container) last.after(container);
      } else if (!container.isConnected) {
        const items = anchor.querySelector('[class~="group/details-items"]') ?? anchor.firstElementChild ?? anchor;
        items.appendChild(container);
      }
    },
  },
};

interface Mount {
  /** `key()` of the anchor when mounted: a re-used element showing another row is torn down and rebuilt. */
  key?: string;
  container: HTMLElement;
  /** Where registration roots go (the dock body for rightPanel, else the container). */
  host: HTMLElement;
  /** registration token -> mounted root */
  roots: Map<Registration, { root: HTMLElement; cleanup: void | (() => void) }>;
}

interface Registration {
  plugin: string;
  reg: UiSlotRegistration;
  seq: number;
  /** anchor element -> mount; filled lazily per slot. */
}

export interface SlotEngineDeps {
  theme: Theme;
  /** Current thread id, or null. */
  threadId(): string | null;
  onError(plugin: string, error: unknown): void;
}

/**
 * Mounts plugin UI into the app's DOM. A MutationObserver on `document.body` plus `hashchange`
 * re-runs `sync()`, which: drops mounts whose anchor or container left the document (running the
 * plugin's cleanup), and mounts every registration into every anchor that does not have it yet.
 * So UI survives route changes and React re-renders: it is torn down with its anchor and rebuilt
 * when the anchor comes back.
 */
export class SlotEngine {
  readonly #regs = new Set<Registration>();
  readonly #mounts = new Map<UiSlotName, Map<Element, Mount>>();
  #seq = 0;
  #observer: MutationObserver | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #dockOpen = false;
  #dockTab: Registration | null = null;
  #setDockOpen: ((open: boolean) => void) | null = null;
  readonly #hidden = new Set<{ labels: string[] }>();

  constructor(private readonly deps: SlotEngineDeps) {}

  start(): void {
    if (this.#observer || typeof MutationObserver === "undefined") return;
    ensureStyles();
    this.#observer = new MutationObserver((records) => {
      // Ignore our own churn: mutations whose every target is inside a plugin container.
      if (records.every((r) => r.target instanceof Element && r.target.closest("[data-t3p-container]"))) return;
      // The details card is a short-lived portal: mount synchronously (this callback runs before paint) so it never flashes without our section.
      if (this.#mounts.get("threadDetails")?.size || this.#hidden.size || this.#hasRegs("threadDetails")) {
        if (document.querySelector(CARD) || this.#mounts.get("threadDetails")?.size) this.#syncSlot("threadDetails");
      }
      this.schedule();
    });
    this.#observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("hashchange", () => this.schedule());
    window.addEventListener("popstate", () => this.schedule());
    this.schedule();
  }

  schedule(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (typeof document === "undefined") return; // timer outlived its page (test teardown)
      this.sync();
    }, 40);
  }

  /** Registers a slot UI. Returns the remover (unmounts and runs the cleanup). */
  add(plugin: string, reg: UiSlotRegistration): () => void {
    if (!reg || !SLOT_NAMES.includes(reg.slot)) throw new Error(`t3.ui.register: unknown slot ${String(reg?.slot)}`);
    if (typeof reg.id !== "string" || !/^[A-Za-z0-9._-]+$/.test(reg.id)) throw new Error("t3.ui.register: id must match [A-Za-z0-9._-]+");
    if (typeof reg.render !== "function") throw new Error("t3.ui.register: render must be a function");
    for (const other of this.#regs) if (other.plugin === plugin && other.reg.id === reg.id) throw new Error(`t3.ui.register: ${plugin}/${reg.id} is already registered`);
    const entry: Registration = { plugin, reg: { ...reg }, seq: (this.#seq += 1) };
    this.#regs.add(entry);
    this.start();
    this.schedule();
    return () => {
      if (!this.#regs.delete(entry)) return;
      for (const mounts of this.#mounts.values()) {
        for (const [anchor, mount] of mounts) {
          this.#unmount(mount, entry);
          if (mount.roots.size === 0) {
            mount.container.remove();
            mounts.delete(anchor);
          }
        }
      }
      this.schedule();
    };
  }

  #hasRegs(slot: UiSlotName): boolean {
    for (const r of this.#regs) if (r.reg.slot === slot) return true;
    return false;
  }

  /** `t3.ui.threadDetails.hide`: hides stock card rows by visible label. Returns the remover. */
  hideStockRows(labels: string[]): () => void {
    if (!Array.isArray(labels) || labels.some((l) => typeof l !== "string")) throw new Error("t3.ui.threadDetails.hide: labels must be an array of strings");
    const entry = { labels: labels.map(norm).filter(Boolean) };
    this.#hidden.add(entry);
    this.start();
    this.schedule();
    return () => {
      if (!this.#hidden.delete(entry)) return;
      this.#applyHidden();
    };
  }

  /** Marks matching stock rows (`data-t3p-hidden`) and collapses sections whose rows are all hidden. Idempotent. */
  #applyHidden(): void {
    for (const el of Array.from(document.querySelectorAll(`${CARD} [data-t3p-hidden]`))) el.removeAttribute("data-t3p-hidden");
    const wanted = new Set<string>();
    for (const e of this.#hidden) for (const l of e.labels) wanted.add(l);
    if (wanted.size === 0) return;
    for (const card of Array.from(document.querySelectorAll(CARD))) {
      for (const section of stockSections(card)) {
        const body = section.lastElementChild;
        if (!body) continue;
        // A row is a child of the section body (or of the body's single flex column). Match on a descendant's own label text.
        const column = body.children.length === 1 && body.firstElementChild?.children.length ? body.firstElementChild : body;
        const rows = Array.from(column.children) as HTMLElement[];
        for (const row of rows) {
          const texts = [norm(row.getAttribute("aria-label")), ...Array.from(row.querySelectorAll("span,p,h3,div,button")).filter((n) => n.children.length === 0).map((n) => norm(n.textContent))];
          if (texts.includes("") && texts.length === 1) continue;
          if (texts.some((t) => wanted.has(t)) || wanted.has(norm(row.textContent))) row.setAttribute("data-t3p-hidden", "");
        }
        if (rows.length > 0 && rows.every((r) => r.hasAttribute("data-t3p-hidden"))) section.setAttribute("data-t3p-hidden", "");
      }
    }
  }

  /** `t3.ui.dock` for one plugin. `tabId` picks one of that plugin's own `rightPanel` registrations. */
  dockControl(plugin: string): T3UiDock {
    const select = (tabId: string | undefined): void => {
      if (tabId === undefined) return;
      const entry = [...this.#regs].find((r) => r.plugin === plugin && r.reg.slot === "rightPanel" && r.reg.id === tabId);
      if (!entry) throw new Error(`t3.ui.dock: ${plugin} has no rightPanel registration "${String(tabId)}"`);
      this.#dockTab = entry;
      this.#renderDockTabs();
    };
    const open = (tabId?: string): void => {
      select(tabId);
      this.#setDockOpen?.(true);
    };
    return Object.freeze({
      open,
      close: (): void => this.#setDockOpen?.(false),
      toggle: (tabId?: string): void => (this.#dockOpen ? this.#setDockOpen?.(false) : open(tabId)),
      isOpen: (): boolean => this.#dockOpen,
    });
  }

  /** Mounted roots, for diagnostics (`window.__t3p.ui.mounted()`). */
  mounted(): Array<{ slot: string; plugin: string; id: string; anchor: string }> {
    const out: Array<{ slot: string; plugin: string; id: string; anchor: string }> = [];
    for (const [slot, mounts] of this.#mounts) {
      for (const [anchor, mount] of mounts) {
        for (const [entry] of mount.roots) out.push({ slot, plugin: entry.plugin, id: entry.reg.id, anchor: describe(anchor) });
      }
    }
    return out;
  }

  sync(): void {
    for (const slot of SLOT_NAMES) this.#syncSlot(slot);
  }

  dispose(): void {
    this.#observer?.disconnect();
    this.#observer = null;
    for (const entry of [...this.#regs]) {
      for (const mounts of this.#mounts.values()) for (const mount of mounts.values()) this.#unmount(mount, entry);
    }
    for (const mounts of this.#mounts.values()) for (const mount of mounts.values()) mount.container.remove();
    this.#mounts.clear();
    this.#regs.clear();
  }

  #syncSlot(slot: UiSlotName): void {
    const regs = [...this.#regs].filter((r) => r.reg.slot === slot).sort((a, b) => (a.reg.order ?? 0) - (b.reg.order ?? 0) || a.seq - b.seq);
    const mounts = this.#mounts.get(slot) ?? new Map<Element, Mount>();
    this.#mounts.set(slot, mounts);

    // Drop mounts whose anchor or container is gone (route change, re-render).
    for (const [anchor, mount] of mounts) {
      const staleKey = slot === "threadListDecorator" && mount.key !== (DEFS[slot].key?.(anchor) ?? "");
      if (!anchor.isConnected || !mount.container.isConnected || staleKey) {
        for (const entry of [...mount.roots.keys()]) this.#unmount(mount, entry);
        mount.container.remove();
        mounts.delete(anchor);
      }
    }
    if (slot === "threadDetails") this.#applyHidden();
    if (regs.length === 0) return;

    const def = DEFS[slot];
    // The card re-renders under us: keep our section right after the last stock section.
    if (slot === "threadDetails") for (const [anchor, mount] of mounts) def.place(anchor, mount.container);
    const anchors = def.find();
    if (slot === "threadListDecorator") for (const [anchor, mount] of mounts) def.place(anchor, mount.container);
    for (const anchor of anchors) {
      let mount = mounts.get(anchor);
      if (!mount) {
        if (slot === "rightPanel") {
          const dock = this.#dock();
          def.place(anchor, dock.container);
          mount = { container: dock.container, host: dock.host, roots: new Map() };
        } else {
          const container =
            slot === "statusBar"
              ? h("div", { class: "t3p-statusbar", "data-t3p-root": "", "data-t3p-container": "statusBar" })
              : slot === "threadListDecorator"
                ? h("div", { class: "t3p-tld", "data-t3p-root": "", "data-t3p-container": slot })
                : slot === "threadDetails"
                ? h("section", { class: "t3p-td-section", "data-t3p-root": "", "data-t3p-container": slot, "aria-label": "Plugins", style: "display:flex;flex-direction:column;gap:4px" })
                : h("div", { "data-t3p-root": "", "data-t3p-container": slot, style: slot === "threadHeader" ? "" : "display:flex;flex-direction:column;gap:4px" });
          def.place(anchor, container);
          mount = { key: DEFS[slot].key?.(anchor), container, host: container, roots: new Map() };
        }
        mounts.set(anchor, mount);
      }
      // Bring the sidebar section container back to the end when React appended later siblings.
      for (const entry of regs) {
        if (mount.roots.has(entry)) continue;
        this.#mountOne(slot, entry, anchor, mount);
      }
      // Registrations that were removed from the set are unmounted by `add`'s remover; order is applied by CSS `order`.
    }
    // A registration that no longer matches an anchor that vanished is handled above. Update dock tabs.
    if (slot === "rightPanel") this.#renderDockTabs();
  }

  #mountOne(slot: UiSlotName, entry: Registration, anchor: Element, mount: Mount): void {
    const root = h("div", {
      "data-t3p-root": "",
      "data-t3p-plugin": entry.plugin,
      "data-t3p-slot": slot,
      "data-t3p-id": entry.reg.id,
      style: `order:${entry.reg.order ?? 0}`,
    });
    if (slot === "rightPanel") root.hidden = true;
    mount.host.appendChild(root);
    const key = DEFS[slot].key?.(anchor) ?? "";
    const deps = this.deps;
    const context: UiSlotContext = {
      slot,
      // Live: the header stays mounted while the route moves between threads.
      get threadId() {
        // A sidebar row belongs to its own thread, not the focused one: `<environmentId>:<threadId>`.
        if (slot === "threadListDecorator") return key.slice(key.indexOf(":") + 1) || null;
        return deps.threadId();
      },
      record: null,
      onThemeChange: (cb) => this.deps.theme.onChange(cb),
    };
    if (slot === "timelineRowDecorator") root.dataset.t3pRow = key;
    let cleanup: void | (() => void) = undefined;
    try {
      cleanup = entry.reg.render(root, context);
    } catch (error) {
      this.deps.onError(entry.plugin, error);
      root.textContent = "";
    }
    mount.roots.set(entry, { root, cleanup: typeof cleanup === "function" ? cleanup : undefined });
  }

  #unmount(mount: Mount, entry: Registration): void {
    const item = mount.roots.get(entry);
    if (!item) return;
    mount.roots.delete(entry);
    try {
      if (typeof item.cleanup === "function") item.cleanup();
    } catch (error) {
      this.deps.onError(entry.plugin, error);
    }
    item.root.remove();
  }

  /** The right panel: a dock with one tab per registration (`title` or id). Collapsed until the toggle is pressed. */
  #dock(): { container: HTMLElement; host: HTMLElement } {
    const tabs = h("div", { class: "t3p-dock-tabs", role: "tablist" });
    const host = h("div", { class: "t3p-dock-body" });
    const grip = h("div", { class: "t3p-dock-grip", role: "separator", "aria-orientation": "vertical" });
    const dock = h("aside", { class: "t3p-dock", hidden: !this.#dockOpen }, grip, tabs, host);
    const root = document.documentElement;
    const setWidth = (w: number): void => {
      const clamped = Math.round(Math.max(260, Math.min(w, Math.min(760, window.innerWidth * 0.6))));
      root.style.setProperty("--t3p-dock-w", `${clamped}px`);
      try {
        localStorage.setItem("t3p-dock-w", String(clamped));
      } catch {
        // storage unavailable
      }
    };
    try {
      const saved = Number(localStorage.getItem("t3p-dock-w"));
      if (saved) setWidth(saved);
    } catch {
      // storage unavailable
    }
    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      grip.setAttribute("data-drag", "");
      grip.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent): void => setWidth(window.innerWidth - ev.clientX);
      const up = (): void => {
        grip.removeAttribute("data-drag");
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
    });
    document.body.classList.toggle("t3p-dock-open", this.#dockOpen);
    const toggle = h("button", { class: "t3p-chip t3p-dock-toggle", "data-compact": "", type: "button", "data-t3p-dock-toggle": "", "aria-label": "Toggle plugin panel" }, "Plugins");
    const setOpen = (open: boolean): void => {
      this.#dockOpen = open;
      dock.hidden = !open;
      document.body.classList.toggle("t3p-dock-open", open);
      if (!open) return;
      // Start below the app header so the dock never covers its buttons or the window controls.
      const inset = dock.parentElement?.parentElement;
      const header = inset?.querySelector("header");
      if (inset && header) dock.style.setProperty("--t3p-dock-top", `${Math.ceil(header.getBoundingClientRect().bottom - inset.getBoundingClientRect().top)}px`);
    };
    this.#setDockOpen = setOpen;
    toggle.addEventListener("click", () => setOpen(!this.#dockOpen));
    const close = h("button", { class: "t3p-btn t3p-dock-close", type: "button", "aria-label": "Close panel", title: "Close (Esc)" }, "×");
    close.addEventListener("click", () => setOpen(false));
    dock.appendChild(close);
    // Click outside the panel (not on its toggle, our UI, or an app popup) or Escape closes it.
    document.addEventListener("pointerdown", (e) => {
      if (!this.#dockOpen || !(e.target instanceof Element)) return;
      if (e.target.closest("[data-t3p-root],[role=menu],[role=dialog],[role=listbox],[data-radix-popper-content-wrapper]")) return;
      setOpen(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.#dockOpen) setOpen(false);
    });
    const container = h("div", { "data-t3p-root": "", "data-t3p-container": "rightPanel" }, toggle, dock);
    return { container, host };
  }

  #renderDockTabs(): void {
    const mounts = this.#mounts.get("rightPanel");
    if (!mounts) return;
    for (const mount of mounts.values()) {
      const tabs = mount.container.querySelector(".t3p-dock-tabs");
      if (!tabs) continue;
      const entries = [...mount.roots.keys()].sort((a, b) => (a.reg.order ?? 0) - (b.reg.order ?? 0) || a.seq - b.seq);
      if (!this.#dockTab || !entries.includes(this.#dockTab)) this.#dockTab = entries[0] ?? null;
      tabs.textContent = "";
      for (const entry of entries) {
        const selected = entry === this.#dockTab;
        const tab = h("button", { class: "t3p-dock-tab", type: "button", role: "tab", "aria-selected": String(selected), "data-t3p-tab": entry.reg.id }, entry.reg.title ?? entry.reg.id);
        tab.addEventListener("click", () => {
          this.#dockTab = entry;
          this.#renderDockTabs();
        });
        tabs.appendChild(tab);
        const root = mount.roots.get(entry)?.root;
        if (root) root.hidden = !selected;
      }
    }
  }
}

function describe(el: Element): string {
  const slot = el.getAttribute("data-slot");
  return `${el.tagName.toLowerCase()}${slot ? `[data-slot=${slot}]` : ""}${el.id ? `#${el.id}` : ""}`;
}
