/**
 * Finding the client chunks a renderer plugin may read. The public API has no
 * "read a chunk" call (`t3.patches` only registers patches), so the patch tester
 * lists the module scripts the page loaded over its own origin and fetches them
 * with the page's `fetch`. Only chunks the app has already loaded or preloaded
 * are visible; lazy routes that were never visited are not.
 */

export interface ChunkCandidate {
  /** Fetchable URL (may carry a query the app used). */
  url: string;
  /** Path relative to the app origin, e.g. `assets/index-abc.js`; used for reports and de-duplication. */
  name: string;
}

export interface ChunkUrlInput {
  /** The page URL, e.g. `location.href`. Relative script paths resolve against it. */
  baseUrl: string;
  scripts: readonly string[];
  modulePreloads: readonly string[];
  /** `performance.getEntriesByType("resource")` names. */
  resources: readonly string[];
  /** Safety cap. Default 400. */
  max?: number;
}

export interface ChunkUrlResult {
  chunks: ChunkCandidate[];
  /** Entries that were not same-origin JS. */
  ignored: number;
  /** Entries dropped because of `max`. */
  overflow: number;
}

const JS_PATH = /\.(m?js)$/i;

function pathOf(url: URL): string {
  return url.pathname.replace(/^\/+/, "");
}

/** Collects same-origin JS chunk URLs from DOM script tags, modulepreload links and resource timings. */
export function collectChunkUrls(input: ChunkUrlInput): ChunkUrlResult {
  const max = input.max ?? 400;
  let base: URL;
  try {
    base = new URL(input.baseUrl);
  } catch {
    return { chunks: [], ignored: 0, overflow: 0 };
  }
  const seen = new Set<string>();
  const chunks: ChunkCandidate[] = [];
  let ignored = 0;

  for (const raw of [...input.scripts, ...input.modulePreloads, ...input.resources]) {
    if (typeof raw !== "string" || raw.length === 0) {
      ignored += 1;
      continue;
    }
    let url: URL;
    try {
      url = new URL(raw, base);
    } catch {
      ignored += 1;
      continue;
    }
    const name = pathOf(url);
    if (url.protocol !== base.protocol || url.host !== base.host || !JS_PATH.test(url.pathname) || name.length === 0) {
      ignored += 1;
      continue;
    }
    if (name.startsWith("__t3p/")) {
      ignored += 1;
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    chunks.push({ url: url.toString(), name });
  }

  chunks.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const overflow = Math.max(0, chunks.length - max);
  return { chunks: chunks.slice(0, max), ignored, overflow };
}

/** Reads the chunk candidates of the current page. DOM and performance APIs only. */
export function liveChunkSources(doc: Document, performanceEntries: readonly PerformanceEntry[], baseUrl: string): ChunkUrlResult {
  const scripts: string[] = [];
  for (const el of Array.from(doc.querySelectorAll("script[src]"))) {
    const src = el.getAttribute("src");
    if (src) scripts.push(src);
  }
  const modulePreloads: string[] = [];
  for (const el of Array.from(doc.querySelectorAll('link[rel="modulepreload"][href]'))) {
    const href = el.getAttribute("href");
    if (href) modulePreloads.push(href);
  }
  return collectChunkUrls({
    baseUrl,
    scripts,
    modulePreloads,
    resources: performanceEntries.map((entry) => entry.name),
  });
}
