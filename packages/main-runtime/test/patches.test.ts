import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { nullLogger } from "../src/log.js";
import { builtinPatches, CORE_OWNER } from "../src/patches/builtin.js";
import { ChunkIndex, listChunks } from "../src/patches/chunk-index.js";
import { PatchRegistry } from "../src/patches/registry.js";
import { PatchService } from "../src/patches/service.js";

let base: string;
let client: string;
let cacheDir: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "t3p-patches-"));
  client = join(base, "client");
  cacheDir = join(base, "cache");
  mkdirSync(join(client, "assets", "nested"), { recursive: true });
  writeFileSync(join(client, "index.html"), "<html></html>");
  writeFileSync(join(client, "assets", "index-abc.js"), 'export const title = "Use T3 Code on your phone";\n');
  writeFileSync(join(client, "assets", "chat-def.js"), 'export const a = "shared"; export const b = 1;\n');
  writeFileSync(join(client, "assets", "nested", "x-1.mjs"), 'export const c = "shared";\n');
  writeFileSync(join(client, "assets", "style.css"), "body{}");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("chunk index", () => {
  it("lists JS chunks recursively with URL-style names", () => {
    expect(listChunks(client).map((c) => c.name)).toEqual(["assets/chat-def.js", "assets/index-abc.js", "assets/nested/x-1.mjs"]);
  });

  it("locates finds and caches them on disk keyed by the listing", () => {
    const file = join(cacheDir, "chunk-index.json");
    const first = new ChunkIndex(client, file, nullLogger);
    expect(first.locate(["Use T3 Code on your phone", "shared", /b = \d/]).get("shared")).toEqual(["assets/chat-def.js", "assets/nested/x-1.mjs"]);
    expect(first.lastScan?.files).toBe(3);
    // A fresh instance (next launch) answers from disk without scanning.
    const second = new ChunkIndex(client, file, nullLogger);
    expect(second.locate(["Use T3 Code on your phone"]).get("Use T3 Code on your phone")).toEqual(["assets/index-abc.js"]);
    expect(second.lastScan).toBeNull();
    // An app update (listing change) invalidates the cache.
    writeFileSync(join(client, "assets", "new-1.js"), 'const t = "Use T3 Code on your phone";');
    const third = new ChunkIndex(client, file, nullLogger);
    expect(third.locate(["Use T3 Code on your phone"]).get("Use T3 Code on your phone")).toEqual(["assets/index-abc.js", "assets/new-1.js"]);
    expect(third.lastScan).not.toBeNull();
  });

  it("is safe against prototype keys as find strings", () => {
    const index = new ChunkIndex(client, join(cacheDir, "i.json"), nullLogger);
    expect(index.locate(["constructor", "__proto__"]).get("constructor")).toEqual([]);
  });
});

describe("patch service", () => {
  const make = (registry: PatchRegistry, useCache = true) =>
    new PatchService(registry, new ChunkIndex(client, join(cacheDir, "chunk-index.json"), nullLogger), useCache ? join(cacheDir, "patches") : null, nullLogger);

  it("applies a patch to the single matching chunk", () => {
    const registry = new PatchRegistry();
    registry.register("p", [{ plugin: "ignored", find: "Use T3 Code on your phone", replacement: { match: "Use T3 Code on your phone", replace: "Patched!" } }]);
    const service = make(registry);
    expect(service.hasPatchesFor("assets/index-abc.js")).toBe(true);
    expect(service.hasPatchesFor("assets/chat-def.js")).toBe(false);
    expect(service.transform("assets/index-abc.js", 'export const title = "Use T3 Code on your phone";\n')).toBe('export const title = "Patched!";\n');
    expect(service.report().applied[0]).toMatchObject({ plugin: "p", chunk: "assets/index-abc.js" });
  });

  it("disables no-match and ambiguous patches without touching others", () => {
    const registry = new PatchRegistry();
    registry.register("p", [
      { plugin: "p", find: "does-not-exist", replacement: { match: "x", replace: "y" } },
      { plugin: "p", find: "shared", replacement: { match: "shared", replace: "z" } },
      { plugin: "p", find: "Use T3 Code on your phone", replacement: { match: "Use T3 Code on your phone", replace: "ok" } },
    ]);
    const service = make(registry);
    expect(service.hasPatchesFor("assets/chat-def.js")).toBe(false);
    expect(service.hasPatchesFor("assets/index-abc.js")).toBe(true);
    expect(registry.disabledList().map((d) => d.reason).sort()).toEqual(["ambiguous", "no-match"]);
    expect(registry.active()).toHaveLength(1);
  });

  it("disables a patch whose replacement misses or breaks syntax and serves the original", () => {
    const registry = new PatchRegistry();
    registry.register("p", [
      { plugin: "p", find: "Use T3 Code on your phone", replacement: { match: "not in chunk", replace: "x" } },
      { plugin: "q", find: "title", replacement: { match: "export const", replace: "export const const" } },
    ]);
    const service = make(registry, false);
    expect(service.transform("assets/index-abc.js", 'export const title = "Use T3 Code on your phone";\n')).toBeNull();
    expect(registry.active()).toHaveLength(0);
    expect(service.report().failed.map((f) => f.reason).sort()).toEqual(["replacement-no-match", "syntax-error"]);
  });

  it("uses the code cache: a changed patch yields new output, same patch hits the cache", () => {
    const source = 'export const title = "Use T3 Code on your phone";\n';
    const r1 = new PatchRegistry();
    r1.register(CORE_OWNER, builtinPatches({ T3P_TEST_PATCH: "1", T3P_TEST_PATCH_TEXT: "first" }));
    expect(make(r1).transform("assets/index-abc.js", source)).toContain('"first"');
    const r2 = new PatchRegistry();
    r2.register(CORE_OWNER, builtinPatches({ T3P_TEST_PATCH: "1", T3P_TEST_PATCH_TEXT: "second" }));
    expect(make(r2).transform("assets/index-abc.js", source)).toContain('"second"');
    const r3 = new PatchRegistry();
    r3.register(CORE_OWNER, builtinPatches({ T3P_TEST_PATCH: "1", T3P_TEST_PATCH_TEXT: "first" }));
    const s3 = make(r3);
    expect(s3.transform("assets/index-abc.js", source)).toContain('"first"');
  });

  it("falls back to uncached apply when the cache dir is unusable", () => {
    const blocker = join(base, "blocker");
    writeFileSync(blocker, "not a dir");
    const registry = new PatchRegistry();
    registry.register(CORE_OWNER, builtinPatches({ T3P_TEST_PATCH: "1" }));
    const service = new PatchService(registry, new ChunkIndex(client, join(cacheDir, "i.json"), nullLogger), join(blocker, "patches"), nullLogger);
    expect(service.transform("assets/index-abc.js", 'export const title = "Use T3 Code on your phone";\n')).toContain("T3P TEST PATCH");
  });

  it("has no patches and does no index work when the registry is empty", () => {
    let calls = 0;
    const service = new PatchService(new PatchRegistry(), { locate: () => (calls++, new Map()) }, null, nullLogger);
    expect(service.hasPatchesFor("assets/index-abc.js")).toBe(false);
    expect(calls).toBe(0);
  });

  it("builtin test patch is off by default and escapes its text", () => {
    expect(builtinPatches({})).toEqual([]);
    const [p] = builtinPatches({ T3P_TEST_PATCH: "1", T3P_TEST_PATCH_TEXT: 'a"b$1' });
    expect(p!.replacement).toEqual({ match: "Use T3 Code on your phone", replace: 'a\\"b$$1' });
  });

  it("registry forces the owner id and unregisters by owner", () => {
    const registry = new PatchRegistry();
    registry.register("owner-a", [{ plugin: "spoofed", find: "x", replacement: { match: "x", replace: "y" } }]);
    expect(registry.active()[0]!.plugin).toBe("owner-a");
    registry.unregisterOwner("owner-a");
    expect(registry.size).toBe(0);
  });
});
