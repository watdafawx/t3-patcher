import { applyPatches } from "./apply.js";
import type {
  AppliedPatch,
  ApplyResult,
  ChunkSet,
  FailedPatch,
  Patch,
} from "./types.js";

export interface PlanResult {
  byChunk: Map<string, Patch[]>;
  failed: FailedPatch[];
}

const AMBIGUOUS_LIST_LIMIT = 5;

function chunkContains(source: string, find: string | RegExp): boolean {
  if (typeof find === "string") return source.includes(find);
  return new RegExp(find.source, find.flags).test(source);
}

function predicateDetail(predicate: () => boolean): string | undefined {
  try {
    return predicate() ? undefined : "predicate returned false";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `predicate threw: ${message}`;
  }
}

/**
 * Assigns every patch to the single chunk its `find` matches.
 *
 * Zero matching chunks is a "no-match" failure, more than one is "ambiguous",
 * and a patch whose predicate returns false is reported as "predicate" without
 * being looked at.
 */
export function planPatches(chunks: ChunkSet, patches: Patch[]): PlanResult {
  const byChunk = new Map<string, Patch[]>();
  const failed: FailedPatch[] = [];

  for (const patch of patches) {
    const plugin = patch.plugin;
    const find = String(patch.find);

    if (patch.predicate) {
      const detail = predicateDetail(patch.predicate);
      if (detail !== undefined) {
        failed.push({ plugin, find, reason: "predicate", detail });
        continue;
      }
    }

    const hits: string[] = [];
    for (const [name, source] of chunks) {
      if (chunkContains(source, patch.find)) hits.push(name);
    }

    if (hits.length === 0) {
      failed.push({
        plugin,
        find,
        reason: "no-match",
        detail: `find matched none of ${chunks.size} chunk(s)`,
      });
      continue;
    }

    if (hits.length > 1) {
      const shown = hits.slice(0, AMBIGUOUS_LIST_LIMIT).join(", ");
      const rest = hits.length - AMBIGUOUS_LIST_LIMIT;
      const more = rest > 0 ? `, +${rest} more` : "";
      failed.push({
        plugin,
        find,
        reason: "ambiguous",
        detail: `find matched ${hits.length} chunks: ${shown}${more}`,
      });
      continue;
    }

    const chunkName = hits[0]!;
    const assigned = byChunk.get(chunkName);
    if (assigned) assigned.push(patch);
    else byChunk.set(chunkName, [patch]);
  }

  return { byChunk, failed };
}

/**
 * Plans the patch set against the chunks, then applies each chunk's patches to
 * that chunk. Returns per-chunk results plus every failure from planning and
 * applying, and all applied patches.
 */
export function applyPatchSet(
  chunks: ChunkSet,
  patches: Patch[],
): {
  results: Map<string, ApplyResult>;
  failed: FailedPatch[];
  applied: AppliedPatch[];
} {
  const plan = planPatches(chunks, patches);

  const results = new Map<string, ApplyResult>();
  const failed: FailedPatch[] = [...plan.failed];
  const applied: AppliedPatch[] = [];

  for (const [chunkName, chunkPatches] of plan.byChunk) {
    const source = chunks.get(chunkName);
    if (source === undefined) continue;

    const result = applyPatches(chunkName, source, chunkPatches);
    results.set(chunkName, result);
    failed.push(...result.failed);
    applied.push(...result.applied);
  }

  return { results, failed, applied };
}
