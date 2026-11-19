/**
 * Read-only patch testing. The rules mirror `packages/patch-engine`:
 *
 * - `find` must match exactly one chunk. Zero matches is `no-match`, more than one
 *   is `ambiguous`.
 * - A string `match` replaces the first occurrence only; a RegExp keeps its own
 *   flags (no implicit `g`), exactly like `String.prototype.replace`.
 * - `$1`-style groups, `$&` and `$$` work as in `String.prototype.replace`.
 *   `$self` resolves to the plugin's global handle.
 * - The patched code is parsed as an ES module; a syntax error is reported.
 *
 * Nothing here applies a patch. The caller reports the outcome and drops the text.
 */

export type MatchSpec = { kind: "string"; text: string } | { kind: "regex"; source: string; flags: string };

export type ParseCheck = (code: string) => { ok: true } | { ok: false; error: string };

export interface ChunkText {
  /** Relative name, e.g. `assets/index-abc.js`. */
  name: string;
  source: string;
}

export interface ReplacementInput {
  /** Slash-literal regex (`/foo/i`) or a literal string. */
  match: string;
  replace: string;
}

export interface Snippet {
  before: string;
  changed: string;
  after: string;
}

export interface ReplacementOutcome {
  /** 1-based position in the patch. */
  index: number;
  /** The replacement's match as written. */
  match: string;
  /** The text the replacement consumed, truncated for display. */
  matchedText: string;
  snippet: Snippet;
}

export interface ChunkHit {
  name: string;
  count: number;
}

export type PatchVerdict = "invalid" | "no-match" | "ambiguous" | "unique";

export interface PatchTestReport {
  ok: boolean;
  /** Why the test could not run or why it failed, when it did. */
  error: string | null;
  find: string;
  searchedChunks: number;
  hits: ChunkHit[];
  verdict: PatchVerdict;
  /** Chunk the patch would be assigned to, when the find is unique. */
  chosen: string | null;
  replacements: ReplacementOutcome[];
  failedReplacement: number | null;
  parse: { status: "ok" | "error" | "unavailable" | "skipped"; detail?: string };
  /** Size of the produced text, when a chunk was patched. */
  patchedChars: number | null;
}

const SNIPPET_RADIUS = 80;
const MATCHED_TEXT_LIMIT = 120;

/** Parses `/source/flags` into a regex spec, or returns null when the input is not slash-delimited. */
function slashRegex(input: string): { source: string; flags: string } | null | { error: string } {
  if (input[0] !== "/") return null;
  for (let i = input.length - 1; i > 0; i--) {
    if (input[i] !== "/") continue;
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && input[j] === "\\"; j--) backslashes += 1;
    if (backslashes % 2 === 1) continue;
    return { source: input.slice(1, i), flags: input.slice(i + 1) };
  }
  return { error: "a regex must be written as /source/flags (no closing /)" };
}

/** Parses a `find` or `match` field. A leading `/` means a regex; everything else is a literal string. */
export function parseMatchSpec(input: string, field: string): { ok: true; spec: MatchSpec } | { ok: false; error: string } {
  if (input.length === 0) return { ok: false, error: `${field} must not be empty` };
  const slash = slashRegex(input);
  if (slash && "error" in slash) return { ok: false, error: `${field}: ${slash.error}` };
  if (slash) {
    if (slash.source.length === 0) return { ok: false, error: `${field}: the regex must not be empty` };
    try {
      new RegExp(slash.source, slash.flags);
    } catch (error) {
      return { ok: false, error: `${field}: ${error instanceof Error ? error.message : String(error)}` };
    }
    return { ok: true, spec: { kind: "regex", source: slash.source, flags: slash.flags } };
  }
  return { ok: true, spec: { kind: "string", text: input } };
}

export function describeSpec(spec: MatchSpec): string {
  return spec.kind === "string" ? JSON.stringify(spec.text) : `/${spec.source}/${spec.flags}`;
}

function regexOf(spec: Extract<MatchSpec, { kind: "regex" }>, global: boolean): RegExp {
  const flags = global && !spec.flags.includes("g") ? `${spec.flags}g` : spec.flags;
  return new RegExp(spec.source, flags);
}

/** Non-overlapping occurrences of `spec` in `text`. */
export function countMatches(text: string, spec: MatchSpec): number {
  if (spec.kind === "string") {
    let count = 0;
    let from = 0;
    for (;;) {
      const at = text.indexOf(spec.text, from);
      if (at < 0) return count;
      count += 1;
      from = at + spec.text.length;
    }
  }
  let count = 0;
  for (const _ of text.matchAll(regexOf(spec, true))) count += 1;
  return count;
}

/** Every chunk the find hits, sorted by name. */
export function findChunks(chunks: readonly ChunkText[], spec: MatchSpec): ChunkHit[] {
  const hits: ChunkHit[] = [];
  for (const chunk of chunks) {
    const count = countMatches(chunk.source, spec);
    if (count > 0) hits.push({ name: chunk.name, count });
  }
  return hits.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** A placeholder that occurs in none of `texts`, so `$self` survives `String.replace`. */
function pickSentinel(texts: string[]): string {
  for (let i = 0; i < 1000; i++) {
    const candidate = `\u0000t3p-dev-self-${i}\u0000`;
    if (texts.every((text) => !text.includes(candidate))) return candidate;
  }
  throw new Error("devtools: could not find a free $self sentinel");
}

function expandSelf(replacement: string, selfHandle: string, texts: string[]): string {
  const sentinel = pickSentinel([...texts, replacement]);
  return replacement.split("$self").join(sentinel).split(sentinel).join(selfHandle);
}

function snippetAround(text: string, at: number, changedLength: number): Snippet {
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(text.length, at + changedLength + SNIPPET_RADIUS);
  return {
    before: text.slice(start, at),
    changed: text.slice(at, at + changedLength),
    after: text.slice(at + changedLength, end),
  };
}

interface Applied {
  text: string;
  at: number;
  matchedText: string;
  changedLength: number;
}

/** One replacement, mirroring patch-engine: a string match replaces the first occurrence only. */
function applyOne(text: string, spec: MatchSpec, replace: string, selfHandle: string): Applied | null {
  let at: number;
  let matchedText: string;
  if (spec.kind === "string") {
    at = text.indexOf(spec.text);
    if (at < 0) return null;
    matchedText = spec.text;
  } else {
    const found = regexOf(spec, false).exec(text);
    if (!found) return null;
    at = found.index;
    matchedText = found[0];
  }
  const expanded = expandSelf(replace, selfHandle, [text, spec.kind === "string" ? spec.text : spec.source]);
  const next = spec.kind === "string" ? text.replace(spec.text, expanded) : text.replace(regexOf(spec, false), expanded);
  const delta = next.length - text.length;
  return { text: next, at, matchedText, changedLength: Math.max(0, matchedText.length + delta) };
}

/** Applies every replacement in order; stops at the first one that does not match. */
export function applyReplacementList(
  source: string,
  replacements: readonly { spec: MatchSpec; original: string; replace: string }[],
  selfHandle: string,
): { ok: boolean; text: string; outcomes: ReplacementOutcome[]; failedReplacement: number | null; error: string | null } {
  let working = source;
  const outcomes: ReplacementOutcome[] = [];
  for (let i = 0; i < replacements.length; i++) {
    const replacement = replacements[i]!;
    const applied = applyOne(working, replacement.spec, replacement.replace, selfHandle);
    if (!applied) {
      return {
        ok: false,
        text: working,
        outcomes,
        failedReplacement: i + 1,
        error: `replacement ${i + 1} match ${describeSpec(replacement.spec)} did not match`,
      };
    }
    outcomes.push({
      index: i + 1,
      match: replacement.original,
      matchedText:
        applied.matchedText.length > MATCHED_TEXT_LIMIT
          ? `${applied.matchedText.slice(0, MATCHED_TEXT_LIMIT)}... [${applied.matchedText.length - MATCHED_TEXT_LIMIT} more chars]`
          : applied.matchedText,
      snippet: snippetAround(applied.text, applied.at, applied.changedLength),
    });
    working = applied.text;
  }
  return { ok: true, text: working, outcomes, failedReplacement: null, error: null };
}

export interface PatchTestRequest {
  chunks: readonly ChunkText[];
  find: string;
  replacements: readonly ReplacementInput[];
  /** What `$self` expands to, e.g. `window.__t3p_plugins["devtools"]`. */
  selfHandle: string;
  /** Omit (or null) when the renderer has no parser: the report then says "unavailable". */
  parseCheck?: ParseCheck | null;
}

/** Runs a patch test against the given sources. Never mutates the chunks. */
export function runPatchTest(request: PatchTestRequest): PatchTestReport {
  const base: PatchTestReport = {
    ok: false,
    error: null,
    find: request.find,
    searchedChunks: request.chunks.length,
    hits: [],
    verdict: "invalid",
    chosen: null,
    replacements: [],
    failedReplacement: null,
    parse: { status: "skipped" },
    patchedChars: null,
  };

  const find = parseMatchSpec(request.find, "find");
  if (!find.ok) return { ...base, error: find.error };
  const findSpec = find.spec;

  if (request.replacements.length === 0) return { ...base, error: "add at least one match/replace pair" };
  const parsed: { spec: MatchSpec; original: string; replace: string }[] = [];
  for (let i = 0; i < request.replacements.length; i++) {
    const input = request.replacements[i]!;
    const match = parseMatchSpec(input.match, `replacement ${i + 1} match`);
    if (!match.ok) return { ...base, error: match.error };
    parsed.push({ spec: match.spec, original: input.match, replace: input.replace });
  }

  const hits = findChunks(request.chunks, findSpec);
  let verdict: PatchVerdict;
  if (hits.length === 0) verdict = "no-match";
  else if (hits.length > 1) verdict = "ambiguous";
  else verdict = "unique";
  const withHits: PatchTestReport = { ...base, hits, verdict };

  if (verdict !== "unique") {
    return {
      ...withHits,
      error:
        verdict === "no-match"
          ? `find matched none of ${request.chunks.length} chunk(s)`
          : `find matched ${hits.length} chunks; it must match exactly one`,
    };
  }

  const chosen = hits[0]!;
  const chunk = request.chunks.find((c) => c.name === chosen.name);
  if (!chunk) return { ...withHits, verdict: "no-match", error: "the chosen chunk disappeared" };

  const applied = applyReplacementList(chunk.source, parsed, request.selfHandle);
  let parse: PatchTestReport["parse"] = { status: "skipped" };
  if (applied.ok && applied.outcomes.length > 0) {
    if (!request.parseCheck) parse = { status: "unavailable" };
    else {
      try {
        const result = request.parseCheck(applied.text);
        parse = result.ok ? { status: "ok" } : { status: "error", detail: result.error };
      } catch (error) {
        parse = { status: "error", detail: error instanceof Error ? error.message : String(error) };
      }
    }
  }

  const ok = applied.ok && parse.status !== "error";
  return {
    ...withHits,
    ok,
    error: applied.error,
    chosen: chosen.name,
    replacements: applied.outcomes,
    failedReplacement: applied.failedReplacement,
    parse,
    patchedChars: applied.text.length,
  };
}
