/**
 * Server-side MCP tool registrations injected into T3 Code's MCP server (`McpHttpServer`).
 *
 * Currently registers `t3_provider_limits`, allowing any model connected to T3's MCP server to
 * inspect usage limits, remaining quota, and reset times for configured providers (and optionally
 * trigger a live probe via `ProviderRegistry`).
 *
 * Pure and electron-free: runs inside `server-hook.mjs` in the T3 server process.
 */

export const T3_PROVIDER_LIMITS_TOOL_NAME = "t3_provider_limits";
export const T3_MCP_TOOLS_ENV = "T3P_MCP_TOOLS";

export interface ProviderLimitsArgs {
  provider?: string;
  refresh: boolean;
  includeDisabled: boolean;
}

export interface ServerProviderUsageWindowLike {
  id: string;
  kind: string;
  label: string;
  usedPercent: number;
  resetsAt?: string;
  windowDurationMins?: number;
  modelIds?: readonly string[];
  providerIds?: readonly string[];
}

export interface ServerProviderUsageLimitsLike {
  checkedAt?: string;
  windows?: readonly ServerProviderUsageWindowLike[];
  zeroSpendCap?: boolean;
  resetCredits?: {
    availableCount: number;
    nextExpiresAt?: string;
  };
  unavailable?: {
    reason: string;
    message?: string;
  };
}

export interface ServerProviderLike {
  instanceId: string;
  driver: string;
  displayName?: string;
  enabled: boolean;
  installed: boolean;
  status: string;
  checkedAt?: string;
  auth?: {
    status?: string;
  };
  usageLimits?: ServerProviderUsageLimitsLike;
}

export interface FormattedLimitWindow {
  id: string;
  kind: string;
  label: string;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string | null;
  resetsInSeconds: number | null;
  windowDurationMins: number | null;
  modelIds?: readonly string[];
}

export interface FormattedProviderLimits {
  instanceId: string;
  driver: string;
  displayName: string;
  status: string;
  enabled: boolean;
  installed: boolean;
  authStatus: string;
  checkedAt: string | null;
  limitsStatus: "ok" | "no-data" | "no-windows" | "unavailable";
  unavailableReason: string | null;
  unavailableMessage: string | null;
  zeroSpendCap?: boolean;
  worstUsedPercent: number | null;
  minRemainingPercent: number | null;
  windows: FormattedLimitWindow[];
  resetCredits?: {
    availableCount: number;
    nextExpiresAt: string | null;
  };
}

export interface ProviderLimitsToolResult {
  checkedAt: string;
  refreshed: boolean;
  filter?: string;
  providers: FormattedProviderLimits[];
}

interface EffectLike {
  pipe: (...ops: unknown[]) => EffectLike;
  [Symbol.iterator]: () => Iterator<unknown, unknown, unknown>;
}

export interface ProviderRegistryLike {
  getProviders: EffectLike;
  refresh: (driver?: string) => EffectLike;
  refreshInstance: (instanceId: string) => EffectLike;
}

export interface McpServerLike {
  addTool: (options: {
    tool: {
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
      annotations?: Record<string, unknown>;
    };
    annotations: unknown;
    handle: (payload: unknown) => unknown;
  }) => EffectLike;
}

export interface McpRegistrationContext {
  server: McpServerLike;
  providerRegistry: ProviderRegistryLike | undefined;
  CallToolResult: new (args: {
    isError: boolean;
    structuredContent?: unknown;
    content: Array<{ type: "text"; text: string }>;
  }) => unknown;
  emptyContext: () => unknown;
  gen: (body: () => Generator<unknown, unknown, unknown>) => unknown;
  orElseSucceed: (fn: () => unknown) => unknown;
}

export interface ServerMcpTools {
  register(ctx: McpRegistrationContext): unknown;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Parses and sanitizes raw MCP tool arguments. Unknown keys are ignored. */
export function parseProviderLimitsArgs(payload: unknown): ProviderLimitsArgs {
  if (typeof payload !== "object" || payload === null) {
    return { refresh: false, includeDisabled: false };
  }
  const raw = payload as Record<string, unknown>;
  const providerRaw = typeof raw.provider === "string" ? raw.provider.trim() : "";
  return {
    ...(providerRaw.length > 0 ? { provider: providerRaw } : {}),
    refresh: raw.refresh === true,
    includeDisabled: raw.includeDisabled === true,
  };
}

function providerFields(provider: ServerProviderLike): string[] {
  const fields = [provider.instanceId, provider.driver];
  if (provider.displayName?.trim()) fields.push(provider.displayName.trim());
  return fields.map((f) => f.toLowerCase());
}

/**
 * Filters providers by optional `provider` query (case-insensitive exact match on instanceId,
 * driver, or displayName first; falls back to substring match). When unfiltered, disabled
 * providers are excluded unless `includeDisabled` is true.
 */
export function filterProviders(
  providers: readonly ServerProviderLike[],
  providerFilter: string | undefined,
  includeDisabled: boolean,
): ServerProviderLike[] {
  const query = providerFilter?.trim().toLowerCase();
  if (!query) {
    return providers.filter((p) => includeDisabled || p.enabled);
  }
  const exact = providers.filter((p) => providerFields(p).some((f) => f === query));
  if (exact.length > 0) return exact;
  return providers.filter((p) => providerFields(p).some((f) => f.includes(query)));
}

function formatWindow(win: ServerProviderUsageWindowLike, nowMs: number): FormattedLimitWindow {
  const used = round1(clampPercent(win.usedPercent));
  const remaining = round1(clampPercent(100 - used));
  const resetsAt = typeof win.resetsAt === "string" && win.resetsAt.length > 0 ? win.resetsAt : null;
  const resetMs = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  const resetsInSeconds = Number.isFinite(resetMs) ? Math.max(0, Math.round((resetMs - nowMs) / 1000)) : null;
  const windowDurationMins =
    typeof win.windowDurationMins === "number" && Number.isFinite(win.windowDurationMins) ? win.windowDurationMins : null;
  const modelIds = Array.isArray(win.modelIds) && win.modelIds.length > 0 ? win.modelIds : undefined;
  return {
    id: win.id,
    kind: win.kind,
    label: win.label,
    usedPercent: used,
    remainingPercent: remaining,
    resetsAt,
    resetsInSeconds,
    windowDurationMins,
    ...(modelIds ? { modelIds } : {}),
  };
}

function formatOneProvider(provider: ServerProviderLike, nowMs: number): FormattedProviderLimits {
  const limits = provider.usageLimits;
  const rawWindows = Array.isArray(limits?.windows) ? limits.windows : [];
  const windows = rawWindows.map((w) => formatWindow(w, nowMs));

  let limitsStatus: FormattedProviderLimits["limitsStatus"];
  if (!limits) limitsStatus = "no-data";
  else if (limits.unavailable) limitsStatus = "unavailable";
  else if (windows.length === 0) limitsStatus = "no-windows";
  else limitsStatus = "ok";

  const worstUsedPercent = windows.length > 0 ? Math.max(...windows.map((w) => w.usedPercent)) : null;
  const minRemainingPercent = worstUsedPercent !== null ? round1(clampPercent(100 - worstUsedPercent)) : null;

  return {
    instanceId: provider.instanceId,
    driver: provider.driver,
    displayName: provider.displayName?.trim() || provider.driver || provider.instanceId,
    status: provider.status,
    enabled: provider.enabled,
    installed: provider.installed,
    authStatus: provider.auth?.status ?? "unknown",
    checkedAt: limits?.checkedAt ?? provider.checkedAt ?? null,
    limitsStatus,
    unavailableReason: limits?.unavailable?.reason ?? null,
    unavailableMessage: limits?.unavailable?.message ?? null,
    ...(limits?.zeroSpendCap === true ? { zeroSpendCap: true } : {}),
    worstUsedPercent,
    minRemainingPercent,
    windows,
    ...(limits?.resetCredits
      ? {
          resetCredits: {
            availableCount: limits.resetCredits.availableCount,
            nextExpiresAt: limits.resetCredits.nextExpiresAt ?? null,
          },
        }
      : {}),
  };
}

/** Formats the full `t3_provider_limits` tool response from raw `ServerProvider` snapshots. */
export function formatProviderLimitsResult(
  providers: readonly ServerProviderLike[],
  options: {
    providerFilter?: string;
    includeDisabled: boolean;
    refreshed: boolean;
    nowMs?: number;
  },
): ProviderLimitsToolResult {
  const nowMs = options.nowMs ?? Date.now();
  const matched = filterProviders(providers, options.providerFilter, options.includeDisabled);
  return {
    checkedAt: new Date(nowMs).toISOString(),
    refreshed: options.refreshed,
    ...(options.providerFilter ? { filter: options.providerFilter } : {}),
    providers: matched.map((p) => formatOneProvider(p, nowMs)),
  };
}

export const T3_PROVIDER_LIMITS_TOOL_DESCRIPTOR = {
  name: T3_PROVIDER_LIMITS_TOOL_NAME,
  description:
    "Check usage limits, remaining quota, and reset times for configured providers. Omit `provider` to list all enabled providers; pass `refresh: true` to re-probe live limits.",
  inputSchema: {
    type: "object",
    properties: {
      provider: {
        type: "string",
        description:
          "Optional filter matching a provider instanceId, driver (e.g. claudeAgent, codex, antigravity), or display name.",
      },
      refresh: {
        type: "boolean",
        description:
          "If true, re-probe live usage limits from the provider before returning. Defaults to false (uses cached server limits).",
      },
      includeDisabled: {
        type: "boolean",
        description: "Include disabled providers when `provider` is omitted. Defaults to false.",
      },
    },
  },
  annotations: {
    title: "Check provider usage limits",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

/** Creates the `globalThis.__t3pMcpTools` runtime installed by `server-hook.mjs`. */
export function createServerMcpTools(deps: { log: (level: "info" | "warn", message: string) => void; now?: () => number }): ServerMcpTools {
  const now = deps.now ?? Date.now;
  return {
    register(ctx: McpRegistrationContext) {
      return ctx.gen(function* () {
        const addEffect = ctx.server.addTool({
          tool: T3_PROVIDER_LIMITS_TOOL_DESCRIPTOR,
          annotations: ctx.emptyContext(),
          handle: (payload: unknown) =>
            ctx.gen(function* () {
              const registry = ctx.providerRegistry;
              if (!registry) {
                const out = {
                  error: "provider_registry_unavailable",
                  message: "Provider registry is not available in this server instance.",
                };
                return new ctx.CallToolResult({
                  isError: true,
                  structuredContent: out,
                  content: [{ type: "text", text: JSON.stringify(out) }],
                });
              }

              const args = parseProviderLimitsArgs(payload);
              let providers = (yield* registry.getProviders.pipe(ctx.orElseSucceed(() => []))) as readonly ServerProviderLike[];
              let refreshed = false;

              if (args.refresh) {
                const targets = args.provider ? filterProviders(providers, args.provider, true) : [];
                if (args.provider && targets.length > 0) {
                  for (const target of targets) {
                    const next = (yield* registry
                      .refreshInstance(target.instanceId)
                      .pipe(ctx.orElseSucceed(() => null))) as readonly ServerProviderLike[] | null;
                    if (next) {
                      providers = next;
                      refreshed = true;
                    }
                  }
                } else {
                  const next = (yield* registry.refresh().pipe(ctx.orElseSucceed(() => null))) as
                    | readonly ServerProviderLike[]
                    | null;
                  if (next) {
                    providers = next;
                    refreshed = true;
                  }
                }
              }

              const result = formatProviderLimitsResult(providers, {
                providerFilter: args.provider,
                includeDisabled: args.includeDisabled,
                refreshed,
                nowMs: now(),
              });
              return new ctx.CallToolResult({
                isError: false,
                structuredContent: result,
                content: [{ type: "text", text: JSON.stringify(result) }],
              });
            }),
        });

        yield* addEffect.pipe(
          ctx.orElseSucceed(() => {
            deps.log("warn", `failed to register MCP tool ${T3_PROVIDER_LIMITS_TOOL_NAME}`);
            return undefined;
          }),
        );
        deps.log("info", `registered MCP tool ${T3_PROVIDER_LIMITS_TOOL_NAME}`);
      });
    },
  };
}
