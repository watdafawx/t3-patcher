import { describe, expect, it } from "vitest";
import { detectDiagnostics } from "../src/diagnostics.js";

describe("detectDiagnostics", () => {
  it("is all-off by default", () => {
    expect(detectDiagnostics({ env: {}, baseDir: "C:\\p", exists: () => false })).toEqual({
      noInject: false,
      noPlugins: false,
      noGuard: false,
      reasons: [],
    });
  });

  it("reads env switches", () => {
    const result = detectDiagnostics({
      env: { T3P_NO_INJECT: "1", T3P_NO_GUARD: "1" },
      baseDir: "/p",
      exists: () => false,
    });
    expect(result).toMatchObject({ noInject: true, noPlugins: false, noGuard: true });
    expect(result.reasons).toEqual(["T3P_NO_INJECT=1", "T3P_NO_GUARD=1"]);
  });

  it("reads marker files without consuming them", () => {
    const seen: string[] = [];
    const result = detectDiagnostics({
      env: {},
      baseDir: "C:\\Users\\x\\.t3-patcher",
      exists: (path) => {
        seen.push(path);
        return path.endsWith("no-plugins");
      },
    });
    expect(result).toMatchObject({ noInject: false, noPlugins: true, noGuard: false });
    expect(result.reasons).toEqual(["no-plugins marker"]);
    expect(seen).toContain("C:\\Users\\x\\.t3-patcher\\no-plugins");
  });

  it("ignores values other than 1 and unreadable markers", () => {
    const result = detectDiagnostics({
      env: { T3P_NO_INJECT: "true" },
      baseDir: "/p",
      exists: () => {
        throw new Error("nope");
      },
    });
    expect(result).toEqual({ noInject: false, noPlugins: false, noGuard: false, reasons: [] });
  });
});
