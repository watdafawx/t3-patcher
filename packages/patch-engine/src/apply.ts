import { parse } from "acorn";

import type {
  AppliedPatch,
  ApplyResult,
  FailedPatch,
  Patch,
  Replacement,
} from "./types.js";

const PARSE_OPTIONS = { ecmaVersion: "latest", sourceType: "module" } as const;

/** `window.__t3p_plugins[<plugin>]`, e.g. `window.__t3p_plugins["t3p.core"]`. */
function selfHandle(plugin: string): string {
  return `window.__t3p_plugins[${JSON.stringify(plugin)}]`;
}

/** Replaces every literal `$self` in `text` with the plugin's global handle. */
function expandSelf(text: string, handle: string): string {
  return text.split("$self").join(handle);
}

/**
 * A placeholder that does not occur in any of `texts`, used to carry `$self`
 * through String.prototype.replace without letting it look like a group ref.
 */
function pickSentinel(texts: string[]): string {
  for (let i = 0; i < 1000; i++) {
    const candidate = `\u0000t3p-self-${i}\u0000`;
    if (texts.every((text) => !text.includes(candidate))) return candidate;
  }
  throw new Error("patch-engine: could not find a free $self sentinel");
}

function describeMatch(match: string | RegExp): string {
  return typeof match === "string" ? JSON.stringify(match) : String(match);
}

/** Clones a regex so `test`/`replace` never touch the caller's lastIndex. */
function cloneRegExp(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags);
}

interface ReplacementResult {
  text: string;
  matched: boolean;
}

/**
 * Applies one replacement to the whole chunk. A string `match` only ever
 * replaces the first occurrence; a RegExp follows its own flags.
 */
function applyReplacement(
  text: string,
  replacement: Replacement,
  handle: string,
): ReplacementResult {
  const { match, replace } = replacement;

  if (typeof match === "string") {
    if (!text.includes(match)) return { text, matched: false };
    if (typeof replace === "function") {
      const out = text.replace(match, (substring: string, ...args) =>
        expandSelf(replace(substring, ...args), handle),
      );
      return { text: out, matched: true };
    }
    const sentinel = pickSentinel([text, match, replace]);
    const pre = replace.split("$self").join(sentinel);
    const out = text.replace(match, pre).split(sentinel).join(handle);
    return { text: out, matched: true };
  }

  if (!cloneRegExp(match).test(text)) return { text, matched: false };

  const regex = cloneRegExp(match);
  if (typeof replace === "function") {
    const out = text.replace(regex, (substring: string, ...args) =>
      expandSelf(replace(substring, ...args), handle),
    );
    return { text: out, matched: true };
  }

  const sentinel = pickSentinel([text, match.source, replace]);
  const pre = replace.split("$self").join(sentinel);
  const out = text.replace(regex, pre).split(sentinel).join(handle);
  return { text: out, matched: true };
}

type PredicateVerdict = { ok: true } | { ok: false; detail: string };

function evaluatePredicate(predicate: () => boolean): PredicateVerdict {
  try {
    return predicate()
      ? { ok: true }
      : { ok: false, detail: "predicate returned false" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `predicate threw: ${message}` };
  }
}

/**
 * Applies `patches` to one chunk, in order. Each patch is atomic: if any of
 * its replacements does not match, or the patched code no longer parses as an
 * ES module, that patch is rolled back and reported as failed. Patches that
 * fail never stop the ones after them.
 */
export function applyPatches(
  chunkName: string,
  source: string,
  patches: Patch[],
): ApplyResult {
  let code = source;
  const applied: AppliedPatch[] = [];
  const failed: FailedPatch[] = [];

  for (const patch of patches) {
    const plugin = patch.plugin;
    const find = String(patch.find);

    if (patch.predicate) {
      const verdict = evaluatePredicate(patch.predicate);
      if (!verdict.ok) {
        failed.push({
          plugin,
          find,
          chunk: chunkName,
          reason: "predicate",
          detail: verdict.detail,
        });
        continue;
      }
    }

    const replacements: Replacement[] = Array.isArray(patch.replacement)
      ? patch.replacement
      : [patch.replacement];

    const handle = selfHandle(plugin);
    let working = code;
    let count = 0;
    let failure: string | undefined;

    for (const replacement of replacements) {
      const result = applyReplacement(working, replacement, handle);
      if (!result.matched) {
        failure = `replacement match ${describeMatch(replacement.match)} did not match`;
        break;
      }
      working = result.text;
      count += 1;
    }

    if (failure !== undefined) {
      failed.push({
        plugin,
        find,
        chunk: chunkName,
        reason: "replacement-no-match",
        detail: failure,
      });
      continue;
    }

    if (count > 0) {
      try {
        parse(working, PARSE_OPTIONS);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed.push({
          plugin,
          find,
          chunk: chunkName,
          reason: "syntax-error",
          detail: `patched code does not parse as an ES module: ${message}`,
        });
        continue;
      }
    }

    code = working;
    applied.push({ plugin, find, chunk: chunkName, replacements: count });
  }

  return { code, applied, failed };
}
