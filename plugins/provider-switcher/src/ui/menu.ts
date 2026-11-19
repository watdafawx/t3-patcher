import type { ModelGroup, ModelOption } from "../logic/grouping.js";

/** A picked menu row. */
export interface MenuPick {
  providerInstanceId: string;
  model: string;
  modelLabel: string;
  providerLabel: string;
}

export interface ModelMenuOptions {
  title: string;
  groups: ModelGroup[];
  /** Anchor below which the menu opens; `null` centres it (command palette). */
  anchor: HTMLElement | null;
  onPick(pick: MenuPick): void;
}

export interface OpenMenu {
  close(): void;
}

const WIDTH = 360;

/**
 * The model menu: one panel per provider instance with every usable model. Unusable providers and
 * their models stay visible but disabled, with the reason in their title. Rendered by the plugin
 * itself (the API has no menu primitive), positioned under its anchor or centred for the palette,
 * closed by Escape, an outside click, a pick, or the plugin's own cleanup.
 */
export function openModelMenu(options: ModelMenuOptions): OpenMenu {
  const panel = document.createElement("div");
  panel.setAttribute("data-t3p-root", "");
  panel.setAttribute("data-t3p-plugin", "provider-switcher");
  panel.setAttribute("data-t3p-id", "model-menu");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", options.title);
  panel.className = "t3p-popover t3p-glass";
  panel.style.cssText = `width:min(${WIDTH}px,calc(100vw - 16px));max-height:min(70vh,520px);display:flex;flex-direction:column;padding:0;overflow:hidden;z-index:2147483000`;

  const head = document.createElement("div");
  head.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--border,currentColor)";
  const heading = document.createElement("div");
  heading.style.cssText = "flex:1 1 auto;font-weight:500;font-size:12px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
  heading.textContent = options.title;
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", "Close");
  closeButton.textContent = "✕";
  closeButton.className = "t3p-chip";
  closeButton.setAttribute("data-compact", "");
  closeButton.addEventListener("click", () => close());
  head.append(heading, closeButton);

  const list = document.createElement("div");
  list.style.cssText = "overflow:auto;padding:4px";
  list.setAttribute("role", "menu");

  const focusable: HTMLButtonElement[] = [];

  for (const group of options.groups) {
    const groupHead = document.createElement("div");
    groupHead.className = "t3p-meta";
    groupHead.style.cssText = `display:flex;align-items:baseline;gap:6px;padding:8px 8px 4px;font-weight:500;opacity:${group.usable ? "1" : "0.7"}`;
    const groupLabel = document.createElement("span");
    groupLabel.textContent = group.label;
    groupHead.appendChild(groupLabel);
    if (!group.usable && group.reason) {
      const reason = document.createElement("span");
      reason.textContent = `— ${group.reason}`;
      reason.style.cssText = "font-weight:400;font-style:italic";
      groupHead.appendChild(reason);
    }
    list.appendChild(groupHead);

    if (group.models.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "no text models reported";
      empty.className = "t3p-meta";
      empty.style.cssText = "padding:2px 8px 8px;font-style:italic";
      list.appendChild(empty);
      continue;
    }

    for (const option of group.models) list.appendChild(buildItem(option, focusable, () => pick(option)));
  }

  panel.append(head, list);
  document.body.appendChild(panel);
  position(panel, options.anchor, list);

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    if (focusable.length === 0) return;
    event.preventDefault();
    const current = document.activeElement instanceof HTMLButtonElement ? focusable.indexOf(document.activeElement) : -1;
    let next: number;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = focusable.length - 1;
    else if (event.key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % focusable.length;
    else next = current <= 0 ? focusable.length - 1 : current - 1;
    focusable[next]?.focus();
  };
  const onPointerDown = (event: MouseEvent): void => {
    if (event.target instanceof Node && !panel.contains(event.target)) close();
  };
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("mousedown", onPointerDown, true);
  const initial = focusable.find((item) => item.getAttribute("aria-current") === "true") ?? focusable[0];
  initial?.focus();

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("mousedown", onPointerDown, true);
    const anchor = options.anchor;
    panel.remove();
    if (anchor?.isConnected) {
      try {
        anchor.focus();
      } catch {
        // focus is best effort
      }
    }
  }

  function pick(option: ModelOption): void {
    if (!option.usable) return;
    close();
    options.onPick({
      providerInstanceId: option.providerInstanceId,
      model: option.model,
      modelLabel: option.label,
      providerLabel: option.providerLabel,
    });
  }

  return { close };
}

function buildItem(option: ModelOption, focusable: HTMLButtonElement[], onPick: () => void): HTMLButtonElement {
  const item = document.createElement("button");
  item.type = "button";
  item.setAttribute("role", "menuitem");
  if (option.current) item.setAttribute("aria-current", "true");
  if (!option.usable) {
    item.disabled = true;
    item.setAttribute("aria-disabled", "true");
    item.title = option.reason ?? "unavailable";
  }
  item.className = "t3p-menu-item";
  item.style.cssText = `font-size:12px;${option.usable ? "" : "opacity:.45;cursor:not-allowed"}`;
  if (option.current) item.style.background = "var(--accent,color-mix(in srgb,currentColor 8%,transparent))";
  if (option.usable) {
    item.addEventListener("click", onPick);
    focusable.push(item);
  }

  const mark = document.createElement("span");
  mark.textContent = option.current ? "✓" : "";
  mark.style.cssText = "width:12px;flex:0 0 12px;color:var(--primary,currentColor);font-weight:600";
  const label = document.createElement("span");
  label.textContent = option.label;
  label.style.cssText = "flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
  item.append(mark, label);
  if (option.label !== option.model) {
    const id = document.createElement("span");
    id.textContent = option.model;
    id.className = "t3p-meta";
    id.style.cssText = "flex:0 0 auto;font-family:var(--font-mono,ui-monospace,monospace)";
    item.appendChild(id);
  }
  return item;
}

/** Places the panel under its anchor (flipping above when there is no room), or centres it. */
function position(panel: HTMLElement, anchor: HTMLElement | null, list: HTMLElement): void {
  const margin = 8;
  const box = panel.getBoundingClientRect();
  const width = box.width || WIDTH;
  const height = box.height || 320;
  let left: number;
  let top: number;
  if (anchor?.isConnected) {
    const rect = anchor.getBoundingClientRect();
    left = Math.min(Math.max(margin, rect.left), Math.max(margin, window.innerWidth - width - margin));
    top = rect.bottom + 6;
    if (top + height > window.innerHeight - margin) {
      const above = rect.top - height - 6;
      top = above >= margin ? above : Math.max(margin, window.innerHeight - height - margin);
    }
  } else {
    left = Math.max(margin, (window.innerWidth - width) / 2);
    top = Math.max(margin, Math.min(window.innerHeight * 0.15, window.innerHeight - height - margin));
  }
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
  const available = Math.max(200, Math.min(window.innerHeight - top - margin, 520));
  panel.style.maxHeight = `${available}px`;
  list.style.maxHeight = `${available - 40}px`;
}
