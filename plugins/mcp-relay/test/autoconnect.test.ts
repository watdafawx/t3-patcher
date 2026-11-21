import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

interface Target {
  id: string;
  label: string;
  harness: string;
  scope: "global" | "project";
  format: "json" | "jsonc" | "toml";
  container?: string;
  entry: string;
  path: string;
}

const { connect, disconnect, targetStatus, linkStatuses, applyToAll, defaultTargets, buildEntry } = require("../autoconnect.cjs") as {
  connect(target: Target, url: string): { id: string; changed: boolean; skipped?: string };
  disconnect(target: Target): { id: string; changed: boolean; skipped?: string };
  targetStatus(target: Target): { exists: boolean; connected: boolean; error: string | null };
  linkStatuses(opts?: { targets?: Target[]; url: string }): {
    targets: Array<{ id: string; label: string; harness: string; scope: string; path: string; exists: boolean; connected: boolean; error: string | null }>;
  };
  applyToAll(opts: { targets: Target[]; url: string; action?: "connect" | "disconnect" }): Array<{ id: string; changed: boolean; error?: string }>;
  defaultTargets(opts?: { home?: string; cwd?: string; appData?: string }): Target[];
  buildEntry(target: Target, url: string): Record<string, unknown> | null;
};

const temps: string[] = [];

function makeDir(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3p-link-"));
  temps.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }
  return dir;
}

function target(dir: string, overrides: Partial<Target> = {}): Target {
  return {
    id: "claude",
    label: "Claude Code",
    harness: "claude",
    scope: "global",
    format: "json",
    container: "mcpServers",
    entry: "claude",
    path: path.join(dir, ".claude.json"),
    ...overrides,
  };
}

const URL = "http://127.0.0.1:39393/mcp";

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

describe("harness auto-connect", () => {
  it("adds a Claude entry, backs the file up once and is idempotent", () => {
    const dir = makeDir({
      ".claude.json": JSON.stringify({ mcpServers: { mine: { command: "node", args: ["x.js"] } }, other: 1 }, null, 2),
    });
    const t = target(dir);

    expect(targetStatus(t).connected).toBe(false);
    expect(connect(t, URL).changed).toBe(true);

    const doc = JSON.parse(fs.readFileSync(t.path, "utf8"));
    expect(Object.keys(doc.mcpServers).sort()).toEqual(["mine", "t3-relay"]);
    expect(doc.other).toBe(1);
    expect(doc.mcpServers["t3-relay"]).toEqual({
      type: "http",
      url: URL,
      headers: { "x-t3p-harness": "claude" },
    });
    expect(targetStatus(t).connected).toBe(true);

    const backup = `${t.path}.t3p-backup`;
    expect(fs.existsSync(backup)).toBe(true);
    const backupDoc = JSON.parse(fs.readFileSync(backup, "utf8"));
    expect(backupDoc.mcpServers["t3-relay"]).toBeUndefined();

    expect(connect(t, URL).changed).toBe(false);
    expect(targetStatus(t).connected).toBe(true);

    // Changing the URL rewrites the entry.
    expect(connect(t, "http://127.0.0.1:40000/mcp").changed).toBe(true);
    const updated = JSON.parse(fs.readFileSync(t.path, "utf8"));
    expect(updated.mcpServers["t3-relay"].url).toBe("http://127.0.0.1:40000/mcp");

    expect(disconnect(t).changed).toBe(true);
    const after = JSON.parse(fs.readFileSync(t.path, "utf8"));
    expect(Object.keys(after.mcpServers)).toEqual(["mine"]);
    expect(targetStatus(t).connected).toBe(false);
  });

  it("writes an empty Antigravity config without breaking it", () => {
    const dir = makeDir({ "mcp_config.json": "" });
    const t = target(dir, {
      id: "antigravity",
      label: "Antigravity",
      harness: "antigravity",
      entry: "antigravity",
      path: path.join(dir, "mcp_config.json"),
    });

    expect(connect(t, URL).changed).toBe(true);
    const doc = JSON.parse(fs.readFileSync(t.path, "utf8"));
    expect(doc.mcpServers["t3-relay"]).toEqual({ serverUrl: URL, headers: { "x-t3p-harness": "antigravity" } });
    expect(buildEntry(t, URL)).toEqual({ serverUrl: URL, headers: { "x-t3p-harness": "antigravity" } });
  });

  it("appends and removes a marked TOML block for Codex without touching the rest", () => {
    const dir = makeDir({ "config.toml": '[mcp_servers.mine]\ncommand = "node"\n' });
    const t = target(dir, { id: "codex", label: "Codex", harness: "codex", format: "toml", entry: "codex", path: path.join(dir, "config.toml") });

    expect(connect(t, URL).changed).toBe(true);
    const text = fs.readFileSync(t.path, "utf8");
    expect(text).toContain('[mcp_servers.mine]\ncommand = "node"');
    expect(text).toContain("# >>> t3p-mcp-relay");
    expect(text).toContain(`url = "${URL}"`);
    expect(text).toContain('http_headers = { "x-t3p-harness" = "codex" }');
    expect(targetStatus(t).connected).toBe(true);

    expect(connect(t, URL).changed).toBe(false);
    expect((text.match(/\[mcp_servers\.t3-relay\]/g) ?? []).length).toBe(1);

    expect(disconnect(t).changed).toBe(true);
    const after = fs.readFileSync(t.path, "utf8");
    expect(after).toContain('[mcp_servers.mine]');
    expect(after).not.toContain("t3-relay");
    expect(targetStatus(t).connected).toBe(false);
  });

  it("edits OpenCode JSONC in place, keeping comments and other servers", () => {
    const dir = makeDir({
      "opencode.jsonc": `{
  // my comment
  "mcp": {
    "other": { "type": "local", "command": ["bunx", "thing"] }
  }
}
`,
    });
    const t = target(dir, {
      id: "opencode",
      label: "OpenCode",
      harness: "opencode",
      format: "jsonc",
      container: "mcp",
      entry: "opencode",
      path: path.join(dir, "opencode.jsonc"),
    });

    expect(connect(t, URL).changed).toBe(true);
    const text = fs.readFileSync(t.path, "utf8");
    expect(text).toContain("// my comment");
    expect(text).toContain('"t3-relay": {');
    expect(text).toContain('"type": "remote"');
    expect(text).toContain('"x-t3p-harness": "opencode"');
    expect(targetStatus(t).connected).toBe(true);

    expect(connect(t, URL).changed).toBe(false);
    expect((text.match(/"t3-relay"/g) ?? []).length).toBe(1);

    expect(disconnect(t).changed).toBe(true);
    const after = fs.readFileSync(t.path, "utf8");
    expect(after).toContain("// my comment");
    expect(after).toContain('"other"');
    expect(after).not.toContain("t3-relay");
    expect(targetStatus(t).connected).toBe(false);
  });

  it("skips missing files and reports every target", () => {
    const dir = makeDir();
    const t = target(dir, { path: path.join(dir, "nope.json") });
    expect(connect(t, URL)).toEqual({ id: "claude", changed: false, skipped: "file not found" });

    const links = linkStatuses({ url: URL, targets: [t] });
    expect(links.targets).toEqual([
      { id: "claude", label: "Claude Code", harness: "claude", scope: "global", path: t.path, exists: false, connected: false, error: null },
    ]);

    const results = applyToAll({ targets: [t], url: URL, action: "connect" });
    expect(results).toEqual([]);
  });

  it("exposes one target per known harness, including Antigravity", () => {
    const home = makeDir();
    const ids = defaultTargets({ home, cwd: home, appData: home }).map((t) => t.id);
    for (const id of ["claude", "claude-desktop", "opencode", "codex", "antigravity", "antigravity-ide", "cursor"]) {
      expect(ids).toContain(id);
    }
  });
});
