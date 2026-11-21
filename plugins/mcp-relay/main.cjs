"use strict";
// Main-process entry of the MCP Relay plugin.
// Starts the local Streamable HTTP MCP server and exposes IPC controls to the renderer UI.

const { McpRelayPool } = require("./relay-pool.cjs");
const { McpRelayHttpServer } = require("./relay-http.cjs");
const { discoverHarnessServers, candidateToServerConfig, defaultSources, HARNESS_LABELS } = require("./discovery.cjs");
const { linkStatuses, applyToAll, defaultTargets } = require("./autoconnect.cjs");

function normalizePaths(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((p) => String(p || "").trim())
    .filter(Boolean)
    .slice(0, 20);
}

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

  const alreadyImported = (candidate) => {
    const existing = pool.listServers();
    for (const server of existing) {
      if (!server.source) continue;
      if (
        server.source.harness === candidate.origins[0].harness &&
        server.source.path === candidate.origins[0].path &&
        server.source.name === candidate.origins[0].name
      ) {
        return server.id;
      }
    }
    const bySource = existing.find((server) =>
      candidate.origins.some(
        (origin) => server.source && server.source.path === origin.path && server.source.name === origin.name,
      ),
    );
    return bySource ? bySource.id : null;
  };

  const scan = (payload) => {
    const extraPaths = normalizePaths(payload && typeof payload === "object" ? payload.paths : undefined);
    const sources = defaultSources({ cwd: process.cwd() });
    for (const projectPath of extraPaths) {
      sources.push(...defaultSources({ cwd: projectPath }));
    }
    const result = discoverHarnessServers({ sources, cwd: process.cwd() });

    return {
      scannedAt: Date.now(),
      harnessLabels: HARNESS_LABELS,
      candidates: result.candidates.map((candidate) => {
        const importedId = alreadyImported(candidate);
        return { ...candidate, importedId };
      }),
      warnings: result.warnings,
    };
  };

  ctx.ipc.handle("status", () => statusPayload());

  ctx.ipc.handle("scanHarnesses", (payload) => scan(payload));

  ctx.ipc.handle("harnessLinks", () => linkStatuses({ url: httpServer.url }));

  ctx.ipc.handle("setHarnessLinks", (payload) => {
    const action = payload && typeof payload === "object" && payload.action === "disconnect" ? "disconnect" : "connect";
    const ids = payload && typeof payload === "object" && Array.isArray(payload.ids)
      ? payload.ids.map((id) => String(id))
      : null;
    const targets = defaultTargets().filter((target) => (ids ? ids.includes(target.id) : true));
    const results = applyToAll({ targets, url: httpServer.url, action });
    for (const result of results) {
      if (result.error) ctx.log.warn(`Harness "${result.id}" ${action} failed: ${result.error}`);
      else if (result.changed) ctx.log.info(`MCP Relay ${action}ed in ${result.id} config`);
    }
    return { action, results, links: linkStatuses({ url: httpServer.url }) };
  });

  const syncConnectedHarnesses = () => {
    const { targets } = linkStatuses({ url: httpServer.url });
    const connected = new Set(targets.filter((target) => target.connected).map((target) => target.id));
    if (connected.size === 0) return;
    applyToAll({
      targets: defaultTargets().filter((target) => connected.has(target.id)),
      url: httpServer.url,
      action: "connect",
    });
  };

  ctx.ipc.handle("importServers", (payload) => {
    const selections = Array.isArray(payload && typeof payload === "object" ? payload.selections : undefined)
      ? payload.selections
      : [];
    if (selections.length === 0) return statusPayload();

    const scanned = scan(payload);
    const byKey = new Map(scanned.candidates.map((candidate) => [candidate.key, candidate]));

    for (const selection of selections) {
      if (!selection || typeof selection !== "object") continue;
      const candidate = byKey.get(String(selection.key || ""));
      if (!candidate) {
        ctx.log.warn(`Import skipped: unknown discovery key "${selection.key}"`);
        continue;
      }
      try {
        const cfg = candidateToServerConfig(candidate, {
          id: selection.id ? String(selection.id) : candidate.suggestedId,
          sourceIndex: Number.isInteger(selection.sourceIndex) ? selection.sourceIndex : 0,
          harnesses: Array.isArray(selection.harnesses) ? selection.harnesses : [],
          mode: selection.mode === "session" ? "session" : "shared",
          pinnedTools: Array.isArray(selection.pinnedTools) ? selection.pinnedTools : [],
        });
        pool.addOrUpdateServer(cfg);
        ctx.log.info(`Imported MCP server "${cfg.id}" from ${cfg.source.harness} config (values resolved at spawn)`);
      } catch (err) {
        ctx.log.warn(`Import of "${selection.key}" failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return statusPayload();
  });

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
    syncConnectedHarnesses();
    return statusPayload();
  });

  ctx.ipc.handle("getSnippets", () => {
    const url = httpServer.url;
    const withHarness = (harness) => ({ "x-t3p-harness": harness });
    return {
      url,
      claude: JSON.stringify(
        { mcpServers: { "t3-relay": { type: "http", url, headers: withHarness("claude") } } },
        null,
        2,
      ),
      claudeDesktop: JSON.stringify(
        { mcpServers: { "t3-relay": { type: "http", url, headers: withHarness("claude-desktop") } } },
        null,
        2,
      ),
      codex: `[mcp_servers.t3-relay]\nurl = "${url}"\nhttp_headers = { "x-t3p-harness" = "codex" }`,
      opencode: JSON.stringify(
        { mcp: { "t3-relay": { type: "remote", url, headers: withHarness("opencode") } } },
        null,
        2,
      ),
    };
  });

  process.once("exit", () => {
    pool.stopAll();
    void httpServer.stop();
  });
}

module.exports = { activate };
