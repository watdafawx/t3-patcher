import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { devLink, devLinkedIds, devMarkerPath, devUnlink, readDevPluginId } from "../src/dev.js";
import { listPlugins, readState } from "../src/plugin-admin.js";

const CLI = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
const platform = process.platform === "win32" ? ("win32" as const) : ("posix" as const);

let home: string;
let source: string;

beforeEach(() => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), "t3p-dev-")));
  source = join(home, "my-plugin");
  mkdirSync(source);
  writeFileSync(
    join(source, "plugin.json"),
    JSON.stringify({ id: "my-plugin", version: "0.1.0", tier: 1, permissions: [], t3Versions: ["*"], renderer: "dist/renderer.js" }),
  );
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const pluginsDir = () => join(home, ".t3-patcher", "plugins");
const linkPath = (id = "my-plugin") => join(pluginsDir(), id);

function cli(args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", windowsHide: true, env: { ...process.env, T3P_HOME: home } });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("t3p dev link", () => {
  it("links the folder into plugins/<id>, enables it and turns dev mode on", () => {
    const result = devLink({ homeDir: home, folder: source, platform });
    expect(result).toMatchObject({ id: "my-plugin", link: linkPath(), changed: true });
    expect(lstatSync(linkPath()).isSymbolicLink()).toBe(true);
    expect(resolve(realpathSync(linkPath()))).toBe(resolve(realpathSync(source)));
    expect(readState(home).plugins["my-plugin"]).toMatchObject({ enabled: true });
    expect(existsSync(devMarkerPath(home))).toBe(true);
    expect(JSON.parse(readFileSync(devMarkerPath(home), "utf8")).plugins).toEqual(["my-plugin"]);

    const listed = listPlugins(home);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: "my-plugin", valid: true, enabled: true, version: "0.1.0" });
  });

  it("is idempotent when the link already points at the same folder", () => {
    devLink({ homeDir: home, folder: source, platform });
    const again = devLink({ homeDir: home, folder: source, platform });
    expect(again.changed).toBe(false);
    expect(devLinkedIds(home)).toEqual(["my-plugin"]);
  });

  it("never overwrites a real plugin folder", () => {
    mkdirSync(linkPath(), { recursive: true });
    writeFileSync(join(linkPath(), "plugin.json"), '{"id":"my-plugin"}');
    expect(() => devLink({ homeDir: home, folder: source, platform })).toThrow(/real plugin folder/);
    expect(readFileSync(join(linkPath(), "plugin.json"), "utf8")).toBe('{"id":"my-plugin"}');
    expect(existsSync(devMarkerPath(home))).toBe(false);
  });

  it("refuses to repoint an existing link at another folder", () => {
    devLink({ homeDir: home, folder: source, platform });
    const other = join(home, "other-plugin");
    mkdirSync(other);
    writeFileSync(
      join(other, "plugin.json"),
      JSON.stringify({ id: "my-plugin", version: "0.1.0", tier: 1, permissions: [], t3Versions: ["*"], renderer: "dist/renderer.js" }),
    );
    expect(() => devLink({ homeDir: home, folder: other, platform })).toThrow(/already links to/);
    expect(resolve(realpathSync(linkPath()))).toBe(resolve(realpathSync(source)));
  });

  it("rejects a folder with no or invalid plugin.json", () => {
    const empty = join(home, "empty");
    mkdirSync(empty);
    expect(() => devLink({ homeDir: home, folder: empty, platform })).toThrow(/no plugin.json/);
    writeFileSync(join(empty, "plugin.json"), JSON.stringify({ id: "Bad Id" }));
    expect(() => readDevPluginId(empty)).toThrow(/invalid/);
  });
});

describe("t3p dev --unlink", () => {
  it("removes the link, keeps the source, disables the plugin and switches dev mode off", () => {
    devLink({ homeDir: home, folder: source, platform });
    const result = devUnlink("my-plugin", { homeDir: home });
    expect(result).toMatchObject({ removed: true, devModeOff: true });
    expect(existsSync(linkPath())).toBe(false);
    expect(existsSync(join(source, "plugin.json"))).toBe(true);
    expect(readState(home).plugins["my-plugin"]).toMatchObject({ enabled: false });
    expect(existsSync(devMarkerPath(home))).toBe(false);
  });

  it("keeps dev mode on while another dev link remains", () => {
    devLink({ homeDir: home, folder: source, platform });
    const second = join(home, "second-plugin");
    mkdirSync(second);
    writeFileSync(
      join(second, "plugin.json"),
      JSON.stringify({ id: "second-plugin", version: "0.1.0", tier: 1, permissions: [], t3Versions: ["*"], renderer: "dist/renderer.js" }),
    );
    devLink({ homeDir: home, folder: second, platform });
    expect(JSON.parse(readFileSync(devMarkerPath(home), "utf8")).plugins).toEqual(["my-plugin", "second-plugin"]);

    expect(devUnlink("my-plugin", { homeDir: home }).devModeOff).toBe(false);
    expect(existsSync(devMarkerPath(home))).toBe(true);
    expect(JSON.parse(readFileSync(devMarkerPath(home), "utf8")).plugins).toEqual(["second-plugin"]);
  });

  it("refuses to delete a real folder and unknown ids", () => {
    mkdirSync(linkPath(), { recursive: true });
    expect(() => devUnlink("my-plugin", { homeDir: home })).toThrow(/real plugin folder/);
    expect(existsSync(linkPath())).toBe(true);
    expect(() => devUnlink("not-there", { homeDir: home })).toThrow(/no plugin folder/);
    expect(() => devUnlink("../evil", { homeDir: home })).toThrow(/invalid plugin id/);
  });
});

describe("t3p dev CLI", () => {
  it("runs link and unlink through the real CLI against T3P_HOME", () => {
    const linked = cli(["dev", source]);
    expect(linked.status).toBe(0);
    expect(linked.stdout).toMatch(/linked my-plugin/);
    expect(linked.stdout).toMatch(/hot reload on/);
    expect(lstatSync(linkPath()).isSymbolicLink()).toBe(true);

    const again = cli(["dev", source]);
    expect(again.status).toBe(0);
    expect(again.stdout).toMatch(/already linked my-plugin/);

    const bad = cli(["dev", join(home, "missing")]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/not a plugin folder/);

    const unlinked = cli(["dev", "--unlink", "my-plugin"]);
    expect(unlinked.status).toBe(0);
    expect(unlinked.stdout).toMatch(/unlinked my-plugin/);
    expect(existsSync(linkPath())).toBe(false);
    expect(existsSync(devMarkerPath(home))).toBe(false);

    expect(cli(["dev", "--unlink", "my-plugin"]).status).toBe(1);
    expect(cli(["dev"]).status).toBe(2);
    expect(cli(["dev", "a", "b"]).status).toBe(2);
  });
});
