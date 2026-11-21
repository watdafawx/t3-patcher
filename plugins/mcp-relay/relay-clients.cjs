"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");

const PROTOCOL_VERSION = "2025-03-26";
const DEFAULT_TIMEOUT_MS = 30_000;

// Windows needs a shell to resolve `npx`, `.cmd` and `.bat` shims.
function needsShell(command) {
  if (process.platform !== "win32") return false;
  const base = path.basename(String(command || "")).toLowerCase();
  return !(base.endsWith(".exe") || base.endsWith(".com"));
}

/**
 * Lightweight MCP JSON-RPC 2.0 client over stdio (newline-delimited JSON).
 */
class StdioMcpClient {
  /**
   * @param {{
   *   command: string;
   *   args?: string[];
   *   env?: Record<string, string>;
   *   cwd?: string;
   *   timeoutMs?: number;
   *   shell?: boolean;
   *   onExit?: (err?: Error) => void;
   * }} opts
   */
  constructor(opts) {
    this.opts = opts;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.stderrTail = "";
    this.proc = null;
    this.closed = false;
  }

  async connect() {
    if (this.proc) return;
    this.closed = false;
    const env = { ...process.env, ...(this.opts.env ?? {}) };
    const proc = spawn(this.opts.command, this.opts.args ?? [], {
      cwd: this.opts.cwd || undefined,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: this.opts.shell ?? needsShell(this.opts.command),
    });
    this.proc = proc;

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => this._onStdout(chunk));

    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });

    proc.once("error", (err) => {
      this._failAll(err);
      this.proc = null;
      if (this.opts.onExit) this.opts.onExit(err);
    });

    proc.once("exit", (code, signal) => {
      const err = new Error(
        `MCP stdio process exited (code=${code}, signal=${signal})${this.stderrTail ? `: ${this.stderrTail.trim().slice(-300)}` : ""}`,
      );
      this._failAll(err);
      this.proc = null;
      if (!this.closed && this.opts.onExit) this.opts.onExit(err);
    });

    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "t3p-mcp-relay", version: "0.2.0" },
    });
    this.notify("notifications/initialized", {});
  }

  _onStdout(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg && msg.id !== undefined && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) {
          entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          entry.resolve(msg.result);
        }
      }
    }
  }

  _failAll(err) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  notify(method, params) {
    if (!this.proc || !this.proc.stdin.writable) return;
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    this.proc.stdin.write(payload);
  }

  request(method, params) {
    if (!this.proc || !this.proc.stdin.writable) {
      return Promise.reject(new Error("MCP stdio process is not running"));
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP stdio request "${method}" timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  async listTools() {
    const res = await this.request("tools/list", {});
    return Array.isArray(res && res.tools) ? res.tools : [];
  }

  async callTool(name, args) {
    return this.request("tools/call", { name, arguments: args ?? {} });
  }

  close() {
    this.closed = true;
    this._failAll(new Error("MCP stdio client closed"));
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        // ignore
      }
      this.proc = null;
    }
  }
}

/**
 * Lightweight MCP JSON-RPC 2.0 client over Streamable HTTP.
 */
class HttpMcpClient {
  /**
   * @param {{
   *   url: string;
   *   headers?: Record<string, string>;
   *   timeoutMs?: number;
   * }} opts
   */
  constructor(opts) {
    this.opts = opts;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.nextId = 1;
    this.sessionId = null;
    this.connected = false;
  }

  async connect() {
    if (this.connected) return;
    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "t3p-mcp-relay", version: "0.2.0" },
    });
    await this._post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, true);
    this.connected = true;
  }

  async _post(body, isNotification = false) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.opts.headers ?? {}),
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.opts.url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const sid = res.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;
      if (isNotification) return null;
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      if (ct.includes("text/event-stream")) {
        const text = await res.text();
        return parseSseJsonRpc(text, body.id);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async request(method, params) {
    const id = this.nextId++;
    const msg = await this._post({ jsonrpc: "2.0", id, method, params });
    if (!msg) throw new Error(`Empty response for "${method}"`);
    if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
    return msg.result;
  }

  async listTools() {
    const res = await this.request("tools/list", {});
    return Array.isArray(res && res.tools) ? res.tools : [];
  }

  async callTool(name, args) {
    return this.request("tools/call", { name, arguments: args ?? {} });
  }

  close() {
    this.connected = false;
    this.sessionId = null;
  }
}

/**
 * Extracts the JSON-RPC response matching `id` from an SSE stream body.
 * @param {string} text
 * @param {number|string} id
 */
function parseSseJsonRpc(text, id) {
  let lastMsg = null;
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.startsWith("data:")) continue;
    const data = rawLine.slice(5).trim();
    if (!data) continue;
    try {
      const parsed = JSON.parse(data);
      lastMsg = parsed;
      if (parsed && parsed.id === id) return parsed;
    } catch {
      // ignore non-JSON data lines
    }
  }
  return lastMsg;
}

module.exports = {
  StdioMcpClient,
  HttpMcpClient,
  parseSseJsonRpc,
  PROTOCOL_VERSION,
};
