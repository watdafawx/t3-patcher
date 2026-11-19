import { describe, expect, it } from "vitest";

import { applyPatchSet, planPatches } from "../src/index.js";
import type { ChunkSet } from "../src/index.js";

const chunks: ChunkSet = new Map([
  ["a.js", "export const x = 1; function foo(){return 'old'}"],
  ["b.js", "export const y = 2;"],
]);

describe("planPatches", () => {
  it("assigns a patch to the only chunk its find matches", () => {
    const plan = planPatches(chunks, [
      {
        plugin: "t3p.t",
        find: "function foo(){",
        replacement: { match: /return 'old'/, replace: "return 'new'" },
      },
    ]);

    expect(plan.failed).toEqual([]);
    expect([...plan.byChunk.keys()]).toEqual(["a.js"]);
    expect(plan.byChunk.get("a.js")).toHaveLength(1);
  });

  it("reports no-match when no chunk contains the find", () => {
    const plan = planPatches(chunks, [
      {
        plugin: "t3p.t",
        find: "not in any chunk",
        replacement: { match: "x", replace: "y" },
      },
    ]);

    expect(plan.byChunk.size).toBe(0);
    expect(plan.failed).toHaveLength(1);
    expect(plan.failed[0]!.reason).toBe("no-match");
    expect(plan.failed[0]!.chunk).toBeUndefined();
  });

  it("reports ambiguous when the find matches several chunks", () => {
    const plan = planPatches(chunks, [
      {
        plugin: "t3p.t",
        find: "export",
        replacement: { match: "x", replace: "y" },
      },
    ]);

    expect(plan.byChunk.size).toBe(0);
    expect(plan.failed).toHaveLength(1);
    expect(plan.failed[0]!.reason).toBe("ambiguous");
    expect(plan.failed[0]!.detail).toContain("a.js");
    expect(plan.failed[0]!.detail).toContain("b.js");
  });

  it("lists at most five chunk names for an ambiguous find", () => {
    const many: ChunkSet = new Map(
      Array.from({ length: 8 }, (_, index) => [`c${index}.js`, "shared text"] as const),
    );

    const plan = planPatches(many, [
      {
        plugin: "t3p.t",
        find: "shared",
        replacement: { match: "shared", replace: "x" },
      },
    ]);

    const detail = plan.failed[0]!.detail;
    expect(detail).toContain("c0.js");
    expect(detail).toContain("c4.js");
    expect(detail).not.toContain("c5.js");
    expect(detail).toContain("+3 more");
  });

  it("matches a RegExp find against chunk sources", () => {
    const plan = planPatches(chunks, [
      {
        plugin: "t3p.t",
        find: /foo\(\)\{/,
        replacement: { match: "return 'old'", replace: "return 'new'" },
      },
    ]);

    expect(plan.failed).toEqual([]);
    expect([...plan.byChunk.keys()]).toEqual(["a.js"]);
  });

  it("skips patches whose predicate returns false", () => {
    const plan = planPatches(chunks, [
      {
        plugin: "t3p.t",
        find: "function foo(){",
        replacement: { match: "x", replace: "y" },
        predicate: () => false,
      },
    ]);

    expect(plan.byChunk.size).toBe(0);
    expect(plan.failed[0]!.reason).toBe("predicate");
  });
});

describe("applyPatchSet", () => {
  it("plans and applies, returning per-chunk results and failures", () => {
    const result = applyPatchSet(chunks, [
      {
        plugin: "t3p.t",
        find: "function foo(){",
        replacement: { match: /return 'old'/, replace: "return 'new'" },
      },
      {
        plugin: "t3p.t",
        find: "export const y = 2;",
        replacement: { match: "y = 2", replace: "y = 3" },
      },
      {
        plugin: "t3p.t",
        find: "missing everywhere",
        replacement: { match: "x", replace: "y" },
      },
    ]);

    expect([...result.results.keys()]).toEqual(["a.js", "b.js"]);
    expect(result.results.get("a.js")!.code).toBe(
      "export const x = 1; function foo(){return 'new'}",
    );
    expect(result.results.get("b.js")!.code).toBe("export const y = 3;");
    expect(result.applied).toHaveLength(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.reason).toBe("no-match");
  });

  it("keeps applying other chunks when one patch fails to apply", () => {
    const result = applyPatchSet(chunks, [
      {
        plugin: "t3p.t",
        find: "function foo(){",
        replacement: { match: "not there", replace: "x" },
      },
      {
        plugin: "t3p.t",
        find: "export const y = 2;",
        replacement: { match: "y = 2", replace: "y = 3" },
      },
    ]);

    expect(result.results.get("a.js")!.code).toBe(chunks.get("a.js"));
    expect(result.results.get("b.js")!.code).toBe("export const y = 3;");
    expect(result.failed[0]!.reason).toBe("replacement-no-match");
    expect(result.applied).toHaveLength(1);
  });
});
