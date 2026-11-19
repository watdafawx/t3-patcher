import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

/**
 * The runtime folder (packages/main-runtime/dist) as ONE blob, so a single-file
 * t3p.exe can carry it as a Node SEA asset.
 *
 * Format: gzip(JSON { v: 1, files: [{ path, data }] }), `path` relative with
 * forward slashes, `data` base64. Source maps and .d.mts files are left out
 * (the app never loads them).
 */
export const RUNTIME_PACK_ASSET = "runtime.pack.gz";

interface PackFile {
  path: string;
  data: string;
}

interface Pack {
  v: 1;
  files: PackFile[];
}

const SKIP = /\.(map|d\.mts|d\.ts)$/i;

function walk(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(root, next));
    else if (entry.isFile() && !SKIP.test(entry.name)) out.push(next);
  }
  return out;
}

/** Packs a runtime folder. Returns the gzip bytes and the file list. */
export function packRuntime(dir: string): { buffer: Buffer; files: string[] } {
  const files = walk(dir);
  const pack: Pack = { v: 1, files: files.map((path) => ({ path, data: readFileSync(join(dir, path)).toString("base64") })) };
  return { buffer: gzipSync(Buffer.from(JSON.stringify(pack)), { level: 9 }), files };
}

/** Writes a packed runtime into `dest`. Rejects paths that escape it. */
export function unpackRuntime(buffer: Uint8Array, dest: string): string[] {
  const pack = JSON.parse(gunzipSync(buffer).toString("utf8")) as Pack;
  if (pack.v !== 1 || !Array.isArray(pack.files)) throw new Error("unsupported runtime pack");
  const root = resolve(dest);
  mkdirSync(root, { recursive: true });
  const written: string[] = [];
  for (const file of pack.files) {
    const target = resolve(root, file.path);
    if (target !== root && !target.startsWith(root + sep)) throw new Error(`runtime pack path escapes the target: ${file.path}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(file.data, "base64"));
    written.push(file.path);
  }
  return written;
}

interface SeaModule {
  isSea(): boolean;
  getRawAsset(key: string): ArrayBuffer;
}

function seaModule(): SeaModule | null {
  try {
    const get = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    const sea = get?.("node:sea") as SeaModule | undefined;
    return sea?.isSea() ? sea : null;
  } catch {
    return null;
  }
}

/** True when running as the single-file t3p.exe (a Node SEA). */
export function isSingleFileExe(): boolean {
  return seaModule() !== null;
}

let extracted: string | null | undefined;

/**
 * Inside the single-file exe: unpacks the embedded runtime to a temp folder
 * (removed when the process exits) and returns it. Null outside the exe or
 * when the asset is missing.
 */
export function extractEmbeddedRuntime(): string | null {
  if (extracted !== undefined && (extracted === null || existsSync(extracted))) return extracted;
  extracted = null;
  const sea = seaModule();
  if (!sea) return null;
  let raw: ArrayBuffer;
  try {
    raw = sea.getRawAsset(RUNTIME_PACK_ASSET);
  } catch {
    return null;
  }
  const dir = mkdtempSync(join(tmpdir(), "t3p-runtime-"));
  unpackRuntime(new Uint8Array(raw), dir);
  // Keep read-only temp files from blocking cleanup on exit.
  for (const f of walk(dir)) chmodSync(join(dir, f), 0o644);
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // temp folder; the OS cleans it up eventually
    }
  });
  extracted = dir;
  return dir;
}
