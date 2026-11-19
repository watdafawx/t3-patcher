import { parse } from "acorn";

/**
 * Parses the patched text as an ES module, the same rule `packages/patch-engine`
 * applies (`ecmaVersion: "latest"`, `sourceType: "module"`). Acorn is bundled into
 * the renderer entry, so evaluating the chunk is never necessary (and never done).
 */
export function checkModuleSyntax(code: string): { ok: true } | { ok: false; error: string } {
  try {
    parse(code, { ecmaVersion: "latest", sourceType: "module" });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
