import type { SettingSchema, SettingValue, SettingsPanelOptions, T3Settings } from "@t3p/api";

import { h } from "./dom.js";

/** One rendered control for a setting schema. */
export interface ControlHandle {
  /** The element to put in a row. */
  el: HTMLElement;
  /** The editable element (`data-t3p-setting` is set on it). */
  input: HTMLInputElement | HTMLSelectElement;
  /** Shows `value` without firing any hook. */
  set(value: SettingValue): void;
}

export interface ControlHooks {
  /** Fires continuously while a slider moves. The value is already shown. */
  onInput?(value: number): void;
  /** Fires when the user finishes an edit (change event). */
  onCommit(value: SettingValue): void;
}

function decimals(step: number): number {
  const text = String(step);
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
}

/** Builds the control for one schema. Shared by the Plugins page and `t3.ui.settingsPanel`. */
export function createControl(schema: SettingSchema, value: SettingValue, hooks: ControlHooks): ControlHandle {
  const attrs = { "data-t3p-setting": schema.key };
  if (schema.type === "boolean") {
    const input = h("input", { class: "t3p-switch", type: "checkbox", checked: value === true, "aria-label": schema.label, ...attrs, onChange: () => hooks.onCommit(input.checked) });
    return { el: input, input, set: (v) => void (input.checked = v === true) };
  }
  if (schema.type === "enum") {
    const select = h("select", { class: "t3p-input", "aria-label": schema.label, ...attrs, onChange: () => hooks.onCommit(select.value) });
    for (const option of schema.options) select.appendChild(h("option", { value: option.value, selected: option.value === value }, option.label ?? option.value));
    return { el: select, input: select, set: (v) => void (select.value = String(v)) };
  }
  if (schema.type === "range") {
    const step = schema.step ?? 1;
    const fixed = decimals(step);
    const show = (v: number): string => (Number.isInteger(step) ? String(Math.round(v)) : v.toFixed(fixed));
    const out = h("output", { class: "t3p-range-out", "data-t3p-range-out": schema.key }, show(Number(value)));
    const input = h("input", {
      class: "t3p-range",
      type: "range",
      min: String(schema.min),
      max: String(schema.max),
      step: String(step),
      value: String(value),
      "aria-label": schema.label,
      ...attrs,
      onInput: () => {
        const n = Number(input.value);
        out.textContent = show(n);
        hooks.onInput?.(n);
      },
      onChange: () => hooks.onCommit(Number(input.value)),
    });
    const el = h("div", { class: "t3p-range-wrap" }, input, out);
    return {
      el,
      input,
      set: (v) => {
        input.value = String(v);
        out.textContent = show(Number(v));
      },
    };
  }
  if (schema.type === "number") {
    const input = h("input", {
      class: "t3p-input",
      type: "number",
      value: String(value),
      "aria-label": schema.label,
      ...attrs,
      ...(schema.min !== undefined ? { min: String(schema.min) } : {}),
      ...(schema.max !== undefined ? { max: String(schema.max) } : {}),
      onChange: () => {
        const n = Number(input.value);
        if (Number.isFinite(n)) hooks.onCommit(n);
      },
    });
    return { el: input, input, set: (v) => void (input.value = String(v)) };
  }
  const input = h("input", { class: "t3p-input", type: "text", value: String(value), "aria-label": schema.label, ...attrs, onChange: () => hooks.onCommit(input.value) });
  return { el: input, input, set: (v) => void (input.value = String(v)) };
}

/**
 * Renders compact live rows for a plugin's own settings into `host`. Writes go to `settings.set`
 * (slider drags are debounced, the readout updates at once), changes made elsewhere update the
 * controls. Returns the cleanup. Used by `t3.ui.settingsPanel`.
 */
export function mountSettingsPanel(host: HTMLElement, settings: T3Settings, options: SettingsPanelOptions = {}): () => void {
  const all = settings.getSchemas();
  const byKey = new Map(all.map((s) => [s.key, s]));
  const schemas = options.keys ? options.keys.map((k) => byKey.get(k)).filter((s): s is SettingSchema => s !== undefined) : all;
  const debounceMs = Math.max(0, options.debounceMs ?? 120);
  const resets = options.resetButtons !== false;
  const root = h("div", { class: "t3p-sp", "data-t3p-settings-panel": "" });
  const handles = new Map<string, { control: ControlHandle; refresh(v: SettingValue): void }>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let disposed = false;

  const write = (key: string, value: SettingValue): void => {
    timers.delete(key);
    if (disposed) return;
    settings.set(key, value).catch(() => undefined);
  };
  const queue = (key: string, value: SettingValue): void => {
    const old = timers.get(key);
    if (old) clearTimeout(old);
    timers.set(key, setTimeout(() => write(key, value), debounceMs));
  };
  const commit = (key: string, value: SettingValue): void => {
    const old = timers.get(key);
    if (old) clearTimeout(old);
    write(key, value);
  };

  for (const schema of schemas) {
    let current: SettingValue;
    try {
      current = settings.get(schema.key);
    } catch {
      current = schema.default;
    }
    const reset = resets
      ? h("button", { class: "t3p-btn t3p-sp-reset", type: "button", "data-variant": "ghost", "data-compact": "", title: "Reset to default", "aria-label": `Reset ${schema.label}`, hidden: current === schema.default }, "↺")
      : null;
    const control = createControl(schema, current, {
      onInput: (v) => {
        if (reset) reset.hidden = v === schema.default;
        try {
          options.onLive?.(schema.key, v);
        } catch {
          // a preview hook must not break editing
        }
        queue(schema.key, v);
      },
      onCommit: (v) => {
        if (reset) reset.hidden = v === schema.default;
        commit(schema.key, v);
      },
    });
    reset?.addEventListener("click", () => {
      const old = timers.get(schema.key);
      if (old) clearTimeout(old);
      timers.delete(schema.key);
      settings.reset(schema.key).catch(() => undefined);
    });
    const label = h("label", { class: "t3p-sp-label", title: schema.description ?? schema.label }, schema.label);
    const range = schema.type === "range";
    const row = h("div", { class: "t3p-sp-row", "data-kind": range ? "range" : "inline", "data-t3p-setting-row": schema.key }, h("div", { class: "t3p-sp-head" }, label, reset), control.el);
    root.appendChild(row);
    handles.set(schema.key, {
      control,
      refresh: (v) => {
        if (reset) reset.hidden = v === schema.default;
        // Do not fight the user's own in-progress edit.
        if (document.activeElement === control.input || timers.has(schema.key)) return;
        control.set(v);
      },
    });
  }

  const off = settings.onChange((change) => handles.get(change.key)?.refresh(change.value));
  host.appendChild(root);
  return () => {
    disposed = true;
    off();
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    root.remove();
  };
}
