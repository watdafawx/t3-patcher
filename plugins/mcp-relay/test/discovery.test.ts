import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

type TomlLeaf = string | number | boolean;
type TomlNode = { [key: string]: TomlLeaf | TomlLeaf[] | TomlNode };

interface Origin {
  harness: string;
  scope: string;
  path: string;
  name: string;
  label: string;
}

interface Candidate {
  key: string;
  name: string;
  suggestedId: string;
  transport: string;
  envKeys: string[];
  headerKeys: string[];
  origins: Origin[];
  warnings: string[];
}

interface ScanOut {
  candidates: Candidate[];
  warnings: Array<{ harness: string; path: string; message: string }>;
}

interface PoolServer {
  id: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  source?: { name: string };
}

const {
  discoverHarnessServers,
  candidateToServerConfig,
  resolveSourceEntry,
  parseToml,
  expandString,
  sanitizeId,
} = require("../discovery.cjs") as {
  discoverHarnessServers(opts: Record<string, unknown>): ScanOut;
  candidateToServerConfig(candidate: Candidate, opts?: Record<string, unknown>): Record<string, unknown>;
  resolveSourceEntry(source: unknown): { env?: Record<string, string>; headers?: Record<string, string> };
  parseToml(text: string): TomlNode;
  expandString(value: string, env: Record<string, string>): string;
  sanitizeId(name: string, taken: Set<string>): string;
};

const { McpRelayPool, normalizeServerConfig } = require("../relay-pool.cjs") as {
  McpRelayPool: new (opts?: Record<string, unknown>) => {
    addOrUpdateServer(cfg: Record<string, unknown>): Record<string, unknown>;
    listServers(harness?: string): PoolServer[];
    listTools(opts?: Record<string, unknown>): Promise<{ tools: Array<Record<string, unknown>>; errors: Array<Record<string, unknown>> }>;
    callTool(server: string, tool: string, args?: Record<string, unknown>, sessionKey?: string, harness?: string): Promise<unknown>;
    getPinnedTools(harness?: string): Array<Record<string, unknown>>;
    stopAll(): void;
  };
  normalizeServerConfig: (raw: Record<string, unknown>) => {
    source?: { name: string };
    env?: Record<string, string>;
    command?: string;
  };
};

interface RpcResponse {
  result?: {
    content?: Array<{ text: string }>;
    tools?: Array<{ name: string }>;
    isError?: boolean;
  };
}
const { McpRelayHttpServer } = require("../relay-http.cjs") as {
  McpRelayHttpServer: new (pool: unknown) => {
    url: string;
    start(port?: number, host?: string): Promise<string>;
    stop(): Promise<void>;
  };
};

const temps: string[] = [];

function makeHome(files: Record<string, string>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3p-relay-"));
  temps.push(home);
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(home, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }
  return home;
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("harness discovery", () => {
  it("parses TOML tables, arrays, quoted keys and inline tables", () => {
    const doc = parseToml(`
# comment
[mcp_servers.node_repl]
command = "node"
args = ["-e", "console.log(1)"]
enabled = true

[mcp_servers."my server".env]
TOKEN = "abc"

[mcp_servers.http_one]
url = "https://example.test/mcp"
http_headers = { "X-Api" = "v1", "X-Other" = "v2" }
`);
    const servers = doc.mcp_servers as Record<string, TomlNode>;
    expect(servers.node_repl!.command).toBe("node");
    expect(servers.node_repl!.args).toEqual(["-e", "console.log(1)"]);
    expect(servers.node_repl!.enabled).toBe(true);
    expect((servers["my server"]!.env as TomlNode).TOKEN).toBe("abc");
    expect((servers.http_one!.http_headers as TomlNode)["X-Api"]).toBe("v1");
  });

  it("expands ${VAR}, ${VAR:-default} and {env:VAR}", () => {
    const env = { PRESENT: "yes" };
    expect(expandString("a-${PRESENT}-${MISSING:-fallback}-{env:PRESENT}", env)).toBe("a-yes-fallback-yes");
    expect(expandString("${MISSING}", env)).toBe("");
  });

  it("discovers Claude, OpenCode, Codex and project configs, dedupes them and never returns secrets", () => {
    const cwd = path.join(os.tmpdir(), "t3p-project");
    const home = makeHome({
      ".claude.json": JSON.stringify({
        mcpServers: {
          shared: { command: "npx", args: ["-y", "shared-mcp"], env: { SHARED_TOKEN: "claude-secret" } },
          "reddit better": { type: "http", url: "https://reddit.test/mcp", headers: { Authorization: "Bearer claude-secret" } },
        },
        projects: {
          [cwd]: { mcpServers: { localOnly: { command: "node", args: ["local.js"] } } },
        },
      }),
      ".config/opencode/opencode.jsonc": `{
        // comment
        "mcp": {
          "shared": { "type": "local", "command": ["npx", "-y", "shared-mcp"], "environment": { "SHARED_TOKEN": "{env:OPENCODE_TOKEN}" } },
          "opencode-only": { "type": "local", "command": ["bunx", "thing"], },
        },
      }`,
      ".codex/config.toml": `
[mcp_servers.codexy]
command = "node"
args = ["codex.js"]
env = { API_KEY = "codex-secret" }

[mcp_servers.shared]
command = "npx"
args = ["-y", "shared-mcp"]
`,
      ".mcp.json": JSON.stringify({ mcpServers: { projectSrv: { command: "uvx", args: ["proj"] } } }),
    });

    const { candidates, warnings } = discoverHarnessServers({
      home,
      cwd,
      env: { OPENCODE_TOKEN: "opencode-secret" },
      sources: [
        { harness: "claude", scope: "global", format: "json", kind: "mcpServers", path: path.join(home, ".claude.json") },
        {
          harness: "opencode",
          scope: "global",
          format: "json",
          kind: "mcp",
          path: path.join(home, ".config", "opencode", "opencode.jsonc"),
        },
        { harness: "codex", scope: "global", format: "toml", kind: "mcp_servers", path: path.join(home, ".codex", "config.toml") },
        { harness: "claude", scope: "project", format: "json", kind: "mcpServers", path: path.join(home, ".mcp.json") },
      ],
    });

    expect(warnings).toEqual([]);
    const ids = candidates.map((c: Candidate) => c.suggestedId).sort();
    expect(ids).toEqual(["codexy", "localonly", "opencode-only", "projectsrv", "reddit-better", "shared"]);

    // Deduped across three harnesses, one entry with all origins.
    const shared = candidates.find((c: Candidate) => c.suggestedId === "shared")!;
    expect(shared.origins.map((o: Origin) => o.harness).sort()).toEqual(["claude", "codex", "opencode"]);

    // No secret values anywhere in the scan payload.
    const serialized = JSON.stringify(candidates);
    expect(serialized).not.toContain("claude-secret");
    expect(serialized).not.toContain("codex-secret");
    expect(serialized).not.toContain("opencode-secret");
    expect(shared.envKeys).toContain("SHARED_TOKEN");

    // Claude's per-project servers are found too.
    const local = candidates.find((c: Candidate) => c.suggestedId === "localonly")!;
    expect(local.origins[0]!.scope).toBe("project");
  });

  it("sanitizes ids and keeps them unique", () => {
    const taken = new Set<string>();
    expect(sanitizeId("reddit better", taken)).toBe("reddit-better");
    const first = sanitizeId("dup", taken);
    taken.add(first);
    expect(sanitizeId("dup", taken)).toBe("dup-2");
    expect(sanitizeId("1nvalid", taken)).toBe("1nvalid");
  });

  it("builds source-referenced configs and resolves values at spawn time", () => {
    const cwd = path.join(os.tmpdir(), "t3p-project");
    const home = makeHome({
      ".claude.json": JSON.stringify({
        mcpServers: { tick: { command: "npx", args: ["-y", "tick"], env: { TOKEN: "first" } } },
      }),
    });
    const configPath = path.join(home, ".claude.json");
    const { candidates } = discoverHarnessServers({
      home,
      cwd,
      sources: [{ harness: "claude", scope: "global", format: "json", kind: "mcpServers", path: configPath }],
    });
    const cfg = candidateToServerConfig(candidates[0], { id: "tick" });

    expect(cfg.source).toEqual({ harness: "claude", scope: "global", path: configPath, format: "json", kind: "mcpServers", name: "tick" });
    expect(cfg.env).toBeUndefined();
    expect(cfg.headers).toBeUndefined();
    expect(JSON.stringify(cfg)).not.toContain("first");

    // Token changes in the harness config are pick-up on the next spawn.
    fs.writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { tick: { command: "npx", args: ["-y", "tick"], env: { TOKEN: "second" } } } }),
      "utf8",
    );
    expect(resolveSourceEntry(cfg.source).env).toEqual({ TOKEN: "second" });

    const normalized = normalizeServerConfig(cfg);
    expect(normalized.source?.name).toBe("tick");
    expect(normalized.env).toBeUndefined();
    expect(normalized.command).toBe("npx");
  });

  it("keeps secrets out of the persisted relay config and passes fresh env to the client", async () => {
    const home = makeHome({
      ".claude.json": JSON.stringify({ mcpServers: { tick: { command: "npx", args: ["-y", "tick"], env: { TOKEN: "secret-1" } } } }),
    });
    const configPath = path.join(home, ".claude.json");
    const relayConfig = path.join(home, "relay", "config.json");
    const { candidates } = discoverHarnessServers({
      home,
      cwd: home,
      sources: [{ harness: "claude", scope: "global", format: "json", kind: "mcpServers", path: configPath }],
    });

    const seen: Array<{ env?: Record<string, string> }> = [];
    const pool = new McpRelayPool({
      configPath: relayConfig,
      clientFactory: (cfg: { env?: Record<string, string> }) => {
        seen.push(cfg);
        return {
          async connect() {},
          async listTools() {
            return [];
          },
          async callTool() {
            return { content: [{ type: "text", text: "ok" }] };
          },
          close() {},
        };
      },
      sourceResolver: (source: unknown) => resolveSourceEntry(source),
    });

    pool.addOrUpdateServer(candidateToServerConfig(candidates[0]!, { id: "tick" }));
    const onDisk = fs.readFileSync(relayConfig, "utf8");
    expect(onDisk).not.toContain("secret-1");
    expect(onDisk).toContain('"source"');

    fs.writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { tick: { command: "npx", args: ["-y", "tick"], env: { TOKEN: "secret-2" } } } }),
      "utf8",
    );
    await pool.callTool("tick", "anything", {});
    expect(seen.at(-1)!.env).toEqual({ TOKEN: "secret-2" });
    pool.stopAll();
  });
});

describe("harness exposure", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  function makePool() {
    const calls: string[] = [];
    const pool = new McpRelayPool({
      persist: false,
      clientFactory: (cfg: { id: string }) => ({
        async connect() {},
        async listTools() {
          return [{ name: "ping", description: "ping", inputSchema: { type: "object" } }];
        },
        async callTool() {
          calls.push(cfg.id);
          return { content: [{ type: "text", text: cfg.id }] };
        },
        close() {},
      }),
    });
    cleanups.push(() => pool.stopAll());
    return { pool, calls };
  }

  it("filters servers and tools per harness, with an empty list meaning every harness", async () => {
    const { pool } = makePool();
    pool.addOrUpdateServer({ id: "everywhere", transport: "stdio", command: "node" });
    pool.addOrUpdateServer({ id: "claudeOnly", transport: "stdio", command: "node", harnesses: ["claude"], pinnedTools: ["ping"] });

    expect(pool.listServers().map((s) => s.id).sort()).toEqual(["claudeOnly", "everywhere"]);
    expect(pool.listServers("codex").map((s) => s.id)).toEqual(["everywhere"]);
    expect(pool.listServers("claude").map((s) => s.id).sort()).toEqual(["claudeOnly", "everywhere"]);
    expect(pool.getPinnedTools("codex")).toHaveLength(0);
    expect(pool.getPinnedTools("claude")).toHaveLength(1);

    const codexTools = await pool.listTools({ harness: "codex" });
    expect(codexTools.tools.map((t) => t.server)).toEqual(["everywhere"]);
    await expect(pool.callTool("claudeOnly", "ping", {}, undefined, "codex")).rejects.toThrow(/not exposed to codex/);
  });

  it("detects the harness from initialize and from the x-t3p-harness header", async () => {
    const { pool } = makePool();
    pool.addOrUpdateServer({ id: "claudeOnly", transport: "stdio", command: "node", harnesses: ["claude"], pinnedTools: ["ping"] });
    const server = new McpRelayHttpServer(pool);
    const url = await server.start(0, "127.0.0.1");
    cleanups.push(() => server.stop());

    const post = async (body: Record<string, unknown>, sessionId?: string, harnessHeader?: string) => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (sessionId) headers["mcp-session-id"] = sessionId;
      if (harnessHeader) headers["x-t3p-harness"] = harnessHeader;
      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
      return { json: (await res.json()) as RpcResponse, sessionId: res.headers.get("mcp-session-id") ?? undefined };
    };

    const codex = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "codex-mcp-client", version: "1" } },
    });
    const codexList = await post(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "relay_list_servers", arguments: {} } },
      codex.sessionId,
    );
    const codexServers = JSON.parse(codexList.json.result!.content![0]!.text) as Array<{ id: string }>;
    expect(codexServers).toEqual([]);

    const codexTools = await post({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }, codex.sessionId);
    expect((codexTools.json.result!.tools as Array<{ name: string }>).map((t) => t.name)).not.toContain("claudeOnly__ping");

    const claude = await post(
      { jsonrpc: "2.0", id: 4, method: "initialize", params: { clientInfo: { name: "claude-code" } } },
    );
    const claudeList = await post(
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "relay_list_servers", arguments: {} } },
      claude.sessionId,
    );
    const claudeServers = JSON.parse(claudeList.json.result!.content![0]!.text) as Array<{ id: string }>;
    expect(claudeServers.map((s) => s.id)).toEqual(["claudeOnly"]);

    // Unknown clients can state their harness explicitly.
    const viaHeader = await post(
      { jsonrpc: "2.0", id: 6, method: "initialize", params: { clientInfo: { name: "custom" } } },
      undefined,
      "claude",
    );
    const headerList = await post(
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "relay_list_servers", arguments: {} } },
      viaHeader.sessionId,
    );
    const headerServers = JSON.parse(headerList.json.result!.content![0]!.text) as Array<{ id: string }>;
    expect(headerServers.map((s) => s.id)).toEqual(["claudeOnly"]);
  });
});
