import type { T3Api, T3Disposable, Unsubscribe } from "@t3p/api";

import type { SwitchQueue } from "../queue.js";
import { providerViews, projectionView } from "../map.js";
import { openSwitchMenu, type OpenMenu } from "./open-menu.js";

export interface HeaderDeps {
  queue: SwitchQueue;
}

/**
 * The thread-header control: current provider and model of the focused thread, one click away from
 * the menu, plus the pending indicator of a queued switch with its cancel button.
 *
 * State comes from `t3.threads.projection` (fresh on mount, on `thread:focus`, on provider changes
 * and on the thread's own model/provider events), never from a cached copy.
 */
export function registerThreadHeader(t3: T3Api, deps: HeaderDeps): T3Disposable {
  return t3.ui.register({
    slot: "threadHeader",
    id: "switch-control",
    title: "Model",
    order: 10,
    render(host, ctx) {
      const root = document.createElement("div");
      root.style.cssText = "display:flex;align-items:center;gap:6px;min-width:0";
      root.setAttribute("data-t3p-widget", "provider-switcher");

      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("aria-haspopup", "dialog");
      button.title = "Switch this thread's model or provider";
      button.className = "t3p-btn";
      button.style.cssText = "max-width:min(320px,40vw);min-width:0;overflow:hidden;text-overflow:ellipsis;justify-content:flex-start";

      const pending = document.createElement("span");
      pending.hidden = true;
      pending.className = "t3p-badge";
      pending.style.cssText = "gap:4px;max-width:min(340px,44vw);min-width:0;padding-right:2px;border:1px dashed var(--border,currentColor);overflow:hidden";
      const pendingText = document.createElement("span");
      pendingText.style.cssText = "overflow:hidden;text-overflow:ellipsis";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Cancel";
      cancel.title = "Cancel the queued switch";
      cancel.className = "t3p-chip";
      cancel.setAttribute("data-compact", "");
      cancel.style.cssText = "height:16px;padding:0 4px;text-decoration:underline";
      cancel.addEventListener("click", () => deps.queue.cancel());
      pending.append(pendingText, cancel);

      root.append(button, pending);
      host.appendChild(root);

      let disposed = false;
      let generation = 0;
      let menu: OpenMenu | null = null;
      let watchedThreadId: string | null = null;
      let streamCancel: Unsubscribe | null = null;
      const offs: Unsubscribe[] = [];

      const currentThreadId = (): string | null => t3.threads.current() ?? ctx.threadId ?? watchedThreadId;

      const paintPending = (): void => {
        const queued = deps.queue.pending;
        const threadId = currentThreadId();
        if (!queued || (threadId !== null && queued.threadId !== threadId)) {
          pending.hidden = true;
          return;
        }
        pending.hidden = false;
        pendingText.textContent = `Queued: ${queued.selection.model}`;
        pending.title = `Switch to ${queued.selection.providerInstanceId} / ${queued.selection.model} when the run ends`;
      };

      const refresh = async (): Promise<void> => {
        const threadId = currentThreadId();
        const ticket = ++generation;
        watch(threadId);
        if (!threadId) {
          button.disabled = true;
          button.textContent = "Select model…";
          button.title = "Open a thread to switch its model";
          return;
        }
        button.disabled = false;
        try {
          const [providers, projection] = await Promise.all([t3.providers.list(), t3.threads.projection(threadId)]);
          if (disposed || ticket !== generation) return;
          const views = providerViews(providers);
          const selection = projectionView(projection).modelSelection;
          if (!selection) {
            button.textContent = "Select model…";
            button.title = "This thread has no model selection yet";
            return;
          }
          const provider = views.find((candidate) => candidate.instanceId === selection.providerInstanceId);
          const providerLabel = provider?.displayName?.trim() || selection.providerInstanceId;
          const modelLabel = provider?.models.find((model) => model.slug === selection.model)?.name?.trim() || selection.model;
          const text = `${providerLabel} · ${modelLabel}`;
          button.textContent = text;
          button.title = `${text} — switch model or provider`;
        } catch (error) {
          if (disposed || ticket !== generation) return;
          t3.log("debug", `header refresh failed for ${threadId}: ${String(error)}`);
          button.textContent = "Model unavailable";
          button.title = error instanceof Error ? error.message : String(error);
        }
      };

      /** One stream per focused thread, to repaint when the model changes anywhere else. */
      const watch = (threadId: string | null): void => {
        if (threadId === watchedThreadId) return;
        watchedThreadId = threadId;
        streamCancel?.();
        streamCancel = null;
        if (!threadId) return;
        try {
          streamCancel = t3.threads.subscribe(threadId, (item) => {
            if (disposed || item.kind !== "event") return;
            const type = (item.event as { type?: unknown }).type;
            if (type === "thread.model-selection.set" || type === "provider.switch") void refresh();
          });
        } catch (error) {
          t3.log("debug", `cannot watch ${threadId} for model changes: ${String(error)}`);
        }
      };

      const closeMenu = (): void => {
        const open = menu;
        menu = null;
        open?.close();
      };

      const openMenu = (): void => {
        closeMenu();
        const threadId = currentThreadId();
        if (!threadId) {
          t3.ui.toast({ title: "Provider switcher", message: "Open a thread first.", kind: "info" });
          return;
        }
        void openSwitchMenu(t3, deps.queue, {
          threadId,
          title: "Switch model",
          anchor: button,
          shouldCancel: () => disposed,
        }).then((opened) => {
          if (!opened) return;
          if (disposed) opened.close();
          else menu = opened;
        });
      };

      button.addEventListener("click", openMenu);

      offs.push(t3.providers.onChange(() => void refresh()));
      offs.push(t3.events.on("thread:focus", () => void refresh()));
      offs.push(deps.queue.subscribe(paintPending));

      paintPending();
      void refresh();

      return () => {
        disposed = true;
        for (const off of offs) {
          try {
            off();
          } catch {
            // a failing listener removal must not block cleanup
          }
        }
        streamCancel?.();
        streamCancel = null;
        closeMenu();
        root.remove();
      };
    },
  });
}
