import { describe, expect, it, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAcpRelayPicker, readRelayUrl, relayConfigPath, RELAY_ACP_CONFIG_ENV, RELAY_ACP_URL_ENV } from "../src/guard/relay-acp.js";
import { applyServerRelayPatch, SERVER_RELAY_FILE_RE } from "../src/guard/relay-acp-patch.js";
import { patchLoadedRelay } from "../src/guard/server-hook.js";

const CHUNK = `
function acpMcpActivation(context) {
	return {
		mcpServers: context.servers,
		acpMcpServers: context.acpServers,
		httpMcpServers: context.httpServers
	};
}
const sessionMcpServers = (initializeResult, activationOptions) => {
	const mcpCapabilities = initializeResult.agentCapabilities?.mcpCapabilities;
	const acpServers = activationOptions?.acpMcpServers ?? options.acpMcpServers ?? [];
	if (mcpCapabilities?.acp === true && acpServers.length > 0) return acpServers;
	const httpServers = activationOptions?.httpMcpServers ?? options.httpMcpServers ?? [];
	if (mcpCapabilities?.http === true && httpServers.length > 0) return httpServers;
	return activationOptions?.mcpServers ?? options.mcpServers ?? [];
};
`;

const T3_CODE_HTTP = { type: "http", name: "t3-code", url: "http://127.0.0.1:9999/mcp", headers: [{ name: "Authorization", value: "x" }] };

describe("applyServerRelayPatch", () => {
  it("injects the pick at the top of sessionMcpServers", () => {
    const result = applyServerRelayPatch(CHUNK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.code).toContain("/*t3p:relay-acp*/");
    expect(result.code).toContain("globalThis.__t3pRelayAcp ? globalThis.__t3pRelayAcp.pick(initializeResult, activationOptions, options) : null");
    expect(result.code.indexOf("/*t3p:relay-acp*/")).toBeLessThan(result.code.indexOf("const mcpCapabilities"));
    expect(result.detail).toBe("sessionMcpServers(initializeResult, activationOptions)");
  });

  it("refuses to patch twice, and refuses an ambiguous or missing anchor", () => {
    const patched = applyServerRelayPatch(CHUNK);
    expect(patched.ok).toBe(true);
    if (!patched.ok) return;
    expect(applyServerRelayPatch(patched.code)).toMatchObject({ ok: false, reason: "already-patched" });
    expect(applyServerRelayPatch(CHUNK + CHUNK)).toMatchObject({ ok: false, reason: "ambiguous-anchor" });
    expect(applyServerRelayPatch("const other = 1;")).toMatchObject({ ok: false, reason: "no-anchor" });
  });

  it("matches runtimeLayer chunks only", () => {
    expect(SERVER_RELAY_FILE_RE.test("C:\\T3\\resources\\server.asar\\apps\\server\\dist\\runtimeLayer-NnW-LAsK.mjs")).toBe(true);
    expect(SERVER_RELAY_FILE_RE.test("/opt/t3/apps/server/dist/runtimeLayer-abc.mjs")).toBe(true);
    expect(SERVER_RELAY_FILE_RE.test("/opt/t3/apps/server/dist/server-abc.mjs")).toBe(false);
  });

  it("patches through the load hook and leaves other files untouched", () => {
    const seen: string[] = [];
    const chunk = "file:///C:/T3/resources/server.asar/apps/server/dist/runtimeLayer-abc.mjs";
    const out = patchLoadedRelay(chunk, { format: "module", source: CHUNK }, (file, ok) => seen.push(`${ok}:${file}`));
    expect(String(out.source)).toContain("/*t3p:relay-acp*/");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^true:.*runtimeLayer-abc\.mjs$/);

    const other = patchLoadedRelay("file:///C:/T3/resources/server.asar/apps/server/dist/bin.mjs", { format: "module", source: CHUNK }, () => seen.push("no"));
    expect(other.source).toBe(CHUNK);
    expect(seen).toHaveLength(1);
  });
});

describe("AcpRelayPicker", () => {
  const url = "http://127.0.0.1:39393/mcp";

  it("appends the relay next to T3's HTTP servers", () => {
    const picker = createAcpRelayPicker({ readUrl: () => url });
    const picked = picker.pick(
      { agentCapabilities: { mcpCapabilities: { http: true } } },
      undefined,
      { httpMcpServers: [T3_CODE_HTTP] },
    ) as Array<Record<string, unknown>> | null;
    expect(picked).not.toBeNull();
    expect(picked!.map((s) => s.name)).toEqual(["t3-code", "t3-relay"]);
    expect(picked![1]).toEqual({
      type: "http",
      name: "t3-relay",
      url,
      headers: [{ name: "x-t3p-harness", value: "acp" }],
    });
  });

  it("prefers activation servers and does nothing when it cannot help", () => {
    const picker = createAcpRelayPicker({ readUrl: () => url });

    const viaActivation = picker.pick(
      { agentCapabilities: { mcpCapabilities: { http: true } } },
      { httpMcpServers: [T3_CODE_HTTP] },
      {},
    ) as Array<Record<string, unknown>> | null;
    expect(viaActivation).toHaveLength(2);

    // Agent does not advertise HTTP MCP support: leave T3's choice alone.
    expect(picker.pick({ agentCapabilities: { mcpCapabilities: { stdio: true } } }, undefined, { httpMcpServers: [T3_CODE_HTTP] })).toBeNull();

    // T3 supplied no HTTP servers (stdio-only flavor): leave it alone.
    expect(picker.pick({ agentCapabilities: { mcpCapabilities: { http: true } } }, undefined, { httpMcpServers: [] })).toBeNull();

    // Already there.
    const withRelay = [{ type: "http", name: "t3-relay", url }];
    expect(picker.pick({ agentCapabilities: { mcpCapabilities: { http: true } } }, undefined, { httpMcpServers: withRelay })).toBeNull();

    // Relay off / not installed.
    expect(createAcpRelayPicker({ readUrl: () => null }).pick(
      { agentCapabilities: { mcpCapabilities: { http: true } } },
      undefined,
      { httpMcpServers: [T3_CODE_HTTP] },
    )).toBeNull();
  });
});

describe("readRelayUrl", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    delete process.env[RELAY_ACP_CONFIG_ENV];
    delete process.env[RELAY_ACP_URL_ENV];
    while (cleanups.length > 0) cleanups.pop()!();
  });

  it("reads port and host from the relay config, and honours the URL override", () => {
    const dir = mkdtempSync(join(tmpdir(), "t3p-relay-acp-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const config = join(dir, "config.json");
    writeFileSync(config, JSON.stringify({ port: 41000, host: "127.0.0.1", servers: [] }), "utf8");
    process.env[RELAY_ACP_CONFIG_ENV] = config;

    expect(relayConfigPath()).toBe(config);
    expect(readRelayUrl()).toBe("http://127.0.0.1:41000/mcp");

    process.env[RELAY_ACP_URL_ENV] = "http://127.0.0.1:50000/mcp";
    expect(readRelayUrl()).toBe("http://127.0.0.1:50000/mcp");

    process.env[RELAY_ACP_URL_ENV] = "not a url";
    expect(readRelayUrl()).toBeNull();
  });

  it("returns null when the relay config is missing or has no usable port", () => {
    const dir = mkdtempSync(join(tmpdir(), "t3p-relay-acp-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    process.env[RELAY_ACP_CONFIG_ENV] = join(dir, "missing.json");
    expect(readRelayUrl()).toBeNull();

    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ port: 0 }), "utf8");
    process.env[RELAY_ACP_CONFIG_ENV] = bad;
    expect(readRelayUrl()).toBeNull();
  });
});

// Against the real server bundle: T3P_SERVER_DIST=<extracted server.asar>/apps/server/dist.
const serverDists = (process.env.T3P_SERVER_DIST ?? "").split(";").filter((d) => d && existsSync(d));
describe.skipIf(serverDists.length === 0)("relay patch against the real server bundle", () => {
  for (const dist of serverDists) {
    it(`patches exactly one chunk in ${dist}`, () => {
      const hits = readdirSync(dist)
        .filter((f) => /^runtimeLayer-[\w-]+\.mjs$/.test(f))
        .map((f) => ({ f, r: applyServerRelayPatch(readFileSync(join(dist, f), "utf8")) }));
      const ok = hits.filter((h) => h.r.ok);
      expect(ok.map((h) => h.f)).toHaveLength(1);
    });
  }
});
