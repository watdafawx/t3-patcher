import type { ModalOptions, ToastOptions } from "@t3p/api";

import { clear, ensureStyles, h } from "./dom.js";

/** Toasts and modals. Plain DOM on `document.body`, removed with the plugin scope. */
export class Overlays {
  #toasts: HTMLElement | null = null;

  /** Shows a toast. Returns a function that removes it. */
  toast(plugin: string, options: ToastOptions): () => void {
    ensureStyles();
    if (!options || typeof options.message !== "string") throw new Error("t3.ui.toast: message is required");
    if (!this.#toasts || !this.#toasts.isConnected) {
      this.#toasts = h("div", { class: "t3p-toasts", "data-t3p-root": "", "data-t3p-toasts": "" });
      document.body.appendChild(this.#toasts);
    }
    const kind = options.kind ?? "info";
    const actions = Array.isArray(options.actions) ? options.actions.filter((a) => a && typeof a.label === "string" && typeof a.onClick === "function") : [];
    const buttons = actions.map((action) =>
      h(
        "button",
        {
          class: "t3p-btn",
          type: "button",
          "data-primary": action.primary ? "" : undefined,
          onClick: () => {
            // Dismiss first, so a throwing or slow action never leaves the toast open.
            remove(false);
            try {
              void Promise.resolve(action.onClick()).catch(() => undefined);
            } catch {
              // plugin action failed; the toast is already gone
            }
          },
        },
        action.label,
      ),
    );
    const node = h(
      "div",
      { class: "t3p-toast t3p-glass", role: "status", "data-kind": kind, "data-t3p-plugin": plugin },
      options.title ? h("b", null, options.title) : null,
      h("span", null, options.message),
      buttons.length > 0 ? h("div", { class: "t3p-buttons" }, ...buttons) : null,
    );
    let closed = false;
    const remove = (dismissed = false): void => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      node.remove();
      if (dismissed && typeof options.onDismiss === "function") {
        try {
          options.onDismiss();
        } catch {
          // plugin callback failed; the toast is already gone
        }
      }
    };
    node.addEventListener("click", () => remove(true));
    this.#toasts.appendChild(node);
    const duration = options.durationMs === undefined ? 5000 : Math.max(0, Number(options.durationMs) || 0);
    const timer: ReturnType<typeof setTimeout> = duration > 0 ? setTimeout(() => remove(true), duration) : (0 as unknown as ReturnType<typeof setTimeout>);
    return () => remove(false);
  }

  /** Opens a modal. Resolves with the pressed button index, or -1 when dismissed (Escape, backdrop, plugin stop). */
  modal(plugin: string, options: ModalOptions, onClose: (close: () => void) => void): Promise<number> {
    ensureStyles();
    if (!options || typeof options.title !== "string") throw new Error("t3.ui.modal: title is required");
    const labels = Array.isArray(options.buttons) && options.buttons.length > 0 ? options.buttons.map(String) : ["OK"];
    return new Promise<number>((resolve) => {
      const body = h("div", { class: "t3p-modal-body" });
      let bodyCleanup: (() => void) | void;
      let done = false;
      const finish = (index: number): void => {
        if (done) return;
        done = true;
        document.removeEventListener("keydown", onKey, true);
        try {
          bodyCleanup?.();
        } catch {
          // plugin cleanup failed; the modal still closes
        }
        overlay.remove();
        resolve(index);
      };
      const onKey = (event: KeyboardEvent): void => {
        if (event.key === "Escape") {
          event.stopPropagation();
          finish(-1);
        }
      };
      const buttons = labels.map((label, index) => h("button", { class: "t3p-btn", type: "button", ...(index === labels.length - 1 ? { "data-primary": "" } : {}), onClick: () => finish(index) }, label));
      const overlay = h(
        "div",
        { class: "t3p-overlay", "data-t3p-root": "", "data-t3p-modal": "", "data-t3p-plugin": plugin, onMousedown: (event: Event) => event.target === overlay && finish(-1) },
        h("div", { class: "t3p-modal t3p-glass", role: "dialog", "aria-modal": "true", "aria-label": options.title }, h("h2", null, options.title), body, h("div", { class: "t3p-buttons" }, ...buttons)),
      );
      document.body.appendChild(overlay);
      document.addEventListener("keydown", onKey, true);
      onClose(() => finish(-1));
      if (typeof options.body === "string") body.textContent = options.body;
      else {
        clear(body);
        try {
          bodyCleanup = options.body(body);
        } catch (error) {
          body.textContent = `plugin ${plugin} failed to render: ${String(error)}`;
        }
      }
      (buttons[buttons.length - 1] as HTMLElement | undefined)?.focus();
    });
  }
}
