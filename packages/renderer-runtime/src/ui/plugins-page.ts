import type { SettingSchema, SettingValue } from "@t3p/api";

import type { ManagedPlugin } from "../manager.js";
import { clear, ensureStyles, h } from "./dom.js";

/** The slice of `window.__t3p.manager` the page uses. */
export interface ManagerFacade {
  list(): ManagedPlugin[];
  enable(id: string): Promise<ManagedPlugin | null>;
  disable(id: string): Promise<{ restartRequired: boolean }>;
  schemas(id: string): SettingSchema[];
  getSetting(id: string, key: string): SettingValue;
  setSetting(id: string, key: string, value: SettingValue): Promise<void>;
  resetSetting(id: string, key: string): Promise<void>;
  onChange(callback: () => void): () => void;
}

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

/**
 * Builds the Plugins settings page into `host`: one card per plugin (name, version, tier, status,
 * error), an enable switch for renderer-only plugins, and a control per `t3.settings` schema.
 * Returns a cleanup. The page re-renders when the plugin manager changes.
 */
export function mountPluginsPage(host: HTMLElement, manager: ManagerFacade, onNotice: (message: string) => void): () => void {
  ensureStyles();
  const root = h("div", { class: "t3p-page", "data-t3p-root": "", "data-t3p-page": "plugins" });
  const extra = h("div", { "data-t3p-slot-anchor": "settingsPage" });
  host.appendChild(root);
  let busy = false;

  const settingControl = (plugin: ManagedPlugin, schema: SettingSchema): HTMLElement => {
    let value: SettingValue;
    try {
      value = manager.getSetting(plugin.id, schema.key);
    } catch {
      value = schema.default;
    }
    const apply = (next: SettingValue): void => {
      manager.setSetting(plugin.id, schema.key, next).catch((error: unknown) => onNotice(`${plugin.id}: ${String(error instanceof Error ? error.message : error)}`));
    };
    let control: HTMLElement;
    if (schema.type === "boolean") {
      control = h("input", { class: "t3p-switch", type: "checkbox", checked: value === true, "data-t3p-setting": schema.key, onChange: (e: Event) => apply((e.target as HTMLInputElement).checked) });
    } else if (schema.type === "enum") {
      const select = h("select", { class: "t3p-input", "data-t3p-setting": schema.key, onChange: (e: Event) => apply((e.target as HTMLSelectElement).value) });
      for (const option of schema.options) select.appendChild(h("option", { value: option.value, selected: option.value === value }, option.label ?? option.value));
      control = select;
    } else if (schema.type === "number") {
      control = h("input", {
        class: "t3p-input",
        type: "number",
        value: String(value),
        "data-t3p-setting": schema.key,
        ...(schema.min !== undefined ? { min: String(schema.min) } : {}),
        ...(schema.max !== undefined ? { max: String(schema.max) } : {}),
        onChange: (e: Event) => {
          const n = Number((e.target as HTMLInputElement).value);
          if (Number.isFinite(n)) apply(n);
        },
      });
    } else {
      control = h("input", { class: "t3p-input", type: "text", value: String(value), "data-t3p-setting": schema.key, onChange: (e: Event) => apply((e.target as HTMLInputElement).value) });
    }
    const reset = h("button", { class: "t3p-btn", type: "button", title: "Reset to default", onClick: () => void manager.resetSetting(plugin.id, schema.key).then(render, (e: unknown) => onNotice(String(e))) }, "Reset");
    return h(
      "div",
      { class: "t3p-setting" },
      h("label", null, schema.label),
      h("div", { style: "display:flex;gap:6px;align-items:center" }, control, reset),
      schema.description ? h("small", null, schema.description) : null,
    );
  };

  const card = (plugin: ManagedPlugin): HTMLElement => {
    const trusted = isTrusted(plugin);
    const on = plugin.status === "started" || plugin.status === "pending";
    const toggle = h("input", {
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
          render();
        });
      },
    });
    const schemas = plugin.status === "started" ? safeSchemas(manager, plugin.id) : [];
    return h(
      "section",
      { class: "t3p-card", "data-t3p-plugin-card": plugin.id },
      h(
        "div",
        { class: "t3p-card-head" },
        h("span", { class: "t3p-card-title" }, plugin.name),
        h("span", { class: "t3p-muted" }, plugin.version ? `v${plugin.version}` : ""),
        h("span", { class: "t3p-pill", "data-t3p-tier": "" }, `tier ${plugin.tier ?? "?"}`),
        h("span", { class: "t3p-pill", "data-tone": tone(plugin.status), "data-t3p-status": "" }, plugin.status),
        trusted ? h("span", { class: "t3p-pill", title: "main, patches or spawn" }, "trusted") : null,
        h("span", { class: "t3p-spacer" }),
        toggle,
      ),
      h("div", { class: "t3p-muted" }, plugin.id),
      plugin.error ? h("div", { class: "t3p-error", "data-t3p-error": "" }, plugin.error) : null,
      plugin.disabledReason === "crash-loop"
        ? h("div", { class: "t3p-error", "data-t3p-disabled-reason": "" }, `Disabled by the crash-loop guard after repeated failed starts. Re-enable with: t3p enable ${plugin.id}`)
        : null,
      plugin.restartRequired ? h("div", { class: "t3p-muted" }, "Restart T3 Code to stop its main code.") : null,
      ...schemas.map((schema) => settingControl(plugin, schema)),
    );
  };

  const render = (): void => {
    // Keep keyboard focus when a re-render fires while the user edits a field.
    const active = document.activeElement as HTMLElement | null;
    if (active && root.contains(active) && active.matches("input[type=text],input[type=number]") && root.contains(active)) return;
    clear(root);
    const plugins = manager.list();
    root.appendChild(h("h1", null, "Plugins"));
    root.appendChild(h("div", { class: "t3p-muted" }, `${plugins.length} installed. Plugins with main code, patches or spawn are switched with the \`t3p\` CLI.`));
    root.appendChild(h("h2", null, "Installed"));
    if (plugins.length === 0) root.appendChild(h("div", { class: "t3p-muted" }, "No plugins installed."));
    for (const plugin of plugins) root.appendChild(card(plugin));
    root.appendChild(extra);
  };

  const off = manager.onChange(render);
  render();
  return () => {
    off();
    root.remove();
  };
}

function safeSchemas(manager: ManagerFacade, id: string): SettingSchema[] {
  try {
    return manager.schemas(id);
  } catch {
    return [];
  }
}
