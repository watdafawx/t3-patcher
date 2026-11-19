import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { BaselineMethod, MethodKind } from "./methods.js";

/**
 * Source-checkout fallback: when the installer cannot be fetched (no network
 * for release assets, no 7-Zip, an unsupported platform), a shallow clone of
 * the tag still answers two of the three questions. It cannot answer the third:
 * patch `find`s are written against the built, minified chunk, which only
 * exists after a full client build.
 */

const SOURCE_EXT = /\.(ts|tsx|mts|js|jsx|mjs)$/i;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE_EXT.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * RPC methods from `packages/contracts/src`, using the same extraction as
 * `packages/contracts-vendor/scripts/build.mjs`: the `*_METHODS` maps give the
 * wire name, `Rpc.make(...)` registrations give the kind.
 */
export function methodsFromContractsSource(contractsSrcDir: string): BaselineMethod[] {
  const files = readdirSync(contractsSrcDir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
  const maps = new Map<string, string>();
  for (const file of files) {
    const text = readFileSync(join(contractsSrcDir, file), "utf8");
    for (const map of text.matchAll(/export const (\w*WS_METHODS|\w*_METHODS)\s*=\s*\{([\s\S]*?)\}\s*as const/g)) {
      for (const entry of map[2]!.matchAll(/(\w+):\s*"([^"]+)"/g)) {
        maps.set(`${map[1]}.${entry[1]}`, entry[2]!);
      }
    }
  }
  const out = new Map<string, MethodKind>();
  for (const file of files) {
    const text = readFileSync(join(contractsSrcDir, file), "utf8");
    for (const part of text.split(/Rpc\.make\(/).slice(1)) {
      const head = part.slice(0, 80).match(/^\s*(\w+)\.(\w+)/);
      const body = part.split(/\n(?:export )?const /)[0] ?? "";
      const kind: MethodKind = /stream:\s*true/.test(body) ? "stream" : "unary";
      const literal = part.match(/^\s*"([^"]+)"/)?.[1];
      const wire = head ? maps.get(`${head[1]}.${head[2]}`) : literal;
      if (wire) out.set(wire, kind);
    }
  }
  return [...out.entries()].map(([name, kind]) => ({ name, kind })).sort((a, b) => a.name.localeCompare(b.name));
}

const SOURCE_SLOT_RE = /data-slot=["'`]([A-Za-z0-9_-]{1,80})["'`]/g;

/** `data-slot` values written in the web app sources. */
export function slotsFromWebSource(webSrcDir: string): string[] {
  if (!existsSync(webSrcDir)) return [];
  const slots = new Set<string>();
  for (const file of walk(webSrcDir)) {
    if (!statSync(file).isFile()) continue;
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(SOURCE_SLOT_RE)) slots.add(match[1]!);
  }
  return [...slots].sort();
}
