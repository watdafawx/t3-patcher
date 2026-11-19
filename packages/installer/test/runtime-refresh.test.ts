import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SHIM_SOURCE } from "@t3p/shim";

import { AppRunningError } from "../src/errors.js";
import { compareRuntime, install, runtimeLabel } from "../src/install.js";
import { layoutPaths } from "../src/layout.js";
import { hashTree, readManifest, sha256File } from "../src/manifest.js";
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
  workerNode: "skip",
  ...extra,
});

const runtimeDir = (): string => join(tree.homeDir, ".t3-patcher", "runtime");

beforeEach(async () => {
  tree = await createFakeInstall();
  runtimeSource = createRuntimeSource(tree.root);
  await install(opts());
});

afterEach(() => tree.cleanup());

describe("install on a patched app (runtime refresh)", () => {
  it("is a noop when the runtime is identical", async () => {
    const before = snapshotTree(tree.homeDir);
    const result = await install(opts());
    expect(result.status).toBe("noop");
    expect(result.changed).toBe(false);
    expect(snapshotTree(tree.homeDir)).toEqual(before);
  });

  it("copies a newer runtime, keeps plugins/state/settings, reports the labels", async () => {
    const base = join(tree.homeDir, ".t3-patcher");
    mkdirSync(join(base, "plugins", "p"), { recursive: true });
    writeFileSync(join(base, "plugins", "p", "plugin.json"), "{}");
    writeFileSync(join(base, "state.json"), '{"a":1}');
    writeFileSync(join(base, "settings.json"), '{"b":2}');
    const oldLabel = runtimeLabel(hashTree(runtimeDir()));
    const asarBefore = sha256File(layoutPaths(tree.installDir).appAsar);

    writeFileSync(join(runtimeSource, "main.cjs"), "// newer runtime\n");
    writeFileSync(join(runtimeSource, "extra.cjs"), "// added\n");
    expect(compareRuntime({ homeDir: tree.homeDir, runtimeSource }).outdated).toBe(true);

    const result = await install(opts());
    expect(result.status).toBe("updated");
    expect(result.changed).toBe(true);
    expect(result.runtimeUpdate).toEqual({ from: oldLabel, to: runtimeLabel(hashTree(runtimeSource)), shimChanged: false });
    expect(readFileSync(join(runtimeDir(), "main.cjs"), "utf8")).toBe("// newer runtime\n");
    expect(existsSync(join(runtimeDir(), "extra.cjs"))).toBe(true);
    expect(existsSync(`${runtimeDir()}.new`)).toBe(false);
    expect(existsSync(`${runtimeDir()}.old`)).toBe(false);
    expect(readFileSync(join(base, "state.json"), "utf8")).toBe('{"a":1}');
    expect(readFileSync(join(base, "settings.json"), "utf8")).toBe('{"b":2}');
    expect(existsSync(join(base, "plugins", "p", "plugin.json"))).toBe(true);
    expect(sha256File(layoutPaths(tree.installDir).appAsar)).toBe(asarBefore);
    expect(readManifest(tree.homeDir)?.installs[tree.installDir.toLowerCase()]?.runtimeFiles).toEqual(hashTree(runtimeSource));
    expect(compareRuntime({ homeDir: tree.homeDir, runtimeSource }).outdated).toBe(false);
    expect((await install(opts())).status).toBe("noop");
    expect((await status({ path: tree.installDir, homeDir: tree.homeDir })).layout).toBe("patched");
  });

  it("rewrites the shim only when it changed, and the layout stays patched", async () => {
    const result = await install(opts({ shimSource: `${SHIM_SOURCE}\n// v2\n` }));
    expect(result.status).toBe("updated");
    expect(result.runtimeUpdate?.shimChanged).toBe(true);
    expect(sha256File(layoutPaths(tree.installDir).appAsar)).toBe(result.replacementAsarSha256);
    expect((await status({ path: tree.installDir, homeDir: tree.homeDir })).layout).toBe("patched");
    expect(existsSync(`${layoutPaths(tree.installDir).appAsar}.t3p-old`)).toBe(false);
  });

  it("rolls back runtime and shim when the swap fails", async () => {
    writeFileSync(join(runtimeSource, "main.cjs"), "// newer runtime\n");
    const paths = layoutPaths(tree.installDir);
    const treeBefore = snapshotTree(tree.homeDir);
    const installBefore = snapshotTree(tree.installDir);
    const filesBefore = hashTree(runtimeDir());
    const asarBefore = sha256File(paths.appAsar);
    let calls = 0;
    const failing = (): void => {
      calls += 1;
      if (calls === 4) throw new Error("disk exploded"); // 1: runtime->old, 2: new->runtime, 3: app.asar->old, 4: new asar->app.asar
    };
    const { renameSync } = await import("node:fs");
    const rename = (from: string, to: string): void => {
      failing();
      renameSync(from, to);
    };

    await expect(install(opts({ shimSource: `${SHIM_SOURCE}\n// v2\n`, rename }))).rejects.toThrow(/rolled back/);
    expect(hashTree(runtimeDir())).toEqual(filesBefore);
    expect(sha256File(paths.appAsar)).toBe(asarBefore);
    expect(snapshotTree(tree.homeDir)).toEqual(treeBefore);
    expect(snapshotTree(tree.installDir)).toEqual(installBefore);
    expect((await status({ path: tree.installDir, homeDir: tree.homeDir })).layout).toBe("patched");
  });

  it("rolls back a runtime-only swap failure before anything moved", async () => {
    writeFileSync(join(runtimeSource, "main.cjs"), "// newer runtime\n");
    const filesBefore = hashTree(runtimeDir());
    await expect(
      install(opts({ hooks: { beforeSwap: () => { throw new Error("nope"); } } })),
    ).rejects.toThrow(/rolled back: nope/);
    expect(hashTree(runtimeDir())).toEqual(filesBefore);
    expect(existsSync(`${runtimeDir()}.new`)).toBe(false);
  });

  it("throws AppRunningError when files are locked, and changes nothing", async () => {
    writeFileSync(join(runtimeSource, "main.cjs"), "// newer runtime\n");
    const filesBefore = hashTree(runtimeDir());
    const busy = (): void => {
      const error = new Error("EBUSY: resource busy or locked") as NodeJS.ErrnoException;
      error.code = "EBUSY";
      throw error;
    };
    await expect(install(opts({ rename: busy }))).rejects.toBeInstanceOf(AppRunningError);
    expect(hashTree(runtimeDir())).toEqual(filesBefore);
    expect(existsSync(`${runtimeDir()}.new`)).toBe(false);
    expect(existsSync(`${runtimeDir()}.old`)).toBe(false);
  });

  it("uninstall still restores stock exactly after a refresh", async () => {
    const pristine = await createFakeInstall();
    const expected = snapshotTree(pristine.installDir).map((e) => e.path);
    pristine.cleanup();
    writeFileSync(join(runtimeSource, "main.cjs"), "// newer runtime\n");
    await install(opts({ shimSource: `${SHIM_SOURCE}\n// v2\n` }));
    await uninstall({ path: tree.installDir, homeDir: tree.homeDir });
    expect(snapshotTree(tree.installDir).map((e) => e.path)).toEqual(expected);
    expect(existsSync(layoutPaths(tree.installDir).originalAsar)).toBe(false);
  });
});
