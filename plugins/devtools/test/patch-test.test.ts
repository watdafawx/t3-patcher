import { describe, expect, it } from "vitest";

import { checkModuleSyntax } from "../src/logic/parse-check.js";
import {
  applyReplacementList,
  countMatches,
  findChunks,
  parseMatchSpec,
  runPatchTest,
  type ChunkText,
  type MatchSpec,
} from "../src/logic/patch-test.js";

const okParse = () => ({ ok: true }) as const;
const handle = 'window.__t3p_plugins["devtools"]';

const chunks: ChunkText[] = [
  { name: "assets/index-abc.js", source: "const a = 'MARK'; const b = 'MARK';" },
  { name: "assets/other-def.js", source: "const c = 'other';" },
];

function specOf(input: string): MatchSpec {
  const parsed = parseMatchSpec(input, "find");
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.spec;
}

describe("match specs", () => {
  it("parses literals and slash regexes, and rejects bad regexes", () => {
    expect(parseMatchSpec("MARK", "find")).toEqual({ ok: true, spec: { kind: "string", text: "MARK" } });
    expect(parseMatchSpec("/ma.k/i", "find")).toEqual({ ok: true, spec: { kind: "regex", source: "ma.k", flags: "i" } });
    expect(parseMatchSpec("/a\\/b/", "find")).toEqual({ ok: true, spec: { kind: "regex", source: "a\\/b", flags: "" } });
    expect(parseMatchSpec("/unterminated", "find")).toMatchObject({ ok: false });
    expect(parseMatchSpec("/[/", "find")).toMatchObject({ ok: false });
    expect(parseMatchSpec("//", "find")).toMatchObject({ ok: false });
    expect(parseMatchSpec("", "find")).toMatchObject({ ok: false });
  });

  it("counts non-overlapping occurrences per chunk", () => {
    expect(countMatches("aaaa", specOf("aa"))).toBe(2);
    expect(countMatches("aAa", specOf("/a/gi"))).toBe(3);
    expect(findChunks(chunks, specOf("MARK"))).toEqual([{ name: "assets/index-abc.js", count: 2 }]);
  });
});

describe("runPatchTest", () => {
  it("reports the single chunk, the replacement outcomes and a passing parse", () => {
    const report = runPatchTest({
      chunks,
      find: "MARK",
      replacements: [{ match: "MARK", replace: "OK" }],
      selfHandle: handle,
      parseCheck: okParse,
    });
    expect(report.verdict).toBe("unique");
    expect(report.chosen).toBe("assets/index-abc.js");
    expect(report.ok).toBe(true);
    expect(report.replacements).toHaveLength(1);
    expect(report.replacements[0]!.matchedText).toBe("MARK");
    expect(report.parse.status).toBe("ok");
    // String match replaces the first occurrence only, like the patch engine.
    expect(report.patchedChars).toBe(chunks[0]!.source.length - 2);
  });

  it("reports no match and ambiguity", () => {
    const none = runPatchTest({ chunks, find: "NOPE", replacements: [{ match: "a", replace: "b" }], selfHandle: handle, parseCheck: okParse });
    expect(none.verdict).toBe("no-match");
    expect(none.ok).toBe(false);
    expect(none.error).toContain("none");

    const two: ChunkText[] = [
      { name: "a.js", source: "xx" },
      { name: "b.js", source: "xx" },
    ];
    const ambiguous = runPatchTest({ chunks: two, find: "xx", replacements: [{ match: "x", replace: "y" }], selfHandle: handle, parseCheck: okParse });
    expect(ambiguous.verdict).toBe("ambiguous");
    expect(ambiguous.hits.map((h) => h.name)).toEqual(["a.js", "b.js"]);
    expect(ambiguous.ok).toBe(false);
  });

  it("applies regex groups, flags and $self, and shows context", () => {
    const source = "prefix const value = foo(123); suffix";
    const report = runPatchTest({
      chunks: [{ name: "assets/x.js", source }],
      find: "prefix",
      replacements: [
        { match: "/foo\\((\\d+)\\)/", replace: "bar($1, $self)" },
      ],
      selfHandle: handle,
      parseCheck: okParse,
    });
    expect(report.ok).toBe(true);
    expect(report.replacements[0]!.snippet.before).toContain("const value = ");
    expect(report.replacements[0]!.snippet.changed).toContain("bar(123,");
    expect(report.replacements[0]!.snippet.after).toBe("; suffix");
    expect(report.replacements[0]!.matchedText).toBe("foo(123)");
  });

  it("stops at a replacement that does not match", () => {
    const report = runPatchTest({
      chunks: [{ name: "assets/x.js", source: "alpha beta" }],
      find: "alpha",
      replacements: [
        { match: "alpha", replace: "A" },
        { match: "gamma", replace: "G" },
      ],
      selfHandle: handle,
      parseCheck: okParse,
    });
    expect(report.ok).toBe(false);
    expect(report.failedReplacement).toBe(2);
    expect(report.replacements).toHaveLength(1);
    expect(report.error).toContain("did not match");
  });

  it("reports a syntax error and says unavailable without a parser", () => {
    const bad = runPatchTest({
      chunks: [{ name: "assets/x.js", source: "const a = 1;" }],
      find: "const a",
      replacements: [{ match: "1", replace: "(" }],
      selfHandle: handle,
      parseCheck: checkModuleSyntax,
    });
    expect(bad.parse.status).toBe("error");
    expect(bad.ok).toBe(false);

    const unavailable = runPatchTest({
      chunks: [{ name: "assets/x.js", source: "const a = 1;" }],
      find: "const a",
      replacements: [{ match: "1", replace: "2" }],
      selfHandle: handle,
      parseCheck: null,
    });
    expect(unavailable.parse.status).toBe("unavailable");
    expect(unavailable.ok).toBe(true);
  });

  it("validates input before touching chunks", () => {
    expect(runPatchTest({ chunks, find: "/[/", replacements: [{ match: "a", replace: "b" }], selfHandle: handle }).verdict).toBe("invalid");
    expect(runPatchTest({ chunks, find: "MARK", replacements: [], selfHandle: handle }).error).toContain("at least one");
    expect(runPatchTest({ chunks, find: "MARK", replacements: [{ match: "", replace: "x" }], selfHandle: handle }).error).toContain("must not be empty");
  });

  it("never mutates the chunk text", () => {
    const source = "const a = 1;";
    const list = [{ name: "assets/x.js", source }];
    runPatchTest({ chunks: list, find: "const", replacements: [{ match: "a", replace: "b" }], selfHandle: handle, parseCheck: okParse });
    expect(list[0]!.source).toBe(source);
  });
});

describe("applyReplacementList", () => {
  it("applies string replacements to the first occurrence only", () => {
    const result = applyReplacementList(
      "aba",
      [{ spec: specOf("a"), original: "a", replace: "z" }],
      handle,
    );
    expect(result.ok).toBe(true);
    expect(result.text).toBe("zba");
  });

  it("keeps a regex without /g to one replacement", () => {
    const result = applyReplacementList("aaa", [{ spec: specOf("/a/"), original: "/a/", replace: "z" }], handle);
    expect(result.text).toBe("zaa");
    const global = applyReplacementList("aaa", [{ spec: specOf("/a/g"), original: "/a/g", replace: "z" }], handle);
    expect(global.text).toBe("zzz");
  });

  it("supports $& and $$ like String.prototype.replace", () => {
    const result = applyReplacementList("abc", [{ spec: specOf("b"), original: "b", replace: "[$&]$$" }], handle);
    expect(result.text).toBe("a[b]$c");
  });
});
