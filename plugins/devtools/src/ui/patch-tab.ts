import type { Unsubscribe } from "@t3p/api";

import { runPatchTest, parseMatchSpec, type PatchTestReport, type ParseCheck, type Snippet } from "../logic/patch-test.js";
import { checkModuleSyntax } from "../logic/parse-check.js";
import { clear, h, shorten } from "./dom.js";
import type { ChunkLoader } from "./live-chunks.js";
import { CSS } from "./styles.js";
import { bindTheme, type ThemeSource } from "./theme.js";

/** What `$self` becomes in a report. The tester never applies anything, so it names this plugin's handle. */
export const SELF_HANDLE = 'window.__t3p_plugins["devtools"]';

export interface PatchTabApi extends ThemeSource {
  log(level: "debug" | "info" | "warn" | "error", message: string): void;
}

export interface PatchTabOptions {
  api: PatchTabApi;
  loadChunks: ChunkLoader;
  /** Default: the acorn-based check. `null` reports "parse check unavailable". */
  parseCheck?: ParseCheck | null;
  onThemeChange?: (cb: () => void) => Unsubscribe;
  /** Reports the last result (diagnostics and tests). */
  onReport?: (report: PatchTestReport) => void;
}

export interface Tab {
  dispose(): void;
}

interface ReplacementRow {
  root: HTMLElement;
  match: HTMLInputElement;
  replace: HTMLInputElement;
}

export function mountPatchTab(host: HTMLElement, opts: PatchTabOptions): Tab {
  const cleanups: Array<() => void> = [];
  const root = h("div", { class: "t3p-dt", data: { t3pDevtools: "patch-tester" } });
  const style = h("style", { text: CSS });
  host.append(style, root);
  cleanups.push(bindTheme(root, opts.api, opts.onThemeChange));
  let disposed = false;
  let running = false;

  root.append(
    h("h4", { text: "Patch tester (read-only)" }),
    h("p", {
      class: "dt-note",
      text:
        "Runs a find and match/replace pairs against the chunks this page has loaded, following the patch engine's rules. " +
        "It only reports: no patch is registered and no code is evaluated.",
    }),
  );

  const findInput = h("input", {
    class: "dt-mono",
    placeholder: "find: a literal string, or /regex/flags",
    attrs: { "aria-label": "find" },
  });
  root.append(h("label", { class: "dt-label" }, h("span", { text: "find (must match exactly one chunk)" }), findInput));

  const rows: ReplacementRow[] = [];
  const rowBox = h("div", { class: "dt-stack", attrs: { "data-role": "replacements" } });
  root.append(h("span", { class: "dt-note", text: "match / replace (string match = first occurrence)" }), rowBox);

  const addRow = (): void => {
    const match = h("input", { class: "dt-mono dt-grow", placeholder: "match: literal or /regex/i", attrs: { "aria-label": "match" } });
    const replace = h("input", { class: "dt-mono dt-grow", placeholder: "replace: $1, $&, $self", attrs: { "aria-label": "replace" } });
    const remove = h("button", { class: "dt-btn", text: "×", title: "Remove this replacement", attrs: { type: "button" } });
    const row = h("div", { class: "dt-row" }, match, replace, remove);
    const entry: ReplacementRow = { root: row, match, replace };
    remove.addEventListener("click", () => {
      if (rows.length <= 1) return;
      const at = rows.indexOf(entry);
      if (at >= 0) rows.splice(at, 1);
      row.remove();
    });
    rows.push(entry);
    rowBox.append(row);
  };
  addRow();

  const addButton = h("button", { class: "dt-btn", text: "Add replacement", attrs: { type: "button" } });
  addButton.addEventListener("click", addRow);
  const runButton = h("button", { class: "dt-btn", text: "Run test", attrs: { type: "button" } });
  const status = h("span", { class: "dt-count", text: "" });
  root.append(h("div", { class: "dt-row" }, addButton, runButton, status));

  const reportBox = h("div", { class: "dt-stack", attrs: { "data-role": "report" } });
  root.append(reportBox);

  const showError = (message: string): void => {
    clear(reportBox);
    reportBox.append(h("div", { class: "dt-error", text: message }));
  };

  const snippetNode = (snippet: Snippet): HTMLElement => {
    const pre = h("pre", { class: "dt-pre dt-snippet" });
    pre.append(document.createTextNode(snippet.before));
    pre.append(h("mark", { text: snippet.changed.length > 0 ? snippet.changed : "(empty)" }));
    pre.append(document.createTextNode(snippet.after));
    return pre;
  };

  const renderReport = (report: PatchTestReport, notes: readonly string[]): void => {
    clear(reportBox);
    const verdictTone = report.verdict === "unique" ? "ok" : report.verdict === "ambiguous" ? "warn" : "bad";
    const verdictText =
      report.verdict === "unique" ? "unique chunk" : report.verdict === "ambiguous" ? "ambiguous" : report.verdict === "no-match" ? "no match" : "invalid input";
    reportBox.append(
      h("div", { class: "dt-row" }, h("span", { class: "dt-badge", text: verdictText, data: { tone: verdictTone } }), h("span", { class: "dt-note", text: `searched ${report.searchedChunks} chunk(s)` })),
    );

    if (report.error) reportBox.append(h("div", { class: "dt-error", text: report.error }));

    if (notes.length > 0) {
      const details = h("details", {}, h("summary", { text: `${notes.length} loader note(s)` }));
      for (const note of notes) details.append(h("div", { class: "dt-note", text: note }));
      reportBox.append(details);
    }

    if (report.hits.length > 0) {
      const list = h("div", { class: "dt-list", attrs: { "data-role": "hits" } });
      list.append(h("span", { class: "dt-note", text: "Matches per chunk:" }));
      for (const hit of report.hits.slice(0, 12)) {
        list.append(h("div", { class: "dt-chunk" }, h("code", { class: "dt-mono", text: hit.name }), h("span", { class: "dt-count", text: `${hit.count}×` })));
      }
      if (report.hits.length > 12) list.append(h("span", { class: "dt-note", text: `+${report.hits.length - 12} more chunk(s)` }));
      reportBox.append(list);
    }

    if (report.chosen) {
      reportBox.append(h("div", { class: "dt-note" }, document.createTextNode("The patch would be assigned to "), h("code", { class: "dt-mono", text: report.chosen }), document.createTextNode(".")));
    }

    for (const outcome of report.replacements) {
      const head = h("div", { class: "dt-row" }, h("span", { class: "dt-note", text: `#${outcome.index}` }), h("code", { class: "dt-mono", text: shorten(outcome.match, 80) }));
      const matched = h("div", { class: "dt-note" }, document.createTextNode("matched "), h("code", { class: "dt-mono", text: JSON.stringify(outcome.matchedText) }));
      reportBox.append(h("div", { class: "dt-stack" }, head, matched, snippetNode(outcome.snippet)));
    }

    const parseText =
      report.parse.status === "ok"
        ? "The patched text parses as an ES module."
        : report.parse.status === "error"
          ? `The patched text does not parse: ${report.parse.detail ?? "syntax error"}`
          : report.parse.status === "unavailable"
            ? "parse check unavailable (no parser in the renderer)"
            : "parse check skipped";
    reportBox.append(
      h("div", {
        class: report.parse.status === "error" ? "dt-error" : "dt-note",
        text: parseText,
        data: { parse: report.parse.status },
      }),
    );
    if (report.patchedChars !== null) reportBox.append(h("div", { class: "dt-note", text: `produced ${report.patchedChars} chars (not applied)` }));
    opts.onReport?.(report);
  };

  const run = async (): Promise<void> => {
    if (running || disposed) return;
    // Validate the input before fetching anything: a typo in a regex should not read 20 chunks.
    const findCheck = parseMatchSpec(findInput.value, "find");
    if (!findCheck.ok) {
      showError(findCheck.error);
      return;
    }
    for (let i = 0; i < rows.length; i++) {
      const check = parseMatchSpec(rows[i]!.match.value, `replacement ${i + 1} match`);
      if (!check.ok) {
        showError(check.error);
        return;
      }
    }
    running = true;
    runButton.disabled = true;
    clear(reportBox);
    reportBox.append(h("div", { class: "dt-note", text: "Reading the page's chunks..." }));
    try {
      const loaded = await opts.loadChunks((message) => {
        if (!disposed) status.textContent = message;
      });
      if (disposed) return;
      if (loaded.error && loaded.chunks.length === 0) {
        showError(loaded.error);
        return;
      }
      const report = runPatchTest({
        chunks: loaded.chunks,
        find: findInput.value,
        replacements: rows.map((row) => ({ match: row.match.value, replace: row.replace.value })),
        selfHandle: SELF_HANDLE,
        parseCheck: opts.parseCheck === undefined ? checkModuleSyntax : opts.parseCheck,
      });
      renderReport(report, loaded.notes);
      opts.api.log("info", `patch test: ${report.verdict}${report.chosen ? ` (${report.chosen})` : ""}`);
    } catch (error) {
      if (!disposed) showError(error instanceof Error ? error.message : String(error));
    } finally {
      running = false;
      if (!disposed) {
        runButton.disabled = false;
        status.textContent = "";
      }
    }
  };
  runButton.addEventListener("click", () => void run());

  return {
    dispose() {
      disposed = true;
      for (const cleanup of cleanups.splice(0)) cleanup();
      style.remove();
      root.remove();
    },
  };
}
