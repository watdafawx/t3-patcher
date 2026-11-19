import type { InternalHandles, ModalOptions, PluginPatch, T3Disposable, T3Internals, T3Patches, T3Ui, ToastOptions, UiSlotRegistration, PermissionSet, T3LogLevel } from "@t3p/api";

import { CommandRegistry } from "./commands.js";
import { InternalsHub } from "./internals.js";
import { KeybindRegistry } from "./keybinds.js";
import type { Scope } from "./scope.js";
import { Fallbacks } from "./ui/fallbacks.js";
import { Overlays } from "./ui/overlays.js";
import { type ManagerFacade, mountPluginsPage } from "./ui/plugins-page.js";
import { SlotEngine } from "./ui/slots.js";
import { Theme } from "./ui/theme.js";
import type { EventBus, NativeBridgeLike } from "./types.js";

export interface ShellDeps {
  native: NativeBridgeLike | null;
  systemBus: EventBus;
  log(level: T3LogLevel, message: string, plugin?: string): void;
  consoleError(...args: unknown[]): void;
  /** Delay before captures that did not arrive get their fallback verdict. */
  finalizeAfterMs?: number;
}

/** The namespaces the shell implements for one plugin. */
export interface ShellNamespaces {
  ui: T3Ui;
  commands: ReturnType<CommandRegistry["namespace"]>;
  keybinds: ReturnType<KeybindRegistry["namespace"]>;
  patches: T3Patches;
  internals: T3Internals;
}

const THREAD_HASH = /^#?\/?([^/?#]+)\/([^/?#]+)/;
const NOT_THREAD = new Set(["settings", "draft", "_chat", "pair", "auth"]);

/**
 * WP-3D runtime: slots, toast/modal, themeVars, commands, keybinds, plugin patches, tier 2 captures
 * and the Plugins settings page. One per page, created at bootstrap before the app's first module runs.
 * The app's patched chunks reach it through `window.__t3p_plugins["t3p.core"]` (see `core()`).
 */
export class Shell {
  readonly hub: InternalsHub;
  readonly commands: CommandRegistry;
  readonly keybinds: KeybindRegistry;
  readonly theme = new Theme();
  readonly overlays = new Overlays();
  readonly slots: SlotEngine;
  readonly fallbacks: Fallbacks;
  #manager: ManagerFacade | null = null;
  #lastThread: string | null | undefined;
  #batch = 0;
  #started = false;

  constructor(private readonly deps: ShellDeps) {
    const reportError = (plugin: string, error: unknown): void => {
      deps.consoleError(`[t3p] ${plugin} failed`, error);
      deps.log("error", String(error instanceof Error ? (error.stack ?? error.message) : error), plugin);
    };
    this.hub = new InternalsHub(deps.native, (message) => deps.log("warn", message));
    this.commands = new CommandRegistry(reportError);
    this.keybinds = new KeybindRegistry(this.commands, this.hub, reportError);
    this.slots = new SlotEngine({ theme: this.theme, threadId: () => this.threadId(), onError: reportError });
    this.fallbacks = new Fallbacks({ hub: this.hub, commands: this.commands, openPluginsPage: () => this.openPluginsPage() });
    // atomRegistry has no substitute: a plugin that needs it must check `t3.internals.status()`.
    this.commands.add("t3p.core", { id: "open-plugins", title: "Plugins: open settings page", description: "t3p", keywords: ["plugins", "settings", "extensions"], run: () => this.openPluginsPage() });
  }

  /** Called once the plugin manager exists. */
  attach(manager: ManagerFacade): void {
    this.#manager = manager;
  }

  start(win: Record<string, unknown>): void {
    if (this.#started) return;
    this.#started = true;
    const doc = (win as { document?: unknown }).document;
    if (!doc && typeof document === "undefined") return;
    const begin = (): void => {
      this.slots.start();
      this.fallbacks.start();
      this.#announceThread();
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", begin, { once: true });
    else begin();
    window.addEventListener("hashchange", () => this.#announceThread());
    this.deps.systemBus.on("app:ready", () => {
      setTimeout(() => this.hub.finalize(), this.deps.finalizeAfterMs ?? 3000);
      this.#announceThread();
    });
  }

  /** Current thread id: from the captured router when possible, else from the hash. */
  threadId(): string | null {
    try {
      const router = this.hub.get("router") as { state?: { matches?: Array<{ params?: Record<string, string> }> } } | null;
      for (const match of router?.state?.matches ?? []) {
        const id = match.params?.threadId;
        if (typeof id === "string" && id) return id;
      }
      if (router?.state?.matches) return null;
    } catch {
      // fall through to the hash
    }
    const m = THREAD_HASH.exec(window.location.hash);
    return m && !NOT_THREAD.has(m[1]!) ? decodeURIComponent(m[2]!) : null;
  }

  /** Navigates the app to a route path. Router when captured, otherwise the hash. */
  navigate(path: string): void {
    const router = this.hub.get("router") as { navigate?: (o: { to: string }) => unknown } | null;
    if (router && typeof router.navigate === "function") {
      try {
        void router.navigate({ to: path });
        return;
      } catch (error) {
        this.deps.consoleError("[t3p] router.navigate failed", error);
      }
    }
    window.location.hash = `#${path}`;
  }

  /** The Plugins page: the real settings route when registered, else an overlay. */
  openPluginsPage(): void {
    if (this.hub.has("settingsNav")) {
      this.navigate("/settings/plugins");
      return;
    }
    const manager = this.#manager;
    if (!manager) return;
    document.querySelector("[data-t3p-overlay-page]")?.remove();
    const holder = document.createElement("div");
    holder.className = "t3p-overlay-page";
    holder.setAttribute("data-t3p-overlay-page", "");
    holder.setAttribute("data-t3p-fallback", "page");
    const close = document.createElement("button");
    close.className = "t3p-btn";
    close.type = "button";
    close.textContent = "Close";
    close.style.cssText = "position:absolute;top:12px;right:16px";
    holder.appendChild(close);
    const dispose = mountPluginsPage(holder, manager, (message) => this.overlays.toast("t3p.core", { message, kind: "error" }));
    close.addEventListener("click", () => {
      dispose();
      holder.remove();
    });
    (document.querySelector('[data-slot="sidebar-inset"]') ?? document.body).appendChild(holder);
  }

  /** `window.__t3p_plugins["t3p.core"]`: the target of `$self` in the first-party capture patches. */
  core(): Record<string, unknown> {
    const hub = this.hub;
    return {
      capture: <T>(name: string, value: T, aux?: Record<string, unknown>): T => hub.capture(name, value, aux),
      palette: (input: unknown): unknown => this.#palette(input),
      settingsRoute: (about: unknown): unknown => this.#settingsRoute(about),
      PluginsIcon: (props: Record<string, unknown>): unknown => {
        const createElement = hub.aux<(...args: unknown[]) => unknown>("atomRegistry", "createElement");
        if (!createElement) return null;
        return createElement(
          "svg",
          { ...props, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
          createElement("path", { d: "M12 22v-5M9 8V2M15 8V2M18 8v5a6 6 0 0 1-12 0V8z" }),
        );
      },
    };
  }

  #palette(input: unknown): unknown {
    try {
      const value = input as { isInSubmenu?: boolean; activeGroups?: Array<{ value: string }> } | null;
      if (!value || value.isInSubmenu || !Array.isArray(value.activeGroups)) return input;
      if (value.activeGroups.some((g) => g.value === "t3p-commands")) return input;
      const items = this.commands.paletteItems();
      if (items.length === 0) return input;
      return { ...value, activeGroups: [...value.activeGroups, { value: "t3p-commands", label: "Plugins", items }] };
    } catch {
      return input;
    }
  }

  #settingsRoute(about: unknown): unknown {
    const hub = this.hub;
    const route = about as { constructor: new (options: object) => { update(options: object): void }; options?: Record<string, unknown> };
    try {
      const createElement = hub.aux<(...args: unknown[]) => unknown>("atomRegistry", "createElement");
      if (!createElement) throw new Error("React createElement not captured (atomRegistry)");
      const options = route.options ?? {};
      const swap = (value: unknown): string => String(value).replace(/about$/, "plugins");
      const manager = (): ManagerFacade => {
        if (!this.#manager) throw new Error("plugin manager not ready");
        return this.#manager;
      };
      let dispose: (() => void) | null = null;
      const component = (): unknown =>
        createElement("div", {
          "data-t3p-settings-route": "",
          ref: (el: HTMLElement | null) => {
            dispose?.();
            dispose = null;
            if (el) dispose = mountPluginsPage(el, manager(), (message) => this.overlays.toast("t3p.core", { message, kind: "error" }));
          },
        });
      const clone = new route.constructor({});
      clone.update({ ...options, id: swap(options.id), path: swap(options.path), component, getParentRoute: options.getParentRoute });
      (clone as { isRoot?: boolean }).isRoot = false; // the constructor ran without a path, so it flagged the clone as the root route
      return clone;
    } catch (error) {
      this.deps.consoleError("[t3p] Plugins settings route failed", error);
      hub.veto("settingsNav", String(error instanceof Error ? error.message : error));
      try {
        const dummy = new route.constructor({});
        const options = route.options ?? {};
        dummy.update({ ...options, id: "/__t3p-unavailable", path: "/__t3p-unavailable", component: () => null, getParentRoute: options.getParentRoute });
        (dummy as { isRoot?: boolean }).isRoot = false;
        return dummy;
      } catch {
        return about;
      }
    }
  }

  #announceThread(): void {
    const id = this.threadId();
    if (id === this.#lastThread) return;
    this.#lastThread = id;
    this.deps.systemBus.emit("thread:focus", { threadId: id });
    this.slots.schedule();
  }

  /** `t3.ui`, `t3.commands`, `t3.keybinds`, `t3.patches`, `t3.internals` for one plugin. */
  namespaces(plugin: string, scope: Scope, effective: PermissionSet): ShellNamespaces {
    const ui: T3Ui = Object.freeze({
      register: (registration: UiSlotRegistration): T3Disposable => {
        scope.assertAlive();
        const off = this.slots.add(plugin, registration);
        const forget = scope.add(off);
        return Object.freeze({ dispose: () => forget() });
      },
      toast: (options: ToastOptions): void => {
        scope.assertAlive();
        const remove = this.overlays.toast(plugin, options);
        scope.add(remove);
      },
      modal: (options: ModalOptions): Promise<number> => {
        scope.assertAlive();
        let close: () => void = () => undefined;
        const forget = scope.add(() => close());
        return this.overlays.modal(plugin, options, (fn) => (close = fn)).finally(() => forget());
      },
      themeVars: () => this.theme.values(),
    });
    const internals: T3Internals = Object.freeze({
      get: <K extends keyof InternalHandles>(name: K): InternalHandles[K] | null => this.hub.get(name),
      status: () => this.hub.status(),
    });
    const patches: T3Patches = Object.freeze({
      register: (list: PluginPatch[]): T3Disposable => {
        scope.assertAlive();
        if (!effective.patches) throw new Error("t3.patches.register needs the `patches` permission (declare it in plugin.json and enable the plugin with `t3p enable`)");
        if (!this.deps.native) throw new Error("t3.patches.register: native bridge is not available");
        const native = this.deps.native;
        const batch = `b${(this.#batch += 1)}`;
        const wire = toWire(list);
        native.invoke("t3p:patches:register", { plugin, batch, patches: wire }).catch((error: unknown) => {
          this.deps.log("error", `t3.patches.register failed: ${String(error)}`, plugin);
        });
        const forget = scope.add(() => {
          native.invoke("t3p:patches:unregister", { plugin, batch }).catch(() => undefined);
        });
        return Object.freeze({ dispose: () => forget() });
      },
    });
    return {
      ui,
      commands: this.commands.namespace(plugin, scope),
      keybinds: this.keybinds.namespace(plugin, scope),
      patches,
      internals,
    };
  }
}

function toWire(list: PluginPatch[]): unknown {
  if (!Array.isArray(list)) throw new Error("t3.patches.register: expected an array of patches");
  const conv = (value: unknown): unknown => (value instanceof RegExp ? { regex: { source: value.source, flags: value.flags } } : value);
  return list.map((p) => ({ find: conv(p.find), replacements: (p.replacements ?? []).map((r) => ({ match: conv(r.match), replace: r.replace })) }));
}
