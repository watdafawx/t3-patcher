import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Logger } from "../log.js";

export interface ChunkFile {
  /** Path relative to the client dir with forward slashes, e.g. "assets/index-abc.js" (= URL path without the leading /). */
  name: string;
  size: number;
}

interface IndexFile {
  version: 1;
  key: string;
  /** String(find) -> chunk names whose source contains it. */
  finds: Record<string, string[]>;
}

const JS_RE = /\.(m?js)$/i;
const MAX_FILES = 20_000;

/** Lists the JS chunks below `dir` (works inside an asar, where readdir has no `recursive`). */
export function listChunks(dir: string): ChunkFile[] {
  const out: ChunkFile[] = [];
  const walk = (abs: string, rel: string): void => {
    for (const name of readdirSync(abs)) {
      if (out.length >= MAX_FILES) return;
      const childAbs = join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      const st = statSync(childAbs);
      if (st.isDirectory()) walk(childAbs, childRel);
      else if (JS_RE.test(name)) out.push({ name: childRel, size: st.size });
    }
  };
  walk(dir, "");
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/** Hash of the listing (names carry Vite content hashes, sizes catch the rest). */
export function listingKey(dir: string, files: readonly ChunkFile[]): string {
  return createHash("sha256").update(JSON.stringify([dir.toLowerCase(), files])).digest("hex");
}

function findsMatch(source: string, find: string | RegExp): boolean {
  return typeof find === "string" ? source.includes(find) : new RegExp(find.source, find.flags).test(source);
}

/**
 * Maps a patch `find` to the chunks that contain it, without reading every
 * chunk on every launch: results are cached in `cacheFile` keyed by the client
 * dir listing, so a launch with unchanged patches and an unchanged app reads no
 * chunk at all. A new find (or an updated app) triggers one scan.
 */
export class ChunkIndex {
  private memory: IndexFile | null = null;
  /** Last scan cost, for the notes / plugins:list report. */
  lastScan: { files: number; bytes: number; ms: number } | null = null;

  constructor(
    private readonly clientDir: string,
    private readonly cacheFile: string,
    private readonly log: Logger,
  ) {}

  locate(finds: ReadonlyArray<string | RegExp>): Map<string, string[]> {
    const files = listChunks(this.clientDir);
    const key = listingKey(this.clientDir, files);
    const index = this.load(key);
    const missing = finds.filter((find) => !Object.hasOwn(index.finds, String(find)));
    if (missing.length > 0) {
      const started = performance.now();
      let bytes = 0;
      for (const find of missing) index.finds[String(find)] = [];
      for (const file of files) {
        let source: string;
        try {
          source = readFileSync(join(this.clientDir, ...file.name.split("/")), "utf8");
        } catch (error) {
          this.log.warn(`chunk index: cannot read ${file.name}: ${String(error)}`);
          continue;
        }
        bytes += source.length;
        for (const find of missing) if (findsMatch(source, find)) index.finds[String(find)]!.push(file.name);
      }
      const ms = Math.round(performance.now() - started);
      this.lastScan = { files: files.length, bytes, ms };
      this.log.info(`chunk index: scanned ${files.length} chunks (${bytes} chars) for ${missing.length} find(s) in ${ms} ms`);
      this.save(index);
    }
    const result = new Map<string, string[]>();
    for (const find of finds) result.set(String(find), Object.hasOwn(index.finds, String(find)) ? index.finds[String(find)]! : []);
    return result;
  }

  private load(key: string): IndexFile {
    if (this.memory?.key === key) return this.memory;
    try {
      const parsed = JSON.parse(readFileSync(this.cacheFile, "utf8")) as IndexFile;
      if (parsed.version === 1 && parsed.key === key && parsed.finds && typeof parsed.finds === "object") {
        this.memory = parsed;
        return parsed;
      }
    } catch {
      // no cache yet or unreadable: rebuild
    }
    this.memory = { version: 1, key, finds: Object.create(null) as Record<string, string[]> };
    return this.memory;
  }

  private save(index: IndexFile): void {
    try {
      mkdirSync(dirname(this.cacheFile), { recursive: true });
      const tmp = `${this.cacheFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(index));
      renameSync(tmp, this.cacheFile);
    } catch (error) {
      this.log.warn(`chunk index: cannot write cache: ${String(error)}`);
    }
  }
}
