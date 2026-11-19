import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { USAGE, parseArgs } from "../src/cli.js";
import { renderReport, type CompatReport } from "../src/report.js";
import { runCompat } from "../src/run.js";
import { findSevenZip, extractServerAsar } from "../src/extract.js";
import { writeAsarFixture } from "./fixtures.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "t3p-compat-cli-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function report(overrides: Partial<CompatReport> = {}): CompatReport {
  return {
    target: { version: "v9.9.9", versionSource: "tag", source: "installer", detail: "x" },
    baseline: { tag: "v0.1.10", rpc: 2, slots: 2 },
    client: { files: 2, bytes: 2048, origin: "x" },
    patches: { findings: [], ok: 0, broken: 0 },
    rpc: { evidence: "server", baseline: 2, found: 2, added: [], removed: [], used: [], missingUsed: [] },
    slots: { baseline: 2, current: 2, added: [], removed: [], required: [], missingRequired: [] },
    ok: true,
    notes: [],
    ...overrides,
  };
}

describe("argument parsing", () => {
  const repo = "C:\\repo";

  it("defaults to the repo cache and no target", () => {
    const parsed = parseArgs([], repo);
    expect(parsed.options.repoRoot).toBe(repo);
    expect(parsed.options.cacheDir).toBe(join(repo, "tools", "compat", ".cache"));
    expect(parsed.options.version).toBeUndefined();
    expect(parsed.json).toBe(false);
  });

  it("takes a bare argument as --version", () => {
    expect(parseArgs(["v0.1.10"], repo).options.version).toBe("v0.1.10");
  });

  it("ignores the separator pnpm forwards", () => {
    expect(parseArgs(["--", "--version", "v0.1.10"], repo).options.version).toBe("v0.1.10");
  });

  it("parses the fetching and check flags", () => {
    const parsed = parseArgs(
      [
        "--version",
        "nightly",
        "--no-cache",
        "--no-patches",
        "--no-plugins",
        "--json",
        "--update-baseline",
        "--patch-file",
        "a.json",
        "--patch-file",
        "b.json",
        "--seven-zip",
        "C:\\7z.exe",
      ],
      repo,
    );
    expect(parsed.options.version).toBe("nightly");
    expect(parsed.options.noPatches).toBe(true);
    expect(parsed.options.plugins).toBe(false);
    expect(parsed.options.updateBaseline).toBe(true);
    expect(parsed.options.patchFiles).toEqual(["a.json", "b.json"]);
    expect(parsed.options.sevenZip).toBe("C:\\7z.exe");
    expect(parsed.json).toBe(true);
    expect(parsed.options.cacheDir).not.toBe(join(repo, "tools", "compat", ".cache"));
  });

  it("keeps --repo as the root of the default cache", () => {
    const parsed = parseArgs(["--repo", "D:\\checkout"], repo);
    expect(parsed.options.repoRoot).toBe("D:\\checkout");
    expect(parsed.options.cacheDir).toBe(join("D:\\checkout", "tools", "compat", ".cache"));
  });

  it("rejects unknown options and missing values", () => {
    expect(() => parseArgs(["--bogus"], repo)).toThrow(/unknown option/);
    expect(() => parseArgs(["--version"], repo)).toThrow(/needs a value/);
    expect(() => parseArgs(["a", "b"], repo)).toThrow(/unexpected arguments/);
  });

  it("documents every flag in the usage text", () => {
    for (const flag of ["--version", "--asar", "--dir", "--from-git", "--json", "--clean", "--no-patches"]) {
      expect(USAGE).toContain(flag);
    }
  });
});

describe("report rendering", () => {
  it("prints a pass line when nothing is wrong", () => {
    const text = renderReport(report());
    expect(text).toContain("Result: PASS");
    expect(text).toContain("removed  none");
  });

  it("marks breakage and names what is used", () => {
    const text = renderReport(
      report({
        ok: false,
        patches: {
          findings: [
            { owner: "t3p.core", label: "commandPalette", origin: "captures.ts", find: "/x/", hits: [], status: "no-match" },
          ],
          ok: 0,
          broken: 1,
        },
        rpc: {
          evidence: "server",
          baseline: 2,
          found: 1,
          added: ["issues.list"],
          removed: ["server.getConfig"],
          used: ["server.getConfig"],
          missingUsed: ["server.getConfig"],
        },
        slots: { baseline: 2, current: 1, added: [], removed: ["sidebar-content"], required: ["sidebar-content"], missingRequired: ["sidebar-content"] },
      }),
    );
    expect(text).toContain("BROKEN  commandPalette");
    expect(text).toContain("0 chunks");
    expect(text).toContain("USED BY FIRST-PARTY CODE");
    expect(text).toContain("+ issues.list");
    expect(text).toContain("Result: FAIL (1 broken patch find, 1 removed RPC method in use, 1 removed data-slot in use)");
  });

  it("says when the patch checks were skipped", () => {
    const text = renderReport(report({ patches: { findings: [], ok: 0, broken: 0, skipped: "a source tree holds no built client" } }));
    expect(text).toContain("Patches: skipped (a source tree holds no built client)");
  });
});

describe("cache cleanup", () => {
  it("removes a tree whose files are read-only, like a git clone's objects", async () => {
    const dir = makeTempDir();
    const clone = join(dir, "src-v1", ".git", "objects");
    mkdirSync(clone, { recursive: true });
    const object = join(clone, "pack-1.pack");
    writeFileSync(object, "x");
    chmodSync(object, 0o444);
    const { removeTree } = await import("../src/fsx.js");
    expect(removeTree(join(dir, "src-v1"))).toEqual([]);
    expect(existsSync(join(dir, "src-v1"))).toBe(false);
  });
});

describe("7z extraction guards", () => {
  it("returns an explicit binary only when it exists", () => {
    const dir = makeTempDir();
    const sevenZip = join(dir, "7z.exe");
    writeFileSync(sevenZip, "");
    expect(findSevenZip(sevenZip)).toBe(sevenZip);
    expect(findSevenZip(join(dir, "missing.exe"))).toBeUndefined();
  });

  it("fails with a hint when no 7-Zip is available", () => {
    const dir = makeTempDir();
    const installer = join(dir, "setup.exe");
    writeFileSync(installer, "");
    expect(() =>
      extractServerAsar({
        installer,
        outFile: join(dir, "server.asar"),
        workDir: join(dir, "work"),
        sevenZip: join(dir, "nope.exe"),
        log: { info: () => {}, warn: () => {} },
      }),
    ).toThrow(/7-Zip not found/);
  });

  it("refuses a zip portable build with a hint", () => {
    const dir = makeTempDir();
    const zip = join(dir, "portable.zip");
    writeFileSync(zip, "");
    const sevenZip = join(dir, "7z.exe");
    writeFileSync(sevenZip, "");
    expect(() =>
      extractServerAsar({
        installer: zip,
        outFile: join(dir, "server.asar"),
        workDir: join(dir, "work"),
        sevenZip,
        log: { info: () => {}, warn: () => {} },
      }),
    ).toThrow(/portable Windows release/);
  });
});

describe("runCompat against a fake repository", () => {
  function makeRepo(): {
    repoRoot: string;
    clientDir: string;
    baselines: { rpc: string; slots: string };
  } {
    const repoRoot = makeTempDir();
    const baselineDir = join(repoRoot, "tools", "compat", "baseline");
    mkdirSync(baselineDir, { recursive: true });
    const rpc = join(baselineDir, "rpc-methods.json");
    writeFileSync(
      rpc,
      JSON.stringify({
        tag: "v0.1.10",
        commit: "7d32075e3757ded707914e2450c3e392a9665765",
        methods: [
          { name: "server.getConfig", kind: "unary" },
          { name: "orchestration.subscribeThread", kind: "stream" },
        ],
      }),
    );
    const slots = join(baselineDir, "data-slots.json");
    writeFileSync(slots, JSON.stringify({ tag: "v0.1.10", slots: ["sidebar-content", "sidebar-inset"] }));

    // one product source using both, so the "used by" paths are exercised
    const src = join(repoRoot, "packages", "demo", "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "index.ts"),
      'const m = "server.getConfig";\nconst s = \'[data-slot="sidebar-content"]\';\n',
    );

    const clientDir = join(repoRoot, "client");
    mkdirSync(join(clientDir, "assets"), { recursive: true });
    writeFileSync(
      join(clientDir, "index.html"),
      '<div data-slot="sidebar-content"></div><div data-slot="sidebar-inset"></div>',
    );
    writeFileSync(
      join(clientDir, "assets", "server-calls.js"),
      'rpc.call("server.getConfig");rpc.call("orchestration.subscribeThread");',
    );
    return { repoRoot, clientDir, baselines: { rpc, slots } };
  }

  it("passes when the methods and anchors are all there", async () => {
    const { repoRoot, clientDir } = makeRepo();
    const result = await runCompat({
      repoRoot,
      dir: clientDir,
      cacheDir: join(repoRoot, "cache"),
      noPatches: true,
      log: { info: () => {}, warn: () => {} },
    });
    expect(result.ok).toBe(true);
    expect(result.rpc.removed).toEqual([]);
    expect(result.rpc.used).toEqual(["server.getConfig"]);
    expect(result.slots.removed).toEqual([]);
  });

  it("fails when a method the API uses is gone", async () => {
    const { repoRoot, clientDir } = makeRepo();
    writeFileSync(join(clientDir, "assets", "server-calls.js"), 'rpc.call("orchestration.subscribeThread");');
    const result = await runCompat({
      repoRoot,
      dir: clientDir,
      cacheDir: join(repoRoot, "cache"),
      noPatches: true,
      log: { info: () => {}, warn: () => {} },
    });
    expect(result.ok).toBe(false);
    expect(result.rpc.removed).toEqual(["server.getConfig"]);
    expect(result.rpc.missingUsed).toEqual(["server.getConfig"]);
  });

  it("fails when an anchor the UI uses is gone, but not for unused removals", async () => {
    const { repoRoot, clientDir } = makeRepo();
    writeFileSync(join(clientDir, "index.html"), '<div data-slot="something-else"></div>');
    const used = await runCompat({
      repoRoot,
      dir: clientDir,
      cacheDir: join(repoRoot, "cache"),
      noPatches: true,
      log: { info: () => {}, warn: () => {} },
    });
    expect(used.slots.removed).toEqual(["sidebar-content", "sidebar-inset"]);
    expect(used.slots.missingRequired).toEqual(["sidebar-content"]);
    expect(used.ok).toBe(false);

    // the same removal is harmless when nothing selects on it
    writeFileSync(join(repoRoot, "packages", "demo", "src", "index.ts"), 'const m = "server.getConfig";\n');
    const unused = await runCompat({
      repoRoot,
      dir: clientDir,
      cacheDir: join(repoRoot, "cache"),
      noPatches: true,
      log: { info: () => {}, warn: () => {} },
    });
    expect(unused.slots.removed).toEqual(["sidebar-content", "sidebar-inset"]);
    expect(unused.ok).toBe(true);
  });

  it("runs the real core patch finds against an asar target", async () => {
    const { repoRoot } = makeRepo();
    const dir = join(repoRoot, "asar");
    mkdirSync(dir, { recursive: true });
    const asar = writeAsarFixture(dir, "server.asar", [
      { path: "apps/server/dist/client/index.html", data: '<div data-slot="sidebar-content"></div>' },
      { path: "apps/server/dist/client/assets/a.js", data: "export const a = 1;" },
      { path: "apps/server/dist/server-x.mjs", data: 'var T={serverGetConfig:"server.getConfig"};' },
    ]);
    const result = await runCompat({
      repoRoot,
      asar,
      cacheDir: join(repoRoot, "cache"),
      plugins: false,
      log: { info: () => {}, warn: () => {} },
    });
    expect(result.patches.findings.length).toBeGreaterThan(0);
    expect(result.patches.broken).toBe(result.patches.findings.length);
    expect(result.ok).toBe(false);
  });
});
