import type { Unsubscribe } from "@t3p/api";

import {
  appendCapped,
  formatDuration,
  formatRpcError,
  isDangerousMethod,
  MAX_RPC_LOG,
  parsePayload,
  RPC_METHOD_SUGGESTIONS,
  summarizeJson,
} from "../logic/rpc-console.js";
import { clear, h, shorten } from "./dom.js";
import { CSS } from "./styles.js";
import { bindTheme, type ThemeSource } from "./theme.js";

export interface RpcTabApi extends ThemeSource {
  rpc: {
    call(method: string, payload: Record<string, unknown>): Promise<unknown>;
    subscribe(
      method: string,
      payload: Record<string, unknown>,
      onItem: (item: unknown) => void,
      options?: { onError?(error: Error): void },
    ): { cancel(): void; done: Promise<void> };
    readonly state: string;
    onState(callback: (state: string) => void): () => void;
  };
  log(level: "debug" | "info" | "warn" | "error", message: string): void;
}

export interface RpcTabOptions {
  api: RpcTabApi;
  onThemeChange?: (cb: () => void) => Unsubscribe;
}

export interface Tab {
  dispose(): void;
}

interface LogItem {
  at: number;
  text: string;
}

let datalistSeq = 0;

export function mountRpcTab(host: HTMLElement, opts: RpcTabOptions): Tab {
  const api = opts.api;
  const cleanups: Array<() => void> = [];
  const root = h("div", { class: "t3p-dt", data: { t3pDevtools: "rpc-console" } });
  const style = h("style", { text: CSS });
  host.append(style, root);
  cleanups.push(bindTheme(root, api, opts.onThemeChange));
  let disposed = false;

  root.append(
    h("h4", { text: "RPC console" }),
    h("div", {
      class: "dt-warn",
      text:
        "Every call runs with the full-scope bearer token: orchestration, terminal and access. " +
        "This is not a sandbox. Methods with dispatch, delete, remove, terminal or auth in the name need a second, explicit confirm.",
    }),
  );

  const datalistId = `t3p-dt-rpc-methods-${++datalistSeq}`;
  const datalist = h("datalist", { attrs: { id: datalistId } });
  for (const method of RPC_METHOD_SUGGESTIONS) datalist.append(h("option", { attrs: { value: method } }));
  root.append(datalist);

  const methodInput = h("input", {
    class: "dt-mono dt-grow",
    value: "server.getConfig",
    placeholder: "method, e.g. server.getConfig",
    attrs: { "aria-label": "RPC method", list: datalistId },
  });
  const mode = h("select", { attrs: { "aria-label": "call or subscribe" } }, h("option", { text: "call", attrs: { value: "call" } }), h("option", { text: "subscribe", attrs: { value: "subscribe" } }));
  const socket = h("span", { class: "dt-count", text: "socket: ?" });
  root.append(h("div", { class: "dt-row" }, methodInput, mode, socket));

  root.append(h("span", { class: "dt-note", text: "payload (JSON object; empty = {})" }));
  const payloadInput = h("textarea", {
    value: "{}",
    attrs: { rows: "6", spellcheck: "false", "aria-label": "RPC payload JSON" },
  });
  root.append(payloadInput);

  const confirmBox = h("div", { class: "dt-warn", attrs: { "data-role": "confirm" } });
  confirmBox.hidden = true;
  const confirmText = h("span", { text: "" });
  const confirmButton = h("button", { class: "dt-btn dt-btn-danger", text: "Run anyway (full scope)", attrs: { type: "button" } });
  const cancelButton = h("button", { class: "dt-btn", text: "Cancel", attrs: { type: "button" } });
  confirmBox.append(confirmText, h("div", { class: "dt-row" }, confirmButton, cancelButton));
  root.append(confirmBox);

  const runButton = h("button", { class: "dt-btn", text: "Call", attrs: { type: "button" } });
  const stopButton = h("button", { class: "dt-btn", text: "Stop", attrs: { type: "button" } });
  stopButton.disabled = true;
  const clearButton = h("button", { class: "dt-btn", text: "Clear log", attrs: { type: "button" } });
  root.append(h("div", { class: "dt-row" }, runButton, stopButton, clearButton));

  const resultBox = h("div", { class: "dt-stack", attrs: { "data-role": "result" } });
  root.append(resultBox);

  const logCount = h("span", { class: "dt-count", text: "0 item(s)" });
  const logBox = h("div", { class: "dt-log", attrs: { "data-role": "stream-log" } });
  root.append(h("div", { class: "dt-row" }, h("span", { class: "dt-note", text: "stream log (newest last, capped)" }), logCount), logBox);

  let subscription: { cancel(): void; done: Promise<void> } | null = null;
  let streaming = false;
  let streamFailed = false;
  let confirmedFor: string | null = null;
  let log: LogItem[] = [];
  let dropped = 0;

  const syncButtons = (): void => {
    runButton.textContent = mode.value === "subscribe" ? "Subscribe" : "Call";
    runButton.disabled = streaming;
    stopButton.disabled = !streaming;
  };

  const show = (kind: "ok" | "bad" | "note", text: string, detail?: unknown): void => {
    clear(resultBox);
    if (kind === "bad") resultBox.append(h("div", { class: "dt-error", text }));
    else resultBox.append(h("div", { class: kind === "ok" ? "dt-row" : "dt-note" }, h("span", { class: kind === "ok" ? "dt-badge" : "dt-note", text, data: kind === "ok" ? { tone: "ok" } : {} })));
    if (detail !== undefined) resultBox.append(h("pre", { class: "dt-pre", text: summarizeJson(detail, 20_000) }));
  };

  const renderLog = (): void => {
    const nearBottom = logBox.scrollTop + logBox.clientHeight >= logBox.scrollHeight - 8;
    clear(logBox);
    if (log.length === 0) logBox.append(h("span", { class: "dt-note", text: "Nothing yet. Subscribe to a stream method to see items here." }));
    for (const item of log) {
      const line = h("div", { class: "dt-log-line" });
      line.append(h("span", { class: "dt-log-at", text: `[${new Date(item.at).toLocaleTimeString()}] ` }), document.createTextNode(item.text));
      logBox.append(line);
    }
    logCount.textContent = `${log.length} item(s)${dropped > 0 ? ` · ${dropped} dropped` : ""}${log.length >= MAX_RPC_LOG ? " · showing the newest 500" : ""}`;
    if (nearBottom) logBox.scrollTop = logBox.scrollHeight;
  };

  const stopStream = (note: string | null): void => {
    const current = subscription;
    subscription = null;
    streaming = false;
    try {
      current?.cancel();
    } catch {
      // already gone
    }
    if (note && !disposed) show("note", note);
    syncButtons();
  };

  const startStream = (method: string, payload: Record<string, unknown>): void => {
    stopStream(null);
    log = [];
    dropped = 0;
    streamFailed = false;
    renderLog();
    const started = performance.now();
    try {
      const sub = api.rpc.subscribe(
        method,
        payload,
        (item) => {
          if (disposed) return;
          if (log.length >= MAX_RPC_LOG) dropped += 1;
          log = appendCapped(log, { at: Date.now(), text: shorten(summarizeJson(item, 2000), 4000) }, MAX_RPC_LOG);
          renderLog();
        },
        {
          onError: (error) => {
            streamFailed = true;
            if (!disposed) show("bad", `stream error: ${formatRpcError(error)}`);
          },
        },
      );
      subscription = sub;
      streaming = true;
      show("note", `Subscribed to ${method}. Waiting for items...`);
      void sub.done.then(() => {
        if (disposed || subscription !== sub) return;
        subscription = null;
        streaming = false;
        syncButtons();
        if (!streamFailed) show("note", `Stream ended after ${formatDuration(performance.now() - started)}.`);
      });
    } catch (error) {
      streaming = false;
      show("bad", formatRpcError(error));
    }
    syncButtons();
  };

  const execute = (method: string): void => {
    if (disposed) return;
    if (method.length === 0) {
      show("bad", "Enter a method name.");
      return;
    }
    const payload = parsePayload(payloadInput.value);
    if (!payload.ok) {
      show("bad", payload.error);
      return;
    }
    confirmBox.hidden = true;
    confirmedFor = null;
    if (mode.value === "subscribe") {
      startStream(method, payload.value);
      return;
    }
    const started = performance.now();
    show("note", `Calling ${method}...`);
    void api.rpc
      .call(method, payload.value)
      .then((result) => {
        if (!disposed) show("ok", `OK in ${formatDuration(performance.now() - started)}`, result);
      })
      .catch((error: unknown) => {
        if (!disposed) show("bad", `${formatRpcError(error)} (after ${formatDuration(performance.now() - started)})`);
      });
  };

  runButton.addEventListener("click", () => {
    const method = methodInput.value.trim();
    if (method.length === 0) {
      show("bad", "Enter a method name.");
      return;
    }
    if (isDangerousMethod(method) && confirmedFor !== method) {
      confirmBox.hidden = false;
      confirmText.textContent = `"${method}" can change or expose the environment. Click "Run anyway (full scope)" to send it.`;
      return;
    }
    execute(method);
  });
  confirmButton.addEventListener("click", () => {
    const method = methodInput.value.trim();
    confirmedFor = method;
    execute(method);
  });
  cancelButton.addEventListener("click", () => {
    confirmedFor = null;
    confirmBox.hidden = true;
  });
  methodInput.addEventListener("input", () => {
    confirmedFor = null;
    confirmBox.hidden = true;
  });
  mode.addEventListener("change", () => {
    confirmedFor = null;
    confirmBox.hidden = true;
    syncButtons();
  });
  stopButton.addEventListener("click", () => stopStream("Stopped."));
  clearButton.addEventListener("click", () => {
    log = [];
    dropped = 0;
    renderLog();
  });

  const renderSocket = (): void => {
    try {
      socket.textContent = `socket: ${api.rpc.state}`;
    } catch {
      socket.textContent = "socket: unavailable";
    }
  };
  renderSocket();
  try {
    cleanups.push(api.rpc.onState(() => renderSocket()));
  } catch {
    // no rpc permission: t3.rpc.call will report it
  }

  syncButtons();
  renderLog();

  return {
    dispose() {
      disposed = true;
      stopStream(null);
      for (const cleanup of cleanups.splice(0)) cleanup();
      style.remove();
      root.remove();
    },
  };
}
