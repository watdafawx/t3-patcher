import type { Patch } from "@t3p/patch-engine";

export const CORE_OWNER = "t3p.core";

/** Visible UI string the TEST patch rewrites. Picked from the 0.1.x client (see docs/wp-2-notes.md). */
// Visible on the onboarding screen of a fresh T3 Code 0.1.10 profile (checked on rig).
export const TEST_PATCH_DEFAULT_MATCH = "Use T3 Code on your phone";
export const TEST_PATCH_DEFAULT_TEXT = "T3P TEST PATCH";

/**
 * Built-in patches. Only the TEST patch exists in WP-2, and only when
 * T3P_TEST_PATCH=1: it replaces one visible UI string (T3P_TEST_PATCH_MATCH,
 * literal, first occurrence) with T3P_TEST_PATCH_TEXT, which lets the rig
 * check prove that chunk rewriting and the code cache work end to end.
 */
export function builtinPatches(env: NodeJS.ProcessEnv): Patch[] {
  if (env.T3P_TEST_PATCH !== "1") return [];
  const match = env.T3P_TEST_PATCH_MATCH || TEST_PATCH_DEFAULT_MATCH;
  const text = env.T3P_TEST_PATCH_TEXT || TEST_PATCH_DEFAULT_TEXT;
  // JSON.stringify keeps the replacement a valid string literal body when the match sits inside quotes.
  const safe = JSON.stringify(text).slice(1, -1).replace(/\$/g, "$$$$");
  return [{ plugin: CORE_OWNER, find: match, replacement: { match, replace: safe } }];
}
