import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateManifest } from "@t3p/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { insideT3pWorkspace, scaffoldPlugin, ScaffoldError, SCAFFOLD_VERSION, slugify } from "../src/index.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t3p-scaffold-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function read(dir: string, file: string): string {
  return readFileSync(join(dir, file), "utf8");
}

describe("scaffoldPlugin", () => {
  it("writes the whole template and a manifest the validator accepts", () => {
    const dir = join(root, "my-plugin");
    const result = scaffoldPlugin({ dir });
    expect(result).toMatchObject({ id: "my-plugin", name: "my-plugin", version: SCAFFOLD_VERSION, tier: 1 });
    expect(result.files).toEqual([".gitignore", "package.json", "plugin.json", "README.md", "src/index.ts", "tsconfig.json"]);

    const manifest = JSON.parse(read(dir, "plugin.json"));
    const checked = validateManifest(manifest, "my-plugin");
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.manifest.renderer).toBe("dist/renderer.js");
      expect(checked.manifest.permissions).toEqual({});
    }

    expect(read(dir, "src/index.ts")).toContain("t3.settings.define");
    expect(read(dir, "src/index.ts")).toContain("t3.log(");
    expect(read(dir, "package.json")).toContain('"build": "t3p-plugin-build"');
    expect(read(dir, "package.json")).toContain('"dev": "t3p-plugin-build --watch"');
    expect(read(dir, "README.md")).toContain("# my-plugin");
    expect(read(dir, ".gitignore")).toContain("dist/");
  });

  it("honours --id, --name and --tier and escapes the name as JSON", () => {
    const dir = join(root, "folder-name");
    const result = scaffoldPlugin({ dir, id: "com.example.hello", name: 'Say "hi"', tier: 3 });
    expect(result.id).toBe("com.example.hello");
    expect(result.files).toContain("plugin.json");
    const raw = read(dir, "plugin.json");
    const manifest = JSON.parse(raw);
    expect(manifest).toMatchObject({ id: "com.example.hello", name: 'Say "hi"', tier: 3, version: SCAFFOLD_VERSION });
    expect(validateManifest(manifest).ok).toBe(true);
    expect(read(dir, "README.md")).toContain('# Say "hi"');
  });

  it("accepts an existing empty folder and refuses a non-empty one", () => {
    const empty = join(root, "empty");
    mkdirSync(empty);
    expect(scaffoldPlugin({ dir: empty }).id).toBe("empty");

    const full = join(root, "full");
    mkdirSync(full);
    writeFileSync(join(full, "keep.txt"), "do not touch");
    expect(() => scaffoldPlugin({ dir: full })).toThrow(ScaffoldError);
    expect(read(full, "keep.txt")).toBe("do not touch");
    expect(existsSync(join(full, "plugin.json"))).toBe(false);
  });

  it("refuses a target that is a file", () => {
    const file = join(root, "file");
    writeFileSync(file, "x");
    expect(() => scaffoldPlugin({ dir: file })).toThrow(/not a directory/);
  });

  it("rejects invalid ids and tiers before writing anything", () => {
    const dir = join(root, "bad");
    expect(() => scaffoldPlugin({ dir, id: "Bad Id" })).toThrow(/not a valid plugin id/);
    expect(() => scaffoldPlugin({ dir, id: "con" })).toThrow(/not a valid plugin id/);
    expect(() => scaffoldPlugin({ dir, tier: 4 as 1 })).toThrow(/--tier/);
    expect(existsSync(dir)).toBe(false);
  });

  it("pins ^0.0.0 for @t3p deps outside the repo", () => {
    const dir = join(root, "outside");
    scaffoldPlugin({ dir });
    const pkg = JSON.parse(read(dir, "package.json"));
    expect(pkg.devDependencies["@t3p/api"]).toBe("^0.0.0");
    expect(pkg.devDependencies["@t3p/plugin-build"]).toBe("^0.0.0");
    expect(insideT3pWorkspace(dir)).toBe(false);
  });

  it("emits workspace:* inside a pnpm workspace that holds @t3p/api", () => {
    const repo = join(root, "repo");
    mkdirSync(join(repo, "packages", "api"), { recursive: true });
    writeFileSync(join(repo, "pnpm-workspace.yaml"), 'packages:\n  - "plugins/*"\n');
    writeFileSync(join(repo, "packages", "api", "package.json"), JSON.stringify({ name: "@t3p/api" }));
    const dir = join(repo, "plugins", "my-plugin"); // does not exist yet
    expect(insideT3pWorkspace(dir)).toBe(true);
    scaffoldPlugin({ dir });
    const pkg = JSON.parse(read(dir, "package.json"));
    expect(pkg.devDependencies["@t3p/api"]).toBe("workspace:*");
    expect(pkg.devDependencies["@t3p/plugin-build"]).toBe("workspace:*");
  });

  it("ignores a pnpm workspace that is not this repo", () => {
    const other = join(root, "other");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "pnpm-workspace.yaml"), 'packages:\n  - "plugins/*"\n');
    const dir = join(other, "plugins", "p");
    expect(insideT3pWorkspace(dir)).toBe(false);
    scaffoldPlugin({ dir });
    expect(JSON.parse(read(dir, "package.json")).devDependencies["@t3p/api"]).toBe("^0.0.0");
  });

  it("derives the id from the folder name and refuses when that is not a valid id", () => {
    expect(slugify("My Fancy Plugin")).toBe("my-fancy-plugin");
    expect(slugify("__x__")).toBe("x");
    expect(scaffoldPlugin({ dir: join(root, "My Fancy Plugin") }).id).toBe("my-fancy-plugin");
    expect(() => scaffoldPlugin({ dir: join(root, "___") })).toThrow(/not a valid plugin id/);
  });
});
