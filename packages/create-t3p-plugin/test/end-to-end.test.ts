import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateManifest } from "@t3p/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { scaffoldPlugin } from "../src/index.js";

/**
 * Acceptance flow from the WP-3E brief, run against the real CLIs:
 * scaffold -> t3p-plugin-build -> plugin.json validates + dist/renderer.js exists
 * -> t3p dev links it into a fake T3P_HOME.
 *
 * `pnpm -r test` runs after `pnpm -r build`; the two CLIs are built dist files.
 */

const buildCli = fileURLToPath(new URL("../../plugin-build/dist/cli.mjs", import.meta.url));
const installerCli = fileURLToPath(new URL("../../installer/dist/cli.mjs", import.meta.url));

let root: string;
let home: string;
let pluginDir: string;

function run(script: string, args: string[], cwd: string) {
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    windowsHide: true,
    cwd,
    env: { ...process.env, T3P_HOME: home },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "t3p-e2e-")));
  home = join(root, "home");
  pluginDir = join(root, "my-plugin");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("scaffold -> build -> t3p dev", () => {
  it("produces a loadable plugin and links it into T3P_HOME", () => {
    expect(existsSync(buildCli), "run pnpm -r build first").toBe(true);
    expect(existsSync(installerCli), "run pnpm -r build first").toBe(true);

    // 1. scaffold
    const scaffold = scaffoldPlugin({ dir: pluginDir });
    expect(scaffold.id).toBe("my-plugin");

    // 2. build through the real preset CLI
    const built = run(buildCli, [], pluginDir);
    expect(built.status, built.stderr).toBe(0);
    expect(built.stdout).toMatch(/built my-plugin@0\.1\.0: dist\/renderer\.js/);

    const manifest = JSON.parse(readFileSync(join(pluginDir, "plugin.json"), "utf8"));
    const checked = validateManifest(manifest, "my-plugin");
    expect(checked.ok, checked.ok ? "" : checked.errors.join("; ")).toBe(true);
    expect(existsSync(join(pluginDir, "dist", "renderer.js"))).toBe(true);
    const bundle = readFileSync(join(pluginDir, "dist", "renderer.js"), "utf8");
    expect(bundle).toContain("t3.settings.define");
    expect(bundle).toMatch(/export\s*\{/);

    // 3. link into a fake T3P_HOME and switch dev mode on
    const dev = run(installerCli, ["dev", pluginDir], root);
    expect(dev.status, dev.stderr).toBe(0);
    expect(dev.stdout).toMatch(/linked my-plugin/);

    const link = join(home, ".t3-patcher", "plugins", "my-plugin");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(resolve(realpathSync(link))).toBe(resolve(realpathSync(pluginDir)));
    expect(existsSync(join(home, ".t3-patcher", "dev-mode"))).toBe(true);
    expect(JSON.parse(readFileSync(join(home, ".t3-patcher", "state.json"), "utf8")).plugins["my-plugin"].enabled).toBe(true);

    // 4. `t3p plugins` sees the linked plugin as a valid, enabled plugin
    const listed = run(installerCli, ["plugins", "--json"], root);
    expect(listed.status).toBe(0);
    const plugins = JSON.parse(listed.stdout) as Array<{ id: string; valid: boolean; enabled: boolean }>;
    expect(plugins).toEqual([expect.objectContaining({ id: "my-plugin", valid: true, enabled: true })]);

    // 5. unlink reverts
    const unlinked = run(installerCli, ["dev", "--unlink", "my-plugin"], root);
    expect(unlinked.status, unlinked.stderr).toBe(0);
    expect(existsSync(link)).toBe(false);
    expect(existsSync(join(pluginDir, "plugin.json"))).toBe(true);
    expect(existsSync(join(home, ".t3-patcher", "dev-mode"))).toBe(false);
  });
});
