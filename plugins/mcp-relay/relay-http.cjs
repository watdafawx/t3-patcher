"use strict";

const http = require("node:http");
const { randomUUID } = require("node:crypto");
const { PROTOCOL_VERSION } = require("./relay-clients.cjs");

const META_TOOLS = [
  {
    name: "relay_list_servers",
    description:
      "List all MCP servers currently registered in the T3 MCP Relay, including whether each is enabled, connected, idle, or errored, and whether it is shared or session-isolated.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "relay_list_tools",
    description:
      "List available tools and their JSON schemas from one MCP server (recommended) or all enabled servers. Use `query` to filter by name/description.",
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "string", description: "Server id from relay_list_servers. Omit to query all enabled servers." },
        query: { type: "string", description: "Optional case-insensitive substring filter." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "relay_call",
    description:
      "Invoke a tool on any active MCP server through the relay. Works for MCPs added or enabled mid-session.",
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "string", description: "Server id from relay_list_servers." },
        tool: { type: "string", description: "Tool name from relay_list_tools." },
        arguments: { type: "object", description: "JSON arguments for the tool.", additionalProperties: true },
        sessionKey: { type: "string", description: "Optional explicit session key for session-mode MCPs (defaults to the caller's MCP session id)." },
      },
      required: ["server", "tool"],
      additionalProperties: false,
    },
  },
  {
    name: "relay_reload_server",
    description: "Restart and reconnect a child MCP server if it crashed or its tools changed.",
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "string", description: "Server id to restart." },
      },
      required: ["server"],
      additionalProperties: false,
    },
  },
];

function jsonTextResult(value, isError = false) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

const HARNESS_HEADER = "x-t3p-harness";

/**
 * Picks a harness id from the MCP client name reported at initialize.
 * @param {string | undefined} clientName
 */
function detectHarness(clientName) {
  const name = String(clientName || "").toLowerCase();
  if (!name) return null;
  if (name.includes("claude")) return "claude";
  if (name.includes("codex")) return "codex";
  if (name.includes("opencode")) return "opencode";
  if (name.includes("cursor")) return "cursor";
  if (name.includes("vscode") || name.includes("visual studio code")) return "vscode";
  return null;
}

/**
 * Streamable HTTP MCP server exposing the McpRelayPool on localhost.
 */
class McpRelayHttpServer {
  /**
   * @param {import("./relay-pool.cjs").McpRelayPool} pool
   */
  constructor(pool) {
    this.pool = pool;
    this.server = null;
    this.sessions = new Map();
    this.listeningPort = null;
  }

  get url() {
    const port = this.listeningPort ?? this.pool.port;
    return `http://${this.pool.host}:${port}/mcp`;
  }

  async start(port = this.pool.port, host = this.pool.host) {
    if (this.server) await this.stop();

    const server = http.createServer((req, res) => {
      this._handleRequest(req, res).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      });
    });

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });

    this.server = server;
    const addr = server.address();
    this.listeningPort = typeof addr === "object" && addr ? addr.port : port;
    return this.url;
  }

  async stop() {
    if (!this.server) return;
    const s = this.server;
    this.server = null;
    this.listeningPort = null;
    await new Promise((resolve) => s.close(() => resolve()));
  }

  async _handleRequest(req, res) {
    const urlPath = (req.url || "/").split("?")[0];

    if (req.method === "GET" && urlPath === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, url: this.url, servers: this.pool.listServers().length }));
      return;
    }

    if (urlPath !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Not found. Use POST /mcp" }));
      return;
    }

    if (req.method === "DELETE") {
      const sid = req.headers["mcp-session-id"];
      if (typeof sid === "string") this.sessions.delete(sid);
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    const rawBody = await readBody(req);
    let msg;
    try {
      msg = JSON.parse(rawBody);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
      return;
    }

    let sessionId = typeof req.headers["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : null;
    const headerHarness = typeof req.headers[HARNESS_HEADER] === "string" ? String(req.headers[HARNESS_HEADER]).trim().toLowerCase() : "";
    if (msg.method === "initialize" && !sessionId) {
      sessionId = randomUUID();
      const clientName = msg.params && msg.params.clientInfo ? msg.params.clientInfo.name : undefined;
      this.sessions.set(sessionId, {
        clientName: clientName ? String(clientName) : null,
        harness: detectHarness(clientName) || (headerHarness || null),
      });
    } else if (sessionId && headerHarness) {
      const meta = this.sessions.get(sessionId) || {};
      this.sessions.set(sessionId, { ...meta, harness: headerHarness });
    }

    // Notifications have no id -> 202 Accepted
    if (msg.id === undefined || msg.id === null) {
      res.writeHead(202, sessionId ? { "mcp-session-id": sessionId } : {});
      res.end();
      return;
    }

    const response = await this._dispatchRpc(msg, sessionId);
    const headers = { "content-type": "application/json" };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    res.writeHead(200, headers);
    res.end(JSON.stringify(response));
  }

  _harnessFor(sessionId) {
    if (!sessionId) return "unknown";
    const meta = this.sessions.get(sessionId);
    return (meta && meta.harness) || "unknown";
  }

  async _dispatchRpc(msg, sessionId) {
    const { id, method, params } = msg;
    const harness = this._harnessFor(sessionId);
    try {
      if (method === "initialize") {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "t3p-mcp-relay", version: "0.2.0" },
          },
        };
      }

      if (method === "ping") {
        return { jsonrpc: "2.0", id, result: {} };
      }

      if (method === "tools/list") {
        const pinned = this.pool.getPinnedTools(harness).map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        }));
        return {
          jsonrpc: "2.0",
          id,
          result: { tools: [...META_TOOLS, ...pinned] },
        };
      }

      if (method === "tools/call") {
        const result = await this._handleToolCall(params || {}, sessionId, harness);
        return { jsonrpc: "2.0", id, result };
      }

      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  async _handleToolCall(params, sessionId, harness) {
    const name = String(params.name || "");
    const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};

    if (name === "relay_list_servers") {
      return jsonTextResult(this.pool.listServers(harness));
    }

    if (name === "relay_list_tools") {
      const res = await this.pool.listTools({
        server: typeof args.server === "string" && args.server.trim() ? args.server.trim() : undefined,
        query: typeof args.query === "string" ? args.query : undefined,
        sessionKey: sessionId || undefined,
        harness,
      });
      return jsonTextResult(res);
    }

    if (name === "relay_call") {
      const server = String(args.server || "").trim();
      const tool = String(args.tool || "").trim();
      if (!server || !tool) {
        return jsonTextResult("relay_call requires both `server` and `tool`", true);
      }
      const sessionKey = typeof args.sessionKey === "string" && args.sessionKey.trim()
        ? args.sessionKey.trim()
        : sessionId || undefined;
      try {
        return await this.pool.callTool(server, tool, args.arguments || {}, sessionKey, harness);
      } catch (err) {
        return jsonTextResult(err instanceof Error ? err.message : String(err), true);
      }
    }

    if (name === "relay_reload_server") {
      const server = String(args.server || "").trim();
      if (!server) return jsonTextResult("relay_reload_server requires `server`", true);
      try {
        const res = await this.pool.restartServer(server, sessionId || undefined, harness);
        return jsonTextResult(res);
      } catch (err) {
        return jsonTextResult(err instanceof Error ? err.message : String(err), true);
      }
    }

    // Check pinned tools (<serverId>__<toolName>)
    const pinned = this.pool.getPinnedTools(harness).find((t) => t.name === name);
    if (pinned) {
      try {
        return await this.pool.callTool(
          pinned._relayTarget.server,
          pinned._relayTarget.tool,
          args,
          sessionId || undefined,
          harness,
        );
      } catch (err) {
        return jsonTextResult(err instanceof Error ? err.message : String(err), true);
      }
    }

    return jsonTextResult(`Unknown tool "${name}". Call relay_list_servers / relay_list_tools first.`, true);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

module.exports = {
  McpRelayHttpServer,
  META_TOOLS,
  HARNESS_HEADER,
  detectHarness,
};
