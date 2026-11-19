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

export const SLOT_NAMES: readonly UiSlotName[] = ["sidebarSection", "threadHeader", "composerBanner", "rightPanel", "statusBar", "settingsPage", "timelineRowDecorator", "contextMenuItem"];

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
  // Open menus: `[data-slot="menu-popup"]` (base-ui) or any `[role="menu"]`.
  contextMenuItem: {
    find: () => Array.from(document.querySelectorAll('[data-slot="menu-popup"],[role="menu"]')).filter(visible),
    place: (anchor, container) => anchor.appendChild(container),
  },
};

interface Mount {
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

  constructor(private readonly deps: SlotEngineDeps) {}

  start(): void {
    if (this.#observer || typeof MutationObserver === "undefined") return;
    ensureStyles();
    this.#observer = new MutationObserver((records) => {
      // Ignore our own churn: mutations whose every target is inside a plugin container.
      if (records.every((r) => r.target instanceof Element && r.target.closest("[data-t3p-container]"))) return;
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
      if (!anchor.isConnected || !mount.container.isConnected) {
        for (const entry of [...mount.roots.keys()]) this.#unmount(mount, entry);
        mount.container.remove();
        mounts.delete(anchor);
      }
    }
    if (regs.length === 0) return;

    const def = DEFS[slot];
    const anchors = def.find();
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
              : h("div", { "data-t3p-root": "", "data-t3p-container": slot, style: slot === "threadHeader" ? "" : "display:flex;flex-direction:column;gap:4px" });
          def.place(anchor, container);
          mount = { container, host: container, roots: new Map() };
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
