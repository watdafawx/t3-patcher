/**
 * RPC method list diffing.
 *
 * The wire method names are plain strings in the shipped bundles (the server
 * keeps them in `*_METHODS`-style maps that survive minification). Two checks
 * use that:
 *
 * - removal: a baseline method must still occur verbatim in the server bundle.
 *   Exact, and the one that gates the exit code.
 * - addition: a new method shows up as a `name: "namespace.method"` entry in a
 *   table that already holds baseline methods. Tables of unrelated dotted ids
 *   (keyboard commands, event names) do not contain baseline methods, so they
 *   are ignored; the cost is that a brand-new namespace is not reported until
 *   it sits next to a known one.
 */

export type MethodKind = "unary" | "stream";

export interface BaselineMethod {
  name: string;
  kind: MethodKind;
}

export interface MethodEvidence {
  /** "server": shipped server bundle; "client": call sites only; "source": contracts source. */
  evidence: "server" | "client" | "source";
  text: string;
}

export interface MethodDiff {
  /** Baseline methods that no longer appear in the bundle. */
  removed: string[];
  /** New `namespace.method` entries in a table that already holds baseline methods. */
  added: string[];
  /** How many baseline methods were found verbatim. */
  found: number;
}

const PAIR_RE = /([A-Za-z_$][\w$]{0,40})\s*:\s*"([a-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+)"/g;
/** Two entries belong to the same table when nothing but whitespace/punctuation sits between them. */
const CLUSTER_GAP = 120;
/** A table counts as an RPC table when at least this share of its entries is in the baseline. */
const MIN_BASELINE_FRACTION = 0.75;
/** Smallest table worth calling a table. */
const MIN_CLUSTER_ENTRIES = 3;

function quoted(text: string, name: string): boolean {
  return text.includes(`"${name}"`) || text.includes(`'${name}'`) || text.includes("`" + name + "`");
}

interface Cluster {
  entries: string[];
  last: number;
  /** Index of the pair in the text where the cluster started (not used for output). */
  start: number;
}

/** Splits `name: "ns.method"` entries into tables by proximity. */
export function methodTables(text: string): string[][] {
  const clusters: Cluster[] = [];
  let current: Cluster | null = null;
  for (const match of text.matchAll(PAIR_RE)) {
    const at = match.index ?? 0;
    if (current && at - current.last > CLUSTER_GAP) {
      clusters.push(current);
      current = null;
    }
    if (!current) current = { entries: [], last: at, start: at };
    current.entries.push(match[2]!);
    current.last = at + match[0].length;
  }
  if (current) clusters.push(current);
  return clusters.filter((cluster) => cluster.entries.length >= MIN_CLUSTER_ENTRIES).map((c) => c.entries);
}

export function diffMethods(baseline: string[], evidence: MethodEvidence): MethodDiff {
  const removed = baseline.filter((name) => !quoted(evidence.text, name));
  const known = new Set(baseline);

  const added = new Set<string>();
  for (const table of methodTables(evidence.text)) {
    const hits = table.filter((entry) => known.has(entry)).length;
    if (hits / table.length < MIN_BASELINE_FRACTION) continue;
    for (const entry of table) if (!known.has(entry)) added.add(entry);
  }

  return {
    removed: [...removed].sort(),
    added: [...added].sort(),
    found: baseline.length - removed.length,
  };
}

const QUOTED_RE = /["'`]([a-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+)["'`]/g;

/**
 * The baseline methods that first-party code names: string literals such as
 * `"orchestration.subscribeThread"` in our own sources. Used to decide which
 * removals are breakage for us and which are just upstream churn.
 */
export function usedMethods(sources: Iterable<string>, baseline: ReadonlySet<string>): string[] {
  const used = new Set<string>();
  for (const text of sources) {
    for (const match of text.matchAll(QUOTED_RE)) {
      const name = match[1]!;
      if (baseline.has(name)) used.add(name);
    }
  }
  return [...used].sort();
}
