/**
 * `data-slot` anchors: the tier 1 DOM contract the slot engine mounts into.
 * The baseline is the set the supported release renders; a removal means a
 * first-party anchor or a documented slot stopped existing.
 */

export interface SlotSource {
  chunks: Map<string, string>;
  html: Map<string, string>;
}

export interface SlotDiff {
  added: string[];
  removed: string[];
}

/**
 * Matches both shapes found in the built client: `"data-slot":"sidebar-content"`
 * (a props object) and `data-slot="sidebar-content"` (an HTML string), in
 * single, double and backtick quotes.
 */
const SLOT_RE = /data-slot["'\]]{0,3}\s*[:=]\s*["'`]([A-Za-z0-9_-]{1,80})["'`]/g;

function collect(texts: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(SLOT_RE)) out.add(match[1]!);
  }
  return out;
}

/** Every `data-slot` value the client renders. */
export function extractSlots(source: SlotSource): string[] {
  return [...collect([...source.chunks.values(), ...source.html.values()])].sort();
}

/**
 * The `data-slot` values our own code selects on (for example
 * `[data-slot="sidebar-content"]` in `packages/renderer-runtime`). A removal of
 * one of these breaks a slot, so it fails the check.
 */
export function requiredSlots(sources: Iterable<string>): string[] {
  return [...collect(sources)].sort();
}

export function diffSlots(baseline: readonly string[], current: readonly string[]): SlotDiff {
  const before = new Set(baseline);
  const after = new Set(current);
  return {
    added: current.filter((slot) => !before.has(slot)),
    removed: baseline.filter((slot) => !after.has(slot)),
  };
}
