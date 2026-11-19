import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { applyPatches } from "./apply.js";
import type { AppliedPatch, ApplyResult, FailedPatch, Patch } from "./types.js";

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

interface CanonicalReplacement {
  match: string;
  replace: string;
}

interface CanonicalPatch {
  plugin: string;
  find: string;
  enabled: boolean;
  replacement: CanonicalReplacement[];
}

function predicateVerdict(patch: Patch): boolean {
  if (!patch.predicate) return true;
  try {
    return patch.predicate() === true;
  } catch {
    return false;
  }
}

/**
 * Hash of a patch set. Patches apply in registration order, so ORDER IS PART OF
 * THE KEY. The current verdict of each patch's `predicate` is part of the key too,
 * so a patch whose predicate turned false never replays from cache. A function
 * `replace` is hashed by its source text only: state it captures is not visible
 * to the cache, so replacers must be pure.
 */
export function patchSetHash(patches: Patch[]): string {
  const canonical: CanonicalPatch[] = patches.map((patch) => ({
    plugin: patch.plugin,
    find: String(patch.find),
    enabled: predicateVerdict(patch),
    replacement: (Array.isArray(patch.replacement)
      ? patch.replacement
      : [patch.replacement]
    ).map((replacement) => ({
      match: String(replacement.match),
      replace:
        typeof replacement.replace === "function"
          ? replacement.replace.toString()
          : replacement.replace,
    })),
  }));

  return sha256(JSON.stringify(canonical));
}

interface CacheMeta {
  codeSha256?: string;
  applied?: AppliedPatch[];
  failed?: FailedPatch[];
}

/**
 * On-disk result cache. Key = sha256(source) + "-" + patchSetHash, written as
 * `<dir>/<first 2 hex>/<key>.js` plus a `<key>.json` sidecar with the applied
 * and failed lists.
 */
export class PatchCache {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private fileFor(key: string, extension: string): string {
    return join(this.dir, key.slice(0, 2), `${key}${extension}`);
  }

  get(source: string, patches: Patch[]): ApplyResult | undefined {
    const key = `${sha256(source)}-${patchSetHash(patches)}`;
    try {
      const code = readFileSync(this.fileFor(key, ".js"), "utf8");
      const meta = JSON.parse(
        readFileSync(this.fileFor(key, ".json"), "utf8"),
      ) as CacheMeta;
      // A truncated or foreign .js (interrupted write, disk fault) is a miss, never served.
      if (meta.codeSha256 !== sha256(code)) return undefined;
      return {
        code,
        applied: meta.applied ?? [],
        failed: meta.failed ?? [],
      };
    } catch {
      return undefined;
    }
  }

  set(source: string, patches: Patch[], result: ApplyResult): void {
    const key = `${sha256(source)}-${patchSetHash(patches)}`;
    const codeFile = this.fileFor(key, ".js");
    mkdirSync(dirname(codeFile), { recursive: true });
    // Atomic publish: write temp files, rename the code first and the metadata (which carries
    // the code digest) last. A reader only trusts code whose digest matches.
    const suffix = `.${process.pid}.${Date.now()}.tmp`;
    const metaFile = this.fileFor(key, ".json");
    writeFileSync(codeFile + suffix, result.code);
    writeFileSync(
      metaFile + suffix,
      `${JSON.stringify({ codeSha256: sha256(result.code), applied: result.applied, failed: result.failed }, null, 2)}\n`,
    );
    renameSync(codeFile + suffix, codeFile);
    renameSync(metaFile + suffix, metaFile);
  }
}

/**
 * Cache-aware apply. Returns the cached result when the key is present, else
 * applies and stores the result (only when at least one patch applied).
 */
export function applyPatchesCached(
  cache: PatchCache,
  chunkName: string,
  source: string,
  patches: Patch[],
): ApplyResult & { cached: boolean } {
  const hit = cache.get(source, patches);
  if (hit) return { ...hit, cached: true };

  const result = applyPatches(chunkName, source, patches);
  if (result.applied.length > 0) cache.set(source, patches, result);
  return { ...result, cached: false };
}
