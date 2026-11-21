"use strict";

// Discovers MCP servers already configured in the harnesses on this machine
// (Claude Code, Claude Desktop, OpenCode, Codex, Cursor, VS Code).
//
// Discovery never copies secrets: imported servers keep a `source` reference
// (harness + config file + entry name) and env/headers are read at spawn time.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");

const HARNESS_LABELS = {
  claude: "Claude Code",
  "claude-desktop": "Claude Desktop",
  opencode: "OpenCode",
  codex: "Codex",
  cursor: "Cursor",
  vscode: "VS Code",
  antigravity: "Antigravity",
};

const KNOWN_HARNESSES = Object.keys(HARNESS_LABELS);

/**
 * @typedef {{ harness: string, scope: "global" | "project", path: string, format: "json" | "toml", kind: string }} SourceRef
 * @typedef {{ harness: string, scope: "global" | "project", path: string, format: "json" | "toml", kind: string, name: string }} ServerSource
 */

function defaultSources({ home = os.homedir(), cwd = process.cwd() } = {}) {
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  return [
    { harness: "claude", scope: "global", format: "json", kind: "mcpServers", path: path.join(home, ".claude.json") },
    {
      harness: "claude-desktop",
      scope: "global",
      format: "json",
      kind: "mcpServers",
      path: path.join(appData, "Claude", "claude_desktop_config.json"),
    },
    {
      harness: "opencode",
      scope: "global",
      format: "json",
      kind: "mcp",
      path: path.join(home, ".config", "opencode", "opencode.jsonc"),
    },
    {
      harness: "opencode",
      scope: "global",
      format: "json",
      kind: "mcp",
      path: path.join(home, ".config", "opencode", "opencode.json"),
    },
    { harness: "codex", scope: "global", format: "toml", kind: "mcp_servers", path: path.join(home, ".codex", "config.toml") },
    { harness: "claude", scope: "project", format: "json", kind: "mcpServers", path: path.join(cwd, ".mcp.json") },
    { harness: "codex", scope: "project", format: "toml", kind: "mcp_servers", path: path.join(cwd, ".codex", "config.toml") },
    { harness: "vscode", scope: "project", format: "json", kind: "servers", path: path.join(cwd, ".vscode", "mcp.json") },
    { harness: "cursor", scope: "project", format: "json", kind: "mcpServers", path: path.join(cwd, ".cursor", "mcp.json") },
    { harness: "antigravity", scope: "global", format: "json", kind: "mcpServers", path: path.join(home, ".gemini", "antigravity", "mcp_config.json") },
    { harness: "antigravity", scope: "global", format: "json", kind: "mcpServers", path: path.join(home, ".gemini", "antigravity-ide", "mcp_config.json") },
    { harness: "antigravity", scope: "global", format: "json", kind: "mcpServers", path: path.join(home, ".gemini", "config", "mcp_config.json") },
  ];
}

// ---------------------------------------------------------------------------
// JSON / JSONC
// ---------------------------------------------------------------------------

function stripJsonc(text) {
  let out = "";
  let inString = false;
  let quote = "";
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next === undefined ? "" : next;
        i += 2;
        continue;
      }
      if (ch === quote) inString = false;
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }

    out += ch;
    i += 1;
  }

  return stripTrailingCommas(out);
}

function stripTrailingCommas(text) {
  let out = "";
  let inString = false;
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += text[i + 1] ?? "";
        i += 1;
        continue;
      }
      if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += ch;
  }
  return out;
}

// ---------------------------------------------------------------------------
// TOML (subset: tables, dotted + quoted keys, strings, numbers, booleans,
// arrays and inline tables — enough for Codex mcp_servers blocks)
// ---------------------------------------------------------------------------

function parseToml(text) {
  const root = {};
  let table = root;
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (header) {
      const keys = splitKeyPath(header[1]);
      table = root;
      for (const key of keys) {
        if (!table[key] || typeof table[key] !== "object") table[key] = {};
        table = table[key];
      }
      continue;
    }

    // Multi-line arrays: keep appending until brackets balance.
    while (!balanced(line) && i + 1 < lines.length) {
      i += 1;
      line += "\n" + lines[i];
    }

    const eq = findTopLevelEquals(line);
    if (eq < 0) continue;
    const keyPart = line.slice(0, eq).trim();
    const valuePart = line.slice(eq + 1).trim();
    const keys = splitKeyPath(keyPart);
    if (keys.length === 0) continue;
    let target = table;
    for (const key of keys.slice(0, -1)) {
      if (!target[key] || typeof target[key] !== "object") target[key] = {};
      target = target[key];
    }
    target[keys[keys.length - 1]] = parseTomlValue(stripTomlComment(valuePart));
  }

  return root;
}

function balanced(line) {
  let depth = 0;
  let inString = false;
  let quote = "";
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
    } else if (ch === "[" || ch === "{") depth += 1;
    else if (ch === "]" || ch === "}") depth -= 1;
  }
  return depth <= 0;
}

function stripTomlComment(value) {
  let inString = false;
  let quote = "";
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
    } else if (ch === "#") {
      return value.slice(0, i).trim();
    }
  }
  return value.trim();
}

function findTopLevelEquals(line) {
  let inString = false;
  let quote = "";
  let depth = 0;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
    } else if (ch === "[" || ch === "{") depth += 1;
    else if (ch === "]" || ch === "}") depth -= 1;
    else if (ch === "=" && depth === 0) return i;
  }
  return -1;
}

function splitKeyPath(text) {
  const keys = [];
  let current = "";
  let inString = false;
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") {
        current += text[i + 1] ?? "";
        i += 1;
      } else if (ch === quote) {
        inString = false;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
    } else if (ch === ".") {
      if (current.trim()) keys.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) keys.push(current.trim());
  return keys;
}

function parseTomlValue(text) {
  const value = text.trim();
  if (!value) return "";

  if (value.startsWith('"') || value.startsWith("'")) {
    const quote = value[0];
    let raw = "";
    for (let i = 1; i < value.length; i += 1) {
      const ch = value[i];
      if (quote === '"' && ch === "\\") {
        raw += value[i] + (value[i + 1] ?? "");
        i += 1;
        continue;
      }
      if (ch === quote) break;
      raw += ch;
    }
    if (quote === "'") return raw;
    try {
      return JSON.parse(`"${raw}"`);
    } catch {
      return raw;
    }
  }

  if (value === "true") return true;
  if (value === "false") return false;
  if (/^[+-]?\d+(\.\d+)?$/.test(value)) return Number(value);

  if (value.startsWith("[")) {
    const inner = value.slice(1, value.lastIndexOf("]"));
    return splitTopLevel(inner).map((part) => parseTomlValue(part)).filter((v) => v !== undefined);
  }

  if (value.startsWith("{")) {
    const inner = value.slice(1, value.lastIndexOf("}"));
    const obj = {};
    for (const part of splitTopLevel(inner)) {
      const eq = findTopLevelEquals(part);
      if (eq < 0) continue;
      const keys = splitKeyPath(part.slice(0, eq));
      if (keys.length === 0) continue;
      obj[keys[keys.length - 1]] = parseTomlValue(part.slice(eq + 1));
    }
    return obj;
  }

  return value.replace(/,$/, "");
}

function splitTopLevel(text) {
  const parts = [];
  let current = "";
  let inString = false;
  let quote = "";
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      current += ch;
      if (ch === "\\") {
        current += text[i + 1] ?? "";
        i += 1;
      } else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      current += ch;
    } else if (ch === "[" || ch === "{") {
      depth += 1;
      current += ch;
    } else if (ch === "]" || ch === "}") {
      depth -= 1;
      current += ch;
    } else if (ch === "," && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

// ---------------------------------------------------------------------------
// Harness config -> relay config
// ---------------------------------------------------------------------------

function expandString(value, env) {
  return String(value)
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name, fallback) => {
      const found = env[name];
      if (found !== undefined) return found;
      return fallback === undefined ? "" : fallback;
    })
    .replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name) => {
      const found = env[name];
      return found === undefined ? "" : found;
    });
}

function expandMap(map, env) {
  if (!map || typeof map !== "object") return undefined;
  const out = {};
  for (const [key, value] of Object.entries(map)) {
    if (value === undefined || value === null) continue;
    out[String(key)] = expandString(value, env);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function stringList(value, env) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.filter((v) => v !== undefined && v !== null).map((v) => expandString(v, env));
}

/**
 * Converts one harness entry into relay-ish fields (no ids, no defaults).
 * @param {string} harness
 * @param {any} entry
 * @param {Record<string, string | undefined>} env
 */
function parseHarnessEntry(harness, entry, env = process.env) {
  if (!entry || typeof entry !== "object") return null;

  const type = String(entry.type || "").toLowerCase();
  const rawUrl = typeof entry.url === "string" && entry.url.trim() !== "" ? entry.url : entry.serverUrl;
  const hasUrl = typeof rawUrl === "string" && rawUrl.trim() !== "";
  const isHttp = hasUrl || type === "http" || type === "remote" || type === "sse";

  if (isHttp) {
    const url = expandString(rawUrl || "", env).trim();
    if (!url) return null;
    let headers = expandMap(entry.headers || entry.http_headers, env);
    if (harness === "codex" && typeof entry.bearer_token_env_var === "string" && entry.bearer_token_env_var.trim()) {
      const tokenVar = entry.bearer_token_env_var.trim();
      const token = env[tokenVar];
      if (token) {
        headers = { ...(headers || {}), Authorization: `Bearer ${token}` };
      }
    }
    return {
      transport: "http",
      url,
      headers,
      envKeys: [],
      headerKeys: headers ? Object.keys(headers) : [],
    };
  }

  // OpenCode stores command + args as a single array; Claude/Codex split them.
  let command = entry.command;
  let args = Array.isArray(entry.args) ? entry.args : [];
  if (Array.isArray(command)) {
    const [head, ...rest] = command;
    command = head;
    args = [...rest, ...args];
  }

  if (typeof command !== "string" || !command.trim()) return null;

  const rawEnv = entry.env || entry.environment;
  const expandedEnv = expandMap(rawEnv, env);

  return {
    transport: "stdio",
    command: expandString(command, env).trim(),
    args: stringList(args, env),
    env: expandedEnv,
    cwd: typeof entry.cwd === "string" && entry.cwd.trim() ? expandString(entry.cwd, env).trim() : undefined,
    envKeys: expandedEnv ? Object.keys(expandedEnv) : [],
    headerKeys: [],
  };
}

function extractEntries(doc, source) {
  if (!doc || typeof doc !== "object") return new Map();

  const container = doc[source.kind];
  if (!container || typeof container !== "object") return new Map();

  const map = new Map();
  for (const [name, entry] of Object.entries(container)) {
    if (!entry || typeof entry !== "object") continue;
    map.set(name, entry);
  }
  return map;
}

function readSource(source) {
  const text = fs.readFileSync(source.path, "utf8");
  return source.format === "toml" ? parseToml(text) : JSON.parse(stripJsonc(text));
}

function sourceLabel(source) {
  const label = HARNESS_LABELS[source.harness] || source.harness;
  return source.scope === "project" ? `${label} (project)` : label;
}

function sanitizeId(name, taken = new Set()) {
  let base = String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  if (!base) base = "server";
  if (!/^[a-z0-9]/.test(base)) base = `s-${base}`;
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function identityOf(parsed) {
  if (parsed.transport === "http") return `http|${parsed.url.trim().toLowerCase()}`;
  return `stdio|${parsed.command}|${(parsed.args || []).join("\u0000")}|${parsed.cwd || ""}`;
}

function candidateKey(identity) {
  return createHash("sha256").update(identity).digest("hex").slice(0, 16);
}

const HINTS = [
  {
    test: /browsermcp/i,
    message: "Browser MCP needs its browser extension; it may not work when the relay spawns it.",
  },
  {
    test: /[?&]token=|--api-key|--token/i,
    message: "Arguments look like they contain a credential. Move it to an env var if possible.",
  },
];

function hintsFor(parsed) {
  const hay = [parsed.command || "", ...(parsed.args || []), parsed.url || ""].join(" ");
  const hints = [];
  for (const rule of HINTS) if (rule.test.test(hay)) hints.push(rule.message);
  return hints;
}

/**
 * Scans every known harness config and returns deduplicated candidates.
 * Secrets (env/header values) are never returned — only their key names.
 *
 * @param {{ home?: string, cwd?: string, env?: Record<string, string | undefined>, sources?: SourceRef[] }} [opts]
 */
function discoverHarnessServers({ home = os.homedir(), cwd = process.cwd(), env = process.env, sources } = {}) {
  const allSources = sources || defaultSources({ home, cwd });
  const warnings = [];
  /** @type {Array<any>} */
  const found = [];

  for (const source of allSources) {
    try {
      if (!fs.existsSync(source.path)) continue;
    } catch {
      continue;
    }

    let doc;
    try {
      doc = readSource(source);
    } catch (err) {
      warnings.push({
        harness: source.harness,
        path: source.path,
        message: `Could not parse: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    const entries = extractEntries(doc, source);
    for (const [name, entry] of entries) {
      // Never offer the relay itself as something to relay.
      if (name === "t3-relay") continue;
      const parsed = parseHarnessEntry(source.harness, entry, env);
      if (!parsed) {
        warnings.push({ harness: source.harness, path: source.path, message: `Skipped "${name}": unsupported entry` });
        continue;
      }

      const entryWarnings = [...hintsFor(parsed)];
      if (entry.enabled === false) entryWarnings.push(`Disabled in ${HARNESS_LABELS[source.harness] || source.harness}.`);
      if (String(entry.type || "").toLowerCase() === "sse") {
        entryWarnings.push("Configured as SSE; the relay connects with Streamable HTTP, which usually still works.");
      }

      found.push({
        ...parsed,
        name,
        displayName: name,
        source: { ...source, name },
        sourceLabel: sourceLabel(source),
        warnings: entryWarnings,
      });
    }
  }

  // Claude Code keeps per-project servers in ~/.claude.json under `projects`.
  try {
    const claudeJson = path.join(home, ".claude.json");
    if (fs.existsSync(claudeJson)) {
      const doc = JSON.parse(stripJsonc(fs.readFileSync(claudeJson, "utf8")));
      const normalizedCwd = normalizeProjectPath(cwd);
      for (const [projectPath, project] of Object.entries(doc.projects || {})) {
        if (normalizeProjectPath(projectPath) !== normalizedCwd) continue;
        for (const [name, entry] of Object.entries(project.mcpServers || {})) {
          if (name === "t3-relay") continue;
          const parsed = parseHarnessEntry("claude", entry, env);
          if (!parsed) continue;
          const entryWarnings = [...hintsFor(parsed)];
          if (entry.enabled === false) entryWarnings.push("Disabled in Claude Code.");
          found.push({
            ...parsed,
            name,
            displayName: name,
            source: { harness: "claude", scope: "project", path: claudeJson, format: "json", kind: "projects", projectPath, name },
            sourceLabel: `${HARNESS_LABELS.claude} (project: ${path.basename(projectPath)})`,
            warnings: entryWarnings,
          });
        }
      }
    }
  } catch (err) {
    warnings.push({
      harness: "claude",
      path: path.join(home, ".claude.json"),
      message: `Could not read project servers: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return { candidates: dedupeCandidates(found), warnings };
}

function normalizeProjectPath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function dedupeCandidates(found) {
  /** @type {Map<string, any>} */
  const groups = new Map();
  for (const item of found) {
    const identity = identityOf(item);
    const key = candidateKey(identity);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { ...item, key, origins: [item.source] });
      continue;
    }
    existing.origins.push(item.source);
    existing.warnings = Array.from(new Set([...existing.warnings, ...item.warnings]));
    existing.envKeys = Array.from(new Set([...existing.envKeys, ...item.envKeys]));
    existing.headerKeys = Array.from(new Set([...existing.headerKeys, ...item.headerKeys]));
  }

  const taken = new Set();
  const candidates = [];
  for (const candidate of groups.values()) {
    const suggestedId = sanitizeId(candidate.name, taken);
    taken.add(suggestedId);
    candidates.push({
      key: candidate.key,
      name: candidate.displayName || candidate.name,
      suggestedId,
      transport: candidate.transport,
      command: candidate.command,
      args: candidate.args || [],
      cwd: candidate.cwd,
      url: candidate.url,
      envKeys: candidate.envKeys || [],
      headerKeys: candidate.headerKeys || [],
      origins: candidate.origins.map((origin) => ({
        harness: origin.harness,
        scope: origin.scope,
        path: origin.path,
        format: origin.format,
        kind: origin.kind,
        name: origin.name,
        projectPath: origin.projectPath,
        label: sourceLabel(origin),
      })),
      warnings: candidate.warnings,
    });
  }
  candidates.sort((a, b) => a.suggestedId.localeCompare(b.suggestedId));
  return candidates;
}

function normalizeSourceRef(raw) {
  if (!raw || typeof raw !== "object") throw new Error("source must be an object");
  const harness = String(raw.harness || "").trim();
  const filePath = String(raw.path || "").trim();
  const kind = String(raw.kind || "").trim();
  const name = String(raw.name || "").trim();
  if (!harness || !filePath || !kind || !name) {
    throw new Error("source needs harness, path, kind and name");
  }
  return {
    harness,
    scope: raw.scope === "project" ? "project" : "global",
    path: filePath,
    format: raw.format === "toml" ? "toml" : "json",
    kind,
    name,
    ...(raw.projectPath ? { projectPath: String(raw.projectPath) } : {}),
  };
}

function extractSourceEntries(doc, source) {
  if (source.kind === "projects") {
    const project = doc.projects && source.projectPath ? doc.projects[source.projectPath] : null;
    return new Map(Object.entries((project && project.mcpServers) || {}));
  }
  return extractEntries(doc, source);
}

/**
 * Re-reads a source config and returns fresh connection fields, so secrets
 * stay in the harness config and are only resolved in memory at spawn time.
 *
 * @param {ServerSource} source
 * @param {Record<string, string | undefined>} [env]
 */
function resolveSourceEntry(source, env = process.env) {
  const normalized = normalizeSourceRef(source);
  const doc = readSource(normalized);
  const entries = extractSourceEntries(doc, normalized);
  const entry = entries.get(normalized.name);
  if (!entry || typeof entry !== "object") {
    throw new Error(`"${normalized.name}" is no longer defined in ${sourceLabel(normalized)} (${normalized.path})`);
  }
  const parsed = parseHarnessEntry(normalized.harness, entry, env);
  if (!parsed) throw new Error(`"${normalized.name}" in ${sourceLabel(normalized)} is not a supported MCP entry`);
  return parsed;
}

/**
 * Builds the relay config for an imported candidate. No env/header values are
 * copied; only a `source` reference plus a non-secret snapshot for display.
 *
 * @param {any} candidate
 * @param {{ id?: string, sourceIndex?: number, harnesses?: string[], mode?: "shared" | "session", pinnedTools?: string[], enabled?: boolean }} [opts]
 */
function candidateToServerConfig(candidate, opts = {}) {
  if (!candidate || typeof candidate !== "object" || !Array.isArray(candidate.origins) || candidate.origins.length === 0) {
    throw new Error("Invalid discovery candidate");
  }
  const sourceIndex = Number.isInteger(opts.sourceIndex) ? opts.sourceIndex : 0;
  const origin = candidate.origins[sourceIndex] || candidate.origins[0];
  return {
    id: String(opts.id || candidate.suggestedId || candidate.name).trim(),
    name: String(candidate.name),
    transport: candidate.transport === "http" ? "http" : "stdio",
    mode: opts.mode === "session" ? "session" : "shared",
    enabled: opts.enabled !== false,
    harnesses: Array.isArray(opts.harnesses) ? opts.harnesses : [],
    pinnedTools: Array.isArray(opts.pinnedTools) ? opts.pinnedTools : [],
    source: normalizeSourceRef(origin),
    ...(candidate.transport === "http"
      ? { url: String(candidate.url || "") }
      : { command: String(candidate.command || ""), args: Array.isArray(candidate.args) ? candidate.args.map(String) : [], ...(candidate.cwd ? { cwd: String(candidate.cwd) } : {}) }),
  };
}

module.exports = {
  HARNESS_LABELS,
  KNOWN_HARNESSES,
  defaultSources,
  discoverHarnessServers,
  candidateToServerConfig,
  resolveSourceEntry,
  normalizeSourceRef,
  parseHarnessEntry,
  parseToml,
  stripJsonc,
  expandString,
  sanitizeId,
  identityOf,
  candidateKey,
  sourceLabel,
};
