#!/usr/bin/env node
"use strict";
// Standalone daemon runner for the T3 MCP Relay.
// Shares the same ~/.t3-patcher/mcp-relay/config.json as the T3 Patcher plugin.

const { McpRelayPool } = require("./relay-pool.cjs");
const { McpRelayHttpServer } = require("./relay-http.cjs");

async function main() {
  const portArg = process.argv.find((a) => a.startsWith("--port="));
  const pool = new McpRelayPool({
    log: {
      info: (m) => console.log(`[mcp-relay] ${m}`),
      warn: (m) => console.warn(`[mcp-relay] ${m}`),
    },
  });
  if (portArg) pool.setPort(Number(portArg.slice("--port=".length)));

  const server = new McpRelayHttpServer(pool);
  const url = await server.start(pool.port, pool.host);
  console.log(`[mcp-relay] listening at ${url} (${pool.listServers().length} servers configured)`);

  const shutdown = async () => {
    pool.stopAll();
    await server.stop();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[mcp-relay] fatal:", err);
  process.exit(1);
});
