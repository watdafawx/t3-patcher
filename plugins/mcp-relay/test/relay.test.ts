import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { McpRelayPool } = require("../relay-pool.cjs") as {
  McpRelayPool: new (opts?: Record<string, unknown>) => {
    addOrUpdateServer(cfg: Record<string, unknown>): Record<string, unknown>;
    removeServer(id: string): boolean;
    setEnabled(id: string, enabled: boolean): Record<string, unknown>;
    listServers(): Array<Record<string, unknown>>;
    listTools(opts?: Record<string, unknown>): Promise<{ tools: Array<Record<string, unknown>>; errors: Array<Record<string, unknown>> }>;
    callTool(server: string, tool: string, args?: Record<string, unknown>, sessionKey?: string): Promise<unknown>;
    getRecentCalls(limit?: number): Array<Record<string, unknown>>;
    stopAll(): void;
  };
};
const { McpRelayHttpServer } = require("../relay-http.cjs") as {
  McpRelayHttpServer: new (pool: unknown) => {
    url: string;
    start(port?: number, host?: string): Promise<string>;
    stop(): Promise<void>;
  };
};

interface MockClient {
  id: number;
  closed: boolean;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  connect(): Promise<void>;
  listTools(): Promise<Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }>;
  close(): void;
}

function makeMockFactory(toolsByServer: Record<string, Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>>) {
  let seq = 0;
  const created: MockClient[] = [];
  const factory = (cfg: { id: string }): MockClient => {
    const clientId = ++seq;
    const client: MockClient = {
      id: clientId,
      closed: false,
      calls: [],
      async connect() {},
      async listTools() {
        return toolsByServer[cfg.id] ?? [];
      },
      async callTool(name, args) {
        client.calls.push({ name, args });
        return {
          content: [{ type: "text", text: JSON.stringify({ server: cfg.id, clientId, name, args }) }],
        };
      },
      close() {
        client.closed = true;
      },
    };
    created.push(client);
    return client;
  };
  return { factory, created };
}

async function postMcp(url: string, body: Record<string, unknown>, sessionId?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const sid = res.headers.get("mcp-session-id") ?? undefined;
  const json = (await res.json()) as { result?: Record<string, unknown>; error?: { message: string } };
  return { status: res.status, sessionId: sid, json };
}

describe("MCP Relay Pool & Streamable HTTP Server", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()!;
      await fn();
    }
  });

  it("isolates session-mode servers per agent and shares shared-mode servers", async () => {
    const { factory, created } = makeMockFactory({
      docs: [{ name: "search", description: "Search docs", inputSchema: { type: "object", properties: {} } }],
      browser: [{ name: "open", description: "Open tab", inputSchema: { type: "object", properties: {} } }],
    });
    const pool = new McpRelayPool({ persist: false, clientFactory: factory });
    cleanups.push(() => pool.stopAll());

    pool.addOrUpdateServer({ id: "docs", transport: "stdio", command: "node", mode: "shared" });
    pool.addOrUpdateServer({ id: "browser", transport: "stdio", command: "node", mode: "session" });

    // Shared server: two different sessions reuse the same client instance
    const r1 = (await pool.callTool("docs", "search", { q: "a" }, "agent-1")) as { content: Array<{ text: string }> };
    const r2 = (await pool.callTool("docs", "search", { q: "b" }, "agent-2")) as { content: Array<{ text: string }> };
    expect(JSON.parse(r1.content[0]!.text).clientId).toBe(JSON.parse(r2.content[0]!.text).clientId);

    // Session server: two different sessions get distinct client instances
    const b1 = (await pool.callTool("browser", "open", { url: "https://a" }, "agent-1")) as { content: Array<{ text: string }> };
    const b2 = (await pool.callTool("browser", "open", { url: "https://b" }, "agent-2")) as { content: Array<{ text: string }> };
    expect(JSON.parse(b1.content[0]!.text).clientId).not.toBe(JSON.parse(b2.content[0]!.text).clientId);
    expect(created.length).toBe(3);
  });

  it("supports live add/disable/remove and hybrid pinned tools over Streamable HTTP", async () => {
    const { factory } = makeMockFactory({
      github: [
        { name: "list_issues", description: "List issues", inputSchema: { type: "object", properties: {} } },
        { name: "create_issue", description: "Create issue", inputSchema: { type: "object", properties: {} } },
      ],
    });
    const pool = new McpRelayPool({ persist: false, clientFactory: factory });
    const server = new McpRelayHttpServer(pool);
    const url = await server.start(0, "127.0.0.1");
    cleanups.push(async () => {
      pool.stopAll();
      await server.stop();
    });

    // 1. Agent connects once (0 child servers configured yet)
    const init = await postMcp(url, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(init.status).toBe(200);
    expect(init.sessionId).toBeTruthy();

    const list1 = await postMcp(url, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, init.sessionId);
    const names1 = (list1.json.result!.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names1).toEqual(["relay_list_servers", "relay_list_tools", "relay_call", "relay_reload_server"]);

    // 2. User adds "github" MCP live mid-session with one pinned tool
    pool.addOrUpdateServer({
      id: "github",
      transport: "stdio",
      command: "node",
      mode: "shared",
      pinnedTools: ["list_issues"],
    });

    // 3. Agent immediately discovers and calls it without restarting session
    const serversRes = await postMcp(
      url,
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "relay_list_servers", arguments: {} } },
      init.sessionId,
    );
    const serversList = JSON.parse((serversRes.json.result!.content as Array<{ text: string }>)[0]!.text) as Array<{ id: string }>;
    expect(serversList.map((s) => s.id)).toEqual(["github"]);

    const callRes = await postMcp(
      url,
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "relay_call", arguments: { server: "github", tool: "create_issue", arguments: { title: "hi" } } },
      },
      init.sessionId,
    );
    const callPayload = JSON.parse((callRes.json.result!.content as Array<{ text: string }>)[0]!.text);
    expect(callPayload.server).toBe("github");
    expect(callPayload.name).toBe("create_issue");

    // 4. Hybrid pinned tool works directly as github__list_issues
    const pinnedRes = await postMcp(
      url,
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "github__list_issues", arguments: {} } },
      init.sessionId,
    );
    const pinnedPayload = JSON.parse((pinnedRes.json.result!.content as Array<{ text: string }>)[0]!.text);
    expect(pinnedPayload.name).toBe("list_issues");

    // 5. Disabling server live blocks further calls immediately
    pool.setEnabled("github", false);
    const blockedRes = await postMcp(
      url,
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "relay_call", arguments: { server: "github", tool: "create_issue", arguments: {} } },
      },
      init.sessionId,
    );
    expect(blockedRes.json.result!.isError).toBe(true);
  });
});
