import type { Patch, Replacement } from "@t3p/patch-engine";

/**
 * Plugin patches from the renderer (`t3.patches.register`) cross IPC as JSON. A RegExp travels as
 * `{regex: {source, flags}}`. Everything is bounded and compiled here, in main, so a bad pattern is
 * refused before it reaches the patch engine. The owner is always the calling plugin.
 */
const MAX_PATCHES = 64;
const MAX_REPLACEMENTS = 16;
const MAX_TEXT = 20_000;
const MAX_REGEX = 2_000;

type Wire = { regex: { source: string; flags?: string } } | string;

function compile(value: unknown, where: string, allowRegex = true): string | RegExp {
  if (typeof value === "string") {
    if (value.length === 0 || value.length > MAX_TEXT) throw new Error(`t3p: ${where} must be 1..${MAX_TEXT} characters`);
    return value;
  }
  const regex = (value as { regex?: { source?: unknown; flags?: unknown } } | null)?.regex;
  if (!allowRegex || !regex || typeof regex.source !== "string" || regex.source.length === 0 || regex.source.length > MAX_REGEX) {
    throw new Error(`t3p: ${where} must be a string or {regex:{source,flags}}`);
  }
  const flags = regex.flags === undefined ? "" : regex.flags;
  if (typeof flags !== "string" || !/^[dgimsuvy]{0,8}$/.test(flags)) throw new Error(`t3p: ${where} has invalid regex flags`);
  try {
    return new RegExp(regex.source, flags);
  } catch (error) {
    throw new Error(`t3p: ${where} is not a valid regular expression (${String(error)})`);
  }
}

/** Validates and compiles a wire patch list for `owner`. Throws with a readable message. */
export function parseWirePatches(owner: string, value: unknown): Patch[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PATCHES) throw new Error(`t3p: patches must be an array of 1..${MAX_PATCHES} items`);
  return value.map((raw, i) => {
    const item = raw as { find?: Wire; replacements?: unknown };
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`t3p: patches[${i}] must be an object`);
    for (const key of Object.keys(raw)) if (key !== "find" && key !== "replacements") throw new Error(`t3p: patches[${i}].${key} is not allowed`);
    const find = compile(item.find, `patches[${i}].find`);
    const reps = item.replacements;
    if (!Array.isArray(reps) || reps.length === 0 || reps.length > MAX_REPLACEMENTS) throw new Error(`t3p: patches[${i}].replacements must be 1..${MAX_REPLACEMENTS} items`);
    const replacement: Replacement[] = reps.map((r, j) => {
      const entry = r as { match?: Wire; replace?: unknown };
      if (typeof r !== "object" || r === null) throw new Error(`t3p: patches[${i}].replacements[${j}] must be an object`);
      for (const key of Object.keys(r)) if (key !== "match" && key !== "replace") throw new Error(`t3p: patches[${i}].replacements[${j}].${key} is not allowed`);
      if (typeof entry.replace !== "string" || entry.replace.length > MAX_TEXT) throw new Error(`t3p: patches[${i}].replacements[${j}].replace must be a string`);
      return { match: compile(entry.match, `patches[${i}].replacements[${j}].match`), replace: entry.replace };
    });
    return { plugin: owner, find, replacement };
  });
}
