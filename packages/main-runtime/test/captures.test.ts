import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { applyPatches, planPatches } from "@t3p/patch-engine";
import { describe, expect, it } from "vitest";

import { CAPTURE_NAMES, CAPTURES, capturePatches, disabledCaptures } from "../src/patches/captures.js";

function walk(dir: string, rel = "", out: Map<string, string> = new Map()): Map<string, string> {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    if (statSync(abs).isDirectory()) walk(abs, r, out);
    else if (/\.m?js$/.test(name)) out.set(r, readFileSync(abs, "utf8"));
  }
  return out;
}

describe("capture definitions", () => {
  it("cover every internal handle once", () => {
    expect(CAPTURES.map((c) => c.name)).toEqual([...CAPTURE_NAMES]);
    for (const c of CAPTURES) expect(c.patches.length).toBeGreaterThan(0);
  });

  it("T3P_CAPTURES_OFF switches captures off", () => {
    expect([...disabledCaptures({ T3P_CAPTURES_OFF: "router, palette,commandPalette" })]).toEqual(["router", "commandPalette"]);
    expect(disabledCaptures({ T3P_CAPTURES_OFF: "all" }).size).toBe(CAPTURE_NAMES.length);
    expect(capturePatches({ T3P_CAPTURES_OFF: "all" })).toEqual([]);
    expect(capturePatches({}).length).toBe(CAPTURES.reduce((n, c) => n + c.patches.length, 0));
  });
});

// Against the real client: T3P_CLIENT_DIR=<.../apps/server/dist/client> (extract server.asar, see docs/wp-3d-notes.md).
const clientDir = process.env.T3P_CLIENT_DIR;
describe.skipIf(!clientDir || !existsSync(join(clientDir, "index.html")))("capture patches against the real client", () => {
  const chunks = clientDir ? walk(join(clientDir, "assets")) : new Map<string, string>();

  for (const capture of CAPTURES) {
    it(`${capture.name}: every patch matches exactly one chunk and applies`, () => {
      const plan = planPatches(chunks, capture.patches);
      expect(plan.failed, JSON.stringify(plan.failed)).toEqual([]);
      for (const [chunk, patches] of plan.byChunk) {
        const result = applyPatches(chunk, chunks.get(chunk)!, patches);
        expect(result.failed, JSON.stringify(result.failed)).toEqual([]);
        expect(result.applied.length).toBe(patches.length);
        expect(result.code !== chunks.get(chunk)).toBe(true);
      }
    });
  }
});
