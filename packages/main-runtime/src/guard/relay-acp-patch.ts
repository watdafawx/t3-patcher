/**
 * Server-side text patch that gives ACP sessions the local MCP Relay.
 *
 * Target, upstream `apps/server/src/provider/acp/AcpProviderAdapter.ts` (the runtime factory):
 *
 *   const sessionMcpServers = (initializeResult, activationOptions) => {
 *     const mcpCapabilities = initializeResult.agentCapabilities?.mcpCapabilities;
 *     ...
 *
 * which the server bundle (unminified ESM, `apps/server/dist/runtimeLayer-<hash>.mjs`) ships with
 * the same shape and parameter names. The injected statement asks `globalThis.__t3pRelayAcp` for a
 * list; `null` leaves T3's own answer untouched, so a missing relay or an agent without HTTP MCP
 * support changes nothing.
 *
 * Pure and electron-free: the server hook applies it, the tests and the compat checker run it too.
 */
import { RELAY_ACP_GLOBAL } from "./relay-acp.js";

/** Server chunks the hook looks at. */
export const SERVER_RELAY_FILE_RE = /(?:^|[\\/])apps[\\/]server[\\/]dist[\\/]runtimeLayer-[^\\/]*\.mjs$/;

/** `find`: plain text that must occur in exactly one server chunk. */
export const SERVER_RELAY_FIND = "const sessionMcpServers = ";

const ANCHOR_RE = /const sessionMcpServers = \(([\w$]+), ([\w$]+)\) => \{/g;
const MARKER = "/*t3p:relay-acp*/";

export type ServerRelayPatchResult =
  | { ok: true; code: string; detail: string }
  | { ok: false; reason: "no-anchor" | "ambiguous-anchor" | "already-patched"; detail: string };

function all(re: RegExp, source: string): RegExpExecArray[] {
  re.lastIndex = 0;
  const out: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.push(m);
  return out;
}

/** Applies the ACP relay patch to one server chunk. Never throws. */
export function applyServerRelayPatch(source: string): ServerRelayPatchResult {
  if (source.includes(MARKER)) {
    return { ok: false, reason: "already-patched", detail: "chunk already carries the ACP relay hook" };
  }
  const anchors = all(ANCHOR_RE, source);
  if (anchors.length === 0) {
    return { ok: false, reason: "no-anchor", detail: "const sessionMcpServers = (<init>, <activation>) => { not found" };
  }
  if (anchors.length > 1) {
    return { ok: false, reason: "ambiguous-anchor", detail: `sessionMcpServers anchor found ${anchors.length} times` };
  }

  const anchor = anchors[0]!;
  const init = anchor[1]!;
  const activation = anchor[2]!;
  const g = `globalThis.${RELAY_ACP_GLOBAL}`;
  const injected =
    `${MARKER}const t3pRelayPick = ${g} ? ${g}.pick(${init}, ${activation}, options) : null; if (t3pRelayPick) return t3pRelayPick;`;

  const at = anchor.index + anchor[0].length;
  return {
    ok: true,
    code: source.slice(0, at) + injected + source.slice(at),
    detail: `sessionMcpServers(${init}, ${activation})`,
  };
}
