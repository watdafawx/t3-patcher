import type { Unsubscribe } from "@t3p/api";

import { filterEntries, LOG_LIMIT, LOG_PATH, type PluginLogEntry } from "../logic/logs.js";
import { clear, h } from "./dom.js";
import { LogTailer, missingGrantHint } from "./log-tailer.js";
import { CSS } from "./styles.js";
import { bindTheme, type ThemeSource } from "./theme.js";

export interface LogsTabApi extends ThemeSource {
  log(level: "debug" | "info" | "warn" | "error", message: string): void;
}

export interface LogsTabOptions {
  api: LogsTabApi;
  tailer: LogTailer;
  /** Plugin id, for the grant hint. */
  pluginId: string;
  onThemeChange?: (cb: () => void) => Unsubscribe;
}

export interface Tab {
  dispose(): void;
}

/** The log directory a grant needs (main.log's parent, with `~` intact). */
function grantRoot(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, "");
}

export function mountLogsTab(host: HTMLElement, opts: LogsTabOptions): Tab {
  const api = opts.api;
  const tailer = opts.tailer;
  const root = h("div", { class: "t3p-dt", data: { t3pDevtools: "plugin-logs" } });
  const style = h("style", { text: CSS });
  host.append(style, root);
  const cleanups: Array<() => void> = [];
  cleanups.push(bindTheme(root, api, opts.onThemeChange));
  let disposed = false;
  let filter: string | null = null;
  let idsKey = "";

  root.append(
    h("h4", { text: "Plugin logs" }),
    h("p", {
      class: "dt-note",
      text: `The renderer has no log event: plugin lines are read from ${LOG_PATH} through t3.native.logTail (permission log.tail, root ${grantRoot(LOG_PATH)}).`,
    }),
  );

  const filterSelect = h("select", { attrs: { "aria-label": "Filter by plugin" } });
  const refresh = h("button", { class: "dt-btn", text: "Refresh", attrs: { type: "button" } });
  const pause = h("button", { class: "dt-btn", text: "Pause", attrs: { type: "button" } });
  const clearButton = h("button", { class: "dt-btn", text: "Clear", attrs: { type: "button" } });
  const status = h("span", { class: "dt-count", text: "" });
  root.append(h("div", { class: "dt-row" }, filterSelect, refresh, pause, clearButton, status));

  const errorBox = h("div", { attrs: { "data-role": "error" } });
  root.append(errorBox);
  const logBox = h("div", { class: "dt-log", attrs: { "data-role": "plugin-log" } });
  root.append(logBox);

  const syncFilterOptions = (entries: readonly PluginLogEntry[]): void => {
    const ids = [...new Set(entries.map((entry) => entry.plugin))].sort();
    const key = ids.join("\u0000");
    if (key === idsKey) return;
    idsKey = key;
    clear(filterSelect);
    filterSelect.append(h("option", { text: "all plugins", attrs: { value: "" } }));
    for (const id of ids) filterSelect.append(h("option", { text: id, attrs: { value: id } }));
    if (filter !== null && !ids.includes(filter)) filter = null;
    filterSelect.value = filter ?? "";
  };

  const render = (): void => {
    if (disposed) return;
    const state = tailer.state;
    const entries = state.entries;
    syncFilterOptions(entries);
    const shown = filterEntries(entries, filter);

    status.textContent = `${shown.length}/${entries.length} line(s)${state.cursor === null ? "" : ` · cursor ${state.cursor}`}${state.size === null ? "" : `/${state.size}`}${state.resets > 0 ? ` · ${state.resets} reset(s)` : ""}`;

    clear(errorBox);
    if (state.error) {
      const needsGrant = /log\.tail|granted|not granted|denied/i.test(state.error);
      errorBox.append(h("div", { class: "dt-error", text: needsGrant ? `${state.error}\n\n${missingGrantHint(opts.pluginId, LOG_PATH)}` : state.error }));
    }

    const nearBottom = logBox.scrollTop + logBox.clientHeight >= logBox.scrollHeight - 8;
    clear(logBox);
    if (shown.length === 0) {
      logBox.append(h("span", { class: "dt-note", text: state.reading ? "Reading main.log..." : "No plugin lines yet." }));
    }
    for (const entry of shown) {
      const line = h("div", { class: "dt-log-line", data: { level: entry.level }, title: `${entry.at} ${entry.level} [${entry.plugin}]` });
      line.append(h("span", { class: "dt-log-at", text: `${entry.at.slice(11, 19)} ` }), h("strong", { text: `${entry.plugin} ` }), document.createTextNode(entry.message));
      logBox.append(line);
    }
    if (entries.length >= LOG_LIMIT) logBox.append(h("span", { class: "dt-note", text: `Showing the newest ${LOG_LIMIT} plugin lines.` }));
    if (nearBottom) logBox.scrollTop = logBox.scrollHeight;
  };

  const unsubscribe = tailer.onUpdate(render);
  cleanups.push(unsubscribe);

  filterSelect.addEventListener("change", () => {
    filter = filterSelect.value === "" ? null : filterSelect.value;
    render();
  });
  refresh.addEventListener("click", () => void tailer.poll().then(() => render()));
  pause.addEventListener("click", () => {
    if (tailer.started) {
      tailer.stop();
      pause.textContent = "Resume";
      pause.setAttribute("aria-pressed", "true");
    } else {
      tailer.start();
      pause.textContent = "Pause";
      pause.setAttribute("aria-pressed", "false");
    }
  });
  clearButton.addEventListener("click", () => tailer.clear());

  tailer.start();
  render();

  return {
    dispose() {
      disposed = true;
      tailer.stop();
      for (const cleanup of cleanups.splice(0)) cleanup();
      style.remove();
      root.remove();
    },
  };
}
