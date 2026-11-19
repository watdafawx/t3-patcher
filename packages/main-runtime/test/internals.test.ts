import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { InternalsStatus } from "../src/internals/status.js";
import { CAPTURES } from "../src/patches/captures.js";
import type { PatchReport } from "../src/patches/service.js";
import { parseWirePatches } from "../src/patches/wire.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return logger; } } as never;

function make(report: Partial<PatchReport> = {}, disabled: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "t3p-int-"));
  dirs.push(dir);
  const file = join(dir, "internals-status.json");
  const status = new InternalsStatus({
    file,
    captures: CAPTURES,
    disabled: new Set(disabled) as never,
    appVersion: "0.1.10",
    patchReport: () => ({ applied: [], failed: [], disabled: [], indexScan: undefined as never, ...report }),
    log: logger,
  });
  return { status, file };
}

describe("InternalsStatus", () => {
  it("starts pending and writes the file", () => {
    const { status, file } = make();
    status.writeInitial();
    const written = JSON.parse(readFileSync(file, "utf8"));
    expect(written.version).toBe(1);
    expect(Object.values(written.captures).every((c) => (c as { state: string }).state === "pending")).toBe(true);
  });

  it("keeps renderer verdicts and rejects unknown input", () => {
    const { status, file } = make();
    status.report("router", "captured", "ok");
    status.report("atomRegistry", "fallback", "sub");
    expect(() => status.report("nope", "captured", "")).toThrow(/unknown capture/);
    expect(() => status.report("router", "weird", "")).toThrow(/invalid capture state/);
    const written = JSON.parse(readFileSync(file, "utf8"));
    expect(written.captures.router.state).toBe("captured");
    expect(written.captures.atomRegistry.state).toBe("fallback");
  });

  it("a failed patch turns captured into failed but keeps fallback", () => {
    const router = CAPTURES.find((c) => c.name === "router")!;
    const find = String(router.patches[0]!.find);
    const palette = CAPTURES.find((c) => c.name === "commandPalette")!;
    const pfind = String(palette.patches[0]!.find);
    const { status } = make({
      failed: [
        { owner: "t3p.core", find, reason: "no-match", detail: "x" } as never,
        { owner: "t3p.core", find: pfind, reason: "no-match", detail: "y" } as never,
      ],
    });
    status.report("router", "captured", "ok");
    status.report("commandPalette", "fallback", "dom");
    const snap = status.snapshot();
    expect(snap.captures.router.state).toBe("failed");
    expect(snap.captures.commandPalette.state).toBe("fallback");
    expect(snap.captures.commandPalette.detail).toContain("patch failed");
  });
});

describe("parseWirePatches", () => {
  it("compiles strings and regexes with the calling plugin as owner", () => {
    const patches = parseWirePatches("p", [{ find: { regex: { source: "a(b)", flags: "g" } }, replacements: [{ match: "a", replace: "$self.x" }] }]);
    expect(patches[0]!.plugin).toBe("p");
    expect(patches[0]!.find).toBeInstanceOf(RegExp);
  });

  it("rejects bad shapes, flags and sizes", () => {
    expect(() => parseWirePatches("p", [])).toThrow();
    expect(() => parseWirePatches("p", [{ find: "a", replacements: [] }])).toThrow(/replacements/);
    expect(() => parseWirePatches("p", [{ find: { regex: { source: "(", flags: "" } }, replacements: [{ match: "a", replace: "b" }] }])).toThrow(/regular expression/);
    expect(() => parseWirePatches("p", [{ find: { regex: { source: "a", flags: "z" } }, replacements: [{ match: "a", replace: "b" }] }])).toThrow(/flags/);
    expect(() => parseWirePatches("p", [{ find: "a", replacements: [{ match: "a", replace: "b" }], extra: 1 }])).toThrow(/not allowed/);
    expect(() => parseWirePatches("p", [{ find: "x".repeat(20_001), replacements: [{ match: "a", replace: "b" }] }])).toThrow();
  });
});
