import type { ChunkText } from "../logic/patch-test.js";
import { liveChunkSources } from "../logic/chunks.js";

export interface LoadedChunks {
  chunks: ChunkText[];
  /** What was skipped and why (non-JS, too large, fetch failures, cap). */
  notes: string[];
  error: string | null;
}

export type ChunkLoader = (onProgress: (message: string) => void) => Promise<LoadedChunks>;

export interface LiveChunkEnv {
  doc: Document;
  performanceEntries: readonly PerformanceEntry[];
  baseUrl: string;
  fetch: typeof fetch;
  /** Per-chunk cap. Default 8 MiB of text. */
  maxChunkChars?: number;
  /** Total cap. Default 64 MiB of text. */
  maxTotalChars?: number;
}

/**
 * Fetches the client chunks the app has loaded from its own origin. This is a
 * read: nothing is registered with `t3.patches`, nothing is evaluated.
 */
export function createLiveChunkLoader(env: LiveChunkEnv): ChunkLoader {
  const perChunk = env.maxChunkChars ?? 8 * 1024 * 1024;
  const totalCap = env.maxTotalChars ?? 64 * 1024 * 1024;
  return async (onProgress) => {
    const sources = liveChunkSources(env.doc, env.performanceEntries, env.baseUrl);
    const notes: string[] = [];
    if (sources.ignored > 0) notes.push(`${sources.ignored} non-chunk URL(s) ignored (other origin, not .js, or /__t3p/).`);
    if (sources.overflow > 0) notes.push(`${sources.overflow} chunk(s) over the ${sources.chunks.length + sources.overflow} candidate cap were not read.`);
    if (sources.chunks.length === 0) {
      return { chunks: [], notes, error: "No same-origin client chunks found in the DOM or resource timings." };
    }
    const chunks: ChunkText[] = [];
    let total = 0;
    for (let i = 0; i < sources.chunks.length; i++) {
      const candidate = sources.chunks[i]!;
      onProgress(`Reading ${i + 1}/${sources.chunks.length}: ${candidate.name}`);
      let text: string;
      try {
        const response = await env.fetch(candidate.url);
        if (!response.ok) {
          notes.push(`${candidate.name}: HTTP ${response.status}`);
          continue;
        }
        text = await response.text();
      } catch (error) {
        notes.push(`${candidate.name}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (text.length > perChunk) {
        notes.push(`${candidate.name}: ${text.length} chars (over the ${perChunk}-char per-chunk cap), skipped`);
        continue;
      }
      if (total + text.length > totalCap) {
        notes.push("Total read cap reached; the remaining chunks were not fetched.");
        break;
      }
      total += text.length;
      chunks.push({ name: candidate.name, source: text });
    }
    if (chunks.length === 0) {
      return { chunks, notes, error: "None of the loaded chunks could be read (see the notes)." };
    }
    onProgress(`Read ${chunks.length} chunk(s), ${total} chars.`);
    return { chunks, notes, error: null };
  };
}
