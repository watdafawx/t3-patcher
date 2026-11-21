"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { StdioMcpClient, HttpMcpClient } = require("./relay-clients.cjs");
const { resolveSourceEntry, normalizeSourceRef } = require("./discovery.cjs");

const DEFAULT_PORT = 39393;
const DEFAULT_HOST = "127.0.0.1";
const MAX_CALL_LOG = 100;
const SESSION_IDLE_TTL_MS = 15 * 60 * 1000;

function defaultConfigPath() {
  return path.join(os.homedir(), ".t3-patcher", "mcp-relay", "config.json");
}

/**
 * Harness ids a server is exposed to. Empty = every harness.
 * @param {any} raw
 */
function normalizeHarnesses(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const value of raw) {
    const id = String(value || "").trim().toLowerCase();
    if (!id || id.length > 32 || !/^[a-z0-9-]+$/.test(id)) continue;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function isExposedTo(cfg, harness) {
  if (!cfg || !cfg.enabled) return false;
  if (!cfg.harnesses || cfg.harnesses.length === 0) return true;
  if (!harness) return true;
  return cfg.harnesses.includes(harness) || cfg.harnesses.includes("all");
}

/**
 * Validates and normalizes a single server config.
 * @param {any} raw
 */
function normalizeServerConfig(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Server config must be an object");
  const id = String(raw.id || "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,47}$/i.test(id)) {
    throw new Error(`Invalid server id "${id}" (use letters, digits, - or _)`);
  }
  const transport = raw.transport === "http" ? "http" : "stdio";
  const mode = raw.mode === "session" ? "session" : "shared";
  const enabled = raw.enabled !== false;
  const pinnedTools = Array.isArray(raw.pinnedTools)
    ? raw.pinnedTools.map((t) => String(t).trim()).filter(Boolean)
    : [];
  const harnesses = normalizeHarnesses(raw.harnesses);
  const source = raw.source ? normalizeSourceRef(raw.source) : null;

  // Imported servers keep a reference to their harness config: env/headers are
  // never stored here, they are resolved in memory at spawn time.
  if (source) {
    const snapshot = transport === "http"
      ? { url: String(raw.url || "").trim() }
      : {
          command: String(raw.command || "").trim(),
          args: Array.isArray(raw.args) ? raw.args.map(String) : [],
          ...(typeof raw.cwd === "string" && raw.cwd.trim() ? { cwd: raw.cwd.trim() } : {}),
        };
    return { id, name: raw.name ? String(raw.name) : id, transport, enabled, mode, pinnedTools, harnesses, source, ...snapshot };
  }

  if (transport === "stdio") {
    const command = String(raw.command || "").trim();
    if (!command) throw new Error(`Server "${id}": stdio transport requires "command"`);
    const args = Array.isArray(raw.args) ? raw.args.map(String) : [];
    const env = raw.env && typeof raw.env === "object" ? Object.fromEntries(Object.entries(raw.env).map(([k, v]) => [String(k), String(v)])) : undefined;
    const cwd = typeof raw.cwd === "string" && raw.cwd.trim() ? raw.cwd.trim() : undefined;
    return { id, name: raw.name ? String(raw.name) : id, transport, command, args, env, cwd, enabled, mode, pinnedTools, harnesses };
  }

  const url = String(raw.url || "").trim();
  if (!/^https?:\/\//i.test(url)) throw new Error(`Server "${id}": http transport requires http(s) "url"`);
  const headers = raw.headers && typeof raw.headers === "object"
    ? Object.fromEntries(Object.entries(raw.headers).map(([k, v]) => [String(k), String(v)]))
    : undefined;
  return { id, name: raw.name ? String(raw.name) : id, transport, url, headers, enabled, mode, pinnedTools, harnesses };
}

/**
 * Multi-agent MCP relay pool:
 * - Holds configured MCP servers (persisted to JSON).
 * - Supports live add/update/remove/toggle/restart without restarting agent sessions.
 * - Shared pool for stateless MCPs, session-isolated instances for stateful MCPs.
 * - Hybrid mode: exposes fixed meta-tools + optional per-server pinned tools.
 */
class McpRelayPool {
  /**
   * @param {{
   *   configPath?: string;
   *   persist?: boolean;
   *   log?: { info: (m: string) => void; warn: (m: string) => void };
   *   clientFactory?: (cfg: any, onExit: (err?: Error) => void) => any;
   *   sourceResolver?: (source: any) => any;
   * }} [opts]
   */
  constructor(opts = {}) {
    this.configPath = opts.configPath || defaultConfigPath();
    this.persist = opts.persist !== false;
    this.log = opts.log || { info: () => {}, warn: () => {} };
    this.clientFactory = opts.clientFactory || null;
    this.sourceResolver = opts.sourceResolver || ((source) => resolveSourceEntry(source));

    this.port = DEFAULT_PORT;
    this.host = DEFAULT_HOST;
    /** @type {Map<string, any>} */
    this.configs = new Map();
    /** @type {Map<string, { client: any, connecting: Promise<void> | null, tools: any[] | null, lastUsed: number, error: string | null }>} */
    this.instances = new Map();
    /** @type {Array<any>} */
    this.callLog = [];

    if (this.persist) this._loadConfig();

    this._reapTimer = setInterval(() => this._reapIdleSessions(), 60_000);
    if (this._reapTimer.unref) this._reapTimer.unref();
  }

  _loadConfig() {
    try {
      if (!fs.existsSync(this.configPath)) return;
      const raw = JSON.parse(fs.readFileSync(this.configPath, "utf8"));
      if (typeof raw.port === "number" && raw.port > 0 && raw.port < 65536) this.port = raw.port;
      if (typeof raw.host === "string" && raw.host.trim()) this.host = raw.host.trim();
      if (Array.isArray(raw.servers)) {
        for (const s of raw.servers) {
          try {
            const cfg = normalizeServerConfig(s);
            this.configs.set(cfg.id, cfg);
          } catch (err) {
            this.log.warn(`Skipping invalid server config: ${err.message}`);
          }
        }
      }
    } catch (err) {
      this.log.warn(`Failed to load MCP relay config: ${err.message}`);
    }
  }

  _saveConfig() {
    if (!this.persist) return;
    try {
      fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
      const data = {
        port: this.port,
        host: this.host,
        servers: Array.from(this.configs.values()),
      };
      fs.writeFileSync(this.configPath, JSON.stringify(data, null, 2) + "\n", "utf8");
    } catch (err) {
      this.log.warn(`Failed to save MCP relay config: ${err.message}`);
    }
  }

  _instanceKey(serverId, sessionKey) {
    const cfg = this.configs.get(serverId);
    if (!cfg || cfg.mode !== "session") return serverId;
    return `${serverId}::${sessionKey || "default"}`;
  }

  _createClient(cfg, key) {
    const effective = cfg.source ? this._resolveFromSource(cfg) : cfg;
    const onExit = (err) => {
      const inst = this.instances.get(key);
      if (inst) {
        inst.client = null;
        inst.connecting = null;
        inst.error = err ? err.message : "Process exited";
      }
    };
    if (this.clientFactory) return this.clientFactory(effective, onExit);
    if (effective.transport === "http") {
      return new HttpMcpClient({ url: effective.url, headers: effective.headers });
    }
    return new StdioMcpClient({
      command: effective.command,
      args: effective.args,
      env: effective.env,
      cwd: effective.cwd,
      onExit,
    });
  }

  /**
   * Re-reads the harness config a server was imported from, so tokens stay in
   * that config and are only expanded in memory at spawn time.
   * Falls back to the stored non-secret snapshot if the source entry vanished.
   */
  _resolveFromSource(cfg) {
    try {
      const fresh = this.sourceResolver(cfg.source);
      return { ...cfg, ...fresh };
    } catch (err) {
      this.log.warn(
        `MCP server "${cfg.id}": could not refresh from ${cfg.source.harness} config (${err instanceof Error ? err.message : String(err)}); using stored copy`,
      );
      return cfg;
    }
  }

  async _ensureConnected(serverId, sessionKey, harness) {
    const cfg = this.configs.get(serverId);
    if (!cfg) throw new Error(`Unknown MCP server "${serverId}"`);
    if (!cfg.enabled) throw new Error(`MCP server "${serverId}" is disabled`);
    if (harness && !isExposedTo(cfg, harness)) {
      throw new Error(`MCP server "${serverId}" is not exposed to ${harness}`);
    }

    const key = this._instanceKey(serverId, sessionKey);
    let inst = this.instances.get(key);
    if (!inst) {
      inst = { client: null, connecting: null, tools: null, lastUsed: Date.now(), error: null };
      this.instances.set(key, inst);
    }
    inst.lastUsed = Date.now();

    if (inst.client && !inst.connecting) return inst;
    if (inst.connecting) {
      await inst.connecting;
      return inst;
    }

    const client = this._createClient(cfg, key);
    inst.client = client;
    inst.error = null;
    inst.connecting = (async () => {
      try {
        await client.connect();
        inst.tools = await client.listTools();
      } catch (err) {
        inst.error = err instanceof Error ? err.message : String(err);
        try { client.close(); } catch { /* ignore */ }
        inst.client = null;
        throw err;
      } finally {
        inst.connecting = null;
      }
    })();

    await inst.connecting;
    return inst;
  }

  _closeInstancesFor(serverId) {
    for (const [key, inst] of this.instances.entries()) {
      if (key === serverId || key.startsWith(`${serverId}::`)) {
        if (inst.client) {
          try { inst.client.close(); } catch { /* ignore */ }
        }
        this.instances.delete(key);
      }
    }
  }

  _reapIdleSessions() {
    const now = Date.now();
    for (const [key, inst] of this.instances.entries()) {
      if (!key.includes("::")) continue;
      if (now - inst.lastUsed > SESSION_IDLE_TTL_MS) {
        if (inst.client) {
          try { inst.client.close(); } catch { /* ignore */ }
        }
        this.instances.delete(key);
      }
    }
  }

  addOrUpdateServer(raw) {
    const cfg = normalizeServerConfig(raw);
    this._closeInstancesFor(cfg.id);
    this.configs.set(cfg.id, cfg);
    this._saveConfig();
    return cfg;
  }

  removeServer(serverId) {
    this._closeInstancesFor(serverId);
    const existed = this.configs.delete(serverId);
    if (existed) this._saveConfig();
    return existed;
  }

  setEnabled(serverId, enabled) {
    const cfg = this.configs.get(serverId);
    if (!cfg) throw new Error(`Unknown MCP server "${serverId}"`);
    cfg.enabled = Boolean(enabled);
    if (!cfg.enabled) this._closeInstancesFor(serverId);
    this._saveConfig();
    return cfg;
  }

  async restartServer(serverId, sessionKey, harness) {
    const cfg = this.configs.get(serverId);
    if (!cfg) throw new Error(`Unknown MCP server "${serverId}"`);
    this._closeInstancesFor(serverId);
    if (!cfg.enabled) return { id: serverId, status: "disabled", toolCount: 0 };
    const inst = await this._ensureConnected(serverId, sessionKey, harness);
    return { id: serverId, status: "connected", toolCount: inst.tools ? inst.tools.length : 0 };
  }

  setPort(port) {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1024 || p > 65535) {
      throw new Error("Port must be an integer between 1024 and 65535");
    }
    this.port = p;
    this._saveConfig();
    return this.port;
  }

  listServers(harness) {
    const result = [];
    for (const cfg of this.configs.values()) {
      if (harness && !isExposedTo(cfg, harness)) continue;
      let activeSessions = 0;
      let status = cfg.enabled ? "idle" : "disabled";
      let toolCount = 0;
      let lastError = null;

      for (const [key, inst] of this.instances.entries()) {
        if (key !== cfg.id && !key.startsWith(`${cfg.id}::`)) continue;
        if (inst.client) {
          activeSessions++;
          status = "connected";
        } else if (inst.error) {
          lastError = inst.error;
          if (status === "idle") status = "error";
        }
        if (inst.tools && inst.tools.length > toolCount) {
          toolCount = inst.tools.length;
        }
      }

      result.push({
        ...cfg,
        status,
        toolCount,
        activeSessions,
        lastError,
      });
    }
    return result;
  }

  /**
   * Lists tools across one or all enabled servers.
   * @param {{ server?: string; query?: string; sessionKey?: string; harness?: string }} [opts]
   */
  async listTools(opts = {}) {
    const targetIds = opts.server
      ? [opts.server]
      : Array.from(this.configs.values())
          .filter((c) => c.enabled && (!opts.harness || isExposedTo(c, opts.harness)))
          .map((c) => c.id);

    const query = opts.query ? String(opts.query).toLowerCase() : "";
    const tools = [];
    const errors = [];

    for (const serverId of targetIds) {
      try {
        const inst = await this._ensureConnected(serverId, opts.sessionKey, opts.harness);
        for (const t of inst.tools || []) {
          if (query) {
            const hay = `${serverId} ${t.name} ${t.description || ""}`.toLowerCase();
            if (!hay.includes(query)) continue;
          }
          tools.push({
            server: serverId,
            name: t.name,
            description: t.description || "",
            inputSchema: t.inputSchema || { type: "object", properties: {} },
          });
        }
      } catch (err) {
        errors.push({ server: serverId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return { tools, errors };
  }

  /**
   * Returns pinned tools (already cached on connected servers) for hybrid mode.
   */
  getPinnedTools(harness) {
    const pinned = [];
    for (const cfg of this.configs.values()) {
      if (!cfg.enabled || !cfg.pinnedTools || cfg.pinnedTools.length === 0) continue;
      if (harness && !isExposedTo(cfg, harness)) continue;
      const inst = this.instances.get(cfg.id);
      const known = inst && inst.tools ? inst.tools : [];
      for (const toolName of cfg.pinnedTools) {
        const match = known.find((t) => t.name === toolName);
        pinned.push({
          name: `${cfg.id}__${toolName}`,
          description: `[${cfg.id}] ${match && match.description ? match.description : `Pinned tool ${toolName} on ${cfg.id}`}`,
          inputSchema: (match && match.inputSchema) || { type: "object", additionalProperties: true },
          _relayTarget: { server: cfg.id, tool: toolName },
        });
      }
    }
    return pinned;
  }

  /**
   * Calls a tool on a child MCP server and logs the call.
   */
  async callTool(serverId, toolName, args, sessionKey, harness) {
    const started = Date.now();
    try {
      const inst = await this._ensureConnected(serverId, sessionKey, harness);
      const res = await inst.client.callTool(toolName, args ?? {});
      this._recordCall({
        id: randomUUID(),
        timestamp: started,
        sessionId: sessionKey || null,
        serverId,
        tool: toolName,
        ok: true,
        durationMs: Date.now() - started,
      });
      return res;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._recordCall({
        id: randomUUID(),
        timestamp: started,
        sessionId: sessionKey || null,
        serverId,
        tool: toolName,
        ok: false,
        durationMs: Date.now() - started,
        error: message,
      });
      throw err;
    }
  }

  _recordCall(entry) {
    this.callLog.unshift(entry);
    if (this.callLog.length > MAX_CALL_LOG) this.callLog.length = MAX_CALL_LOG;
  }

  getRecentCalls(limit = 25) {
    return this.callLog.slice(0, limit);
  }

  stopAll() {
    clearInterval(this._reapTimer);
    for (const inst of this.instances.values()) {
      if (inst.client) {
        try { inst.client.close(); } catch { /* ignore */ }
      }
    }
    this.instances.clear();
  }
}

module.exports = {
  McpRelayPool,
  normalizeServerConfig,
  normalizeHarnesses,
  isExposedTo,
  DEFAULT_PORT,
  DEFAULT_HOST,
};
