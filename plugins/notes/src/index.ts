import type { PluginModule, T3Api } from "@t3p/api";

import {
  Autosaver,
  clampHeight,
  describeCount,
  GENERAL,
  menuEntries,
  noteKey,
  parseUi,
  projectFromWire,
  resolveProject,
  selectedId,
  UI_KEY,
  type ProjectInfo,
  type Resolution,
  type SaveStatus,
  type UiState,
} from "./model.js";

/** Cap on the text area so a tall note cannot push the sidebar list out of view. */
const MAX_VH = 0.45;

const CSS = `
[data-t3p-plugin="notes"] .nt { display: flex; flex-direction: column; gap: 4px; padding: 6px var(--sidebar-content-inset, 8px) 4px; border-top: 1px solid var(--border, currentColor); color: var(--foreground, inherit); font-size: 12px; }
[data-t3p-plugin="notes"] .nt-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
[data-t3p-plugin="notes"] .nt-head { all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; height: 22px; cursor: pointer; font-weight: 500; }
[data-t3p-plugin="notes"] .nt-head:focus-visible, [data-t3p-plugin="notes"] .nt-pick:focus-visible { outline: 2px solid var(--ring, currentColor); outline-offset: 1px; border-radius: var(--control-radius, .5rem); }
[data-t3p-plugin="notes"] .nt-chev { width: 12px; height: 12px; flex: none; color: var(--muted-foreground, inherit); transition: transform .12s; }
[data-t3p-plugin="notes"] .nt[data-collapsed="true"] .nt-head .nt-chev { transform: rotate(-90deg); }
[data-t3p-plugin="notes"] .nt-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--muted-foreground, currentColor); opacity: .55; transition: background .15s, opacity .15s; }
[data-t3p-plugin="notes"] .nt-dot[data-state="busy"] { background: var(--warning, currentColor); opacity: 1; }
[data-t3p-plugin="notes"] .nt-pick { all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 6px; width: 100%; height: 24px; padding: 0 8px; cursor: pointer; border: 1px solid var(--input, var(--border, currentColor)); border-radius: var(--control-radius, .5rem); background: transparent; min-width: 0; }
[data-t3p-plugin="notes"] .nt-pick:hover { background: var(--accent, transparent); }
[data-t3p-plugin="notes"] .nt-pick > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-t3p-plugin="notes"] .nt-grip { height: 8px; margin: 0 auto; width: 100%; cursor: ns-resize; display: flex; align-items: center; justify-content: center; touch-action: none; }
[data-t3p-plugin="notes"] .nt-grip::before { content: ""; width: 28px; height: 3px; border-radius: 2px; background: var(--border, currentColor); }
[data-t3p-plugin="notes"] .nt-grip:hover::before { background: var(--muted-foreground, currentColor); }
[data-t3p-plugin="notes"] .nt-text { box-sizing: border-box; width: 100%; resize: none; padding: 6px 8px; font: inherit; line-height: 1.4; color: inherit; background: transparent; border: 1px solid var(--input, var(--border, currentColor)); border-radius: var(--control-radius, .5rem); outline: none; overflow-y: auto; }
[data-t3p-plugin="notes"] .nt-text:focus-visible { border-color: var(--ring, currentColor); box-shadow: 0 0 0 1px var(--ring, currentColor); }
[data-t3p-plugin="notes"] .nt-text::placeholder { color: var(--muted-foreground, inherit); }
[data-t3p-plugin="notes"] .nt-foot { display: flex; align-items: center; gap: 6px; }
[data-t3p-plugin="notes"] .nt-foot .t3p-meta { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-t3p-plugin="notes"] .nt-body { display: flex; flex-direction: column; gap: 4px; }
[data-t3p-plugin="notes"] .nt[data-collapsed="true"] .nt-body { display: none; }
.t3p-nt-menu { padding: 4px; min-width: 180px; max-width: 280px; max-height: 260px; overflow-y: auto; display: flex; flex-direction: column; gap: 1px; font-size: 12px; }
.t3p-nt-menu .t3p-menu-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 4px 8px; text-align: left; border-radius: calc(var(--control-radius, .5rem) - 2px); }
.t3p-nt-menu .t3p-menu-item > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.t3p-nt-menu .t3p-menu-item[aria-checked="true"] { background: var(--accent, transparent); }
.t3p-nt-menu .nt-cur { width: 6px; height: 6px; border-radius: 50%; background: var(--success, currentColor); flex: none; }
.t3p-nt-menu .nt-tag { color: var(--muted-foreground, inherit); font-size: 11px; flex: none; }
`;

const CHEVRON = '<svg class="nt-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>';

interface ShellProject { id?: unknown; title?: unknown; workspaceRoot?: unknown; archivedAt?: unknown }
interface ShellThread { id?: unknown; projectId?: unknown }
interface ShellItem {
  kind?: string;
  snapshot?: { projects?: ShellProject[]; threads?: ShellThread[] };
  project?: ShellProject;
  projectId?: string;
  thread?: ShellThread;
  threadId?: string;
}

interface View {
  focus(): void;
  toggle(): void;
  showGeneral(): void;
}

const plugin: PluginModule = {
  start(t3: T3Api) {
    const disposers: Array<() => void> = [];
    const projects = new Map<string, ProjectInfo>();
    const threadProject = new Map<string, string | null>();
    const views = new Set<View>();
    const redraws = new Set<() => void>();
    let ui: UiState = { collapsed: false, height: 120 };
    let stopped = false;

    const redrawAll = (): void => {
      for (const fn of redraws) fn();
    };
    const saveUi = (): void => {
      void t3.storage.set(UI_KEY, ui as never).catch((error) => t3.log("warn", `ui state not saved: ${String(error)}`));
    };
    void t3.storage
      .get(UI_KEY)
      .then((value) => {
        ui = parseUi(value);
        redrawAll();
      })
      .catch(() => undefined);

    // Projects and thread -> project, from the shell stream (the shared socket; `rpc` permission).
    const onShell = (raw: unknown): void => {
      const item = raw as ShellItem | null;
      if (!item || typeof item.kind !== "string") return;
      switch (item.kind) {
        case "snapshot": {
          // Upsert only: the stream can repeat a snapshot with fewer rows, removals arrive as their own items.
          for (const p of item.snapshot?.projects ?? []) {
            const info = projectFromWire(p);
            if (info) projects.set(info.id, info);
          }
          for (const th of item.snapshot?.threads ?? []) {
            if (typeof th.id === "string") threadProject.set(th.id, typeof th.projectId === "string" ? th.projectId : null);
          }
          break;
        }
        case "project.updated": {
          const info = projectFromWire(item.project);
          if (info) projects.set(info.id, info);
          else if (item.project && typeof item.project.id === "string") projects.delete(item.project.id);
          break;
        }
        case "project.removed":
          if (typeof item.projectId === "string") projects.delete(item.projectId);
          break;
        case "thread.updated":
          if (item.thread && typeof item.thread.id === "string") threadProject.set(item.thread.id, typeof item.thread.projectId === "string" ? item.thread.projectId : null);
          break;
        case "thread.removed":
          if (typeof item.threadId === "string") threadProject.delete(item.threadId);
          break;
        default:
          return;
      }
      redrawAll();
    };
    const sub = t3.rpc.subscribe("orchestration.subscribeShell", {}, onShell as never, { onError: (error) => t3.log("warn", `shell stream ended: ${error.message}`) });
    disposers.push(() => sub.cancel());

    const listed = new Set<string>();
    // A thread the stream has not shown yet (just created): ask the thread list once.
    const lookup = (threadId: string): void => {
      if (listed.has(threadId)) return;
      listed.add(threadId);
      void t3.threads
        .list()
        .then((rows) => {
          for (const row of rows) if (!threadProject.has(row.threadId)) threadProject.set(row.threadId, row.projectId);
          redrawAll();
        })
        .catch(() => undefined);
    };
    const resolve = (threadId: string | null): Resolution => {
      if (threadId && !threadProject.has(threadId)) lookup(threadId);
      return resolveRaw(threadId);
    };
    const resolveRaw = (threadId: string | null): Resolution => resolveProject(threadId, threadId && threadProject.has(threadId) ? { projectId: threadProject.get(threadId) ?? null } : undefined, projects);

    const saver = new Autosaver({
      save: (key, text) => (text === "" ? t3.storage.delete(key) : t3.storage.set(key, text)),
      onStatus: (status, error) => {
        for (const fn of statusListeners) fn(status, error);
      },
    });
    const statusListeners = new Set<(status: SaveStatus, error?: string) => void>();
    const flush = (): void => void saver.flush();
    disposers.push(t3.events.on("app:unload", flush));
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    disposers.push(() => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      flush();
    });

    // A navigation unpins the picked note, so the panel follows the new thread's project.
    // `thread:focus` can lag behind the route, so draw() also compares the thread id itself.
    let pinned: string | null = null;
    disposers.push(
      t3.events.on("thread:focus", () => {
        pinned = null;
        redrawAll();
      }),
    );
    // The router state settles a moment after the hash changes: redraw again once it has.
    const onHash = (): void => {
      redrawAll();
      setTimeout(redrawAll, 150);
      setTimeout(redrawAll, 700);
    };
    window.addEventListener("hashchange", onHash);
    disposers.push(() => window.removeEventListener("hashchange", onHash));

    const reg = t3.ui.register({
      slot: "sidebarSection",
      id: "notes",
      title: "Notes",
      order: 1000,
      render(host) {
        const style = document.createElement("style");
        style.textContent = CSS;

        const wrap = document.createElement("div");
        wrap.className = "nt";

        // Header: collapse toggle, label, status dot.
        const row = document.createElement("div");
        row.className = "nt-row";
        const head = document.createElement("button");
        head.type = "button";
        head.className = "nt-head";
        head.innerHTML = `${CHEVRON}<span>Notes</span>`;
        const dot = document.createElement("span");
        dot.className = "nt-dot";
        dot.setAttribute("role", "status");
        head.append(dot);
        row.append(head);

        const body = document.createElement("div");
        body.className = "nt-body";
        const pick = document.createElement("button");
        pick.type = "button";
        pick.className = "nt-pick";
        pick.setAttribute("aria-haspopup", "menu");
        pick.setAttribute("aria-expanded", "false");
        const pickLabel = document.createElement("span");
        pick.append(pickLabel);
        pick.insertAdjacentHTML("beforeend", CHEVRON);
        const grip = document.createElement("div");
        grip.className = "nt-grip";
        grip.setAttribute("role", "separator");
        grip.setAttribute("aria-orientation", "horizontal");
        grip.title = "Drag to resize";
        const area = document.createElement("textarea");
        area.className = "nt-text";
        area.spellcheck = false;
        area.setAttribute("aria-label", "Note");
        const foot = document.createElement("div");
        foot.className = "nt-foot";
        const hint = document.createElement("span");
        hint.className = "t3p-meta";
        const copy = document.createElement("button");
        copy.type = "button";
        copy.className = "t3p-btn";
        copy.setAttribute("data-variant", "ghost");
        copy.style.cssText = "height:22px;padding:0 8px;font-size:11px";
        copy.textContent = "Copy";
        foot.append(hint, copy);
        body.append(pick, grip, area, foot);
        wrap.append(row, body);
        host.append(style, wrap);

        // Sit right above the sidebar footer, outside the scrolling list, so it stays in view.
        const container = host.parentElement;
        const footer = container?.closest('[data-slot="sidebar"]')?.querySelector('[data-slot="sidebar-footer"]') ?? null;
        if (container && footer?.parentElement) footer.before(container);

        let shown = GENERAL;
        let target: string | null = null;
        let loadToken = 0;
        let menu: HTMLElement | null = null;
        let closeMenu: (() => void) | null = null;

        const applyHeight = (): void => {
          const cap = Math.max(60, Math.floor(window.innerHeight * MAX_VH));
          area.style.height = `${Math.min(ui.height, cap)}px`;
        };
        const applyCollapsed = (): void => {
          wrap.dataset.collapsed = String(ui.collapsed);
          head.setAttribute("aria-expanded", String(!ui.collapsed));
        };
        const paintStatus = (status: SaveStatus, error?: string): void => {
          dot.dataset.state = status === "saved" ? "saved" : "busy";
          const label = status === "saved" ? "Saved" : status === "error" ? `Not saved: ${error ?? "error"}` : "Saving…";
          dot.title = label;
          dot.setAttribute("aria-label", label);
        };
        const paintCount = (): void => {
          const text = describeCount(area.value);
          hint.textContent = text;
          pick.title = `${text}. Click to switch note.`;
        };
        statusListeners.add(paintStatus);
        paintStatus(saver.status);

        const label = (id: string, r: Resolution): string => {
          if (id === GENERAL) return "General";
          const known = projects.get(id);
          if (known) return known.name;
          return r.kind === "unknown-project" && r.projectId === id ? "Unknown project" : "Project";
        };

        const load = async (id: string): Promise<void> => {
          const token = ++loadToken;
          await saver.flush();
          if (stopped || token !== loadToken) return;
          const key = noteKey(id);
          let text = saver.pendingText(key);
          if (text === undefined) {
            try {
              text = (await t3.storage.get<string>(key)) ?? "";
            } catch (error) {
              t3.log("warn", `load ${key} failed: ${String(error)}`);
              text = "";
            }
          }
          if (stopped || token !== loadToken) return;
          shown = id;
          if (area.value !== text) area.value = text;
          paintCount();
        };

        let lastThread: string | null | undefined;
        const draw = (): void => {
          if (t3.threads.current() !== lastThread) {
            if (lastThread !== undefined) pinned = null;
            lastThread = t3.threads.current();
          }
          const r = resolve(t3.threads.current());
          const id = selectedId(pinned, r);
          pickLabel.textContent = label(id, r);
          applyCollapsed();
          applyHeight();
          if (id !== target) {
            target = id;
            void load(id);
          }
        };

        const openMenu = (): void => {
          closeMenu?.();
          const r = resolve(t3.threads.current());
          const currentId = r.kind === "project" ? r.project.id : r.kind === "unknown-project" ? r.projectId : null;
          const pop = document.createElement("div");
          pop.className = "t3p-popover t3p-glass t3p-nt-menu";
          pop.setAttribute("role", "menu");
          pop.setAttribute("data-t3p-plugin", "notes");
          for (const entry of menuEntries(projects, currentId)) {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "t3p-menu-item";
            item.setAttribute("role", "menuitemradio");
            item.setAttribute("aria-checked", String(entry.id === shown));
            if (entry.current) {
              const d = document.createElement("i");
              d.className = "nt-cur";
              item.append(d);
            }
            const name = document.createElement("span");
            name.textContent = entry.label;
            item.append(name);
            if (entry.current) {
              const tag = document.createElement("em");
              tag.className = "nt-tag";
              tag.style.fontStyle = "normal";
              tag.textContent = "this thread";
              item.append(tag);
            }
            item.addEventListener("click", () => {
              pinned = entry.id;
              closeMenu?.();
              draw();
            });
            pop.append(item);
          }
          document.body.append(pop);
          const box = pick.getBoundingClientRect();
          pop.style.left = `${Math.max(4, Math.min(box.left, window.innerWidth - pop.offsetWidth - 4))}px`;
          pop.style.minWidth = `${box.width}px`;
          pop.style.bottom = `${window.innerHeight - box.top + 4}px`;
          pop.style.top = "auto";
          pick.setAttribute("aria-expanded", "true");
          menu = pop;
          const onDown = (e: Event): void => {
            if (!pop.contains(e.target as Node) && !pick.contains(e.target as Node)) closeMenu?.();
          };
          const onKey = (e: KeyboardEvent): void => {
            if (e.key === "Escape") {
              closeMenu?.();
              pick.focus();
            }
          };
          document.addEventListener("pointerdown", onDown, true);
          document.addEventListener("keydown", onKey, true);
          closeMenu = () => {
            document.removeEventListener("pointerdown", onDown, true);
            document.removeEventListener("keydown", onKey, true);
            pop.remove();
            menu = null;
            closeMenu = null;
            pick.setAttribute("aria-expanded", "false");
          };
          (pop.querySelector('[aria-checked="true"]') as HTMLElement | null)?.focus();
        };
        pick.addEventListener("click", () => (menu ? closeMenu?.() : openMenu()));

        head.addEventListener("click", () => {
          ui = { ...ui, collapsed: !ui.collapsed };
          saveUi();
          applyCollapsed();
        });

        area.addEventListener("input", () => {
          saver.edit(noteKey(shown), area.value);
          paintCount();
        });
        area.addEventListener("blur", () => void saver.flush());

        copy.addEventListener("click", () => {
          const text = area.value;
          void navigator.clipboard
            .writeText(text)
            .then(() => t3.ui.toast({ message: "Note copied", kind: "success", durationMs: 1500 }))
            .catch(() => t3.ui.toast({ message: "Could not copy the note", kind: "error" }));
        });

        // Resize by dragging the grip above the text area.
        grip.addEventListener("pointerdown", (event) => {
          event.preventDefault();
          const startY = event.clientY;
          const startH = area.getBoundingClientRect().height;
          grip.setPointerCapture(event.pointerId);
          const move = (e: PointerEvent): void => {
            // Dragging up grows the box: the section is anchored to the bottom of the sidebar.
            ui = { ...ui, height: clampHeight(startH + (startY - e.clientY)) };
            applyHeight();
          };
          const up = (): void => {
            grip.removeEventListener("pointermove", move);
            grip.removeEventListener("pointerup", up);
            grip.removeEventListener("pointercancel", up);
            saveUi();
          };
          grip.addEventListener("pointermove", move);
          grip.addEventListener("pointerup", up);
          grip.addEventListener("pointercancel", up);
        });

        const onResize = (): void => applyHeight();
        window.addEventListener("resize", onResize);
        redraws.add(draw);
        draw();

        const view: View = {
          focus() {
            if (ui.collapsed) {
              ui = { ...ui, collapsed: false };
              saveUi();
              applyCollapsed();
            }
            area.focus();
          },
          toggle() {
            head.click();
          },
          showGeneral() {
            pinned = GENERAL;
            draw();
            view.focus();
          },
        };
        views.add(view);

        return () => {
          views.delete(view);
          redraws.delete(draw);
          statusListeners.delete(paintStatus);
          window.removeEventListener("resize", onResize);
          closeMenu?.();
          loadToken += 1;
          void saver.flush();
          // The container was moved out of the slot anchor: take it with us.
          container?.remove();
        };
      },
    });
    disposers.push(() => reg.dispose());

    const onView = (fn: (v: View) => void) => (): void => {
      const v = [...views].pop();
      if (v) fn(v);
    };
    const commands = [
      t3.commands.register({ id: "focus", title: "Notes: focus", description: "Put the cursor in the notes text area", keywords: ["notes", "focus", "write"], run: onView((v) => v.focus()) }),
      t3.commands.register({ id: "toggle", title: "Notes: toggle section", description: "Collapse or expand the notes section", keywords: ["notes", "toggle", "collapse", "expand"], run: onView((v) => v.toggle()) }),
      t3.commands.register({ id: "general", title: "Notes: open General", description: "Show the General note", keywords: ["notes", "general"], run: onView((v) => v.showGeneral()) }),
    ];
    for (const c of commands) disposers.push(() => c.dispose());

    return () => {
      stopped = true;
      for (const d of disposers.reverse()) {
        try {
          d();
        } catch (error) {
          t3.log("warn", `cleanup failed: ${String(error)}`);
        }
      }
    };
  },
};

export default plugin;
