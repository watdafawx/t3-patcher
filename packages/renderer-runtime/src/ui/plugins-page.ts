import { GRANT_ATTR, GRANT_PERMS_ATTR, isHighRisk, parsePermissions, permissionInfo, permissionScope, type SettingSchema, type SettingValue } from "@t3p/api";

import type { ManagedPlugin } from "../manager.js";
import { clear, ensureStyles, h } from "./dom.js";
import { createControl } from "./setting-controls.js";

/** The slice of `window.__t3p.manager` the page uses. */
export interface ManagerFacade {
  list(): ManagedPlugin[];
  enable(id: string): Promise<ManagedPlugin | null>;
  disable(id: string): Promise<{ restartRequired: boolean }>;
  /** Optional so older facades still mount the page; without it Revoke buttons are hidden. */
  revoke?(id: string, permissions: string[]): Promise<{ restartRequired: boolean }>;
  schemas(id: string): SettingSchema[];
  getSetting(id: string, key: string): SettingValue;
  setSetting(id: string, key: string, value: SettingValue): Promise<void>;
  resetSetting(id: string, key: string): Promise<void>;
  onChange(callback: () => void): () => void;
}

/** localStorage keys (all reads and writes are in try/catch). */
export const SELECTED_KEY = "t3p.plugins.selected";
export const COLLAPSED_KEY = "t3p.plugins.collapsed";

/** True when the plugin has main code, patches or spawn: only `t3p enable/disable` (CLI) may toggle those (WP-3A). */
export function isTrusted(plugin: Pick<ManagedPlugin, "declared">): boolean {
  return plugin.declared.some((entry) => {
    const name = typeof entry === "string" ? entry : Object.keys(entry as object)[0];
    return name === "main" || name === "patches" || name === "spawn";
  });
}

function tone(status: string): "ok" | "bad" | "warn" | "" {
  if (status === "started" || status === "active") return "ok";
  if (status === "failed" || status === "invalid" || status === "incompatible") return "bad";
  if (status === "pending") return "warn";
  return "";
}

function declaredNames(plugin: Pick<ManagedPlugin, "declared">): string[] {
  return plugin.declared.map((entry) => (typeof entry === "string" ? entry : (Object.keys(entry as object)[0] ?? ""))).filter(Boolean);
}

/** Declared permissions the user has not granted yet. */
export function missingPermissions(plugin: Pick<ManagedPlugin, "declared" | "effective">): string[] {
  const granted = plugin.effective as Record<string, unknown>;
  return declaredNames(plugin).filter((name) => !granted[name]);
}

// ---- storage ---------------------------------------------------------------------------------------

function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStore(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable: the page works, it just forgets
  }
}
function readCollapsed(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(readStore(COLLAPSED_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

// ---- deep link -------------------------------------------------------------------------------------

let pending: string | null = null;
let pendingFocus: "permissions" | null = null;
const selectors = new Set<(id: string, focus: "permissions" | null) => void>();

/**
 * Selects a plugin on the Plugins page. A page that is open switches at once; otherwise the next page
 * opens on it. Use before navigating to the page (`Shell.openPluginsPage(id)` does both).
 * `focus: "permissions"` scrolls to and focuses the permissions section.
 */
export function selectPlugin(id: string, focus: "permissions" | null = null): void {
  pending = id;
  pendingFocus = focus;
  writeStore(SELECTED_KEY, id);
  for (const fn of [...selectors]) fn(id, focus);
}

// ---- search and grouping ---------------------------------------------------------------------------

/** Settings of a plugin whose key, label or description contains `query` (case-insensitive). */
export function matchingSchemas(schemas: SettingSchema[], query: string): SettingSchema[] {
  const q = query.trim().toLowerCase();
  if (!q) return schemas;
  return schemas.filter((s) => `${s.key}\n${s.label}\n${s.description ?? ""}`.toLowerCase().includes(q));
}

/** True when the plugin's own name or id contains `query`. */
export function pluginNameMatches(plugin: Pick<ManagedPlugin, "id" | "name">, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || plugin.name.toLowerCase().includes(q) || plugin.id.toLowerCase().includes(q);
}

/** Plugins visible for `query`: name, id, or any setting name or description matches. */
export function filterPlugins(plugins: ManagedPlugin[], query: string, schemasOf: (id: string) => SettingSchema[]): ManagedPlugin[] {
  if (!query.trim()) return plugins;
  return plugins.filter((p) => pluginNameMatches(p, query) || matchingSchemas(schemasOf(p.id), query).length > 0);
}

export interface SettingGroup {
  title: string;
  schemas: SettingSchema[];
}

const GENERAL = "General";
/** How long a Grant button says "Confirm in dialog…" without an answer from the main process. */
export const WAITING_RESET_MS = 30_000;

/**
 * Groups a plugin's settings for collapsible sections: keys that share a first camelCase word
 * (`oceanOn`, `oceanSpeed` share "ocean") form a group when at least two do; the rest go to "General".
 */
export function groupSchemas(schemas: SettingSchema[]): SettingGroup[] {
  const word = (key: string): string => (/^[a-z0-9]+/.exec(key)?.[0] ?? key).toLowerCase();
  const counts = new Map<string, number>();
  for (const s of schemas) counts.set(word(s.key), (counts.get(word(s.key)) ?? 0) + 1);
  const general: SettingSchema[] = [];
  const groups = new Map<string, SettingSchema[]>();
  for (const s of schemas) {
    const w = word(s.key);
    if ((counts.get(w) ?? 0) >= 2) groups.set(w, [...(groups.get(w) ?? []), s]);
    else general.push(s);
  }
  const out: SettingGroup[] = [];
  if (general.length > 0) out.push({ title: GENERAL, schemas: general });
  for (const [w, list] of groups) out.push({ title: w.charAt(0).toUpperCase() + w.slice(1), schemas: list });
  return out;
}

/** `text` with every case-insensitive match of `query` wrapped in `<mark class="t3p-hl">`. */
export function highlight(text: string, query: string): Array<Node | string> {
  const q = query.trim();
  if (!q) return [text];
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const out: Array<Node | string> = [];
  let at = 0;
  for (;;) {
    const hit = lower.indexOf(needle, at);
    if (hit < 0) break;
    if (hit > at) out.push(text.slice(at, hit));
    out.push(h("mark", { class: "t3p-hl" }, text.slice(hit, hit + needle.length)));
    at = hit + needle.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

function safeSchemas(manager: ManagerFacade, id: string): SettingSchema[] {
  try {
    return manager.schemas(id);
  } catch {
    return [];
  }
}

const isEditable = (el: Element | null): boolean => !!el && (el.matches("input,textarea,select,[contenteditable='true']") || (el as HTMLElement).isContentEditable === true);

/**
 * Builds the Plugins settings page into `host`: master-detail. Left: search and the plugin list.
 * Right: the selected plugin (enable switch, version, permissions, settings in collapsible sections,
 * "Reset plugin settings", and the `settingsPage` slot of that plugin). Under 640px wide the two
 * panes show one at a time (`data-t3p-view` on the root, CSS container query). Returns a cleanup. The
 * page re-renders when the plugin manager changes.
 */
export function mountPluginsPage(host: HTMLElement, manager: ManagerFacade, onNotice: (message: string) => void): () => void {
  ensureStyles();
  const root = h("div", { class: "t3p-pgw", "data-t3p-root": "", "data-t3p-page": "plugins", "data-t3p-view": "list" });
  host.appendChild(root);
  const collapsed = readCollapsed();
  let query = "";
  let selected: string | null = pending ?? readStore(SELECTED_KEY);
  let busy = false;
  let resetArmed: string | null = null;
  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  /** A Grant button was pressed and its native dialog has not answered yet (cleared on the next manager change). */
  let waiting: { id: string; perms: string } | null = null;
  let focusPerms = pendingFocus === "permissions";
  if (pending) root.setAttribute("data-t3p-view", "detail");
  pending = null;
  pendingFocus = null;

  // ---- fixed skeleton (search keeps focus while the panes redraw) -----------------------------------
  const search = h("input", { class: "t3p-input t3p-pg-search", type: "search", placeholder: "Search plugins and settings (/)", "aria-label": "Search plugins and settings", "data-t3p-search": "" }) as HTMLInputElement;
  const count = h("div", { class: "t3p-meta", "data-t3p-count": "" });
  const list = h("div", { class: "t3p-pg-list", role: "listbox", "aria-label": "Plugins", "data-t3p-list": "" });
  const side = h("nav", { class: "t3p-pg-side" }, h("h1", null, "Plugins"), search, count, list);
  const back = h("button", { class: "t3p-btn t3p-pg-back", type: "button", "data-variant": "ghost", "data-t3p-back": "", onClick: () => root.setAttribute("data-t3p-view", "list") }, "‹ Plugins");
  const detail = h("div", { class: "t3p-pg-detail-body", "data-t3p-detail": "" });
  // One anchor for the `settingsPage` slot. It is moved, never recreated, so mounted plugin UI survives redraws.
  const extra = h("div", { class: "t3p-pg-extra", "data-t3p-slot-anchor": "settingsPage" });
  const main = h("section", { class: "t3p-pg-main", "aria-label": "Plugin details" }, back, detail);
  root.appendChild(h("div", { class: "t3p-pg" }, side, main));

  /** Shows only the selected plugin's `settingsPage` roots in the shared anchor. */
  const filterExtras = (): void => {
    for (const el of Array.from(extra.querySelectorAll("[data-t3p-plugin]"))) el.toggleAttribute("data-t3p-hidden", el.getAttribute("data-t3p-plugin") !== effective());
  };
  const extraObserver = typeof MutationObserver === "undefined" ? null : new MutationObserver(filterExtras);
  extraObserver?.observe(extra, { childList: true, subtree: true });

  const plugins = (): ManagedPlugin[] => manager.list();
  const visible = (): ManagedPlugin[] => filterPlugins(plugins(), query, (id) => safeSchemas(manager, id));
  /** The shown plugin: the selected one when it passes the filter, else the first that does. */
  const effective = (): string | null => {
    const shown = visible();
    return shown.find((p) => p.id === selected)?.id ?? shown[0]?.id ?? null;
  };

  const choose = (id: string, opts: { focus?: boolean; keepView?: boolean } = {}): void => {
    selected = id;
    writeStore(SELECTED_KEY, id);
    if (!opts.keepView) root.setAttribute("data-t3p-view", "detail");
    resetArmed = null;
    renderList();
    renderDetail();
    if (opts.focus) Array.from(list.querySelectorAll<HTMLElement>("[data-t3p-item]")).find((el) => el.getAttribute("data-t3p-item") === id)?.focus();
  };

  // ---- list ------------------------------------------------------------------------------------------
  const item = (plugin: ManagedPlugin, active: boolean): HTMLElement => {
    const schemas = safeSchemas(manager, plugin.id);
    const missing = missingPermissions(plugin);
    const on = plugin.status === "started" || plugin.status === "pending";
    const matched = query.trim() ? matchingSchemas(schemas, query).length : 0;
    return h(
      "button",
      {
        class: "t3p-pg-item",
        type: "button",
        role: "option",
        "aria-selected": String(active),
        tabindex: active ? "0" : "-1",
        "data-t3p-item": plugin.id,
        ...(active ? { "data-active": "" } : {}),
        title: plugin.id,
        onClick: () => choose(plugin.id),
      },
      h("span", { class: "t3p-pg-ico", "aria-hidden": "true" }, (plugin.name.trim()[0] ?? "?").toUpperCase()),
      h("span", { class: "t3p-pg-name" }, ...highlight(plugin.name, query)),
      matched > 0 && !pluginNameMatches(plugin, query) ? h("span", { class: "t3p-badge", "data-t3p-badge": "match", title: "Matching settings" }, String(matched)) : null,
      missing.length > 0 ? h("span", { class: "t3p-badge", "data-tone": "warn", "data-t3p-badge": "perm", title: `Needs permission: ${missing.join(", ")}` }, `needs ${missing.length}`) : null,
      schemas.length > 0 ? h("span", { class: "t3p-badge", "data-t3p-badge": "settings", title: `${schemas.length} settings` }, String(schemas.length)) : null,
      h("span", { class: "t3p-pg-dot", "data-tone": on ? "ok" : tone(plugin.status), "data-t3p-dot": "", title: plugin.status }),
    );
  };

  const renderList = (): void => {
    const all = plugins();
    const shown = visible();
    const current = effective();
    clear(list);
    count.textContent = query.trim() ? `${shown.length} of ${all.length} match` : `${all.length} installed`;
    if (all.length === 0) list.appendChild(h("div", { class: "t3p-meta", "data-t3p-empty": "" }, "No plugins installed."));
    else if (shown.length === 0) list.appendChild(h("div", { class: "t3p-meta", "data-t3p-empty": "" }, `Nothing matches "${query.trim()}".`));
    for (const plugin of shown) list.appendChild(item(plugin, plugin.id === current));
  };

  // ---- detail ----------------------------------------------------------------------------------------
  const toggleFor = (plugin: ManagedPlugin): HTMLInputElement => {
    const trusted = isTrusted(plugin);
    const on = plugin.status === "started" || plugin.status === "pending";
    return h("input", {
      class: "t3p-switch",
      type: "checkbox",
      checked: on,
      disabled: trusted || busy,
      title: trusted ? "Has main code, patches or spawn: use `t3p enable` / `t3p disable`." : on ? "Disable" : "Enable",
      "aria-label": `${on ? "Disable" : "Enable"} ${plugin.name}`,
      "data-t3p-toggle": plugin.id,
      onChange: (e: Event) => {
        const want = (e.target as HTMLInputElement).checked;
        busy = true;
        const op = want ? manager.enable(plugin.id).then(() => undefined) : manager.disable(plugin.id).then(() => undefined);
        op.catch((error: unknown) => onNotice(`${plugin.id}: ${String(error instanceof Error ? error.message : error)}`)).finally(() => {
          busy = false;
          renderList();
          renderDetail();
        });
      },
    }) as HTMLInputElement;
  };

  const settingRow = (plugin: ManagedPlugin, schema: SettingSchema): HTMLElement => {
    let value: SettingValue;
    try {
      value = manager.getSetting(plugin.id, schema.key);
    } catch {
      value = schema.default;
    }
    const ref: { reset?: HTMLButtonElement } = {};
    const handle = createControl(schema, value, {
      onCommit: (next) => {
        if (ref.reset) ref.reset.hidden = next === schema.default;
        manager.setSetting(plugin.id, schema.key, next).catch((error: unknown) => onNotice(`${plugin.id}: ${String(error instanceof Error ? error.message : error)}`));
      },
    });
    const reset = h("button", {
      class: "t3p-btn",
      type: "button",
      "data-variant": "ghost",
      "data-compact": "",
      title: "Reset to default",
      "aria-label": `Reset ${schema.label}`,
      "data-t3p-reset": schema.key,
      hidden: value === schema.default,
      onClick: () => {
        manager.resetSetting(plugin.id, schema.key).then(
          () => {
            handle.set(schema.default);
            reset.hidden = true;
          },
          (e: unknown) => onNotice(String(e)),
        );
      },
    }, "↺");
    ref.reset = reset;
    return h(
      "div",
      { class: "t3p-setting", "data-t3p-setting-row": schema.key },
      h("label", null, ...highlight(schema.label, query)),
      h("div", { class: "t3p-pg-ctl" }, handle.el, reset),
      schema.description ? h("small", null, ...highlight(schema.description, query)) : null,
    );
  };

  const settingsSection = (plugin: ManagedPlugin, group: SettingGroup, forceOpen: boolean): HTMLElement => {
    const id = `${plugin.id}/${group.title}`;
    const closed = !forceOpen && collapsed.has(id);
    const body = h("div", { class: "t3p-pg-sec-body", hidden: closed }, ...group.schemas.map((s) => settingRow(plugin, s)));
    const head = h(
      "button",
      {
        class: "t3p-pg-sec-head",
        type: "button",
        "aria-expanded": String(!closed),
        "data-t3p-section": id,
        onClick: () => {
          const open = body.hidden;
          body.hidden = !open;
          head.setAttribute("aria-expanded", String(open));
          if (open) collapsed.delete(id);
          else collapsed.add(id);
          writeStore(COLLAPSED_KEY, JSON.stringify([...collapsed]));
        },
      },
      h("span", { class: "t3p-pg-chev", "aria-hidden": "true" }, "▾"),
      h("span", null, group.title),
      h("span", { class: "t3p-meta" }, String(group.schemas.length)),
    );
    return h("section", { class: "t3p-pg-sec", "data-t3p-group": group.title }, head, body);
  };

  /**
   * Permissions section. Grant buttons carry `data-t3p-grant-request`: the click itself is handled by
   * the preload in its isolated world (trusted clicks only), which asks the main process to show a
   * native confirmation dialog. This page never sends a grant; it only shows "waiting" until the
   * main process reports back. Revoke goes through the manager (no dialog: it only removes power).
   */
  const permissionsSection = (plugin: ManagedPlugin, missing: Set<string>): HTMLElement | null => {
    const names = declaredNames(plugin);
    if (names.length === 0) return null;
    const declared = parsePermissions(plugin.declared).set;
    const grantButton = (perms: string, label: string, aria: string, primary: boolean): HTMLButtonElement => {
      const isWaiting = waiting !== null && waiting.id === plugin.id && (waiting.perms === perms || waiting.perms === "*");
      return h(
        "button",
        {
          class: "t3p-btn",
          type: "button",
          "aria-label": aria,
          title: "Opens a T3 Patcher confirmation dialog",
          [GRANT_ATTR]: plugin.id,
          [GRANT_PERMS_ATTR]: perms,
          ...(primary ? { "data-primary": "" } : {}),
          ...(isWaiting ? { "data-t3p-waiting": "" } : {}),
          onClick: () => {
            // UI state only. The grant request itself is sent by the preload (trusted clicks).
            const mine = { id: plugin.id, perms };
            waiting = mine;
            // A click the preload ignored (synthetic, or a page script) never gets an answer: drop the
            // waiting label after a while so it cannot get stuck.
            setTimeout(() => {
              if (waiting !== mine) return;
              waiting = null;
              renderDetail();
            }, WAITING_RESET_MS);
            for (const el of Array.from(detail.querySelectorAll<HTMLElement>(`[${GRANT_ATTR}]`))) {
              if (perms === "*" || el.getAttribute(GRANT_PERMS_ATTR) === perms) {
                el.setAttribute("data-t3p-waiting", "");
                el.textContent = "Confirm in dialog…";
              }
            }
          },
        },
        isWaiting ? "Confirm in dialog…" : label,
      );
    };
    const revokeButton = (name: string): HTMLButtonElement | null => {
      const revoke = manager.revoke?.bind(manager);
      if (!revoke) return null;
      return h(
        "button",
        {
          class: "t3p-btn",
          type: "button",
          "data-variant": "ghost",
          "aria-label": `Revoke ${name} from ${plugin.name}`,
          "data-t3p-revoke": name,
          disabled: busy,
          onClick: () => {
            busy = true;
            revoke(plugin.id, [name])
              .catch((error: unknown) => onNotice(`${plugin.id}: ${String(error instanceof Error ? error.message : error)}`))
              .finally(() => {
                busy = false;
                renderList();
                renderDetail();
              });
          },
        },
        "Revoke",
      );
    };
    const rows = names.map((name) => {
      const info = permissionInfo(name);
      const granted = !missing.has(name);
      const scope = permissionScope(declared, name);
      return h(
        "div",
        { class: "t3p-perm-row", "data-t3p-perm": name, "data-t3p-granted": String(granted) },
        h(
          "div",
          { class: "t3p-perm-title" },
          h("span", null, info.title),
          h("code", null, name),
          h("span", { class: "t3p-pill", "data-tone": info.risk === "high" ? "bad" : info.risk === "medium" ? "warn" : "", "data-t3p-risk": info.risk, title: isHighRisk(name) ? "Always confirmed in a native dialog" : "Confirmed in a native dialog" }, `${info.risk} risk`),
          h("span", { class: "t3p-pill", "data-tone": granted ? "ok" : "", "data-t3p-perm-state": "" }, granted ? "granted" : "not granted"),
        ),
        h("small", null, info.meaning),
        scope.length > 0 ? h("small", { "data-t3p-perm-scope": "" }, `${name === "spawn" ? "Programs" : "Folders"}: ${scope.join(", ")}`) : null,
        granted ? revokeButton(name) : grantButton(name, "Grant", `Grant ${name} to ${plugin.name}`, false),
      );
    });
    const missingCount = names.filter((n) => missing.has(n)).length;
    return h(
      "section",
      { class: "t3p-pg-sec", "data-t3p-perm-section": plugin.id, tabindex: "-1", "aria-label": `Permissions of ${plugin.name}` },
      h(
        "div",
        { class: "t3p-pg-actions t3p-perm-head" },
        h("h2", null, "Permissions"),
        h("span", { class: "t3p-meta", "data-t3p-perm-count": "" }, `${names.length - missingCount} of ${names.length} granted`),
        h("span", { class: "t3p-spacer" }),
        missingCount > 0 ? grantButton("*", missingCount === 1 ? "Grant requested" : `Grant all requested (${missingCount})`, `Grant all requested permissions to ${plugin.name}`, true) : null,
      ),
      h("div", { class: "t3p-perm-body" }, ...rows),
    );
  };

  const renderDetail = (): void => {
    // Keep keyboard focus when a re-render fires while the user edits a field.
    const active = document.activeElement as HTMLElement | null;
    if (active && detail.contains(active) && active.matches("input[type=text],input[type=number]")) return;
    if (extra.parentElement) extra.remove(); // keep the element, drop it from the old pane
    clear(detail);
    const id = effective();
    const plugin = plugins().find((p) => p.id === id);
    if (!plugin) {
      detail.appendChild(h("div", { class: "t3p-muted", "data-t3p-empty": "" }, plugins().length === 0 ? "No plugins installed. Plugins with main code, patches or spawn are switched with the `t3p` CLI." : "Pick a plugin."));
      return;
    }
    const trusted = isTrusted(plugin);
    const names = declaredNames(plugin);
    const missing = new Set(missingPermissions(plugin));
    const all = plugin.status === "started" ? safeSchemas(manager, plugin.id) : [];
    // A plugin whose own name matched shows every setting; otherwise only the ones that matched.
    const shown = pluginNameMatches(plugin, query) ? all : matchingSchemas(all, query);

    detail.appendChild(
      h(
        "header",
        { class: "t3p-pg-head", "data-t3p-plugin-card": plugin.id },
        h(
          "div",
          { class: "t3p-card-head" },
          h("span", { class: "t3p-pg-ico", "data-large": "", "aria-hidden": "true" }, (plugin.name.trim()[0] ?? "?").toUpperCase()),
          h("span", { class: "t3p-card-title" }, ...highlight(plugin.name, query)),
          h("span", { class: "t3p-muted" }, plugin.version ? `v${plugin.version}` : ""),
          h("span", { class: "t3p-pill", "data-t3p-tier": "" }, `tier ${plugin.tier ?? "?"}`),
          h("span", { class: "t3p-pill", "data-tone": tone(plugin.status), "data-t3p-status": "" }, plugin.status),
          trusted ? h("span", { class: "t3p-pill", title: "main, patches or spawn" }, "trusted") : null,
          h("span", { class: "t3p-spacer" }),
          toggleFor(plugin),
        ),
        h("div", { class: "t3p-meta" }, ...highlight(plugin.id, query)),
        names.length > 0
          ? h(
              "div",
              { class: "t3p-pg-perms", "data-t3p-perms": "" },
              h("span", { class: "t3p-meta" }, "Permissions"),
              ...names.map((n) => h("span", { class: "t3p-pill", "data-tone": missing.has(n) ? "warn" : "ok", title: missing.has(n) ? "Not granted: see Permissions below" : "Granted" }, n)),
            )
          : h("div", { class: "t3p-pg-perms", "data-t3p-perms": "" }, h("span", { class: "t3p-meta" }, "No permissions requested")),
        plugin.error ? h("div", { class: "t3p-error", "data-t3p-error": "" }, plugin.error) : null,
        plugin.disabledReason === "crash-loop"
          ? h("div", { class: "t3p-error", "data-t3p-disabled-reason": "" }, `Disabled by the crash-loop guard after repeated failed starts. Re-enable with: t3p enable ${plugin.id}`)
          : null,
        plugin.restartRequired ? h("div", { class: "t3p-muted", "data-t3p-restart": "" }, "Restart T3 Code to apply the change to its main code.") : null,
      ),
    );
    const permSection = permissionsSection(plugin, missing);
    if (permSection) {
      detail.appendChild(permSection);
      if (focusPerms) {
        focusPerms = false;
        try {
          permSection.scrollIntoView({ block: "start" });
          permSection.focus();
        } catch {
          // an engine without scrollIntoView options: no scrolling
        }
      }
    }

    if (all.length > 0) {
      const forceOpen = query.trim() !== "";
      const actions = h(
        "div",
        { class: "t3p-pg-actions" },
        h("h2", null, "Settings"),
        h("span", { class: "t3p-spacer" }),
        h(
          "button",
          {
            class: "t3p-btn",
            type: "button",
            "data-t3p-reset-plugin": plugin.id,
            onClick: (e: Event) => {
              const btn = e.currentTarget as HTMLButtonElement;
              if (resetArmed !== plugin.id) {
                resetArmed = plugin.id;
                btn.textContent = "Really reset?";
                btn.setAttribute("data-primary", "");
                if (resetTimer) clearTimeout(resetTimer);
                resetTimer = setTimeout(() => {
                  resetArmed = null;
                  btn.textContent = "Reset plugin settings";
                  btn.removeAttribute("data-primary");
                }, 3000);
                return;
              }
              resetArmed = null;
              if (resetTimer) clearTimeout(resetTimer);
              Promise.all(all.map((s) => manager.resetSetting(plugin.id, s.key))).then(
                () => {
                  resetArmed = null;
                  renderDetail();
                },
                (err: unknown) => onNotice(String(err)),
              );
            },
          },
          "Reset plugin settings",
        ),
      );
      detail.appendChild(actions);
      if (shown.length === 0) detail.appendChild(h("div", { class: "t3p-meta", "data-t3p-empty": "" }, `No setting of this plugin matches "${query.trim()}".`));
      const keep = new Set(shown.map((x) => x.key));
      // Group on the full list so a filtered view keeps the same section titles.
      for (const group of groupSchemas(all)) {
        const part = { title: group.title, schemas: group.schemas.filter((x) => keep.has(x.key)) };
        if (part.schemas.length > 0) detail.appendChild(settingsSection(plugin, part, forceOpen));
      }
    } else if (plugin.status === "started") {
      detail.appendChild(h("div", { class: "t3p-meta", "data-t3p-no-settings": "" }, "This plugin has no settings."));
    } else {
      detail.appendChild(h("div", { class: "t3p-meta", "data-t3p-no-settings": "" }, "Settings show up while the plugin is running."));
    }
    detail.appendChild(extra);
    filterExtras();
  };

  // ---- events ----------------------------------------------------------------------------------------
  search.addEventListener("input", () => {
    query = search.value;
    renderList();
    renderDetail();
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && search.value) {
      e.preventDefault();
      search.value = "";
      query = "";
      renderList();
      renderDetail();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const first = visible()[0];
      if (first) choose(first.id, { focus: true, keepView: true });
    }
  });
  list.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const shown = visible();
    if (shown.length === 0) return;
    e.preventDefault();
    const at = shown.findIndex((p) => p.id === effective());
    let next = at;
    if (e.key === "ArrowDown") next = Math.min(shown.length - 1, at + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, at - 1);
    else if (e.key === "Home") next = 0;
    else next = shown.length - 1;
    if (e.key === "ArrowUp" && at === 0) search.focus();
    else choose(shown[next]!.id, { focus: true, keepView: true });
  });
  const onDocKey = (e: KeyboardEvent): void => {
    if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || !root.isConnected) return;
    if (isEditable(document.activeElement)) return;
    e.preventDefault();
    root.setAttribute("data-t3p-view", "list");
    search.focus();
    search.select();
  };
  document.addEventListener("keydown", onDocKey);
  const onSelect = (id: string, focus: "permissions" | null): void => {
    pending = null;
    pendingFocus = null;
    focusPerms = focus === "permissions";
    if (query) {
      query = "";
      search.value = "";
    }
    choose(id);
  };
  selectors.add(onSelect);

  const offManager = manager.onChange(() => {
    waiting = null;
    renderList();
    renderDetail();
  });
  renderList();
  renderDetail();
  return () => {
    offManager();
    selectors.delete(onSelect);
    document.removeEventListener("keydown", onDocKey);
    extraObserver?.disconnect();
    if (resetTimer) clearTimeout(resetTimer);
    root.remove();
  };
}
