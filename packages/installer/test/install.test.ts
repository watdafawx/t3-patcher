import { extractFile, listPackage } from "@electron/asar";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SHIM_SOURCE } from "@t3p/shim";

import { readAsarPackageJson } from "../src/asar.js";
import { AppRunningError, T3pError } from "../src/errors.js";
import { install } from "../src/install.js";
import { junctionInfo, layoutPaths } from "../src/layout.js";
import { installKey, readManifest, sha256File } from "../src/manifest.js";
import { status } from "../src/status.js";
import { uninstall } from "../src/uninstall.js";
import type { InstallOpts } from "../src/types.js";
import { createFakeInstall, createRuntimeSource, safeReadFuses, snapshotTree, type FakeInstall } from "./fake-install.js";

let tree: FakeInstall;
let runtimeSource: string;

const opts = (extra: Partial<InstallOpts> = {}): InstallOpts => ({
  path: tree.installDir,
  homeDir: tree.homeDir,
  readFuses: safeReadFuses,
  runtimeSource,
  ...extra,
});

beforeEach(async () => {
  tree = await createFakeInstall();
  runtimeSource = createRuntimeSource(tree.root);
});

afterEach(() => {
  tree.cleanup();
});

describe("install", () => {
  it("builds the replacement asar, renames the original and reports patched", async () => {
    const paths = layoutPaths(tree.installDir);
    const originalHash = sha256File(paths.appAsar);

    const result = await install(opts());

    expect(result.status).toBe("installed");
    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(existsSync(paths.originalAsar)).toBe(true);
    expect(existsSync(`${paths.appAsar}.t3p-new`)).toBe(false);
    expect(sha256File(paths.originalAsar)).toBe(originalHash);

    const entries = listPackage(paths.appAsar, { isPack: false })
      .map((entry) => entry.replace(/^[\\/]+/, "").replace(/\\/g, "/"))
      .sort();
    expect(entries).toEqual(["index.js", "package.json"]);
    expect(extractFile(paths.appAsar, "index.js").toString("utf8")).toBe(SHIM_SOURCE);

    const pkg = readAsarPackageJson(paths.appAsar);
    expect(pkg).not.toBeNull();
    expect(pkg?.main).toBe("index.js");
    expect(pkg?.version).toBe("0.1.10");
    expect(pkg?.name).toBe("t3code");
    expect(pkg?.t3codeCommitHash).toBe("7d32075e3757");
    expect(pkg?.dependencies).toEqual({});

    const junction = junctionInfo(paths.resourcesDir);
    expect(junction.present).toBe(true);
    expect(junction.isSymlink).toBe(true);
    expect(junction.targetExists).toBe(true);
    expect(junction.target).toBe(paths.unpacked);

    const report = await status({ path: tree.installDir, homeDir: tree.homeDir });
    expect(report.layout).toBe("patched");
    expect(report.manifestPresent).toBe(true);

    const manifest = readManifest(tree.homeDir);
    const entry = manifest?.installs[installKey(tree.installDir)];
    expect(entry).toBeDefined();
    expect(entry?.exePath).toBe(tree.exePath);
    expect(entry?.appVersion).toBe("0.1.10");
    expect(entry?.originalAsarSha256).toBe(originalHash);
    expect(entry?.replacementAsarSha256).toBe(sha256File(paths.appAsar));
    expect(entry?.junction).toBe(true);
    expect(entry?.runtimeFiles.map((file) => file.path).sort()).toEqual(["lib/patch.cjs", "main.cjs"]);
    expect(result.runtime).toEqual({ source: runtimeSource, files: 2 });

    expect(readFileSync(join(tree.homeDir, ".t3-patcher", "runtime", "main.cjs"), "utf8")).toBe(
      "// t3p runtime stub\n",
    );
    expect(readdirSync(tree.installDir).some((name) => name.startsWith(".t3p-build-"))).toBe(false);
  });

  it("is idempotent: a second install changes nothing", async () => {
    const first = await install(opts());
    const manifestAfterFirst = readManifest(tree.homeDir);
    const appHash = sha256File(layoutPaths(tree.installDir).appAsar);
    const listing = snapshotTree(tree.installDir);

    const second = await install(opts());

    expect(second.status).toBe("noop");
    expect(second.changed).toBe(false);
    expect(second.replacementAsarSha256).toBe(first.replacementAsarSha256);
    expect(sha256File(layoutPaths(tree.installDir).appAsar)).toBe(appHash);
    expect(snapshotTree(tree.installDir)).toEqual(listing);
    expect(readManifest(tree.homeDir)).toEqual(manifestAfterFirst);
  });

  it("refuses unsafe fuses unless forced", async () => {
    const paths = layoutPaths(tree.installDir);
    const before = sha256File(paths.appAsar);
    const unsafe = async () => ({
      onlyLoadAppFromAsar: true,
      embeddedAsarIntegrityValidation: true,
      runAsNode: false,
    });

    await expect(install(opts({ readFuses: unsafe }))).rejects.toThrow(/Unsafe Electron fuses/);
    expect(existsSync(paths.originalAsar)).toBe(false);
    expect(sha256File(paths.appAsar)).toBe(before);

    const forced = await install(opts({ readFuses: unsafe, force: true }));
    expect(forced.status).toBe("installed");
    expect(forced.warnings.join("\n")).toMatch(/unsafe fuses/);
  });

  it("refuses an unsupported version unless forced", async () => {
    tree.cleanup();
    tree = await createFakeInstall({ version: "0.1.13" });
    runtimeSource = createRuntimeSource(tree.root);

    await expect(install(opts())).rejects.toThrow(/0\.1\.13 is not supported/);
    const forced = await install(opts({ force: true }));
    expect(forced.status).toBe("installed");
    expect(forced.warnings.join("\n")).toMatch(/outside the supported versions/);
  });

  it("accepts a channel build of a supported version without --force", async () => {
    tree.cleanup();
    tree = await createFakeInstall({ version: "0.1.12-nightly.20261121.5051" });
    runtimeSource = createRuntimeSource(tree.root);

    const result = await install(opts());
    expect(result.status).toBe("installed");
    expect(result.warnings.join("\n")).not.toMatch(/outside the supported versions/);
  });

  it("rolls back when the asar swap fails", async () => {
    const installDirBefore = snapshotTree(tree.installDir);
    const appHashBefore = sha256File(layoutPaths(tree.installDir).appAsar);

    await expect(
      install(
        opts({
          hooks: {
            beforeSwap: () => {
              throw new Error("simulated swap failure");
            },
          },
        }),
      ),
    ).rejects.toThrow(/rolled back: simulated swap failure/);

    const paths = layoutPaths(tree.installDir);
    expect(snapshotTree(tree.installDir)).toEqual(installDirBefore);
    expect(sha256File(paths.appAsar)).toBe(appHashBefore);
    expect(existsSync(paths.originalAsar)).toBe(false);
    expect(existsSync(`${paths.appAsar}.t3p-new`)).toBe(false);
  });

  it("throws AppRunningError when the rename is blocked by a running app", async () => {
    const paths = layoutPaths(tree.installDir);
    const appHashBefore = sha256File(paths.appAsar);
    const busyRename = (): void => {
      const error = new Error("EBUSY: resource busy or locked, rename") as NodeJS.ErrnoException;
      error.code = "EBUSY";
      throw error;
    };

    await expect(install(opts({ rename: busyRename }))).rejects.toBeInstanceOf(AppRunningError);
    await expect(install(opts({ rename: busyRename }))).rejects.toThrow(/Close T3 Code and retry/);
    expect(sha256File(paths.appAsar)).toBe(appHashBefore);
    expect(existsSync(paths.originalAsar)).toBe(false);
    expect(existsSync(`${paths.appAsar}.t3p-new`)).toBe(false);
  });

  it("rejects a directory that is not a T3 Code install", async () => {
    await expect(install({ homeDir: tree.homeDir, path: tree.homeDir })).rejects.toBeInstanceOf(T3pError);
  });
});

describe("uninstall", () => {
  it("restores the exact original tree and keeps the junction target intact", async () => {
    const paths = layoutPaths(tree.installDir);
    const resourcesBefore = snapshotTree(paths.resourcesDir);
    const installDirBefore = snapshotTree(tree.installDir);
    const appHashBefore = sha256File(paths.appAsar);
    const nativeFile = join(paths.unpacked, "node_modules", "x", "x.node");

    await install(opts());
    expect(existsSync(paths.originalAsar)).toBe(true);

    await uninstall({ path: tree.installDir, homeDir: tree.homeDir });

    expect(snapshotTree(paths.resourcesDir)).toEqual(resourcesBefore);
    expect(snapshotTree(tree.installDir)).toEqual(installDirBefore);
    expect(sha256File(paths.appAsar)).toBe(appHashBefore);
    expect(existsSync(paths.originalAsar)).toBe(false);
    expect(existsSync(paths.junction)).toBe(false);
    expect(readFileSync(nativeFile, "utf8")).toBe("native bytes");
    expect(readManifest(tree.homeDir)).toBeNull();

    const report = await status({ path: tree.installDir, homeDir: tree.homeDir });
    expect(report.layout).toBe("unpatched");
  });

  it("refuses to delete an app.asar that does not match the manifest", async () => {
    await install(opts());
    const paths = layoutPaths(tree.installDir);
    writeFileSync(paths.appAsar, "not our replacement");

    await expect(uninstall({ path: tree.installDir, homeDir: tree.homeDir })).rejects.toThrow(/Refusing/);
    expect(readFileSync(paths.appAsar, "utf8")).toBe("not our replacement");
    expect(existsSync(paths.originalAsar)).toBe(true);
  });

  it("restores by detection when the manifest is gone", async () => {
    const paths = layoutPaths(tree.installDir);
    const resourcesBefore = snapshotTree(paths.resourcesDir);
    const appHashBefore = sha256File(paths.appAsar);

    await install(opts());
    rmSync(join(tree.homeDir, ".t3-patcher", "install-manifest.json"), { force: true });

    await uninstall({ path: tree.installDir, homeDir: tree.homeDir });

    expect(snapshotTree(paths.resourcesDir)).toEqual(resourcesBefore);
    expect(sha256File(paths.appAsar)).toBe(appHashBefore);
  });

  it("purges the runtime only when asked", async () => {
    const runtimeDir = join(tree.homeDir, ".t3-patcher", "runtime");
    await install(opts());

    await uninstall({ path: tree.installDir, homeDir: tree.homeDir });
    expect(existsSync(runtimeDir)).toBe(true);

    await install(opts());
    await uninstall({ path: tree.installDir, homeDir: tree.homeDir, purge: true });
    expect(existsSync(runtimeDir)).toBe(false);
  });

  it("drops a stale manifest entry after an upstream update and keeps the new app.asar", async () => {
    await install(opts());
    const paths = layoutPaths(tree.installDir);
    rmSync(paths.originalAsar, { force: true });
    writeFileSync(paths.appAsar, "a newer stock asar");

    await uninstall({ path: tree.installDir, homeDir: tree.homeDir });

    expect(readFileSync(paths.appAsar, "utf8")).toBe("a newer stock asar");
    expect(readManifest(tree.homeDir)).toBeNull();
  });
});
