import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { compareVersions, parseChecksum, selfUpdate, sha256, UPDATE_ASSET, UPDATE_CHECKSUM_ASSET } from "../src/self-update.js";
import { fakeFetch } from "./registry-helpers.js";

const RELEASE = "https://api.github.com/repos/watdafawx/t3-patcher/releases/latest";
const EXE = "https://github.com/watdafawx/t3-patcher/releases/download/v0.1.7/t3p.exe";
const SUMS = "https://github.com/watdafawx/t3-patcher/releases/download/v0.1.7/t3p.exe.sha256";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

function tempExe(bytes: Buffer): string {
  const root = mkdtempSync(join(tmpdir(), "t3p-update-"));
  roots.push(root);
  const file = join(root, "t3p.exe");
  writeFileSync(file, bytes);
  return file;
}

function releaseJson(tag: string): string {
  return JSON.stringify({
    tag_name: tag,
    assets: [
      { name: UPDATE_ASSET, browser_download_url: EXE },
      { name: UPDATE_CHECKSUM_ASSET, browser_download_url: SUMS },
    ],
  });
}

/** The real binary guard requires a plausible size. */
function fakeBinary(fill: number): Buffer {
  const bytes = Buffer.alloc(1024 * 1024 + 512, fill);
  bytes.set(Buffer.from("MZ"), 0);
  return bytes;
}

function routes(opts: { tag: string; exe?: Buffer; sha?: string }): Parameters<typeof fakeFetch>[0] {
  const exe = opts.exe ?? fakeBinary(1);
  return {
    [RELEASE]: { body: releaseJson(opts.tag), headers: { "content-type": "application/json" } },
    [EXE]: { body: exe },
    [SUMS]: { body: `${opts.sha ?? sha256(exe)}  t3p.exe\n` },
  };
}

describe("compareVersions", () => {
  it("orders releases and sorts a prerelease before its release", () => {
    expect(compareVersions("0.1.6", "0.1.5")).toBe(1);
    expect(compareVersions("0.1.5", "0.1.6")).toBe(-1);
    expect(compareVersions("v0.1.5", "0.1.5")).toBe(0);
    expect(compareVersions("0.2.0", "0.1.99")).toBe(1);
    expect(compareVersions("0.1.5-nightly.1", "0.1.5")).toBe(-1);
    expect(compareVersions("0.1.5", "0.1.5-nightly.1")).toBe(1);
  });
});

describe("parseChecksum", () => {
  it("reads sha256sum lines and refuses anything else", () => {
    expect(parseChecksum(`${"a".repeat(64)}  t3p.exe\n`)).toBe("a".repeat(64));
    expect(parseChecksum("not a checksum")).toBeNull();
    expect(parseChecksum("")).toBeNull();
  });
});

describe("selfUpdate", () => {
  it("tells npm/source copies to use npm and never hits the network", async () => {
    const fetch = fakeFetch({});
    const result = await selfUpdate({ currentVersion: "0.1.5", singleFile: false, fetch });
    expect(result).toMatchObject({ status: "unsupported", source: "npm" });
    expect(result.message).toContain("npm i -g t3-patcher@latest");
    expect(fetch.calls).toEqual([]);
  });

  it("reports current without downloading", async () => {
    const exe = tempExe(Buffer.from("old"));
    const fetch = fakeFetch(routes({ tag: "v0.1.5" }));
    const result = await selfUpdate({ currentVersion: "0.1.5", singleFile: true, exePath: exe, fetch, afterSwap: () => undefined });
    expect(result.status).toBe("current");
    expect(fetch.calls.map((c) => c.url)).toEqual([RELEASE]);
    expect(readFileSync(exe, "utf8")).toBe("old");
  });

  it("--check reports the new version and writes nothing", async () => {
    const exe = tempExe(Buffer.from("old"));
    const fetch = fakeFetch(routes({ tag: "v0.1.7" }));
    const result = await selfUpdate({ currentVersion: "0.1.6", singleFile: true, exePath: exe, fetch, check: true });
    expect(result).toMatchObject({ status: "available", latest: "0.1.7" });
    expect(readFileSync(exe, "utf8")).toBe("old");
    expect(fetch.calls.map((c) => c.url)).toEqual([RELEASE]);
  });

  it("downloads, verifies and swaps the executable in place", async () => {
    const exe = tempExe(Buffer.from("old"));
    const next = fakeBinary(2);
    const fetch = fakeFetch(routes({ tag: "v0.1.7", exe: next }));
    let swapped = "";
    const result = await selfUpdate({ currentVersion: "0.1.6", singleFile: true, exePath: exe, fetch, afterSwap: (p) => (swapped = p) });
    expect(result).toMatchObject({ status: "updated", latest: "0.1.7", asset: UPDATE_ASSET });
    expect(swapped).toBe(exe);
    expect(sha256(readFileSync(exe))).toBe(sha256(next));
  });

  it("refuses a binary whose hash does not match and leaves the old exe alone", async () => {
    const exe = tempExe(Buffer.from("old"));
    const fetch = fakeFetch(routes({ tag: "v0.1.7", sha: "0".repeat(64) }));
    await expect(selfUpdate({ currentVersion: "0.1.6", singleFile: true, exePath: exe, fetch, afterSwap: () => undefined })).rejects.toThrow(/SHA-256 mismatch/);
    expect(readFileSync(exe, "utf8")).toBe("old");
  });

  it("refuses a release without the exe or checksum asset", async () => {
    const exe = tempExe(Buffer.from("old"));
    const fetch = fakeFetch({
      [RELEASE]: { body: JSON.stringify({ tag_name: "v0.1.7", assets: [{ name: UPDATE_ASSET, browser_download_url: EXE }] }) },
    });
    await expect(selfUpdate({ currentVersion: "0.1.6", singleFile: true, exePath: exe, fetch })).rejects.toThrow(/no t3p.exe/);
  });
});
