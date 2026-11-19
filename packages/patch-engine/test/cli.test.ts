import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const cliPath = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
const cliAvailable = existsSync(cliPath);

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "t3p-patch-cli-"));
  tempDirs.push(dir);
  return dir;
}

function makeClientDir(): string {
  const dir = makeTempDir();
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "assets", "a.js"), "export const x = 1;\n");
  writeFileSync(join(dir, "assets", "b.js"), "export const y = 2;\n");
  return dir;
}

function writePatchFile(dir: string, name: string, text: string): string {
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
}

function runCli(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const describeCli = cliAvailable ? describe : describe.skip;

describeCli("t3p-patch-test CLI", () => {
  it("reports OK lines and exits 0 when every patch applies", () => {
    const clientDir = makeClientDir();
    const patchDir = makeTempDir();
    const patchFile = writePatchFile(
      patchDir,
      "patches.json",
      JSON.stringify([
        {
          plugin: "t3p.t",
          find: "export const x = 1;",
          replacement: { match: "x = 1", replace: "x = 2" },
        },
      ]),
    );

    const result = runCli([clientDir, patchFile]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK   assets/a.js (1 replacement)");
    expect(result.stdout).not.toContain("FAIL");
  });

  it("reports FAIL lines and exits 1 when a patch does not match", () => {
    const clientDir = makeClientDir();
    const patchDir = makeTempDir();
    const patchFile = writePatchFile(
      patchDir,
      "patches.json",
      JSON.stringify([
        {
          plugin: "t3p.t",
          find: "not in the client",
          replacement: { match: "x", replace: "y" },
        },
      ]),
    );

    const result = runCli([clientDir, patchFile]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("FAIL no-match");
  });

  it("prints {applied, failed} with --json", () => {
    const clientDir = makeClientDir();
    const patchDir = makeTempDir();
    const patchFile = writePatchFile(
      patchDir,
      "patches.json",
      JSON.stringify([
        {
          plugin: "t3p.t",
          find: "export const y = 2;",
          replacement: { match: "y = 2", replace: "y = 3" },
        },
      ]),
    );

    const result = runCli([clientDir, patchFile, "--json"]);
    expect(result.status).toBe(0);

    const parsed = JSON.parse(result.stdout) as {
      applied: unknown[];
      failed: unknown[];
    };
    expect(parsed.applied).toHaveLength(1);
    expect(parsed.failed).toEqual([]);
  });

  it("loads a patch module whose default export is Patch[]", () => {
    const clientDir = makeClientDir();
    const patchDir = makeTempDir();
    const patchFile = writePatchFile(
      patchDir,
      "patches.mjs",
      [
        "export default [",
        "  {",
        '    plugin: "t3p.t",',
        '    find: "export const x = 1;",',
        '    replacement: { match: "x = 1", replace: "x = 9" },',
        "  },",
        "];",
        "",
      ].join("\n"),
    );

    const result = runCli([clientDir, patchFile]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK   assets/a.js");
  });

  it("supports a findRegex in a JSON patch", () => {
    const clientDir = makeClientDir();
    const patchDir = makeTempDir();
    const patchFile = writePatchFile(
      patchDir,
      "patches.json",
      JSON.stringify([
        {
          plugin: "t3p.t",
          findRegex: { source: "const y = \\d+;", flags: "" },
          replacement: { match: "y = 2", replace: "y = 4" },
        },
      ]),
    );

    const result = runCli([clientDir, patchFile]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK   assets/b.js");
  });

  it("exits 2 on a usage error", () => {
    const result = runCli([]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage: t3p-patch-test");
  });
});
