import { describe, expect, it } from "vitest";

import { applyPatches } from "../src/index.js";

describe("applyPatches", () => {
  it("applies a single string match to the right chunk", () => {
    const source = "export const x = 1; function foo(){return 'old'}";

    const result = applyPatches("a.js", source, [
      {
        plugin: "t3p.t",
        find: "function foo(){",
        replacement: { match: /return 'old'/, replace: "return 'new'" },
      },
    ]);

    expect(result.code).toBe(
      "export const x = 1; function foo(){return 'new'}",
    );
    expect(result.applied).toEqual([
      {
        plugin: "t3p.t",
        find: "function foo(){",
        chunk: "a.js",
        replacements: 1,
      },
    ]);
    expect(result.failed).toEqual([]);
  });

  it("resolves $self to the plugin's global handle", () => {
    const source = "export const z = 1;\nhook(0);";

    const result = applyPatches("a.js", source, [
      {
        plugin: "t3p.core",
        find: "hook(0)",
        replacement: { match: /hook\((\d+)\)/, replace: "$self.hook($1 + 1)" },
      },
    ]);

    expect(result.failed).toEqual([]);
    expect(result.code).toBe(
      'export const z = 1;\nwindow.__t3p_plugins["t3p.core"].hook(0 + 1);',
    );
  });

  it("resolves $self in the return value of a function replacement", () => {
    const source = "export const z = 1;\nhook(0);";

    const result = applyPatches("a.js", source, [
      {
        plugin: "t3p.core",
        find: "hook(0)",
        replacement: {
          match: "hook(0)",
          replace: (substring) => `$self.${substring}`,
        },
      },
    ]);

    expect(result.failed).toEqual([]);
    expect(result.code).toBe(
      'export const z = 1;\nwindow.__t3p_plugins["t3p.core"].hook(0);',
    );
  });

  it("supports native $1, $& and $$ expansion in string replacements", () => {
    const source = "export const v = 'abc';";

    const result = applyPatches("a.js", source, [
      {
        plugin: "t3p.t",
        find: "export const v",
        replacement: [
          { match: /'(\w+)'/, replace: "'$1$$'" },
        ],
      },
    ]);

    expect(result.failed).toEqual([]);
    expect(result.code).toBe("export const v = 'abc$';");
  });

  it("passes capture groups to function replacements", () => {
    const result = applyPatches("a.js", "n=0", [
      {
        plugin: "t3p.t",
        find: "n=0",
        replacement: {
          match: /(\w+)=0/,
          replace: (substring, name: string) => `${name}+1`,
        },
      },
    ]);

    expect(result.failed).toEqual([]);
    expect(result.code).toBe("n+1");
  });

  it("reports replacement-no-match and leaves the chunk unchanged", () => {
    const source = "export const x = 1;";

    const result = applyPatches("a.js", source, [
      {
        plugin: "t3p.t",
        find: "export const x",
        replacement: { match: "y = 2", replace: "y = 3" },
      },
    ]);

    expect(result.code).toBe(source);
    expect(result.applied).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.reason).toBe("replacement-no-match");
    expect(result.failed[0]!.chunk).toBe("a.js");
  });

  it("rolls back a patch that produces a syntax error and keeps later patches", () => {
    const source = "export const a = 1;";

    const result = applyPatches("a.js", source, [
      {
        plugin: "t3p.bad",
        find: "export const a = 1;",
        replacement: { match: "export const a = 1;", replace: "export const a = }}};" },
      },
      {
        plugin: "t3p.good",
        find: "const a = 1",
        replacement: { match: "const a = 1", replace: "const a = 2" },
      },
    ]);

    expect(result.code).toBe("export const a = 2;");
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.plugin).toBe("t3p.bad");
    expect(result.failed[0]!.reason).toBe("syntax-error");
    expect(result.applied).toEqual([
      {
        plugin: "t3p.good",
        find: "const a = 1",
        chunk: "a.js",
        replacements: 1,
      },
    ]);
  });

  it("is atomic across multiple replacements", () => {
    const source = "export const x = 1; export const y = 2;";

    const result = applyPatches("a.js", source, [
      {
        plugin: "t3p.t",
        find: "export const x",
        replacement: [
          { match: "x = 1", replace: "x = 3" },
          { match: "y = 9", replace: "y = 4" },
        ],
      },
    ]);

    expect(result.code).toBe(source);
    expect(result.applied).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.reason).toBe("replacement-no-match");
  });

  it("counts every replacement in a multi-replacement patch", () => {
    const source = "export const x = 1; export const y = 2;";

    const result = applyPatches("a.js", source, [
      {
        plugin: "t3p.t",
        find: "export const x",
        replacement: [
          { match: "x = 1", replace: "x = 3" },
          { match: /y = 2/, replace: "y = 4" },
        ],
      },
    ]);

    expect(result.failed).toEqual([]);
    expect(result.code).toBe("export const x = 3; export const y = 4;");
    expect(result.applied[0]!.replacements).toBe(2);
  });

  it("skips a patch whose predicate returns false", () => {
    const source = "export const x = 1;";

    const result = applyPatches("a.js", source, [
      {
        plugin: "t3p.t",
        find: "export const x",
        replacement: { match: "x = 1", replace: "x = 2" },
        predicate: () => false,
      },
    ]);

    expect(result.code).toBe(source);
    expect(result.applied).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.reason).toBe("predicate");
  });

  it("applies a patch whose predicate returns true", () => {
    const result = applyPatches("a.js", "export const x = 1;", [
      {
        plugin: "t3p.t",
        find: "export const x",
        replacement: { match: "x = 1", replace: "x = 2" },
        predicate: () => true,
      },
    ]);

    expect(result.code).toBe("export const x = 2;");
    expect(result.applied).toHaveLength(1);
    expect(result.failed).toEqual([]);
  });

  it("applies only the first occurrence of a string match", () => {
    const source = "const a = 1; const b = 1;";

    const result = applyPatches("a.js", source, [
      {
        plugin: "t3p.t",
        find: "const a = 1;",
        replacement: { match: "= 1", replace: "= 2" },
      },
    ]);

    expect(result.code).toBe("const a = 2; const b = 1;");
  });
});
