import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Reads our own TypeScript sources, which is how the checker knows which RPC
 * methods and which `data-slot` anchors first-party code actually depends on.
 */

const SOURCE_RE = /\.(ts|mts|tsx)$/i;
const SKIP_DIRS = new Set(["node_modules", "dist", "test", "tests", "__tests__"]);

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
      continue;
    }
    if (!SOURCE_RE.test(entry.name)) continue;
    if (/\.test\.tsx?$/.test(entry.name)) continue;
    out.push(full);
  }
}

/** Source files of the packages and plugins that make up the product. */
export function productSourceFiles(repoRoot: string): string[] {
  const out: string[] = [];
  for (const group of ["packages", "plugins"]) {
    const dir = join(repoRoot, group);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
      const src = join(dir, entry.name, "src");
      if (!existsSync(src) || !statSync(src).isDirectory()) continue;
      walk(src, out);
    }
  }
  return out;
}

export function readTexts(files: readonly string[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    try {
      out.push(readFileSync(file, "utf8"));
    } catch {
      // A file that disappears mid-run is not worth failing the report over.
    }
  }
  return out;
}
