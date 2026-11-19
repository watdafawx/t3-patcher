import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildPlugin, checkManifest, findExternalImports, PluginBuildError, RENDERER_OUTPUT } from "../src/index.js";
import { validateManifest } from "@t3p/api";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t3p-plugin-build-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(rel: string, content: string): void {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function manifest(overrides: Record<string, unknown> = {}): void {
  write(
    "plugin.json",
    `${JSON.stringify({ id: "test-plugin", version: "1.0.0", tier: 1, permissions: [], t3Versions: ["*"], renderer: RENDERER_OUTPUT, ...overrides }, null, 2)}\n`,
  );
}

function source(overrides: { entry?: string; helper?: string } = {}): void {
  write(
    overrides.entry ?? "src/index.ts",
    `import type { PluginModule, T3Api } from "@t3p/api";

import { greeting } from "./greeting.js";

const plugin: PluginModule = {
  start(t3: T3Api) {
    t3.log("info", greeting());
  },
};

export default plugin;
`,
  );
  write(
    overrides.helper ?? "src/greeting.ts",
    `export function greeting(): string {
  return "hello from a bundled plugin";
}
`,
  );
}

describe("checkManifest", () => {
  it("accepts a manifest in a folder whose name differs from the id (dev link)", () => {
    manifest();
    const check = checkManifest(root);
    expect(check.manifest.id).toBe("test-plugin");
    expect(validateManifest(JSON.parse(readFileSync(join(root, "plugin.json"), "utf8"))).ok).toBe(true);
  });

  it("reports every validator error instead of building", () => {
    manifest({ id: "Bad Id", tier: 9, t3Versions: [] });
    expect(() => checkManifest(root)).toThrow(PluginBuildError);
    try {
      checkManifest(root);
    } catch (error) {
      expect((error as PluginBuildError).details.join("\n")).toMatch(/id/);
      expect((error as PluginBuildError).details.join("\n")).toMatch(/tier/);
    }
  });

  it("rejects a missing or broken plugin.json", () => {
    expect(() => checkManifest(root)).toThrow(/no plugin.json/);
    write("plugin.json", "{broken");
    expect(() => checkManifest(root)).toThrow(/not valid JSON/);
  });
});

describe("buildPlugin", () => {
  it("bundles a single ESM renderer.js with local imports inlined", async () => {
    manifest();
    source();
    const result = await buildPlugin({ root });
    expect(result.output).toBe(join(root, "dist", "renderer.js"));
    expect(existsSync(result.output)).toBe(true);
    const code = readFileSync(result.output, "utf8");
    expect(code).toContain("hello from a bundled plugin");
    expect(code).toMatch(/export\s*\{/);
    expect(findExternalImports(code)).toEqual([]);
    expect(code).not.toMatch(/module\.exports/);
    expect(result.warnings).toEqual([]);
  });

  it("honours a custom entry and out dir", async () => {
    manifest();
    source({ entry: "src/main.ts" });
    const result = await buildPlugin({ root, entry: "src/main.ts", outDir: "out" });
    expect(result.output).toBe(join(root, "out", "renderer.js"));
    expect(existsSync(result.output)).toBe(true);
  });

  it("does not build when plugin.json is invalid", async () => {
    manifest({ tier: 8 });
    source();
    await expect(buildPlugin({ root })).rejects.toThrow(/plugin.json is invalid/);
    expect(existsSync(join(root, "dist"))).toBe(false);
  });

  it("rejects a manifest with a traversal entry path", async () => {
    manifest({ permissions: ["main"], main: "../evil.js" });
    source();
    await expect(buildPlugin({ root })).rejects.toThrow(/invalid/);
  });

  it("rejects a missing entry", async () => {
    manifest();
    await expect(buildPlugin({ root })).rejects.toThrow(/entry not found/);
  });

  it("fails when the bundle would keep an external import", async () => {
    manifest();
    source();
    write("src/extra.ts", `import "node:fs";\nexport const x = 1;\n`);
    write(
      "src/index.ts",
      `import type { PluginModule } from "@t3p/api";
import "./extra.js";
const plugin: PluginModule = { start() {} };
export default plugin;
`,
    );
    await expect(buildPlugin({ root })).rejects.toThrow(/external modules: node:fs/);
  });
});

describe("findExternalImports", () => {
  it("finds static, re-export, require and dynamic imports", () => {
    const code = [
      `import a from "pkg-a";`,
      `export { b } from "pkg-b";`,
      `const c = require("pkg-c");`,
      `import("pkg-d");`,
      `const s = "import x from 'not-a-real-import'";`,
    ].join("\n");
    expect(findExternalImports(code).sort()).toEqual(["pkg-a", "pkg-b", "pkg-c", "pkg-d"]);
  });

  it("returns nothing for a self-contained bundle", () => {
    expect(findExternalImports("export const start = () => {};\n")).toEqual([]);
  });
});
