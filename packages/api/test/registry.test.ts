import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv from "ajv";
import { describe, expect, it } from "vitest";

import {
  canonicalPermissions,
  compareSemver,
  DEFAULT_REGISTRY_URL,
  isRegistryUrl,
  isSemver,
  parseState,
  permissionsEqual,
  registryAssetName,
  registryInstallState,
  searchRegistry,
  validateRegistry,
  validateRegistryEntry,
} from "../src/index.js";

const schemaDir = fileURLToPath(new URL("../schema/", import.meta.url));
const schema = JSON.parse(readFileSync(join(schemaDir, "registry.schema.json"), "utf8")) as object;

const SHA = "a".repeat(64);
const entry = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "hello",
  name: "Hello",
  description: "Says hello.",
  author: "Someone",
  homepage: "https://github.com/example/hello",
  version: "1.0.0",
  apiVersion: "1",
  permissions: ["rpc"],
  tags: ["demo"],
  download: { url: "https://github.com/example/hello/releases/download/v1.0.0/t3p-plugin-hello-1.0.0.zip", sha256: SHA, size: 1234 },
  ...extra,
});
const index = (plugins: unknown[]): unknown => ({ schemaVersion: 1, plugins });

interface Case {
  name: string;
  index: unknown;
  valid: boolean;
  /** Rules JSON Schema cannot express: only the validator rejects these. */
  validatorOnly?: boolean;
}

const cases: Case[] = [
  { name: "empty registry", index: index([]), valid: true },
  { name: "minimal entry", index: index([entry()]), valid: true },
  {
    name: "full entry",
    index: index([
      entry({
        icon: "https://example.com/icon.png",
        screenshots: ["https://example.com/a.png"],
        minRuntime: "0.1.0",
        license: "MIT",
        source: "https://github.com/example/hello",
        permissions: ["rpc", "guard", { "fs.read": { roots: ["~/.t3"] } }, { spawn: { allow: ["C:/Windows/System32/notepad.exe"] } }],
      }),
    ]),
    valid: true,
  },
  { name: "prerelease version", index: index([entry({ version: "1.0.0-beta.1" })]), valid: true },
  { name: "wrong schemaVersion", index: { schemaVersion: 2, plugins: [] }, valid: false },
  { name: "plugins not array", index: { schemaVersion: 1, plugins: {} }, valid: false },
  { name: "bad id", index: index([entry({ id: "Hello" })]), valid: false },
  { name: "reserved id", index: index([entry({ id: "con" })]), valid: false },
  { name: "http download", index: index([entry({ download: { url: "http://example.com/x.zip", sha256: SHA, size: 100 } })]), valid: false },
  { name: "non-zip download", index: index([entry({ download: { url: "https://example.com/x.exe", sha256: SHA, size: 100 } })]), valid: false },
  { name: "uppercase sha", index: index([entry({ download: { url: "https://example.com/x.zip", sha256: "A".repeat(64), size: 100 } })]), valid: false },
  { name: "short sha", index: index([entry({ download: { url: "https://example.com/x.zip", sha256: "ab", size: 100 } })]), valid: false },
  { name: "size too big", index: index([entry({ download: { url: "https://example.com/x.zip", sha256: SHA, size: 26 * 1024 * 1024 } })]), valid: false },
  { name: "size not integer", index: index([entry({ download: { url: "https://example.com/x.zip", sha256: SHA, size: 1.5 } })]), valid: false },
  { name: "bad semver", index: index([entry({ version: "1.0" })]), valid: false },
  { name: "leading zero semver", index: index([entry({ version: "01.0.0" })]), valid: false },
  { name: "bad apiVersion", index: index([entry({ apiVersion: ">=1" })]), valid: false },
  { name: "http homepage", index: index([entry({ homepage: "http://example.com" })]), valid: false },
  { name: "javascript homepage", index: index([entry({ homepage: "javascript:alert(1)" })]), valid: false },
  { name: "unknown permission", index: index([entry({ permissions: ["root"] })]), valid: false },
  { name: "bad tag", index: index([entry({ tags: ["Has Space"] })]), valid: false },
  { name: "missing tags", index: index([{ ...entry(), tags: undefined }]), valid: false },
  { name: "missing download", index: index([{ ...entry(), download: undefined }]), valid: false },
  { name: "empty name", index: index([entry({ name: "  " })]), valid: false },
  { name: "http icon", index: index([entry({ icon: "http://example.com/i.png" })]), valid: false },
  { name: "duplicate ids", index: index([entry(), entry()]), valid: false, validatorOnly: true },
  { name: "duplicate permission", index: index([entry({ permissions: ["rpc", "rpc"] })]), valid: false, validatorOnly: true },
  { name: "credentials in url", index: index([entry({ homepage: "https://user:pw@example.com/" })]), valid: false },
];

describe("registry validator and schema agree", () => {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  it("schema is a valid draft-07 schema", () => expect(ajv.validateSchema(schema)).toBe(true));
  for (const c of cases) {
    it(`${c.valid ? "accepts" : "rejects"}: ${c.name}`, () => {
      const res = validateRegistry(c.index);
      expect(res.ok, res.ok ? "" : res.errors.join("; ")).toBe(c.valid);
      if (!c.validatorOnly) expect(validate(c.index), JSON.stringify(validate.errors)).toBe(c.valid);
    });
  }
  it("the committed registry/index.json is valid for both", () => {
    const raw = JSON.parse(readFileSync(join(schemaDir, "..", "..", "..", "registry", "index.json"), "utf8")) as unknown;
    const res = validateRegistry(raw);
    expect(res.ok, res.ok ? "" : res.errors.join("; ")).toBe(true);
    if (res.ok) expect(res.warnings).toEqual([]);
    expect(validate(raw), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe("registry helpers", () => {
  it("only https (or loopback http when allowed) URLs pass", () => {
    expect(isRegistryUrl("https://example.com/x")).toBe(true);
    expect(isRegistryUrl("http://example.com/x")).toBe(false);
    expect(isRegistryUrl("http://127.0.0.1:8080/x")).toBe(false);
    expect(isRegistryUrl("http://127.0.0.1:8080/x", { allowInsecureLocal: true })).toBe(true);
    expect(isRegistryUrl("http://localhost/x", { allowInsecureLocal: true })).toBe(true);
    expect(isRegistryUrl("http://192.168.1.2/x", { allowInsecureLocal: true })).toBe(false);
    expect(isRegistryUrl("file:///C:/x.zip", { allowInsecureLocal: true })).toBe(false);
    expect(isRegistryUrl("ftp://example.com/x")).toBe(false);
    expect(isRegistryUrl(DEFAULT_REGISTRY_URL)).toBe(true);
  });
  it("insecure local URLs need the option in entries too", () => {
    const local = entry({ download: { url: "http://127.0.0.1:9/t.zip", sha256: SHA, size: 100 } });
    expect(validateRegistryEntry(local).ok).toBe(false);
    expect(validateRegistryEntry(local, { allowInsecureLocal: true }).ok).toBe(true);
  });
  it("semver compare", () => {
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("1.0.1", "1.0.0")).toBe(1);
    expect(compareSemver("1.10.0", "1.9.9")).toBe(1);
    expect(compareSemver("1.0.0-beta", "1.0.0")).toBe(-1);
    expect(compareSemver("1.0.0-beta.2", "1.0.0-beta.10")).toBe(-1);
    expect(compareSemver("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    expect(compareSemver("1.0.0-1", "1.0.0-alpha")).toBe(-1);
    expect(compareSemver("1.0.0+build.1", "1.0.0")).toBe(0);
    expect(() => compareSemver("x", "1.0.0")).toThrow();
    expect(isSemver("1.2.3")).toBe(true);
    expect(isSemver("1.2")).toBe(false);
  });
  it("permission equality ignores order but not scope", () => {
    expect(permissionsEqual(["rpc", "main"], ["main", "rpc"])).toBe(true);
    expect(permissionsEqual([{ "fs.read": { roots: ["~/a", "~/b"] } }], [{ "fs.read": { roots: ["~/b", "~/a"] } }])).toBe(true);
    expect(permissionsEqual([{ "fs.read": { roots: ["~/a"] } }], [{ "fs.read": { roots: ["~/a", "~/b"] } }])).toBe(false);
    expect(permissionsEqual(["rpc"], ["rpc", "guard"])).toBe(false);
    expect(permissionsEqual([], [])).toBe(true);
    expect(canonicalPermissions(["nope"])).toBeNull();
    expect(permissionsEqual(["nope"], ["nope"])).toBe(false);
  });
  it("install state compares versions", () => {
    expect(registryInstallState({ version: "1.1.0" }, null)).toBe("install");
    expect(registryInstallState({ version: "1.1.0" }, "1.0.0")).toBe("update");
    expect(registryInstallState({ version: "1.1.0" }, "1.1.0")).toBe("installed");
    expect(registryInstallState({ version: "1.1.0" }, "2.0.0")).toBe("installed");
  });
  it("search filters by text and tags", () => {
    const res = validateRegistry(index([entry(), entry({ id: "notes", name: "Notes", tags: ["sidebar", "demo"] })]));
    if (!res.ok) throw new Error(res.errors.join("; "));
    expect(searchRegistry(res.index.plugins, "note").map((e) => e.id)).toEqual(["notes"]);
    expect(searchRegistry(res.index.plugins, "", ["demo"]).map((e) => e.id)).toEqual(["hello", "notes"]);
    expect(searchRegistry(res.index.plugins, "", ["sidebar"]).map((e) => e.id)).toEqual(["notes"]);
    expect(searchRegistry(res.index.plugins, "SOMEONE").length).toBe(2);
  });
  it("asset names", () => expect(registryAssetName("notes", "0.1.0")).toBe("t3p-plugin-notes-0.1.0.zip"));
  it("state.json keeps a valid install record and drops a bad one", () => {
    const good = { source: "registry", registry: DEFAULT_REGISTRY_URL, version: "1.0.0", sha256: SHA, at: "2026-11-19T00:00:00.000Z" };
    const parsed = parseState({ version: 1, plugins: { a: { enabled: false, granted: [], install: good }, b: { enabled: false, granted: [], install: { ...good, sha256: "x" } } } });
    expect(parsed.state.plugins.a?.install).toEqual(good);
    expect(parsed.state.plugins.b?.install).toBeUndefined();
  });
});
