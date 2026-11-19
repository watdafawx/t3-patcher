import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { install } from "../src/install.js";
import { manifestEntry, readManifest, sha256File } from "../src/manifest.js";
import { repair } from "../src/repair.js";
import { status } from "../src/status.js";
import { readAsarPackageJson } from "../src/asar.js";
import { layoutPaths } from "../src/layout.js";
import {
  createFakeInstall,
  createRuntimeSource,
  safeReadFuses,
  simulateUpstreamUpdate,
  type FakeInstall,
} from "./fake-install.js";

let tree: FakeInstall;
let runtimeSource: string;

const opts = () => ({
  path: tree.installDir,
  homeDir: tree.homeDir,
  readFuses: safeReadFuses,
  runtimeSource,
});

beforeEach(async () => {
  tree = await createFakeInstall();
  runtimeSource = createRuntimeSource(tree.root);
});

afterEach(() => {
  tree.cleanup();
});

describe("status", () => {
  it("reports a stock install as unpatched", async () => {
    const report = await status({ path: tree.installDir, homeDir: tree.homeDir });

    expect(report.layout).toBe("unpatched");
    expect(report.manifestPresent).toBe(false);
    expect(report.install?.version).toBe("0.1.10");
    expect(report.install?.channel).toBe("beta");
    expect(report.reasons.join(" ")).toMatch(/stock asar/);
  });

  it("reports a patched install", async () => {
    await install(opts());

    const report = await status({ path: tree.installDir, homeDir: tree.homeDir });

    expect(report.layout).toBe("patched");
    expect(report.manifestPresent).toBe(true);
    expect(report.reasons.join(" ")).toMatch(/replacement asar hash matches/);
    expect(report.reasons.join(" ")).toMatch(/original asar hash matches/);
  });

  it("reports stale after an upstream update", async () => {
    await install(opts());
    await simulateUpstreamUpdate(tree, { version: "0.1.11" });

    const report = await status({ path: tree.installDir, homeDir: tree.homeDir });

    expect(report.layout).toBe("stale");
    expect(report.manifestPresent).toBe(true);
    expect(report.install?.version).toBe("0.1.11");
    expect(report.reasons.join(" ")).toMatch(/_app\.asar is missing/);
    expect(report.reasons.join(" ")).toMatch(/does not match the recorded replacement/);
  });

  it("reports broken when the original asar disappears but the replacement stays", async () => {
    await install(opts());
    const paths = layoutPaths(tree.installDir);
    rmSync(paths.originalAsar, { force: true });

    const report = await status({ path: tree.installDir, homeDir: tree.homeDir });

    expect(report.layout).toBe("broken");
    expect(report.reasons.join(" ")).toMatch(/_app\.asar is missing/);
  });

  it("reports broken when the original asar was modified", async () => {
    await install(opts());
    const paths = layoutPaths(tree.installDir);
    writeFileSync(paths.originalAsar, "tampered");

    const report = await status({ path: tree.installDir, homeDir: tree.homeDir });

    expect(report.layout).toBe("broken");
    expect(report.reasons.join(" ")).toMatch(/_app\.asar hash/);
  });

  it("reports unknown when no install is found", async () => {
    const report = await status({
      homeDir: join(tree.root, "empty-home"),
      localAppDataDir: join(tree.root, "no-programs"),
      platform: "linux",
      registryQuery: () => null,
    });

    expect(report.layout).toBe("unknown");
    expect(report.install).toBeUndefined();
    expect(report.reasons.join(" ")).toMatch(/No T3 Code install found/);
  });
});

describe("repair", () => {
  it("re-installs after an update that renamed the exe from Beta to Nightly", async () => {
    await install(opts());
    const oldEntry = manifestEntry(tree.homeDir, tree.installDir);
    expect(oldEntry?.exePath).toMatch(/Beta/);

    await simulateUpstreamUpdate(tree, { version: "0.1.11", exeName: "T3 Code (Nightly).exe" });
    expect((await status({ path: tree.installDir, homeDir: tree.homeDir })).layout).toBe("stale");

    const result = await repair(opts());

    expect(result).not.toBe("noop");
    if (result === "noop") throw new Error("unreachable");
    expect(result.status).toBe("installed");
    expect(result.install.exePath).toBe(join(tree.installDir, "T3 Code (Nightly).exe"));
    expect(result.install.channel).toBe("nightly");
    expect(result.install.version).toBe("0.1.11");

    const report = await status({ path: tree.installDir, homeDir: tree.homeDir });
    expect(report.layout).toBe("patched");

    const entry = manifestEntry(tree.homeDir, tree.installDir);
    expect(entry?.exePath).toBe(join(tree.installDir, "T3 Code (Nightly).exe"));
    expect(entry?.appVersion).toBe("0.1.11");
    expect(readAsarPackageJson(layoutPaths(tree.installDir).appAsar)?.version).toBe("0.1.11");
    expect(sha256File(layoutPaths(tree.installDir).appAsar)).toBe(entry?.replacementAsarSha256);
  });

  it("is a no-op with --if-stale when the layout is patched", async () => {
    await install(opts());
    const before = readManifest(tree.homeDir);

    await expect(repair({ ...opts(), ifStale: true })).resolves.toBe("noop");
    expect(readManifest(tree.homeDir)).toEqual(before);
  });

  it("patches an unpatched install when not started with --if-stale", async () => {
    const result = await repair(opts());

    expect(result).not.toBe("noop");
    if (result === "noop") throw new Error("unreachable");
    expect(result.status).toBe("installed");
    expect((await status({ path: tree.installDir, homeDir: tree.homeDir })).layout).toBe("patched");
  });

  it("is a no-op on an already patched install without --if-stale", async () => {
    await install(opts());

    await expect(repair(opts())).resolves.toBe("noop");
  });
});
