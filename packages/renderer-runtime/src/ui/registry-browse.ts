import { parsePermissions, permissionInfo, permissionNames, REGISTRY_ACTION_ATTR, REGISTRY_ID_ATTR, type RegistryAction, type RegistryEntry, registryInstallState, searchRegistry } from "@t3p/api";

import type { RegistryResultEvent, RegistryView } from "../manager.js";
import { clear, h } from "./dom.js";

/**
 * The Browse tab of Settings > Plugins (WP-14A): the plugin registry, master-detail like the
 * Installed tab. Read-only on the page side: Install, Update and Uninstall buttons only carry
 * `data-t3p-registry-action` / `data-t3p-registry-id`. The preload sends the request for real
 * (isTrusted) clicks, and the main process shows a native dialog. A page script calling `.click()`
 * on these buttons, or dispatching events, reaches nothing (docs/security.md section 4.7).
 */

export interface RegistryFacade {
  registry(refresh?: boolean): Promise<RegistryView>;
  onRegistryResult(callback: (result: RegistryResultEvent) => void): () => void;
}

export type BrowseState = "install" | "update" | "installed" | "dev";

export interface BrowseRow {
  entry: RegistryEntry;
  installed: string | null;
  state: BrowseState;
}

/** Same reset as the Grant buttons: an ignored click never gets an answer. */
export const BROWSE_WAITING_RESET_MS = 30_000;

/** Registry rows with install state, filtered by text and tags (all tags must match). */
export function browseRows(view: Pick<RegistryView, "plugins" | "installed">, query: string, tags: readonly string[]): BrowseRow[] {
  return searchRegistry(view.plugins, query, tags).map((entry) => {
    const inst = view.installed[entry.id];
    if (!inst) return { entry, installed: null, state: "install" as const };
    if (inst.devLink) return { entry, installed: inst.version, state: "dev" as const };
    return { entry, installed: inst.version, state: registryInstallState(entry, inst.version ?? "0.0.0-unknown") };
  });
}

/** Every tag in the index, most used first, then by name. */
export function registryTags(plugins: readonly RegistryEntry[]): string[] {
  const counts = new Map<string, number>();
  for (const p of plugins) for (const t of p.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([t]) => t);
}

/** Permission badge tone by risk: high = destructive, medium = warning, low = neutral. */
export function riskTone(name: string): "bad" | "warn" | "" {
  const risk = permissionInfo(name).risk;
  return risk === "high" ? "bad" : risk === "medium" ? "warn" : "";
}

const safeUrl = (url: string | undefined): string | null => {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || (u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost")) ? u.href : null;
  } catch {
    return null;
  }
};

function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export interface BrowseHandle {
  /** Loads the index on first show. */
  show(): void;
  dispose(): void;
}

/** Builds the Browse tab into `host`. `onReview` opens the Installed tab on the plugin's permissions. */
export function mountBrowse(host: HTMLElement, manager: RegistryFacade, opts: { onNotice(message: string): void; onReview(id: string): void }): BrowseHandle {
  const root = h("div", { class: "t3p-pg", "data-t3p-browse": "", "data-t3p-state": "idle" });
  host.appendChild(root);
  let view: RegistryView | null = null;
  let loading = false;
  let loaded = false;
  let query = "";
  const tags = new Set<string>();
  let selected: string | null = null;
  let waiting: { id: string; action: RegistryAction } | null = null;
  let disposed = false;

  const search = h("input", { class: "t3p-input t3p-pg-search", type: "search", placeholder: "Search the registry", "aria-label": "Search the plugin registry", "data-t3p-browse-search": "" }) as HTMLInputElement;
  const chips = h("div", { class: "t3p-rg-chips", role: "group", "aria-label": "Filter by tag", "data-t3p-tags": "" });
  const refresh = h("button", { class: "t3p-btn", type: "button", "data-variant": "ghost", "data-t3p-refresh": "", onClick: () => void load(true) }, "Refresh");
  const status = h("div", { class: "t3p-meta", "data-t3p-browse-status": "" });
  const list = h("div", { class: "t3p-pg-list", role: "listbox", "aria-label": "Registry plugins", "data-t3p-browse-list": "" });
  const side = h("nav", { class: "t3p-pg-side" }, h("div", { class: "t3p-rg-headrow" }, h("h1", null, "Browse"), refresh), search, chips, status, list);
  const back = h("button", { class: "t3p-btn t3p-pg-back", type: "button", "data-variant": "ghost", onClick: () => host.setAttribute("data-t3p-view", "list") }, "‹ Registry");
  const detail = h("div", { class: "t3p-pg-detail-body", "data-t3p-browse-detail": "" });
  root.append(side, h("section", { class: "t3p-pg-main", "aria-label": "Registry plugin details" }, back, detail));

  const rows = (): BrowseRow[] => (view ? browseRows(view, query, [...tags]) : []);
  const current = (): BrowseRow | null => {
    const shown = rows();
    return shown.find((r) => r.entry.id === selected) ?? shown[0] ?? null;
  };

  const icon = (entry: RegistryEntry, large: boolean): HTMLElement => {
    const letter = h("span", { class: "t3p-pg-ico", "aria-hidden": "true", ...(large ? { "data-large": "" } : {}) }, (entry.name.trim()[0] ?? "?").toUpperCase());
    const src = safeUrl(entry.icon);
    if (!src) return letter;
    const img = h("img", { class: "t3p-rg-icon", alt: "", loading: "lazy", referrerpolicy: "no-referrer", ...(large ? { "data-large": "" } : {}) }) as HTMLImageElement;
    img.addEventListener("error", () => img.replaceWith(letter), { once: true });
    img.src = src;
    return img;
  };

  const stateBadge = (row: BrowseRow): HTMLElement | null => {
    if (row.state === "installed") return h("span", { class: "t3p-badge", "data-tone": "ok", "data-t3p-badge": "installed" }, "Installed");
    if (row.state === "update") return h("span", { class: "t3p-badge", "data-tone": "warn", "data-t3p-badge": "update" }, "Update available");
    if (row.state === "dev") return h("span", { class: "t3p-badge", "data-t3p-badge": "dev" }, "Dev link");
    return null;
  };

  const card = (row: BrowseRow, active: boolean): HTMLElement =>
    h(
      "button",
      {
        class: "t3p-pg-item",
        type: "button",
        role: "option",
        "data-t3p-card": row.entry.id,
        "aria-selected": String(active),
        tabindex: active ? "0" : "-1",
        ...(active ? { "data-active": "" } : {}),
        onClick: () => {
          selected = row.entry.id;
          host.setAttribute("data-t3p-view", "detail");
          render();
        },
      },
      icon(row.entry, false),
      h(
        "span",
        { class: "t3p-rg-lines" },
        h("span", { class: "t3p-rg-title" }, h("span", { class: "t3p-pg-name" }, row.entry.name), h("span", { class: "t3p-meta" }, row.entry.version)),
        h("span", { class: "t3p-rg-desc" }, `${row.entry.author} · ${row.entry.description}`),
      ),
      stateBadge(row),
    );

  const actionButton = (row: BrowseRow, action: RegistryAction, label: string, primary: boolean): HTMLButtonElement => {
    const isWaiting = waiting?.id === row.entry.id && waiting.action === action;
    return h(
      "button",
      {
        class: "t3p-btn",
        type: "button",
        title: "Opens a T3 Patcher confirmation dialog",
        [REGISTRY_ACTION_ATTR]: action,
        [REGISTRY_ID_ATTR]: row.entry.id,
        ...(primary ? { "data-primary": "" } : {}),
        ...(action === "uninstall" ? { "data-variant": "ghost" } : {}),
        ...(isWaiting ? { "data-t3p-waiting": "" } : {}),
        onClick: (e: Event) => {
          // UI state only; the preload sends the request for trusted clicks. A scripted click
          // opens no dialog, so it must not show "Confirm in dialog" either.
          if (!e.isTrusted) return;
          const mine = { id: row.entry.id, action };
          waiting = mine;
          const el = e.currentTarget as HTMLElement;
          el.setAttribute("data-t3p-waiting", "");
          el.textContent = "Confirm in dialog…";
          setTimeout(() => {
            if (waiting !== mine || disposed) return;
            waiting = null;
            renderDetail();
          }, BROWSE_WAITING_RESET_MS);
        },
      },
      isWaiting ? "Confirm in dialog…" : label,
    ) as HTMLButtonElement;
  };

  const renderTags = (): void => {
    clear(chips);
    for (const tag of view ? registryTags(view.plugins) : []) {
      const on = tags.has(tag);
      chips.appendChild(
        h(
          "button",
          {
            class: "t3p-chip",
            type: "button",
            "data-compact": "",
            "data-t3p-tag": tag,
            "aria-pressed": String(on),
            onClick: () => {
              if (tags.has(tag)) tags.delete(tag);
              else tags.add(tag);
              render();
            },
          },
          tag,
        ),
      );
    }
  };

  const renderList = (): void => {
    clear(list);
    if (!view) return;
    const shown = rows();
    const active = current();
    status.textContent = "";
    const parts: string[] = [];
    parts.push(query.trim() || tags.size ? `${shown.length} of ${view.plugins.length} match` : `${view.plugins.length} in the registry`);
    if (view.fetchedAt && view.source !== "network") parts.push(`checked ${when(view.fetchedAt)}`);
    status.textContent = parts.join(" · ");
    if (view.plugins.length === 0 && !view.error) list.appendChild(h("div", { class: "t3p-meta", "data-t3p-empty": "" }, "The registry is empty."));
    else if (shown.length === 0 && view.plugins.length > 0) list.appendChild(h("div", { class: "t3p-meta", "data-t3p-empty": "" }, "Nothing matches."));
    for (const row of shown) list.appendChild(card(row, row === active));
  };

  const problem = (): HTMLElement | null => {
    if (!view?.error) return null;
    const stale = view.plugins.length > 0;
    return h(
      "div",
      { class: "t3p-card", "data-t3p-problem": view.offline ? "offline" : "error" },
      h("div", { class: "t3p-card-head" }, h("span", { class: "t3p-badge", "data-tone": stale ? "warn" : "bad" }, view.offline ? "Offline" : "Registry error"), h("span", { class: "t3p-card-title" }, stale ? "Showing the last copy" : "Cannot load the registry")),
      h("div", { class: "t3p-meta" }, stale ? `The registry could not be reached; this list is from ${when(view.fetchedAt)}.` : view.offline ? "You may be offline. Check the connection and press Refresh." : "The registry answered with something T3 Patcher cannot use."),
      h("div", { class: "t3p-error" }, view.error),
    );
  };

  const renderDetail = (): void => {
    clear(detail);
    const p = problem();
    if (p) detail.appendChild(p);
    const row = current();
    if (!row) {
      if (!p && view) detail.appendChild(h("div", { class: "t3p-meta" }, "Select a plugin."));
      return;
    }
    const { entry } = row;
    const set = parsePermissions(entry.permissions).set;
    const names = permissionNames(set);
    const homepage = safeUrl(entry.homepage);
    const actions: Array<HTMLElement | null> = [];
    if (row.state === "install") actions.push(actionButton(row, "install", "Install", true));
    if (row.state === "update") actions.push(actionButton(row, "update", `Update to ${entry.version}`, true));
    if (row.state === "installed") actions.push(h("button", { class: "t3p-btn", type: "button", disabled: true, "data-t3p-is-installed": "" }, "Installed"));
    if (row.state === "update" || row.state === "installed") actions.push(actionButton(row, "uninstall", "Uninstall", false));
    if (homepage) actions.push(h("a", { class: "t3p-btn", "data-variant": "ghost", href: homepage, target: "_blank", rel: "noopener noreferrer", "data-t3p-homepage": "" }, "Open homepage"));
    const shots = (entry.screenshots ?? []).map(safeUrl).filter((u): u is string => u !== null).slice(0, 4);
    detail.appendChild(
      h(
        "div",
        { class: "t3p-pg-head", "data-t3p-entry": entry.id },
        h("div", { class: "t3p-card-head" }, icon(entry, true), h("span", { class: "t3p-card-title" }, entry.name), h("span", { class: "t3p-meta" }, `${entry.id} · v${entry.version}`), stateBadge(row)),
        h("div", { class: "t3p-meta" }, `by ${entry.author}${row.installed ? ` · installed v${row.installed}` : ""}${entry.license ? ` · ${entry.license}` : ""}`),
        h("div", null, entry.description),
        h(
          "div",
          { class: "t3p-pg-perms", "data-t3p-perms": "" },
          ...(names.length === 0
            ? [h("span", { class: "t3p-badge", "data-tone": "ok" }, "No permissions")]
            : names.map((n) => h("span", { class: "t3p-badge", "data-tone": riskTone(n) || undefined, "data-t3p-perm": n, title: `${permissionInfo(n).title}: ${permissionInfo(n).meaning}` }, n))),
        ),
        entry.tags.length ? h("div", { class: "t3p-pg-perms" }, ...entry.tags.map((t) => h("span", { class: "t3p-pill" }, t))) : null,
        h("div", { class: "t3p-pg-actions" }, ...actions),
        row.state === "dev" ? h("div", { class: "t3p-meta" }, "This plugin is a t3p dev link; the registry does not touch it.") : null,
        row.state === "install" ? h("div", { class: "t3p-meta" }, "Installs disabled with no permissions granted. You enable it and grant permissions on the Installed tab.") : null,
      ),
    );
    if (names.length > 0) {
      detail.appendChild(
        h(
          "div",
          { class: "t3p-pg-sec" },
          h("div", { class: "t3p-pg-sec-head", role: "heading", "aria-level": "2" }, "Permissions it asks for"),
          h(
            "div",
            { class: "t3p-perm-body" },
            ...names.map((n) => {
              const info = permissionInfo(n);
              return h(
                "div",
                { class: "t3p-perm-row" },
                h("div", { class: "t3p-perm-title" }, h("span", null, info.title), h("code", null, n), h("span", { class: "t3p-badge", "data-tone": riskTone(n) || undefined }, `${info.risk} risk`)),
                h("small", null, info.meaning),
              );
            }),
          ),
        ),
      );
    }
    if (shots.length) {
      detail.appendChild(
        h(
          "div",
          { class: "t3p-rg-shots", "data-t3p-shots": "" },
          ...shots.map((src) => {
            const img = h("img", { alt: `${entry.name} screenshot`, loading: "lazy", referrerpolicy: "no-referrer" }) as HTMLImageElement;
            img.addEventListener("error", () => img.remove(), { once: true });
            img.src = src;
            return img;
          }),
        ),
      );
    }
    detail.appendChild(h("div", { class: "t3p-meta" }, `Download: ${entry.download.url} (${Math.ceil(entry.download.size / 1024)} KB, SHA-256 checked before unpacking)`));
  };

  const render = (): void => {
    root.setAttribute("data-t3p-state", loading && !view ? "loading" : !view ? "idle" : view.error ? (view.plugins.length ? "stale" : view.offline ? "offline" : "error") : view.plugins.length ? "ready" : "empty");
    refresh.toggleAttribute("disabled", loading);
    refresh.textContent = loading ? "Loading…" : "Refresh";
    if (loading && !view) {
      clear(list);
      clear(detail);
      status.textContent = "Loading the registry…";
      return;
    }
    renderTags();
    renderList();
    renderDetail();
  };

  const load = async (force: boolean): Promise<void> => {
    if (loading) return;
    loading = true;
    render();
    try {
      view = await manager.registry(force);
    } catch (error) {
      view = { url: null, source: null, fetchedAt: null, error: error instanceof Error ? error.message : String(error), offline: false, plugins: [], installed: {} };
    } finally {
      loading = false;
      loaded = true;
      if (!disposed) render();
    }
  };

  search.addEventListener("input", () => {
    query = search.value;
    render();
  });

  const offResult = manager.onRegistryResult((r) => {
    waiting = null;
    if (r.status === "busy") opts.onNotice("Another T3 Patcher dialog is open. Finish it first.");
    if ((r.status === "installed" || r.status === "updated") && r.review) opts.onReview(r.plugin);
    if (loaded) void load(false);
  });

  return {
    show: () => {
      if (!loaded && !loading) void load(false);
    },
    dispose: () => {
      disposed = true;
      offResult();
      root.remove();
    },
  };
}
