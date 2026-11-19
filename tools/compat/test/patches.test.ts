import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  corePatchFinds,
  pluginPatchFinds,
  readPatchFile,
  scanFinds,
  serverGuardFinding,
  type FindEntry,
} from "../src/patches.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "t3p-compat-patches-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const chunks = new Map<string, string>([
  ["assets/a.js", "const alpha = 1; export { alpha };\n"],
  ["assets/b.js", "const beta = 2; export { beta };\n"],
  ["assets/c.js", "const alpha = 3; const gamma = 4;\n"],
]);

function entry(find: string | RegExp, label = "probe"): FindEntry {
  return { owner: "test", label, origin: "test", patch: { plugin: "test", find, replacement: [] } };
}

describe("patch find scanning", () => {
  it("passes a find that matches exactly one chunk", () => {
    const [result] = scanFinds(chunks, [entry("const beta")]);
    expect(result).toMatchObject({ status: "ok", hits: ["assets/b.js"] });
  });

  it("fails a find that matches no chunk", () => {
    const [result] = scanFinds(chunks, [entry("const delta")]);
    expect(result).toMatchObject({ status: "no-match", hits: [] });
  });

  it("fails a find that matches more than one chunk", () => {
    const [result] = scanFinds(chunks, [entry("const alpha")]);
    expect(result).toMatchObject({ status: "ambiguous", hits: ["assets/a.js", "assets/c.js"] });
  });

  it("supports regex finds without keeping lastIndex state", () => {
    const find = /const (beta)/g;
    const first = scanFinds(chunks, [entry(find)]);
    const second = scanFinds(chunks, [entry(find)]);
    expect(first[0]!.status).toBe("ok");
    expect(second[0]!.hits).toEqual(first[0]!.hits);
  });

  it("reports the find text for the report", () => {
    const [result] = scanFinds(chunks, [entry(/const (alpha|beta)/)]);
    expect(result!.find).toBe("/const (alpha|beta)/");
  });
});

describe("first-party find sources", () => {
  it("exposes the core capture patches with their capture names", () => {
    const entries = corePatchFinds();
    const labels = entries.map((entry) => entry.label);
    expect(labels).toContain("atomRegistry");
    expect(labels).toContain("router");
    expect(labels).toContain("settingsNav[0]");
    expect(labels.every((label) => label.length > 0)).toBe(true);
    expect(entries[0]!.owner).toBe("t3p.core");
  });

  it("reads a find-only patch file", () => {
    const dir = makeTempDir();
    const file = join(dir, "patches.json");
    writeFileSync(
      file,
      JSON.stringify([
        { name: "literal", plugin: "demo", find: "const beta" },
        { label: "regex", findRegex: { source: "const\\s+gamma", flags: "i" } },
      ]),
    );
    const entries = readPatchFile(file);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ owner: "demo", label: "literal" });
    expect(entries[1]!.patch.find).toBeInstanceOf(RegExp);
    expect((entries[1]!.patch.find as RegExp).test("const GAMMA")).toBe(true);
  });

  it("rejects a patch file without a find", () => {
    const dir = makeTempDir();
    const file = join(dir, "bad.json");
    writeFileSync(file, JSON.stringify([{ name: "no find" }]));
    expect(() => readPatchFile(file)).toThrow(/needs a string "find"/);
  });

  it("discovers plugins/<id>/patches.json when present", () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "demo"), { recursive: true });
    writeFileSync(
      join(dir, "demo", "patches.json"),
      JSON.stringify([{ name: "demo find", plugin: "demo", find: "const alpha" }]),
    );
    const entries = pluginPatchFinds(dir);
    expect(entries.map((entry) => entry.label)).toEqual(["demo find"]);
    expect(pluginPatchFinds(join(dir, "missing"))).toEqual([]);
  });
});

describe("serverGuardFinding", () => {
  const chunk = `import { n as fnUntraced, Fs as tryPromise } from "./effect.mjs";
var OrchestratorDispatchError = class extends TaggedError$1()("OrchestratorDispatchError", {}) {};
const dispatchWithReceipt = fnUntraced(function* (command) {
	return command;
});`;

  it("is ok when the patch applies to exactly one server chunk", () => {
    const result = serverGuardFinding(new Map([["apps/server/dist/runtimeLayer-A.mjs", chunk], ["apps/server/dist/bin.mjs", "export {};"]]));
    expect(result).toMatchObject({ owner: "t3p.core", label: "serverGuard", status: "ok", hits: ["apps/server/dist/runtimeLayer-A.mjs"] });
    expect(result?.detail).toBeUndefined();
  });

  it("reports why the anchor no longer patches", () => {
    const result = serverGuardFinding(new Map([["apps/server/dist/runtimeLayer-A.mjs", chunk.replace("Fs as tryPromise", "Fs as tp")]]));
    expect(result).toMatchObject({ status: "no-match", hits: [] });
    expect(result?.detail).toContain("no-try-promise");
  });

  it("is skipped without server chunks", () => {
    expect(serverGuardFinding(undefined)).toBeNull();
    expect(serverGuardFinding(new Map())).toBeNull();
  });
});
