/**
 * Server-side text patch for T3 Code's MCP server: registers T3 Patcher's MCP tools
 * (currently `t3_provider_limits`) when `McpHttpServer` initializes `layerToolExposure`.
 *
 * Target, upstream `apps/server/src/mcp/McpHttpServer.ts`:
 *
 *   const layerToolExposure = Layer.effect(
 *     McpToolExposure.McpToolExposure,
 *     Effect.gen(function* () {
 *       const server = yield* McpServer.McpServer;
 *
 * which the server bundle (unminified ESM, `apps/server/dist/server-<hash>.mjs`) ships as:
 *
 *   const layerToolExposure = effect(McpToolExposure, gen(function* () {
 *     const server = yield* McpServer;
 *
 * The injected statement resolves `ProviderRegistry` via `serviceOption` (fail-open if absent)
 * and delegates tool registration to `globalThis.__t3pMcpTools.register(...)`.
 *
 * Pure and electron-free: the server hook applies it, the tests and the compat checker run it too.
 */

/** The global the server hook installs. */
export const SERVER_MCP_GLOBAL = "__t3pMcpTools";

/** Server chunks the hook looks at. */
export const SERVER_MCP_FILE_RE = /(?:^|[\\/])apps[\\/]server[\\/]dist[\\/]server-[^\\/]*\.mjs$/;

/** `find`: plain text that must occur in exactly one server chunk. */
export const SERVER_MCP_FIND = "const layerToolExposure = ";

const ANCHOR_RE =
  /const layerToolExposure = ([\w$]+)\(McpToolExposure, ([\w$]+)\(function\* \(\) \{\s*const ([\w$]+) = yield\* (McpServer(?:\$\d+)?);/g;
const CALL_TOOL_RESULT_RE = /\bnew (CallToolResult(?:\$\d+)?)\(\{/g;
const SERVICE_OPTION_PROVIDER_RE = /\b([\w$]+)\((ProviderRegistry(?:\$\d+)?)\)/g;
const EMPTY_CONTEXT_RES = [
  /const services = context === void 0 \? ([\w$]+)\(\) : omitRequestServices\(context\);/g,
  /const \{ localMiddleware, services \} = context === void 0 \? \{\s*services: ([\w$]+)\(\),\s*localMiddleware: \[\]\s*\} : prepareContext\(context\);/g,
];
const GET_OR_UNDEFINED_SCOPE_RE = /\b([\w$]+)\(scope\)\?\.thread\?\.providerSessionId/g;
const OR_ELSE_SUCCEED_RE = /\bas (orElseSucceed(?:\$\d+)?)\s*[,}]/g;

/** Marker so a chunk is never patched twice. */
const MARKER = "/*t3p:mcp-tools*/";

export type ServerMcpPatchResult =
  | { ok: true; code: string; detail: string }
  | {
      ok: false;
      reason:
        | "no-anchor"
        | "ambiguous-anchor"
        | "no-call-tool-result"
        | "ambiguous-call-tool-result"
        | "no-provider-registry"
        | "ambiguous-provider-registry"
        | "no-empty-context"
        | "ambiguous-empty-context"
        | "no-get-or-undefined"
        | "ambiguous-get-or-undefined"
        | "no-or-else-succeed"
        | "ambiguous-or-else-succeed"
        | "already-patched";
      detail: string;
    };

function all(re: RegExp, source: string): RegExpExecArray[] {
  re.lastIndex = 0;
  const out: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.push(m);
  return out;
}

/** Applies the MCP tools patch to one server chunk. Never throws. */
export function applyServerMcpPatch(source: string): ServerMcpPatchResult {
  if (source.includes(MARKER)) {
    return { ok: false, reason: "already-patched", detail: "chunk already carries the MCP tools hook" };
  }

  const anchors = all(ANCHOR_RE, source);
  if (anchors.length === 0) {
    return { ok: false, reason: "no-anchor", detail: "const layerToolExposure = <effect>(McpToolExposure, <gen>(function* () { const <server> = yield* McpServer; not found" };
  }
  if (anchors.length > 1) {
    return { ok: false, reason: "ambiguous-anchor", detail: `layerToolExposure anchor found ${anchors.length} times` };
  }

  const callToolResults = [...new Set(all(CALL_TOOL_RESULT_RE, source).map((m) => m[1]!))];
  if (callToolResults.length === 0) {
    return { ok: false, reason: "no-call-tool-result", detail: "no `new CallToolResult({` binding found" };
  }
  if (callToolResults.length > 1) {
    return { ok: false, reason: "ambiguous-call-tool-result", detail: `CallToolResult bindings: ${callToolResults.join(", ")}` };
  }

  const providerLookups = [...new Set(all(SERVICE_OPTION_PROVIDER_RE, source).map((m) => `${m[1]!}:${m[2]!}`))];
  if (providerLookups.length === 0) {
    return { ok: false, reason: "no-provider-registry", detail: "no `serviceOption(ProviderRegistry)` lookup found" };
  }
  if (providerLookups.length > 1) {
    return { ok: false, reason: "ambiguous-provider-registry", detail: `ProviderRegistry lookups: ${providerLookups.join(", ")}` };
  }

  const emptyContexts = [...new Set(EMPTY_CONTEXT_RES.flatMap((re) => all(re, source).map((m) => m[1]!)))];
  if (emptyContexts.length === 0) {
    return { ok: false, reason: "no-empty-context", detail: "no `empty()` invocation-context helper found" };
  }
  if (emptyContexts.length > 1) {
    return { ok: false, reason: "ambiguous-empty-context", detail: `empty context helpers: ${emptyContexts.join(", ")}` };
  }

  const getOrUndefineds = [...new Set(all(GET_OR_UNDEFINED_SCOPE_RE, source).map((m) => m[1]!))];
  if (getOrUndefineds.length === 0) {
    return { ok: false, reason: "no-get-or-undefined", detail: "no `getOrUndefined(scope)` binding found" };
  }
  if (getOrUndefineds.length > 1) {
    return { ok: false, reason: "ambiguous-get-or-undefined", detail: `getOrUndefined bindings: ${getOrUndefineds.join(", ")}` };
  }

  const orElseSucceeds = [...new Set(all(OR_ELSE_SUCCEED_RE, source).map((m) => m[1]!))];
  if (orElseSucceeds.length === 0) {
    return { ok: false, reason: "no-or-else-succeed", detail: "no `as orElseSucceed` import binding found" };
  }
  if (orElseSucceeds.length > 1) {
    return { ok: false, reason: "ambiguous-or-else-succeed", detail: `orElseSucceed bindings: ${orElseSucceeds.join(", ")}` };
  }

  const anchor = anchors[0]!;
  const gen = anchor[2]!;
  const serverVar = anchor[3]!;
  const callToolResult = callToolResults[0]!;
  const [serviceOption, providerRegistry] = providerLookups[0]!.split(":") as [string, string];
  const emptyContext = emptyContexts[0]!;
  const getOrUndefined = getOrUndefineds[0]!;
  const orElseSucceed = orElseSucceeds[0]!;

  const g = `globalThis.${SERVER_MCP_GLOBAL}`;
  const injected =
    `\n\t${MARKER}if (${g}) yield* ${g}.register({ ` +
    `server: ${serverVar}, ` +
    `providerRegistry: ${getOrUndefined}(yield* ${serviceOption}(${providerRegistry})), ` +
    `CallToolResult: ${callToolResult}, ` +
    `emptyContext: ${emptyContext}, ` +
    `gen: ${gen}, ` +
    `orElseSucceed: ${orElseSucceed}` +
    ` });`;

  const at = anchor.index + anchor[0].length;
  const code = source.slice(0, at) + injected + source.slice(at);
  return {
    ok: true,
    code,
    detail: `layerToolExposure(${serverVar}) via ${gen}, ${callToolResult}, ${serviceOption}(${providerRegistry}), ${emptyContext}, ${orElseSucceed}`,
  };
}
