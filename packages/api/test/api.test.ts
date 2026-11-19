import { describe, expect, it } from "vitest";

import {
  effectivePermissions,
  emptyState,
  grantPermission,
  isAllowedEventChannel,
  isAllowedInvokeChannel,
  isValidEntryPath,
  isValidPluginId,
  matchesT3Version,
  parsePermissions,
  parseState,
  pluginState,
  revokePermission,
  setEnabled,
  validateManifest,
} from "../src/index.js";

const good = {
  id: "test-plugin",
  version: "1.0.0",
  tier: 1,
  permissions: ["main", { "fs.read": { roots: ["~/.t3/caches"] } }],
  t3Versions: ["0.1.x"],
  main: "main.cjs",
  renderer: "dist/renderer.js",
};

describe("validateManifest", () => {
  it("accepts a valid manifest and normalizes permissions", () => {
    const r = validateManifest(good, "test-plugin");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.permissions).toEqual({ main: true, "fs.read": { roots: ["~/.t3/caches"] } });
    expect(r.manifest.name).toBe("test-plugin");
  });

  it("rejects a folder/id mismatch", () => {
    const r = validateManifest(good, "other");
    expect(r.ok).toBe(false);
  });

  it.each([
    ["missing id", { ...good, id: undefined }],
    ["bad id", { ...good, id: "../evil" }],
    ["reserved id", { ...good, id: "con" }],
    ["bad version", { ...good, version: "one" }],
    ["bad tier", { ...good, tier: 4 }],
    ["empty t3Versions", { ...good, t3Versions: [] }],
    ["bad t3Versions", { ...good, t3Versions: ["latest"] }],
    ["main traversal", { ...good, main: "../x.js" }],
    ["main absolute", { ...good, main: "C:/x.js" }],
    ["renderer backslash", { ...good, renderer: "dist\\r.js" }],
    ["renderer not js", { ...good, renderer: "r.html" }],
    ["main without main permission", { ...good, permissions: [] }],
    ["unknown permission", { ...good, permissions: ["main", "network"] }],
    ["UNC root", { ...good, permissions: ["main", { "fs.read": { roots: ["\\\\server\\share"] } }] }],
    ["relative root", { ...good, permissions: ["main", { "fs.read": { roots: ["caches"] } }] }],
    ["not an object", "plugin"],
  ])("rejects %s", (_name, manifest) => {
    expect(validateManifest(manifest).ok).toBe(false);
  });

  it("warns about unknown keys but accepts", () => {
    const r = validateManifest({ ...good, extra: 1 });
    expect(r.ok).toBe(true);
    expect(r.warnings.join()).toContain("extra");
  });
});

describe("ids and entry paths", () => {
  it("validates ids", () => {
    expect(isValidPluginId("a.b-c")).toBe(true);
    expect(isValidPluginId("A")).toBe(false);
    expect(isValidPluginId("a..b")).toBe(false);
    expect(isValidPluginId("nul.txt")).toBe(false);
    expect(isValidPluginId("x".repeat(65))).toBe(false);
  });
  it("validates entry paths", () => {
    expect(isValidEntryPath("a/b.mjs")).toBe(true);
    for (const bad of ["./a.js", "a/../b.js", "a.js.", "a /b.js", "nul.js", "a:b.js", "/a.js", "a//b.js"]) {
      expect(isValidEntryPath(bad), bad).toBe(false);
    }
  });
});

describe("matchesT3Version", () => {
  it("matches exact, wildcard, star and prerelease of a base", () => {
    expect(matchesT3Version(["0.1.10"], "0.1.10")).toBe(true);
    expect(matchesT3Version(["0.1.x"], "0.1.11-nightly.20261118.4890")).toBe(true);
    expect(matchesT3Version(["0.2.x"], "0.1.10")).toBe(false);
    expect(matchesT3Version(["*"], null)).toBe(true);
    expect(matchesT3Version(["0.1.x"], null)).toBe(false);
  });
});

describe("effectivePermissions", () => {
  const declared = parsePermissions([
    "main",
    { "fs.read": { roots: ["~/.t3/caches", "C:/Data"] } },
    { spawn: { allow: ["C:/Tools/a.exe"] } },
  ]).set;

  it("is the intersection of declared and granted", () => {
    const granted = parsePermissions([
      "main",
      "patches",
      { "fs.read": { roots: ["~/.t3/caches/sub", "C:/Other"] } },
      { spawn: { allow: ["c:\\tools\\A.exe", "C:/Tools/b.exe"] } },
    ]).set;
    expect(effectivePermissions(declared, granted)).toEqual({
      main: true,
      "fs.read": { roots: ["~/.t3/caches/sub"] },
      spawn: { allow: ["c:\\tools\\A.exe"] },
    });
  });

  it("drops a granted root that only shares a prefix or uses ..", () => {
    const granted = parsePermissions([{ "fs.read": { roots: ["C:/Database", "C:/Data/../Windows"] } }]).set;
    expect(effectivePermissions(declared, granted)).toEqual({});
  });

  it("grants nothing that was not granted", () => {
    expect(effectivePermissions(declared, {})).toEqual({});
  });
});

describe("state", () => {
  it("round-trips enable and grants", () => {
    const s = emptyState();
    setEnabled(s, "p", true);
    grantPermission(s, "p", "main");
    grantPermission(s, "p", "fs.read", ["~/.t3/caches"]);
    grantPermission(s, "p", "fs.read", ["C:/x"]);
    const parsed = parseState(JSON.parse(JSON.stringify(s))).state;
    expect(pluginState(parsed, "p")).toEqual({
      enabled: true,
      granted: { main: true, "fs.read": { roots: ["~/.t3/caches", "C:/x"] } },
    });
    revokePermission(parsed, "p", "fs.read");
    expect(pluginState(parsed, "p").granted).toEqual({ main: true });
  });

  it("fails closed on garbage", () => {
    const { state, errors } = parseState({ version: 1, plugins: { "../x": { enabled: true }, ok: { enabled: "yes" } } });
    expect(errors.length).toBeGreaterThan(0);
    expect(pluginState(state, "ok").enabled).toBe(false);
    expect(pluginState(state, "missing")).toEqual({ enabled: false, granted: {} });
    expect(pluginState(state, "__proto__")).toEqual({ enabled: false, granted: {} });
  });

  it("rejects unknown permissions and bad ids", () => {
    expect(() => grantPermission(emptyState(), "p", "network")).toThrow();
    expect(() => grantPermission(emptyState(), "p", "fs.read", ["relative"])).toThrow();
    expect(() => setEnabled(emptyState(), "../p", true)).toThrow();
  });
});

describe("ipc channel allowlist", () => {
  it("allows fixed and plugin channels only", () => {
    expect(isAllowedInvokeChannel("t3p:ping")).toBe(true);
    expect(isAllowedInvokeChannel("t3p:plugin:test-plugin:echo")).toBe(true);
    expect(isAllowedInvokeChannel("t3p:plugin:Bad:echo")).toBe(false);
    expect(isAllowedInvokeChannel("t3p:plugin:test-plugin:")).toBe(false);
    expect(isAllowedInvokeChannel("desktop:get-bearer")).toBe(false);
    expect(isAllowedInvokeChannel("t3p:native:fs.write")).toBe(false);
    expect(isAllowedEventChannel("t3p:event")).toBe(true);
    expect(isAllowedEventChannel("t3p:ping")).toBe(false);
  });
});
