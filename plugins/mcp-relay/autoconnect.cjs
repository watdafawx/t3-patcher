"use strict";

// Writes/removes the relay entry in each harness's own config file, so the user
// does not have to copy snippets around. Every write is idempotent, keeps a
// one-time *.t3p-backup copy and only ever touches the "t3-relay" entry.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { stripJsonc } = require("./discovery.cjs");

const ENTRY_KEY = "t3-relay";
const BACKUP_SUFFIX = ".t3p-backup";
const JSON_MARK_BEGIN = "// >>> t3p-mcp-relay (managed by T3 Patcher; remove from MCP Relay settings)";
const JSON_MARK_END = "// <<< t3p-mcp-relay";
const TOML_MARK_BEGIN = "# >>> t3p-mcp-relay (managed by T3 Patcher; remove from MCP Relay settings)";
const TOML_MARK_END = "# <<< t3p-mcp-relay";

function defaultTargets({ home = os.homedir(), appData = process.env.APPDATA || path.join(home, "AppData", "Roaming") } = {}) {
  const gemini = path.join(home, ".gemini");
  return [
    {
      id: "claude",
      label: "Claude Code",
      harness: "claude",
      scope: "global",
      format: "json",
      container: "mcpServers",
      entry: "claude",
      path: path.join(home, ".claude.json"),
    },
    {
      id: "claude-desktop",
      label: "Claude Desktop",
      harness: "claude-desktop",
      scope: "global",
      format: "json",
      container: "mcpServers",
      entry: "claude",
      path: path.join(appData, "Claude", "claude_desktop_config.json"),
    },
    {
      id: "opencode",
      label: "OpenCode",
      harness: "opencode",
      scope: "global",
      format: "jsonc",
      container: "mcp",
      entry: "opencode",
      path: path.join(home, ".config", "opencode", "opencode.jsonc"),
    },
    {
      id: "opencode-json",
      label: "OpenCode (json)",
      harness: "opencode",
      scope: "global",
      format: "jsonc",
      container: "mcp",
      entry: "opencode",
      path: path.join(home, ".config", "opencode", "opencode.json"),
    },
    {
      id: "codex",
      label: "Codex",
      harness: "codex",
      scope: "global",
      format: "toml",
      entry: "codex",
      path: path.join(home, ".codex", "config.toml"),
    },
    {
      id: "antigravity",
      label: "Antigravity",
      harness: "antigravity",
      scope: "global",
      format: "json",
      container: "mcpServers",
      entry: "antigravity",
      path: path.join(gemini, "antigravity", "mcp_config.json"),
    },
    {
      id: "antigravity-ide",
      label: "Antigravity IDE",
      harness: "antigravity",
      scope: "global",
      format: "json",
      container: "mcpServers",
      entry: "antigravity",
      path: path.join(gemini, "antigravity-ide", "mcp_config.json"),
    },
    {
      id: "antigravity-cli",
      label: "Antigravity CLI",
      harness: "antigravity",
      scope: "global",
      format: "json",
      container: "mcpServers",
      entry: "antigravity",
      path: path.join(gemini, "config", "mcp_config.json"),
    },
    {
      id: "cursor",
      label: "Cursor",
      harness: "cursor",
      scope: "global",
      format: "json",
      container: "mcpServers",
      entry: "cursor",
      path: path.join(home, ".cursor", "mcp.json"),
    },
  ];
}

function buildEntry(target, url) {
  const headers = { "x-t3p-harness": target.harness };
  switch (target.entry) {
    case "opencode":
      return { type: "remote", url, headers };
    case "antigravity":
      return { serverUrl: url, headers };
    case "codex":
      return null;
    case "cursor":
      return { url, headers };
    case "vscode":
      return { type: "http", url, headers };
    case "claude":
    default:
      return { type: "http", url, headers };
  }
}

function codexBlock(url, harness) {
  return [
    TOML_MARK_BEGIN,
    "[mcp_servers.t3-relay]",
    `url = "${url}"`,
    `http_headers = { "x-t3p-harness" = "${harness}" }`,
    TOML_MARK_END,
  ].join("\n");
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function parseJsonText(text) {
  const trimmed = text.trim();
  if (!trimmed) return {};
  return JSON.parse(stripJsonc(trimmed));
}

function backupOnce(filePath, text) {
  const backupPath = `${filePath}${BACKUP_SUFFIX}`;
  if (fs.existsSync(backupPath)) return backupPath;
  fs.writeFileSync(backupPath, text, "utf8");
  return backupPath;
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, "utf8");
}

function hasJsonEntry(doc, container) {
  if (!doc || typeof doc !== "object") return false;
  const bucket = doc[container];
  return Boolean(bucket && typeof bucket === "object" && bucket[ENTRY_KEY]);
}

function markerBlock(entry) {
  const body = JSON.stringify(entry, null, 2)
    .split("\n")
    .map((line, index) => (index === 0 ? `"${ENTRY_KEY}": ${line}` : `  ${line}`))
    .join("\n");
  return [JSON_MARK_BEGIN, body + ",", JSON_MARK_END].join("\n");
}

function upsertJsoncEntry(text, target, entry) {
  const block = markerBlock(entry);
  if (text.includes(JSON_MARK_BEGIN)) {
    const pattern = new RegExp(`${escapeRegExp(JSON_MARK_BEGIN)}[\\s\\S]*?${escapeRegExp(JSON_MARK_END)}`, "m");
    return text.replace(pattern, block);
  }
  const containerPattern = new RegExp(`("${escapeRegExp(target.container)}"\\s*:\\s*\\{)`);
  const match = containerPattern.exec(text);
  if (!match) {
    throw new Error(`no "${target.container}" object in ${target.path}; add "${target.container}": {} first`);
  }
  const insertAt = match.index + match[0].length;
  return `${text.slice(0, insertAt)}\n${block}\n${text.slice(insertAt)}`;
}

function removeJsoncEntry(text) {
  if (!text.includes(JSON_MARK_BEGIN)) return text;
  const pattern = new RegExp(`\\n?${escapeRegExp(JSON_MARK_BEGIN)}[\\s\\S]*?${escapeRegExp(JSON_MARK_END)}`, "m");
  const next = text.replace(pattern, "");
  // A container left with a single trailing comma is still valid JSONC, but tidy it.
  return next.replace(/([{,]\s*)\n(\s*)\}/g, "$1\n$2}");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function targetStatus(target) {
  const text = readText(target.path);
  if (text === null) {
    return { id: target.id, label: target.label, harness: target.harness, scope: target.scope, path: target.path, exists: false, connected: false, error: null };
  }
  try {
    if (target.format === "toml") {
      return {
        id: target.id,
        label: target.label,
        harness: target.harness,
        scope: target.scope,
        path: target.path,
        exists: true,
        connected: text.includes(TOML_MARK_BEGIN) || /^\s*\[mcp_servers\.t3-relay\]\s*$/m.test(text),
        error: null,
      };
    }
    if (target.format === "jsonc") {
      const connected = text.includes(JSON_MARK_BEGIN) || hasJsonEntry(parseJsonText(text), target.container);
      return { id: target.id, label: target.label, harness: target.harness, scope: target.scope, path: target.path, exists: true, connected, error: null };
    }
    return {
      id: target.id,
      label: target.label,
      harness: target.harness,
      scope: target.scope,
      path: target.path,
      exists: true,
      connected: hasJsonEntry(parseJsonText(text), target.container),
      error: null,
    };
  } catch (err) {
    return {
      id: target.id,
      label: target.label,
      harness: target.harness,
      scope: target.scope,
      path: target.path,
      exists: true,
      connected: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function connect(target, url) {
  const text = readText(target.path);
  if (text === null) return { id: target.id, changed: false, skipped: "file not found" };
  const entry = buildEntry(target, url);

  if (target.format === "toml") {
    const block = codexBlock(url, target.harness);
    if (text.includes(TOML_MARK_BEGIN)) {
      const pattern = new RegExp(`\\n?${escapeRegExp(TOML_MARK_BEGIN)}[\\s\\S]*?${escapeRegExp(TOML_MARK_END)}`, "m");
      const next = text.replace(pattern, `\n${block}`);
      if (next === text) return { id: target.id, changed: false };
      backupOnce(target.path, text);
      writeText(target.path, next.endsWith("\n") ? next : `${next}\n`);
      return { id: target.id, changed: true };
    }
    backupOnce(target.path, text);
    const separator = text.endsWith("\n") ? "\n" : "\n\n";
    writeText(target.path, `${text}${separator}${block}\n`);
    return { id: target.id, changed: true };
  }

  if (target.format === "jsonc") {
    const next = upsertJsoncEntry(text, target, entry);
    if (next === text) return { id: target.id, changed: false };
    backupOnce(target.path, text);
    writeText(target.path, next.endsWith("\n") ? next : `${next}\n`);
    return { id: target.id, changed: true };
  }

  const doc = parseJsonText(text);
  const current = doc[target.container] && doc[target.container][ENTRY_KEY];
  if (current && JSON.stringify(current) === JSON.stringify(entry)) {
    return { id: target.id, changed: false };
  }
  doc[target.container] = doc[target.container] && typeof doc[target.container] === "object" ? doc[target.container] : {};
  doc[target.container][ENTRY_KEY] = entry;
  backupOnce(target.path, text);
  writeText(target.path, `${JSON.stringify(doc, null, 2)}\n`);
  return { id: target.id, changed: true };
}

function disconnect(target) {
  const text = readText(target.path);
  if (text === null) return { id: target.id, changed: false, skipped: "file not found" };

  if (target.format === "toml") {
    if (!text.includes(TOML_MARK_BEGIN)) return { id: target.id, changed: false };
    const pattern = new RegExp(`\\n?${escapeRegExp(TOML_MARK_BEGIN)}[\\s\\S]*?${escapeRegExp(TOML_MARK_END)}\\n?`, "m");
    backupOnce(target.path, text);
    writeText(target.path, text.replace(pattern, "\n"));
    return { id: target.id, changed: true };
  }

  if (target.format === "jsonc") {
    if (!text.includes(JSON_MARK_BEGIN)) return { id: target.id, changed: false };
    backupOnce(target.path, text);
    writeText(target.path, removeJsoncEntry(text));
    return { id: target.id, changed: true };
  }

  const doc = parseJsonText(text);
  const bucket = doc[target.container];
  if (!bucket || typeof bucket !== "object" || !(ENTRY_KEY in bucket)) {
    return { id: target.id, changed: false };
  }
  delete bucket[ENTRY_KEY];
  backupOnce(target.path, text);
  writeText(target.path, `${JSON.stringify(doc, null, 2)}\n`);
  return { id: target.id, changed: true };
}

/**
 * @param {{ targets?: any[], url: string, home?: string }} opts
 */
function linkStatuses({ targets, url, home } = {}) {
  const list = targets || defaultTargets({ home });
  return { url, targets: list.map((target) => targetStatus(target)) };
}

/**
 * Connects or disconnects the relay entry on every target that exists.
 * @param {{ targets?: any[], url: string, action?: "connect" | "disconnect", home?: string }} opts
 */
function applyToAll({ targets, url, action = "connect", home } = {}) {
  const list = (targets || defaultTargets({ home })).filter((target) => fs.existsSync(target.path));
  const results = [];
  for (const target of list) {
    try {
      results.push(action === "disconnect" ? disconnect(target) : connect(target, url));
    } catch (err) {
      results.push({ id: target.id, changed: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

module.exports = {
  ENTRY_KEY,
  BACKUP_SUFFIX,
  defaultTargets,
  buildEntry,
  targetStatus,
  connect,
  disconnect,
  linkStatuses,
  applyToAll,
};
