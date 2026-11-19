import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Builds asar fixtures in a temp dir. Electron 44 writes the "new" layout (a
 * three-field pickle preamble); 4x-era asar writers used the "old" one. Both
 * are exercised because the checker reads whatever the user points it at.
 */

export interface AsarFixtureEntry {
  /** Archive path with forward slashes. */
  path: string;
  data: string;
}

interface TreeNode {
  files?: Record<string, TreeNode>;
  size?: number;
  offset?: string;
}

function buildTree(entries: AsarFixtureEntry[]): { tree: TreeNode; data: Buffer } {
  const tree: TreeNode = { files: {} };
  const chunks: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const parts = entry.path.split("/");
    const name = parts.pop()!;
    let node = tree;
    for (const part of parts) {
      node.files ??= {};
      node.files[part] ??= { files: {} };
      node = node.files[part]!;
    }
    node.files ??= {};
    const data = Buffer.from(entry.data, "utf8");
    node.files[name] = { size: data.length, offset: String(offset) };
    chunks.push(data);
    offset += data.length;
  }

  return { tree, data: Buffer.concat(chunks) };
}

function oldLayout(header: string, data: Buffer): Buffer {
  const json = Buffer.from(header, "utf8");
  const preamble = Buffer.alloc(8);
  preamble.writeUInt32LE(4, 0);
  preamble.writeUInt32LE(json.length, 4);
  return Buffer.concat([preamble, json, data]);
}

function newLayout(header: string, data: Buffer): Buffer {
  const json = Buffer.from(header, "utf8");
  const headerSize = 8 + json.length;
  const preamble = Buffer.alloc(16);
  preamble.writeUInt32LE(4, 0);
  preamble.writeUInt32LE(headerSize, 4);
  preamble.writeUInt32LE(headerSize - 4, 8);
  preamble.writeUInt32LE(json.length, 12);
  const padding = Buffer.alloc((4 - (json.length % 4)) % 4);
  return Buffer.concat([preamble, json, padding, data]);
}

/** Writes an asar fixture and returns its path. */
export function writeAsarFixture(
  dir: string,
  name: string,
  entries: AsarFixtureEntry[],
  layout: "old" | "new" = "new",
): string {
  const { tree, data } = buildTree(entries);
  const header = JSON.stringify(tree);
  const bytes = layout === "old" ? oldLayout(header, data) : newLayout(header, data);
  const file = join(dir, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return file;
}

/** The entries of a minimal shipped `server.asar`: client plus a server chunk. */
export function serverAsarEntries(options: {
  indexHtml?: string;
  chunks?: Record<string, string>;
  server?: string;
} = {}): AsarFixtureEntry[] {
  const chunks = options.chunks ?? {
    "assets/a.js": "export const a = 1;\n",
    "assets/b.js": "export const b = 2;\n",
  };
  const entries: AsarFixtureEntry[] = [
    { path: "apps/server/package.json", data: JSON.stringify({ name: "t3code-server", version: "9.9.9" }) },
    {
      path: "apps/server/dist/client/index.html",
      data: options.indexHtml ?? '<!doctype html><div data-slot="sidebar-content"></div>',
    },
  ];
  for (const [name, source] of Object.entries(chunks)) {
    entries.push({ path: `apps/server/dist/client/${name}`, data: source });
  }
  entries.push({
    path: "apps/server/dist/server-abc.mjs",
    data: options.server ?? 'var T={serverGetConfig:"server.getConfig"};',
  });
  return entries;
}
