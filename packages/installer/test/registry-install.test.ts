import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readState, writeState } from "../src/plugin-admin.js";
import { fetchRegistryIndex, installFromRegistry, resolveRegistry, uninstallPlugin } from "../src/registry.js";
import { writeZip } from "../src/registry/zip.js";
import { entryFor, fakeFetch, indexOf, pluginZip, REGISTRY_URL } from "./registry-helpers.js";

let home: string;
const base = (): string => join(home, ".t3-patcher");
const pluginDir = (id = "demo"): string => join(base(), "plugins", id);
const stagingLeft = (): string[] => (existsSync(join(base(), "staging")) ? readdirSync(join(base(), "staging")) : []);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "t3p-registry-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function serve(zip: Buffer, entry = entryFor(zip)) {
  return { entry, fetch: fakeFetch({ [entry.download.url]: { body: zip } }) };
}

describe("installFromRegistry", () => {
  it("installs disabled with no grants, records the source, leaves no staging", async () => {
    const zip = pluginZip();
    const { entry, fetch } = serve(zip);
    const res = await installFromRegistry({ homeDir: home, entry, registryUrl: REGISTRY_URL, fetch });
    expect(res).toMatchObject({ id: "demo", version: "1.0.0", updated: false, previousVersion: null, sha256: entry.download.sha256 });
    expect(existsSync(join(pluginDir(), "plugin.json"))).toBe(true);
    expect(existsSync(join(pluginDir(), "dist", "renderer.js"))).toBe(true);
    const ps = readState(home).plugins.demo!;
    expect(ps.enabled).toBe(false);
    expect(ps.granted).toEqual([]);
    expect(ps.install).toMatchObject({ source: "registry", registry: REGISTRY_URL, version: "1.0.0", sha256: entry.download.sha256 });
    expect(stagingLeft()).toEqual([]);
  });

  it("replaces a stale state entry on a fresh install (no old grants survive)", async () => {
    writeState({ version: 1, plugins: { demo: { enabled: true, granted: ["rpc", "main"] } } }, home);
    const zip = pluginZip();
    const { entry, fetch } = serve(zip);
    await installFromRegistry({ homeDir: home, entry, registryUrl: REGISTRY_URL, fetch });
    expect(readState(home).plugins.demo).toMatchObject({ enabled: false, granted: [] });
  });

  it("refuses a SHA-256 mismatch before unpacking anything", async () => {
    const zip = pluginZip();
    const entry = entryFor(zip);
    const tampered = pluginZip({ manifest: { description: "tampered" } });
    const fetch = fakeFetch({ [entry.download.url]: { body: Buffer.concat([tampered, Buffer.alloc(Math.max(0, zip.length - tampered.length))]).subarray(0, zip.length) } });
    await expect(installFromRegistry({ homeDir: home, entry, registryUrl: REGISTRY_URL, fetch })).rejects.toThrow(/SHA-256 mismatch/);
    expect(existsSync(pluginDir())).toBe(false);
    expect(stagingLeft()).toEqual([]);
    expect(readState(home).plugins.demo).toBeUndefined();
  });

  it("refuses a size mismatch and an oversized body", async () => {
    const zip = pluginZip();
    const entry = entryFor(zip);
    const short = fakeFetch({ [entry.download.url]: { body: zip.subarray(0, zip.length - 1) } });
    await expect(installFromRegistry({ homeDir: home, entry, registryUrl: REGISTRY_URL, fetch: short })).rejects.toThrow(/bytes, the registry says/);
    const long = fakeFetch({ [entry.download.url]: { body: Buffer.concat([zip, Buffer.alloc(10)]) } });
    await expect(installFromRegistry({ homeDir: home, entry, registryUrl: REGISTRY_URL, fetch: long })).rejects.toThrow(/larger than/);
    const declared = fakeFetch({ [entry.download.url]: { body: zip, headers: { "content-length": String(30 * 1024 * 1024) } } });
    await expect(installFromRegistry({ homeDir: home, entry, registryUrl: REGISTRY_URL, fetch: declared })).rejects.toThrow(/larger than/);
    expect(existsSync(pluginDir())).toBe(false);
  });

  it.each([
    ["id", { manifest: { id: "other" } }, /must equal the folder name/],
    ["version", { version: "1.0.1" }, /version 1\.0\.1, the registry says 1\.0\.0/],
    ["permissions (extra)", { permissions: ["rpc", "main"], manifest: { main: "dist/renderer.js" } }, /different permissions/],
    ["permissions (scope)", { permissions: [{ "fs.read": { roots: ["~/"] } }] }, /different permissions/],
    ["missing plugin.json", { noManifest: true }, /plugin\.json must be at the root/],
    ["missing renderer", { manifest: { renderer: "dist/missing.js" } }, /missing from the zip/],
  ])("refuses a %s mismatch between zip and registry entry", async (_what, p, error) => {
    const zip = pluginZip(p as never);
    const entry = entryFor(zip, { version: "1.0.0", permissions: ["rpc"] });
    const fetch = fakeFetch({ [entry.download.url]: { body: zip } });
    await expect(installFromRegistry({ homeDir: home, entry, registryUrl: REGISTRY_URL, fetch })).rejects.toThrow(error);
    expect(existsSync(pluginDir())).toBe(false);
    expect(stagingLeft()).toEqual([]);
  });

  it("refuses unsafe zips (traversal, symlink) and writes nothing outside", async () => {
    for (const extra of [[{ name: "../../evil.js", data: Buffer.from("x") }], [{ name: "link.js", data: Buffer.from("/etc"), unixMode: 0o120777 }]]) {
      const zip = pluginZip({ extra });
      const { entry, fetch } = serve(zip);
      await expect(installFromRegistry({ homeDir: home, entry, registryUrl: REGISTRY_URL, fetch })).rejects.toThrow(/unsafe or invalid zip/);
      expect(existsSync(pluginDir())).toBe(false);
      expect(existsSync(join(home, "evil.js"))).toBe(false);
      expect(existsSync(join(base(), "evil.js"))).toBe(false);
      expect(stagingLeft()).toEqual([]);
    }
  });

  it("follows redirects only to allowed https hosts", async () => {
    const zip = pluginZip();
    const entry = entryFor(zip);
    const ok = fakeFetch({
      [entry.download.url]: { location: "https://release-assets.githubusercontent.com/x/demo.zip" },
      "https://release-assets.githubusercontent.com/x/demo.zip": { body: zip },
    });
    await installFromRegistry({ homeDir: home, entry, registryUrl: REGISTRY_URL, fetch: ok });
    expect(existsSync(pluginDir())).toBe(true);
    uninstallPlugin({ homeDir: home, id: "demo" });

    const evil = fakeFetch({ [entry.download.url]: { location: "https://evil.example/demo.zip" }, "https://evil.example/demo.zip": { body: zip } });
    await expect(installFromRegistry({ homeDir: home, entry, registryUrl: REGISTRY_URL, fetch: evil })).rejects.toThrow(/refusing redirect to evil\.example/);
    const downgrade = fakeFetch({ [entry.download.url]: { location: "http://github.com/demo.zip" } });
    await expect(installFromRegistry({ homeDir: home, entry, registryUrl: REGISTRY_URL, fetch: downgrade })).rejects.toThrow(/non-https/);
  });

  it("refuses http download URLs unless loopback is explicitly allowed", async () => {
    const zip = pluginZip();
    const entry = entryFor(zip, { url: "http://127.0.0.1:1/t3p-plugin-demo-1.0.0.zip" });
    const fetch = fakeFetch({ [entry.download.url]: { body: zip } });
    await expect(installFromRegistry({ homeDir: home, entry, registryUrl: REGISTRY_URL, fetch })).rejects.toThrow(/non-https/);
    await installFromRegistry({ homeDir: home, entry, registryUrl: "http://127.0.0.1:1/index.json", fetch, allowInsecureLocal: true });
    expect(existsSync(pluginDir())).toBe(true);
  });

  it("update keeps enabled, grants and storage; removes files of the old version", async () => {
    const v1 = pluginZip({ extra: [{ name: "old-only.txt", data: Buffer.from("v1") }] });
    const s1 = serve(v1);
    await installFromRegistry({ homeDir: home, entry: s1.entry, registryUrl: REGISTRY_URL, fetch: s1.fetch });
    const state = readState(home);
    state.plugins.demo!.enabled = true;
    state.plugins.demo!.granted = ["rpc"];
    writeState(state, home);
    mkdirSync(join(base(), "storage"), { recursive: true });
    writeFileSync(join(base(), "storage", "demo.json"), JSON.stringify({ kv: { a: 1 }, settings: { b: 2 } }));

    const v2 = pluginZip({ version: "1.1.0" });
    const s2 = serve(v2, entryFor(v2, { version: "1.1.0" }));
    const res = await installFromRegistry({ homeDir: home, entry: s2.entry, registryUrl: REGISTRY_URL, fetch: s2.fetch, mode: "update" });
    expect(res).toMatchObject({ updated: true, previousVersion: "1.0.0", version: "1.1.0" });
    expect(JSON.parse(readFileSync(join(pluginDir(), "plugin.json"), "utf8")).version).toBe("1.1.0");
    expect(existsSync(join(pluginDir(), "old-only.txt"))).toBe(false);
    expect(readState(home).plugins.demo).toMatchObject({ enabled: true, granted: ["rpc"], install: { version: "1.1.0" } });
    expect(JSON.parse(readFileSync(join(base(), "storage", "demo.json"), "utf8"))).toEqual({ kv: { a: 1 }, settings: { b: 2 } });
    expect(stagingLeft()).toEqual([]);
    // same version again: nothing to update
    await expect(installFromRegistry({ homeDir: home, entry: s2.entry, registryUrl: REGISTRY_URL, fetch: s2.fetch })).rejects.toThrow(/nothing to update/);
  });

  it("rolls back to the old version when the swap fails before state.json is written", async () => {
    const v1 = pluginZip();
    const s1 = serve(v1);
    await installFromRegistry({ homeDir: home, entry: s1.entry, registryUrl: REGISTRY_URL, fetch: s1.fetch });
    const before = readFileSync(join(base(), "state.json"), "utf8");
    const v2 = pluginZip({ version: "2.0.0" });
    const s2 = serve(v2, entryFor(v2, { version: "2.0.0" }));
    await expect(
      installFromRegistry({
        homeDir: home,
        entry: s2.entry,
        registryUrl: REGISTRY_URL,
        fetch: s2.fetch,
        beforeStateWrite: () => {
          throw new Error("disk full");
        },
      }),
    ).rejects.toThrow(/disk full/);
    expect(JSON.parse(readFileSync(join(pluginDir(), "plugin.json"), "utf8")).version).toBe("1.0.0");
    expect(readFileSync(join(base(), "state.json"), "utf8")).toBe(before);
    expect(stagingLeft()).toEqual([]);
  });

  it("rolls back a fresh install too (no folder left)", async () => {
    const zip = pluginZip();
    const { entry, fetch } = serve(zip);
    await expect(
      installFromRegistry({
        homeDir: home,
        entry,
        registryUrl: REGISTRY_URL,
        fetch,
        beforeStateWrite: () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow(/boom/);
    expect(existsSync(pluginDir())).toBe(false);
    expect(stagingLeft()).toEqual([]);
  });

  it("refuses dev links, already-installed installs and missing updates", async () => {
    const zip = pluginZip();
    const { entry, fetch } = serve(zip);
    await expect(installFromRegistry({ homeDir: home, entry, registryUrl: REGISTRY_URL, fetch, mode: "update" })).rejects.toThrow(/not installed/);
    await installFromRegistry({ homeDir: home, entry, registryUrl: REGISTRY_URL, fetch });
    await expect(installFromRegistry({ homeDir: home, entry, registryUrl: REGISTRY_URL, fetch, mode: "install" })).rejects.toThrow(/already installed/);
    uninstallPlugin({ homeDir: home, id: "demo" });
    const src = join(home, "src-demo");
    mkdirSync(src);
    mkdirSync(join(base(), "plugins"), { recursive: true });
    symlinkSync(src, pluginDir(), process.platform === "win32" ? "junction" : "dir");
    await expect(installFromRegistry({ homeDir: home, entry, registryUrl: REGISTRY_URL, fetch })).rejects.toThrow(/t3p dev/);
    expect(() => uninstallPlugin({ homeDir: home, id: "demo" })).toThrow(/t3p dev/);
    expect(existsSync(src)).toBe(true);
  });

  it("refuses an incompatible plugin API before downloading", async () => {
    const zip = pluginZip();
    const { entry, fetch } = serve(zip);
    await expect(installFromRegistry({ homeDir: home, entry: { ...entry, apiVersion: "2" }, registryUrl: REGISTRY_URL, fetch })).rejects.toThrow(/plugin API 2/);
    expect(fetch.calls).toHaveLength(0);
  });

  it("never executes anything from the zip", async () => {
    const zip = writeZip([
      { name: "plugin.json", data: Buffer.from(JSON.stringify({ id: "demo", version: "1.0.0", tier: 1, t3Versions: ["*"], permissions: ["rpc"], renderer: "r.js" })) },
      { name: "r.js", data: Buffer.from("globalThis.__ran = true; throw new Error('executed');") },
      { name: "package.json", data: Buffer.from(JSON.stringify({ scripts: { install: "node -e \"require('fs').writeFileSync('pwned','1')\"", postinstall: "calc.exe" } })) },
    ]);
    const { entry, fetch } = serve(zip);
    await installFromRegistry({ homeDir: home, entry, registryUrl: REGISTRY_URL, fetch });
    expect((globalThis as { __ran?: boolean }).__ran).toBeUndefined();
    expect(existsSync(join(pluginDir(), "pwned"))).toBe(false);
    expect(existsSync(join(home, "pwned"))).toBe(false);
  });
});

describe("uninstallPlugin", () => {
  it("removes the folder and the state entry, keeps storage", async () => {
    const zip = pluginZip();
    const { entry, fetch } = serve(zip);
    await installFromRegistry({ homeDir: home, entry, registryUrl: REGISTRY_URL, fetch });
    const st = readState(home);
    st.loadOrder = ["demo", "x"];
    writeState(st, home);
    mkdirSync(join(base(), "storage"), { recursive: true });
    writeFileSync(join(base(), "storage", "demo.json"), "{}");
    const res = uninstallPlugin({ homeDir: home, id: "demo" });
    expect(res).toEqual({ id: "demo", version: "1.0.0", storageKept: true });
    expect(existsSync(pluginDir())).toBe(false);
    expect(readState(home).plugins.demo).toBeUndefined();
    expect(readState(home).loadOrder).toEqual(["x"]);
    expect(() => uninstallPlugin({ homeDir: home, id: "demo" })).toThrow(/not installed/);
  });
});

describe("registry index", () => {
  it("resolves env, then config.json, then the default; refuses non-https", () => {
    expect(resolveRegistry({ homeDir: home, env: {} }).from).toBe("default");
    mkdirSync(base(), { recursive: true });
    writeFileSync(join(base(), "config.json"), JSON.stringify({ registryUrl: "https://my.example/r.json" }));
    expect(resolveRegistry({ homeDir: home, env: {} })).toMatchObject({ url: "https://my.example/r.json", from: "config" });
    expect(resolveRegistry({ homeDir: home, env: { T3P_REGISTRY_URL: "https://env.example/r.json" } })).toMatchObject({ url: "https://env.example/r.json", from: "env" });
    expect(() => resolveRegistry({ homeDir: home, env: { T3P_REGISTRY_URL: "http://127.0.0.1:9/r.json" } })).toThrow(/must be https/);
    expect(resolveRegistry({ homeDir: home, env: { T3P_REGISTRY_URL: "http://127.0.0.1:9/r.json", T3P_REGISTRY_ALLOW_INSECURE_LOCAL: "1" } }).allowInsecureLocal).toBe(true);
    expect(() => resolveRegistry({ homeDir: home, env: { T3P_REGISTRY_URL: "http://example.com/r.json", T3P_REGISTRY_ALLOW_INSECURE_LOCAL: "1" } })).toThrow(/must be https/);
  });

  it("caches with ETag, revalidates with If-None-Match and falls back to the cache offline", async () => {
    const zip = pluginZip();
    const body = JSON.stringify(indexOf(entryFor(zip)));
    const env = { T3P_REGISTRY_URL: REGISTRY_URL };
    const fresh = fakeFetch({ [REGISTRY_URL]: { body, headers: { etag: '"v1"' } } });
    const a = await fetchRegistryIndex({ homeDir: home, env, fetch: fresh });
    expect(a.source).toBe("network");
    expect(a.index.plugins[0]!.id).toBe("demo");
    const revalidate = fakeFetch({ [REGISTRY_URL]: (h) => (h["if-none-match"] === '"v1"' ? { status: 304 } : { body: "{}" }) });
    const b = await fetchRegistryIndex({ homeDir: home, env, fetch: revalidate });
    expect(b.source).toBe("not-modified");
    expect(b.index.plugins).toHaveLength(1);
    const offline = fakeFetch({});
    const c = await fetchRegistryIndex({ homeDir: home, env, fetch: offline });
    expect(c.source).toBe("cache");
    expect(c.error).toMatch(/cannot reach/);
    // an invalid index never replaces the good cached copy
    const broken = fakeFetch({ [REGISTRY_URL]: { body: JSON.stringify({ schemaVersion: 1, plugins: [{ id: "x" }] }) } });
    const d = await fetchRegistryIndex({ homeDir: home, env, fetch: broken });
    expect(d.source).toBe("cache");
    expect(d.error).toMatch(/invalid/);
  });

  it("fails without a cache when offline, and enforces the 1 MB cap", async () => {
    const env = { T3P_REGISTRY_URL: REGISTRY_URL };
    await expect(fetchRegistryIndex({ homeDir: home, env, fetch: fakeFetch({}) })).rejects.toThrow(/cannot reach/);
    const huge = fakeFetch({ [REGISTRY_URL]: { body: Buffer.alloc(1024 * 1024 + 1, 32) } });
    await expect(fetchRegistryIndex({ homeDir: home, env, fetch: huge })).rejects.toThrow(/larger than 1048576/);
  });

  it("times out", async () => {
    const env = { T3P_REGISTRY_URL: REGISTRY_URL };
    const hang = ((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))))) as never;
    await expect(fetchRegistryIndex({ homeDir: home, env, fetch: hang, timeoutMs: 50 })).rejects.toThrow(/timed out after 50 ms/);
  });
});
