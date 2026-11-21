import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyServerMcpPatch,
  SERVER_MCP_FILE_RE,
  SERVER_MCP_GLOBAL,
} from "../src/guard/mcp-patch.js";
import {
  createServerMcpTools,
  filterProviders,
  formatProviderLimitsResult,
  parseProviderLimitsArgs,
  T3_PROVIDER_LIMITS_TOOL_NAME,
  type McpRegistrationContext,
  type ServerProviderLike,
} from "../src/guard/mcp-tools.js";
import { patchLoadedMcp } from "../src/guard/server-hook.js";

const FIXTURE_CHUNK = `
import { x as orElseSucceed } from "./effect.mjs";
const makeInvoke = (context, globalMiddleware) => {
  const services = context === void 0 ? empty() : omitRequestServices(context);
  return { services };
};
const withToolAnalytics = () => {
  const registry = serviceOption(ProviderRegistry);
  return new CallToolResult$5({ isError: false, content: [] });
};
const layerToolExposure = effect(McpToolExposure, gen(function* () {
\tconst server = yield* McpServer;
\treturn make$13(() => server.tools, () => undefined);
}));
const layerDeferredListing = () => {
  const providerSessionId = getOrUndefined(scope)?.thread?.providerSessionId;
  return providerSessionId;
};
`;

/** 0.1.12 turned the empty invocation context into a destructured object literal. */
const FIXTURE_CHUNK_0112 = FIXTURE_CHUNK.replace(
  "const services = context === void 0 ? empty() : omitRequestServices(context);",
  "const { localMiddleware, services } = context === void 0 ? {\n\t\tservices: empty(),\n\t\tlocalMiddleware: []\n\t} : prepareContext(context);",
);

const SAMPLE_PROVIDERS: ServerProviderLike[] = [
  {
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    displayName: "Claude Code",
    enabled: true,
    installed: true,
    status: "ready",
    checkedAt: "2026-11-20T20:00:00.000Z",
    auth: { status: "authenticated" },
    usageLimits: {
      checkedAt: "2026-11-20T20:05:00.000Z",
      windows: [
        {
          id: "session",
          kind: "session",
          label: "5-hour session",
          usedPercent: 82.4,
          resetsAt: "2026-11-20T21:30:00.000Z",
          windowDurationMins: 300,
        },
        {
          id: "weekly",
          kind: "weekly",
          label: "7-day weekly",
          usedPercent: 40,
          resetsAt: "2026-11-25T00:00:00.000Z",
          windowDurationMins: 10080,
          modelIds: ["claude-opus-5-5"],
        },
      ],
      resetCredits: {
        availableCount: 2,
        nextExpiresAt: "2026-12-01T00:00:00.000Z",
      },
    },
  },
  {
    instanceId: "codex",
    driver: "codex",
    displayName: "Codex",
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    usageLimits: {
      checkedAt: "2026-11-20T20:05:00.000Z",
      windows: [],
      unavailable: { reason: "probeFailed", message: "rate limited" },
    },
  },
  {
    instanceId: "antigravity",
    driver: "antigravity",
    displayName: "Antigravity",
    enabled: false,
    installed: true,
    status: "disabled",
    auth: { status: "unauthenticated" },
  },
];

/** Minimal synchronous/promise Effect runner for testing generator-based MCP handlers. */
interface FakeEffect<T = unknown> {
  _run: () => Promise<T>;
  pipe: (...ops: Array<(eff: FakeEffect) => FakeEffect>) => FakeEffect;
  [Symbol.iterator]: () => Generator<FakeEffect<T>, T, T>;
}

function makeEffect<T>(run: () => Promise<T>): FakeEffect<T> {
  const eff: FakeEffect<T> = {
    _run: run,
    pipe(...ops) {
      let cur: FakeEffect = eff;
      for (const op of ops) cur = op(cur);
      return cur;
    },
    *[Symbol.iterator]() {
      return (yield eff) as T;
    },
  };
  return eff;
}

function fakeGen(body: () => Generator<unknown, unknown, unknown>): FakeEffect {
  return makeEffect(async () => {
    const it = body();
    let step = it.next();
    while (!step.done) {
      const yielded = step.value as FakeEffect;
      const val = await yielded._run();
      step = it.next(val);
    }
    return step.value;
  });
}

function fakeOrElseSucceed(fallback: () => unknown) {
  return (eff: FakeEffect): FakeEffect =>
    makeEffect(async () => {
      try {
        return await eff._run();
      } catch {
        return fallback();
      }
    });
}

class FakeCallToolResult {
  readonly isError: boolean;
  readonly structuredContent?: unknown;
  readonly content: Array<{ type: "text"; text: string }>;
  constructor(args: { isError: boolean; structuredContent?: unknown; content: Array<{ type: "text"; text: string }> }) {
    this.isError = args.isError;
    this.structuredContent = args.structuredContent;
    this.content = args.content;
  }
}

describe("applyServerMcpPatch", () => {
  it("matches server-*.mjs file names only", () => {
    expect(SERVER_MCP_FILE_RE.test("C:\\T3\\resources\\server.asar\\apps\\server\\dist\\server-8K5Ixyrs.mjs")).toBe(true);
    expect(SERVER_MCP_FILE_RE.test("/opt/t3/server.asar/apps/server/dist/server-hANTJVk5.mjs")).toBe(true);
    expect(SERVER_MCP_FILE_RE.test("/opt/t3/apps/server/dist/runtimeLayer-CMUqXtti.mjs")).toBe(false);
    expect(SERVER_MCP_FILE_RE.test("/opt/t3/apps/server/dist/client/server-abc.mjs")).toBe(false);
  });

  it("patches the 0.1.12 invocation-context shape", () => {
    expect(FIXTURE_CHUNK_0112).not.toBe(FIXTURE_CHUNK);
    const res = applyServerMcpPatch(FIXTURE_CHUNK_0112);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.code).toContain("emptyContext: empty");
    expect(res.code).toContain(`globalThis.${SERVER_MCP_GLOBAL}.register`);
  });

  it("patches a valid server chunk and refuses missing/ambiguous/duplicate ones", () => {
    const res = applyServerMcpPatch(FIXTURE_CHUNK);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.code).toContain(`globalThis.${SERVER_MCP_GLOBAL}.register`);
    expect(res.code).toContain("CallToolResult: CallToolResult$5");
    expect(res.code).toContain("emptyContext: empty");
    expect(res.code).toContain("orElseSucceed: orElseSucceed");

    expect(applyServerMcpPatch(res.code)).toMatchObject({ ok: false, reason: "already-patched" });
    expect(applyServerMcpPatch("const x = 1;")).toMatchObject({ ok: false, reason: "no-anchor" });
    expect(applyServerMcpPatch(FIXTURE_CHUNK.replace("new CallToolResult$5({", "new Other({"))).toMatchObject({
      ok: false,
      reason: "no-call-tool-result",
    });
    expect(applyServerMcpPatch(FIXTURE_CHUNK.replace("serviceOption(ProviderRegistry)", "none()"))).toMatchObject({
      ok: false,
      reason: "no-provider-registry",
    });
    expect(applyServerMcpPatch(FIXTURE_CHUNK.replace("omitRequestServices(context)", "other(context)"))).toMatchObject({
      ok: false,
      reason: "no-empty-context",
    });
    expect(applyServerMcpPatch(FIXTURE_CHUNK.replace("getOrUndefined(scope)?.thread?.providerSessionId", "null"))).toMatchObject({
      ok: false,
      reason: "no-get-or-undefined",
    });
    expect(applyServerMcpPatch(FIXTURE_CHUNK.replace("as orElseSucceed", "as other"))).toMatchObject({
      ok: false,
      reason: "no-or-else-succeed",
    });
  });

  it("patches through patchLoadedMcp for matching file URLs", () => {
    const url = pathToFileURL("C:/T3/resources/server.asar/apps/server/dist/server-abc.mjs").href;
    const reports: Array<{ ok: boolean; detail: string }> = [];
    const out = patchLoadedMcp(url, { format: "module", source: FIXTURE_CHUNK }, (_file, ok, detail) => {
      reports.push({ ok, detail });
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]!.ok).toBe(true);
    expect(String(out.source)).toContain(`globalThis.${SERVER_MCP_GLOBAL}`);
  });
});

describe("provider limits helpers", () => {
  it("parses arguments safely and ignores unknown keys", () => {
    expect(parseProviderLimitsArgs(undefined)).toEqual({ refresh: false, includeDisabled: false });
    expect(parseProviderLimitsArgs({ provider: "  claude  ", refresh: true, includeDisabled: true, toolSummary: "ignored" })).toEqual({
      provider: "claude",
      refresh: true,
      includeDisabled: true,
    });
    expect(parseProviderLimitsArgs({ provider: "   ", refresh: "yes" })).toEqual({ refresh: false, includeDisabled: false });
  });

  it("filters providers by exact match first, then substring, respecting includeDisabled", () => {
    expect(filterProviders(SAMPLE_PROVIDERS, undefined, false).map((p) => p.instanceId)).toEqual(["claudeAgent", "codex"]);
    expect(filterProviders(SAMPLE_PROVIDERS, undefined, true).map((p) => p.instanceId)).toEqual([
      "claudeAgent",
      "codex",
      "antigravity",
    ]);
    expect(filterProviders(SAMPLE_PROVIDERS, "claude", false).map((p) => p.instanceId)).toEqual(["claudeAgent"]);
    expect(filterProviders(SAMPLE_PROVIDERS, "antigravity", false).map((p) => p.instanceId)).toEqual(["antigravity"]);

    const extra: ServerProviderLike[] = [
      ...SAMPLE_PROVIDERS,
      { instanceId: "codex-work", driver: "codex", displayName: "Codex Work", enabled: true, installed: true, status: "ready" },
    ];
    // Exact match on instanceId wins over substring match on codex-work
    expect(filterProviders(extra, "codex", false).map((p) => p.instanceId)).toEqual(["codex", "codex-work"]);
    expect(filterProviders(extra, "codex-work", false).map((p) => p.instanceId)).toEqual(["codex-work"]);
  });

  it("formats windows, remaining percents, countdowns, and unavailable/no-data states", () => {
    const nowMs = Date.parse("2026-11-20T20:30:00.000Z");
    const result = formatProviderLimitsResult(SAMPLE_PROVIDERS, {
      includeDisabled: true,
      refreshed: false,
      nowMs,
    });
    expect(result.checkedAt).toBe("2026-11-20T20:30:00.000Z");
    expect(result.refreshed).toBe(false);
    expect(result.providers).toHaveLength(3);

    const claude = result.providers[0]!;
    expect(claude).toMatchObject({
      instanceId: "claudeAgent",
      displayName: "Claude Code",
      limitsStatus: "ok",
      worstUsedPercent: 82.4,
      minRemainingPercent: 17.6,
      resetCredits: { availableCount: 2, nextExpiresAt: "2026-12-01T00:00:00.000Z" },
    });
    expect(claude.windows[0]).toMatchObject({
      id: "session",
      usedPercent: 82.4,
      remainingPercent: 17.6,
      resetsInSeconds: 3600,
      windowDurationMins: 300,
    });
    expect(claude.windows[1]!.modelIds).toEqual(["claude-opus-5-5"]);

    const codex = result.providers[1]!;
    expect(codex).toMatchObject({
      instanceId: "codex",
      limitsStatus: "unavailable",
      unavailableReason: "probeFailed",
      unavailableMessage: "rate limited",
      worstUsedPercent: null,
      minRemainingPercent: null,
    });

    const ag = result.providers[2]!;
    expect(ag).toMatchObject({
      instanceId: "antigravity",
      limitsStatus: "no-data",
      enabled: false,
    });
  });
});

describe("createServerMcpTools", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[SERVER_MCP_GLOBAL];
  });

  it("registers t3_provider_limits and handles cached + refreshed queries", async () => {
    let registered: Parameters<McpRegistrationContext["server"]["addTool"]>[0] | null = null;
    const refresh = vi.fn(() => makeEffect(async () => SAMPLE_PROVIDERS));
    const refreshInstance = vi.fn(() => makeEffect(async () => SAMPLE_PROVIDERS));

    const mcp = createServerMcpTools({
      log: () => undefined,
      now: () => Date.parse("2026-11-20T20:30:00.000Z"),
    });

    const regEffect = mcp.register({
      server: {
        addTool: (opts) =>
          makeEffect(async () => {
            registered = opts;
          }),
      },
      providerRegistry: {
        getProviders: makeEffect(async () => SAMPLE_PROVIDERS),
        refresh,
        refreshInstance,
      },
      CallToolResult: FakeCallToolResult,
      emptyContext: () => ({ mapUnsafe: new Map() }),
      gen: fakeGen,
      orElseSucceed: fakeOrElseSucceed,
    }) as FakeEffect;

    await regEffect._run();
    expect(registered).not.toBeNull();
    expect(registered!.tool.name).toBe(T3_PROVIDER_LIMITS_TOOL_NAME);

    // Cached query for all enabled providers
    const cachedRes = (await (registered!.handle({}) as FakeEffect<FakeCallToolResult>)._run()) as FakeCallToolResult;
    expect(cachedRes.isError).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
    expect(refreshInstance).not.toHaveBeenCalled();
    expect((cachedRes.structuredContent as { providers: unknown[] }).providers).toHaveLength(2);

    // Refreshed query for one provider calls refreshInstance
    const refreshedOne = (await (
      registered!.handle({ provider: "claude", refresh: true }) as FakeEffect<FakeCallToolResult>
    )._run()) as FakeCallToolResult;
    expect(refreshInstance).toHaveBeenCalledWith("claudeAgent");
    expect(refresh).not.toHaveBeenCalled();
    expect((refreshedOne.structuredContent as { refreshed: boolean; providers: Array<{ instanceId: string }> })).toMatchObject({
      refreshed: true,
      providers: [{ instanceId: "claudeAgent" }],
    });

    // Refreshed query without filter calls refresh()
    const refreshedAll = (await (
      registered!.handle({ refresh: true }) as FakeEffect<FakeCallToolResult>
    )._run()) as FakeCallToolResult;
    expect(refresh).toHaveBeenCalledTimes(1);
    expect((refreshedAll.structuredContent as { refreshed: boolean }).refreshed).toBe(true);
  });

  it("returns an error CallToolResult when ProviderRegistry is missing", async () => {
    let registered: Parameters<McpRegistrationContext["server"]["addTool"]>[0] | null = null;
    const mcp = createServerMcpTools({ log: () => undefined });
    const regEffect = mcp.register({
      server: {
        addTool: (opts) =>
          makeEffect(async () => {
            registered = opts;
          }),
      },
      providerRegistry: undefined,
      CallToolResult: FakeCallToolResult,
      emptyContext: () => ({ mapUnsafe: new Map() }),
      gen: fakeGen,
      orElseSucceed: fakeOrElseSucceed,
    }) as FakeEffect;
    await regEffect._run();

    const res = (await (registered!.handle({}) as FakeEffect<FakeCallToolResult>)._run()) as FakeCallToolResult;
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ error: "provider_registry_unavailable" });
  });
});
