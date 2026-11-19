import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { listAsarFiles, readAsarFile, readAsarFormat, readAsarFiles } from "../src/asar.js";
import { loadClientFromAsar, loadServerSources } from "../src/bundle.js";
import { readAsarIdentity } from "../src/target.js";
import { serverAsarEntries, writeAsarFixture } from "./fixtures.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "t3p-compat-asar-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("asar reader", () => {
  it("reads the new (Electron 44) header layout", () => {
    const dir = makeTempDir();
    const file = writeAsarFixture(dir, "new.asar", serverAsarEntries(), "new");
    const format = readAsarFormat(file);
    expect(format.layout).toBe("new");
    expect(format.jsonStart).toBe(16);
    expect(format.dataOffset % 4).toBe(0);
  });

  it("reads the old (8-byte preamble) header layout", () => {
    const dir = makeTempDir();
    const file = writeAsarFixture(dir, "old.asar", serverAsarEntries(), "old");
    expect(readAsarFormat(file).layout).toBe("old");
  });

  it("lists and reads every packed file", () => {
    const dir = makeTempDir();
    const file = writeAsarFixture(dir, "a.asar", serverAsarEntries());
    const files = listAsarFiles(file);
    const names = files.map((entry) => entry.path);
    expect(names).toContain("apps/server/dist/client/index.html");
    expect(names).toContain("apps/server/dist/client/assets/a.js");

    const js = files.find((entry) => entry.path === "apps/server/dist/client/assets/a.js")!;
    expect(readAsarFile(file, js).toString("utf8")).toBe("export const a = 1;\n");

    const many = readAsarFiles(file, files);
    expect(many.size).toBe(files.length);
    expect(many.get("apps/server/package.json")!.toString("utf8")).toContain("t3code-server");
  });

  it("reports an archive without a client instead of returning nothing", () => {
    const dir = makeTempDir();
    const file = writeAsarFixture(dir, "empty.asar", [{ path: "package.json", data: "{}" }]);
    expect(() => loadClientFromAsar(file)).toThrow(/no \*\/client\/index\.html/);
  });

  it("rejects a file that is not an asar", () => {
    const dir = makeTempDir();
    const file = join(dir, "nope.asar");
    writeFileSync(file, "not an archive at all");
    expect(() => readAsarFormat(file)).toThrow(/unrecognised asar header layout|too small/);
  });
});

describe("client bundle", () => {
  it("loads chunks and html relative to the client root", () => {
    const dir = makeTempDir();
    const file = writeAsarFixture(dir, "s.asar", serverAsarEntries());
    const bundle = loadClientFromAsar(file);
    expect(bundle.root).toBe("apps/server/dist/client/");
    expect([...bundle.chunks.keys()].sort()).toEqual(["assets/a.js", "assets/b.js"]);
    expect(bundle.html.has("index.html")).toBe(true);
    expect(bundle.bytes).toBeGreaterThan(0);
  });

  it("uses the server bundle as method evidence and skips the client itself", () => {
    const dir = makeTempDir();
    const file = writeAsarFixture(
      dir,
      "s.asar",
      serverAsarEntries({ server: 'var T={serverGetConfig:"server.getConfig"};' }),
    );
    const sources = loadServerSources({ asarPath: file });
    expect(sources.evidence).toBe("server");
    expect(sources.text).toContain("server.getConfig");
    expect(sources.text).not.toContain("export const a = 1");
  });

  it("falls back to the client chunks when only a dir is available", () => {
    const dir = makeTempDir();
    const file = writeAsarFixture(dir, "s.asar", serverAsarEntries());
    const bundle = loadClientFromAsar(file);
    const sources = loadServerSources({ bundle });
    expect(sources.evidence).toBe("client");
  });

  it("reads the version the archive reports", () => {
    const dir = makeTempDir();
    const file = writeAsarFixture(dir, "s.asar", serverAsarEntries());
    expect(readAsarIdentity(file)).toMatchObject({ name: "t3code-server", version: "9.9.9" });
  });

  it("keeps the fixture chunk text intact", () => {
    const fixture = JSON.parse(
      readFileSync(join(import.meta.dirname, "fixtures", "client-chunk.jsonl"), "utf8"),
    ) as { body: string };
    const dir = makeTempDir();
    const file = writeAsarFixture(
      dir,
      "c.asar",
      serverAsarEntries({ chunks: { "assets/chunk.js": fixture.body } }),
    );
    const bundle = loadClientFromAsar(file);
    expect(bundle.chunks.get("assets/chunk.js")).toBe(fixture.body);
  });
});
