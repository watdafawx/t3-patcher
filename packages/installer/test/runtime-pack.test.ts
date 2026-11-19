import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultRuntimeSource } from "../src/install.js";
import { extractEmbeddedRuntime, isSingleFileExe, packRuntime, unpackRuntime } from "../src/runtime-pack.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "t3p-pack-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("runtime pack", () => {
  it("round-trips a runtime folder and leaves maps and type files out", () => {
    const src = join(tmp, "src");
    mkdirSync(join(src, "lib"), { recursive: true });
    writeFileSync(join(src, "main.cjs"), "// main\n");
    writeFileSync(join(src, "main.cjs.map"), "{}");
    writeFileSync(join(src, "x.d.mts"), "export {}");
    writeFileSync(join(src, "lib", "a.js"), Buffer.from([0, 1, 2, 255]));
    const { buffer, files } = packRuntime(src);
    expect(files).toEqual(["lib/a.js", "main.cjs"]);
    const dest = join(tmp, "dest");
    expect(unpackRuntime(buffer, dest).sort()).toEqual(["lib/a.js", "main.cjs"]);
    expect(readFileSync(join(dest, "main.cjs"), "utf8")).toBe("// main\n");
    expect([...readFileSync(join(dest, "lib", "a.js"))]).toEqual([0, 1, 2, 255]);
  });

  it("refuses a path that escapes the target", () => {
    const evil = gzipSync(Buffer.from(JSON.stringify({ v: 1, files: [{ path: "../evil.txt", data: "eA==" }] })));
    expect(() => unpackRuntime(evil, join(tmp, "dest"))).toThrow(/escapes/);
  });

  it("refuses an unknown format", () => {
    expect(() => unpackRuntime(gzipSync(Buffer.from(JSON.stringify({ v: 2, files: [] }))), join(tmp, "d"))).toThrow(/unsupported/);
  });
});

describe("outside the single-file exe", () => {
  it("is not an exe, has nothing embedded, and falls back to the monorepo runtime", () => {
    expect(isSingleFileExe()).toBe(false);
    expect(extractEmbeddedRuntime()).toBeNull();
    const found = defaultRuntimeSource();
    if (found) expect(found.replace(/\\/g, "/")).toMatch(/main-runtime\/dist$|installer\/runtime$/);
  });
});
