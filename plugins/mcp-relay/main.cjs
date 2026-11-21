"use strict";
// Main-process entry of the MCP Relay plugin.
// Starts the local Streamable HTTP MCP server and exposes IPC controls to the renderer UI.

const { McpRelayPool } = require("./relay-pool.cjs");
const { McpRelayHttpServer } = require("./relay-http.cjs");

/** @param {{ log: any, ipc: any }} ctx */
function activate(ctx) {
  const pool = new McpRelayPool({
    log: {
      info: (m) => ctx.log.info(m),
      warn: (m) => ctx.log.warn(m),
    },
  });
  const httpServer = new McpRelayHttpServer(pool);
  let startError = null;

  const startServer = async () => {
    startError = null;
    try {
      const url = await httpServer.start(pool.port, pool.host);
      ctx.log.info(`MCP Relay listening at ${url}`);
    } catch (err) {
      startError = err instanceof Error ? err.message : String(err);
      ctx.log.warn(`MCP Relay failed to start on port ${pool.port}: ${startError}`);
    }
  };

  void startServer();

  const statusPayload = () => ({
    running: httpServer.server !== null,
    url: httpServer.url,
    port: pool.port,
    host: pool.host,
    error: startError,
    servers: pool.listServers(),
    recentCalls: pool.getRecentCalls(25),
  });

  ctx.ipc.handle("status", () => statusPayload());

  ctx.ipc.handle("addServer", (payload) => {
    pool.addOrUpdateServer(payload);
    return statusPayload();
  });

  ctx.ipc.handle("removeServer", (payload) => {
    const id = payload && typeof payload === "object" ? String(payload.id || "") : "";
    pool.removeServer(id);
    return statusPayload();
  });

  ctx.ipc.handle("toggleServer", (payload) => {
    const id = payload && typeof payload === "object" ? String(payload.id || "") : "";
    const enabled = Boolean(payload && typeof payload === "object" ? payload.enabled : false);
    pool.setEnabled(id, enabled);
    return statusPayload();
  });

  ctx.ipc.handle("restartServer", async (payload) => {
    const id = payload && typeof payload === "object" ? String(payload.id || "") : "";
    try {
      await pool.restartServer(id);
    } catch (err) {
      ctx.log.warn(`Restart "${id}" failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return statusPayload();
  });

  ctx.ipc.handle("setPort", async (payload) => {
    const port = payload && typeof payload === "object" ? Number(payload.port) : NaN;
    pool.setPort(port);
    await startServer();
    return statusPayload();
  });

  ctx.ipc.handle("getSnippets", () => {
    const url = httpServer.url;
    return {
      url,
      claude: JSON.stringify({ mcpServers: { "t3-relay": { type: "http", url } } }, null, 2),
      codex: `[mcp_servers.t3-relay]\nurl = "${url}"`,
      opencode: JSON.stringify({ mcp: { "t3-relay": { type: "remote", url } } }, null, 2),
    };
  });

  process.once("exit", () => {
    pool.stopAll();
    void httpServer.stop();
  });
}

module.exports = { activate };
