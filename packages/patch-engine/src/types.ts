/**
 * Public types for the patch engine.
 *
 * A patch is a text edit against one chunk of the shipped client. The `find`
 * value only locates the chunk (it must match exactly one chunk of the set);
 * the edits themselves are the `replacement` entries.
 */

// `args` mirrors String.prototype.replace's callback arguments; it stays loose
// so a replacement can type only the groups it cares about.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Replacer = string | ((substring: string, ...args: any[]) => string);

export interface Replacement {
  /** String = literal search, first occurrence only. RegExp = used as given (its own flags, no extra flags). */
  match: string | RegExp;
  /** Replaces the match. String replacements support `$1`.., `$&` and `$$` like String.prototype.replace, plus `$self`. */
  replace: Replacer;
}

export interface Patch {
  /** Owner id, e.g. "t3p.core". */
  plugin: string;
  /** Locates the chunk; must match exactly one chunk of the set. */
  find: string | RegExp;
  replacement: Replacement | Replacement[];
  /** If present and it returns false, the patch is skipped and reported with reason "predicate". */
  predicate?: () => boolean;
}

export type FailReason =
  | "no-match"
  | "ambiguous"
  | "replacement-no-match"
  | "syntax-error"
  | "predicate";

export interface AppliedPatch {
  plugin: string;
  find: string;
  chunk: string;
  replacements: number;
}

export interface FailedPatch {
  plugin: string;
  find: string;
  chunk?: string;
  reason: FailReason;
  detail: string;
}

export interface ApplyResult {
  code: string;
  applied: AppliedPatch[];
  failed: FailedPatch[];
}

/** Chunk file name -> source text. */
export type ChunkSet = ReadonlyMap<string, string>;
