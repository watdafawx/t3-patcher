/**
 * Adds the local MCP Relay to ACP provider sessions (Antigravity and any other flavor that uses
 * HTTP MCP servers). T3 Code builds one MCP list per ACP session in `sessionMcpServers` and passes
 * only its own `t3-code` server, so a harness-level config file is never read for these sessions.
 *
 * Installed by the server hook as `globalThis.__t3pRelayAcp`; the text patch in
 * `relay-acp-patch.ts` calls `pick()` while the session is being created. Reads the relay's own
 * config (`~/.t3-patcher/mcp-relay/config.json`) on every call, so add/remove/toggle stays live and
 * a missing relay is simply a no-op.
 *
 * Pure and electron-free apart from `node:fs`/`node:os`, like the rest of `src/guard`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The global the server hook installs. */
export const RELAY_ACP_GLOBAL = "__t3pRelayAcp";

/** Set to `0` to leave ACP sessions untouched. */
export const RELAY_ACP_DISABLE_ENV = "T3P_RELAY_ACP";

/** Optional override of the relay config path (tests, other profiles). */
export const RELAY_ACP_CONFIG_ENV = "T3P_MCP_RELAY_CONFIG";

/** Optional override of the relay URL (wins over the config file). */
export const RELAY_ACP_URL_ENV = "T3P_MCP_RELAY_URL";

export const RELAY_DEFAULT_PORT = 39393;
const RELAY_DEFAULT_HOST = "127.0.0.1";
/** Harness id reported to the relay; every server exposed to "all" is visible. */
const RELAY_ACP_HARNESS = "acp";
const RELAY_ACP_NAME = "t3-relay";
const RELAY_ACP_HEADER = "x-t3p-harness";

type Json = Record<string, unknown>;

export interface AcpRelayPicker {
  /** Returns the MCP list to use, or `null` to leave T3's own choice untouched. */
  pick(initializeResult: unknown, activationOptions: unknown, options: unknown): unknown[] | null;
}

export function relayConfigPath(): string {
  return process.env[RELAY_ACP_CONFIG_ENV]?.trim()
    || path.join(os.homedir(), ".t3-patcher", "mcp-relay", "config.json");
}

/** Reads the relay URL from the env override or the relay's config file. Never throws. */
export function readRelayUrl(): string | null {
  const explicit = process.env[RELAY_ACP_URL_ENV]?.trim();
  if (explicit) return /^https?:\/\//i.test(explicit) ? explicit : null;
  try {
    const raw = JSON.parse(fs.readFileSync(relayConfigPath(), "utf8")) as Json;
    const port = Number(raw.port);
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) return null;
    const host = typeof raw.host === "string" && raw.host.trim() ? raw.host.trim() : RELAY_DEFAULT_HOST;
    return `http://${host}:${port}/mcp`;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Json | null {
  return value !== null && typeof value === "object" ? (value as Json) : null;
}

function mcpList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function namedServer(value: unknown): boolean {
  const entry = asRecord(value);
  return entry !== null && entry.name === RELAY_ACP_NAME;
}

/**
 * `pick` is called at the top of T3's `sessionMcpServers(initializeResult, activationOptions)`.
 * It only acts when the agent advertised HTTP MCP support *and* T3 itself put HTTP servers in the
 * list (its `mcpOverHttp` flavors, which includes Antigravity). It then appends the relay, so the
 * agent sees `t3-code` plus `t3-relay`.
 */
export function createAcpRelayPicker(options: { readUrl?: () => string | null } = {}): AcpRelayPicker {
  const readUrl = options.readUrl ?? readRelayUrl;

  return {
    pick(initializeResult, activationOptions, sessionOptions) {
      const init = asRecord(initializeResult);
      const capabilities = asRecord(asRecord(init?.agentCapabilities)?.mcpCapabilities);
      if (capabilities?.http !== true) return null;

      const activation = asRecord(activationOptions);
      const session = asRecord(sessionOptions);
      const httpServers = mcpList(
        (activation && activation.httpMcpServers) ?? (session && session.httpMcpServers),
      );
      if (httpServers.length === 0) return null;
      if (httpServers.some(namedServer)) return null;

      const url = readUrl();
      if (!url) return null;

      return [
        ...httpServers,
        {
          type: "http",
          name: RELAY_ACP_NAME,
          url,
          headers: [{ name: RELAY_ACP_HEADER, value: RELAY_ACP_HARNESS }],
        },
      ];
    },
  };
}
