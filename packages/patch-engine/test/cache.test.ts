import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PatchCache,
  applyPatchesCached,
  patchSetHash,
  sha256,
} from "../src/index.js";
import type { Patch } from "../src/index.js";

const tempDirs: string[] = [];

function makeCacheDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "t3p-patch-cache-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const patches: Patch[] = [
  {
    plugin: "t3p.t",
    find: "export const n = 0;",
    replacement: { match: "n = 0", replace: "n = 1" },
  },
];

describe("sha256", () => {
  it("hashes text with sha256", () => {
    expect(sha256("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("patchSetHash", () => {
  it("depends on patch order (patches apply in registration order)", () => {
    const other: Patch = {
      plugin: "t3p.a",
      find: "export const y = 2;",
      replacement: { match: "y = 2", replace: "y = 3" },
    };

    expect(patchSetHash([patches[0]!, other])).not.toBe(
      patchSetHash([other, patches[0]!]),
    );
  });

  it("changes when a predicate verdict changes", () => {
    let on = true;
    const gated: Patch = { ...patches[0]!, predicate: () => on };
    const before = patchSetHash([gated]);
    on = false;
    expect(patchSetHash([gated])).not.toBe(before);
  });

  it("changes when the replacement changes", () => {
    const changed: Patch[] = [
      {
        ...patches[0]!,
        replacement: { match: "n = 0", replace: "n = 2" },
      },
    ];

    expect(patchSetHash(changed)).not.toBe(patchSetHash(patches));
  });
});

describe("applyPatchesCached", () => {
  it("applies once, then serves the cached result, and re-applies when the patch set changes", () => {
    const dir = makeCacheDir();
    const cache = new PatchCache(dir);
    const source = "export const n = 0;";

    const first = applyPatchesCached(cache, "a.js", source, patches);
    expect(first.cached).toBe(false);
    expect(first.code).toBe("export const n = 1;");
    expect(first.applied).toHaveLength(1);
    expect(first.failed).toEqual([]);

    const second = applyPatchesCached(cache, "a.js", source, patches);
    expect(second.cached).toBe(true);
    expect(second.code).toBe(first.code);
    expect(second.applied).toEqual(first.applied);

    const changedPatches: Patch[] = [
      {
        ...patches[0]!,
        replacement: { match: "n = 0", replace: "n = 2" },
      },
    ];
    const third = applyPatchesCached(cache, "a.js", source, changedPatches);
    expect(third.cached).toBe(false);
    expect(third.code).toBe("export const n = 2;");
  });

  it("writes the result under <dir>/<first 2 hex>/<key>.js with a json sidecar", () => {
    const dir = makeCacheDir();
    const cache = new PatchCache(dir);
    const source = "export const n = 0;";
    const key = `${sha256(source)}-${patchSetHash(patches)}`;

    applyPatchesCached(cache, "a.js", source, patches);

    expect(existsSync(join(dir, key.slice(0, 2), `${key}.js`))).toBe(true);
    expect(existsSync(join(dir, key.slice(0, 2), `${key}.json`))).toBe(true);
  });

  it("does not cache a result in which nothing applied", () => {
    const dir = makeCacheDir();
    const cache = new PatchCache(dir);
    const source = "export const n = 0;";
    const missing: Patch[] = [
      {
        plugin: "t3p.t",
        find: "n = 0",
        replacement: { match: "no such text", replace: "x" },
      },
    ];

    const first = applyPatchesCached(cache, "a.js", source, missing);
    expect(first.cached).toBe(false);
    expect(first.applied).toEqual([]);
    expect(first.failed).toHaveLength(1);

    const second = applyPatchesCached(cache, "a.js", source, missing);
    expect(second.cached).toBe(false);
  });

  it("returns undefined from get() when nothing is cached", () => {
    const cache = new PatchCache(makeCacheDir());
    expect(cache.get("export const n = 0;", patches)).toBeUndefined();
  });
});

describe("cache integrity", () => {
  const src = "export const n=0;";
  const p: Patch[] = [{ plugin: "t3p.i", find: "const n=0", replacement: { match: "n=0", replace: "n=1" } }];

  it("a predicate that turns false is not served from cache", () => {
    const dir = makeCacheDir();
    const cache = new PatchCache(dir);
    let on = true;
    const gated: Patch[] = [{ ...p[0]!, predicate: () => on }];
    expect(applyPatchesCached(cache, "a.js", src, gated).code).toContain("n=1");
    on = false;
    const r = applyPatchesCached(cache, "a.js", src, gated);
    expect(r.cached).toBe(false);
    expect(r.code).toBe(src);
  });

  it("truncated cached code is a miss", () => {
    const dir = makeCacheDir();
    const cache = new PatchCache(dir);
    applyPatchesCached(cache, "a.js", src, p);
    const sub = readdirSync(dir)[0]!;
    const js = readdirSync(join(dir, sub)).find((f) => f.endsWith(".js"))!;
    writeFileSync(join(dir, sub, js), "const x =");
    const r = applyPatchesCached(cache, "a.js", src, p);
    expect(r.cached).toBe(false);
    expect(r.code).toBe("export const n=1;");
  });

  it("leaves no temp files after set", () => {
    const dir = makeCacheDir();
    applyPatchesCached(new PatchCache(dir), "a.js", src, p);
    const sub = readdirSync(dir)[0]!;
    expect(readdirSync(join(dir, sub)).some((f) => f.endsWith(".tmp"))).toBe(false);
  });
});
