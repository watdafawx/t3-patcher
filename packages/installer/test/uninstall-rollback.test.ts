import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// renameSync can be made to fail per call; everything else is the real fs.
const hooks = vi.hoisted(() => ({ failRename: null as null | ((from: string, to: string) => boolean) }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    renameSync: (from: string, to: string) => {
      if (hooks.failRename?.(String(from), String(to))) throw Object.assign(new Error(`EIO: injected failure renaming ${from}`), { code: "EIO" });
      return real.renameSync(from, to);
    },
  };
});

import { AppRunningError } from "../src/errors.js";
import { install } from "../src/install.js";
import { layoutPaths } from "../src/layout.js";
import { readManifest, sha256File } from "../src/manifest.js";
import { status } from "../src/status.js";
import { uninstall } from "../src/uninstall.js";
import { createFakeInstall, createRuntimeSource, safeReadFuses, type FakeInstall } from "./fake-install.js";

let tree: FakeInstall;
let runtimeSource: string;

beforeEach(async () => {
  hooks.failRename = null;
  tree = await createFakeInstall();
  runtimeSource = createRuntimeSource(tree.root);
});
afterEach(() => {
  hooks.failRename = null;
  tree.cleanup();
});

const installOpts = () => ({ path: tree.installDir, homeDir: tree.homeDir, readFuses: safeReadFuses, runtimeSource });
const uninstallOpts = () => ({ path: tree.installDir, homeDir: tree.homeDir });

describe("uninstall failing midway", () => {
  it("failure restoring _app.asar leaves the patched install intact and a retry restores stock", async () => {
    const paths = layoutPaths(tree.installDir);
    const stockHash = sha256File(paths.appAsar);
    await install(installOpts());
    const shimHash = sha256File(paths.appAsar);
    const entryBefore = readManifest(tree.homeDir);

    hooks.failRename = (_from, to) => to === paths.appAsar && _from === paths.originalAsar;
    await expect(uninstall(uninstallOpts())).rejects.toThrow(/could not rename/);

    // Shim is back in place, original untouched, no backup litter, manifest unchanged.
    expect(sha256File(paths.appAsar)).toBe(shimHash);
    expect(sha256File(paths.originalAsar)).toBe(stockHash);
    expect(existsSync(`${paths.appAsar}.t3p-backup`)).toBe(false);
    expect(readManifest(tree.homeDir)).toEqual(entryBefore);
    expect((await status(uninstallOpts())).layout).toBe("patched");

    // Recoverable: the same command now succeeds.
    hooks.failRename = null;
    await uninstall(uninstallOpts());
    expect(sha256File(paths.appAsar)).toBe(stockHash);
    expect(existsSync(paths.originalAsar)).toBe(false);
    expect(readManifest(tree.homeDir)).toBeNull();
  });

  it("the swap is one rename: no moment without an app.asar, no backup file", async () => {
    const paths = layoutPaths(tree.installDir);
    await install(installOpts());
    const renames: Array<[string, string]> = [];
    hooks.failRename = (from, to) => {
      renames.push([from, to]);
      return false;
    };
    await uninstall(uninstallOpts());
    expect(renames).toEqual([[paths.originalAsar, paths.appAsar]]);
  });

  it("a busy app.asar reports AppRunningError and changes nothing", async () => {
    const paths = layoutPaths(tree.installDir);
    await install(installOpts());
    const shimHash = sha256File(paths.appAsar);
    hooks.failRename = () => {
      throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
    };
    await expect(uninstall(uninstallOpts())).rejects.toThrow(AppRunningError);
    expect(sha256File(paths.appAsar)).toBe(shimHash);
    expect(existsSync(paths.originalAsar)).toBe(true);
    expect(readManifest(tree.homeDir)).not.toBeNull();
    expect((await status(uninstallOpts())).layout).toBe("patched");
  });
});
