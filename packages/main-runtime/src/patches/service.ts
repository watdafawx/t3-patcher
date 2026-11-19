import { type AppliedPatch, applyPatches, applyPatchesCached, type FailedPatch, type Patch, PatchCache } from "@t3p/patch-engine";

import type { Logger } from "../log.js";
import type { ChunkIndex } from "./chunk-index.js";
import type { PatchRegistry } from "./registry.js";

export interface PatchReport {
  applied: AppliedPatch[];
  failed: FailedPatch[];
  disabled: { owner: string; find: string; reason: string }[];
  indexScan: ChunkIndex["lastScan"];
}

export interface Locator {
  locate(finds: ReadonlyArray<string | RegExp>): Map<string, string[]>;
  lastScan?: ChunkIndex["lastScan"];
}

/**
 * Decides which patches belong to which chunk and applies them when the chunk
 * is served. Every failure (no match, ambiguous, replacement miss, syntax
 * error, cache I/O) disables that patch and is logged once; the original chunk
 * is served instead.
 */
export class PatchService {
  private plan: { version: number; byChunk: Map<string, Patch[]> } | null = null;
  private readonly applied: AppliedPatch[] = [];
  private readonly failed: FailedPatch[] = [];
  private readonly cache: PatchCache | null;

  constructor(
    private readonly registry: PatchRegistry,
    private readonly index: Locator | null,
    cacheDir: string | null,
    private readonly log: Logger,
  ) {
    this.cache = cacheDir ? new PatchCache(cacheDir) : null;
  }

  /** Patches assigned to this chunk name (URL path without the leading slash). */
  patchesFor(chunkName: string): Patch[] {
    if (this.registry.size === 0 || !this.index) return [];
    return this.currentPlan().get(chunkName) ?? [];
  }

  hasPatchesFor(chunkName: string): boolean {
    return this.patchesFor(chunkName).length > 0;
  }

  /** Returns the patched source, or null to serve the original. Never throws. */
  transform(chunkName: string, source: string): string | null {
    const patches = this.patchesFor(chunkName);
    if (patches.length === 0) return null;
    let result: ReturnType<typeof applyPatches> & { cached?: boolean };
    try {
      if (this.cache) {
        try {
          result = applyPatchesCached(this.cache, chunkName, source, patches);
        } catch (error) {
          this.log.warn(`patch cache unusable (${String(error)}); applying without cache`);
          result = applyPatches(chunkName, source, patches);
        }
      } else {
        result = applyPatches(chunkName, source, patches);
      }
    } catch (error) {
      this.log.error(`patching ${chunkName} threw; serving the original`, error);
      for (const patch of patches) this.registry.disable(patch, "engine threw");
      return null;
    }
    for (const failure of result.failed) {
      this.failed.push(failure);
      this.log.warn(`patch failed and disabled: ${failure.plugin} find=${failure.find} in ${chunkName}: ${failure.reason} ${failure.detail}`);
      const patch = patches.find((p) => p.plugin === failure.plugin && String(p.find) === failure.find);
      if (patch) this.registry.disable(patch, failure.reason);
    }
    for (const ok of result.applied) {
      this.applied.push(ok);
      this.log.info(`patch applied: ${ok.plugin} find=${ok.find} in ${chunkName} (${ok.replacements} replacement(s)${result.cached ? ", cached" : ""})`);
    }
    return result.applied.length > 0 ? result.code : null;
  }

  report(): PatchReport {
    return {
      applied: [...this.applied],
      failed: [...this.failed],
      disabled: this.registry.disabledList(),
      indexScan: this.index?.lastScan ?? null,
    };
  }

  private currentPlan(): Map<string, Patch[]> {
    if (this.plan && this.plan.version === this.registry.version) return this.plan.byChunk;
    const patches = this.registry.active();
    const byChunk = new Map<string, Patch[]>();
    let hits: Map<string, string[]>;
    try {
      hits = this.index!.locate(patches.map((p) => p.find));
    } catch (error) {
      this.log.error("chunk index failed; no patches this session", error);
      for (const patch of patches) this.registry.disable(patch, "chunk index failed");
      this.plan = { version: this.registry.version, byChunk };
      return byChunk;
    }
    for (const patch of patches) {
      const chunks = hits.get(String(patch.find)) ?? [];
      if (chunks.length === 1) {
        const list = byChunk.get(chunks[0]!) ?? [];
        list.push(patch);
        byChunk.set(chunks[0]!, list);
        continue;
      }
      const reason = chunks.length === 0 ? "no-match" : "ambiguous";
      const detail = chunks.length === 0 ? "find matched no chunk" : `find matched ${chunks.length} chunks: ${chunks.slice(0, 5).join(", ")}`;
      this.failed.push({ plugin: patch.plugin, find: String(patch.find), reason, detail });
      this.log.warn(`patch disabled: ${patch.plugin} find=${String(patch.find)}: ${reason} (${detail})`);
      this.registry.disable(patch, reason);
    }
    this.plan = { version: this.registry.version, byChunk };
    return byChunk;
  }
}
