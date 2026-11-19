import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv from "ajv";
import { beforeAll, describe, expect, it } from "vitest";

import { validateManifest } from "../src/index.js";

/**
 * The JSON Schema in schema/plugin.schema.json is the editor-facing copy of
 * validateManifest(). This table is the contract between them: every entry must
 * be accepted by BOTH or rejected by BOTH. Never relax the validator to make a
 * case pass; fix the schema (or the case) instead.
 */

const schemaPath = join(fileURLToPath(new URL("../schema/", import.meta.url)), "plugin.schema.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as object;

interface Case {
  name: string;
  manifest: unknown;
  valid: boolean;
}

const base = { id: "hello-world", version: "1.0.0", tier: 1, t3Versions: ["*"] };

const scoped = (permissions: unknown[]) => ({ ...base, permissions });

const cases: Case[] = [
  // Valid
  { name: "minimal manifest", manifest: base, valid: true },
  {
    name: "full manifest",
    manifest: {
      id: "com.example.hello",
      name: "Hello world",
      description: "A demo plugin",
      author: "Someone",
      version: "1.2.3-beta.1+build.7",
      tier: 3,
      permissions: [
        "main",
        "patches",
        "rpc",
        { "fs.read": { roots: ["~/.t3/caches", "C:/Users/x/logs", "/var/log"] } },
        { "sqlite.read": { roots: ["~/.t3"] } },
        { "log.tail": { roots: ["~/logs"] } },
        { spawn: { allow: ["C:/Tools/git.exe", "~/bin/tool.exe"] } },
      ],
      t3Versions: ["*"],
      main: "main.cjs",
      renderer: "dist/renderer.js",
    },
    valid: true,
  },
  { name: "empty permissions array", manifest: { ...base, permissions: [] }, valid: true },
  { name: "permissions omitted", manifest: { ...base, permissions: undefined }, valid: true },
  { name: "duplicate permissions", manifest: scoped(["rpc", "rpc"]), valid: true },
  { name: "one bad root invalidates the scope list", manifest: scoped([{ "fs.read": { roots: ["~", "~\\logs", "C:\\logs", "\\\\server"] } }]), valid: false },
  { name: "unknown top-level keys are warnings only", manifest: { ...base, future: { anything: true } }, valid: true },
  { name: "$schema key is allowed", manifest: { $schema: "./plugin.schema.json", ...base }, valid: true },
  { name: "empty name string", manifest: { ...base, name: "" }, valid: true },
  { name: "name at 512 chars", manifest: { ...base, name: "x".repeat(512) }, valid: true },
  { name: "t3Versions patterns", manifest: { ...base, t3Versions: ["*", "0.1.x", "x.x.x", "1.2.3-nightly.1"] }, valid: true },
  { name: "entry in a subfolder", manifest: { ...base, permissions: ["main"], main: "plugins/main.js", renderer: "dist/r.js" }, valid: true },
  { name: "single dot file name", manifest: { ...base, renderer: ".js" }, valid: true },
  { name: "root equals bare tilde", manifest: scoped([{ "fs.read": { roots: ["~"] } }]), valid: true },
  { name: "root equals single slash", manifest: scoped([{ "fs.read": { roots: ["/"] } }]), valid: true },

  // Invalid: root shape and id
  { name: "not an object", manifest: "plugin", valid: false },
  { name: "array", manifest: [base], valid: false },
  { name: "null", manifest: null, valid: false },
  { name: "missing id", manifest: { ...base, id: undefined }, valid: false },
  { name: "uppercase id", manifest: { ...base, id: "Hello" }, valid: false },
  { name: "underscore id", manifest: { ...base, id: "hello_world" }, valid: false },
  { name: "leading dash id", manifest: { ...base, id: "-hello" }, valid: false },
  { name: "empty id segment", manifest: { ...base, id: "a..b" }, valid: false },
  { name: "id at 65 chars", manifest: { ...base, id: "a".repeat(65) }, valid: false },
  { name: "reserved id con", manifest: { ...base, id: "con" }, valid: false },
  { name: "reserved id con.json", manifest: { ...base, id: "con.json" }, valid: false },
  { name: "reserved id com1", manifest: { ...base, id: "com1" }, valid: false },

  // Invalid: version, tier, text fields
  { name: "missing version", manifest: { ...base, version: undefined }, valid: false },
  { name: "two-part version", manifest: { ...base, version: "1.0" }, valid: false },
  { name: "v-prefixed version", manifest: { ...base, version: "v1.0.0" }, valid: false },
  { name: "missing tier", manifest: { ...base, tier: undefined }, valid: false },
  { name: "tier 4", manifest: { ...base, tier: 4 }, valid: false },
  { name: "tier as string", manifest: { ...base, tier: "1" }, valid: false },
  { name: "name as number", manifest: { ...base, name: 5 }, valid: false },
  { name: "name over 512 chars", manifest: { ...base, name: "x".repeat(513) }, valid: false },
  { name: "description as array", manifest: { ...base, description: [] }, valid: false },
  { name: "author as object", manifest: { ...base, author: {} }, valid: false },

  // Invalid: t3Versions
  { name: "missing t3Versions", manifest: { ...base, t3Versions: undefined }, valid: false },
  { name: "empty t3Versions", manifest: { ...base, t3Versions: [] }, valid: false },
  { name: "t3Versions latest", manifest: { ...base, t3Versions: ["latest"] }, valid: false },
  { name: "t3Versions number", manifest: { ...base, t3Versions: [1] }, valid: false },
  { name: "t3Versions object", manifest: { ...base, t3Versions: {} }, valid: false },

  // Invalid: permissions
  { name: "permissions not an array", manifest: { ...base, permissions: "main" }, valid: false },
  { name: "unknown permission", manifest: scoped(["network"]), valid: false },
  { name: "null permission", manifest: scoped([null]), valid: false },
  { name: "number permission", manifest: scoped([5]), valid: false },
  { name: "empty permission object", manifest: scoped([{}]), valid: false },
  { name: "two keys in a scoped permission", manifest: scoped([{ "fs.read": { roots: ["~/a"] }, "log.tail": { roots: ["~/b"] } }]), valid: false },
  { name: "extra key in a scope object is ignored", manifest: scoped([{ "fs.read": { roots: ["~/a"], extra: true } }]), valid: true },
  { name: "bare main inside an object", manifest: scoped([{ main: true }]), valid: false },
  { name: "roots missing", manifest: scoped([{ "fs.read": {} }]), valid: false },
  { name: "roots empty", manifest: scoped([{ "fs.read": { roots: [] } }]), valid: false },
  { name: "roots too many", manifest: scoped([{ "fs.read": { roots: Array.from({ length: 33 }, (_, i) => `~/r${i}`) } }]), valid: false },
  { name: "root relative", manifest: scoped([{ "fs.read": { roots: ["caches"] } }]), valid: false },
  { name: "root UNC", manifest: scoped([{ "fs.read": { roots: ["\\\\server\\share"] } }]), valid: false },
  { name: "root double slash", manifest: scoped([{ "fs.read": { roots: ["//server/share"] } }]), valid: false },
  { name: "root with NUL", manifest: scoped([{ "fs.read": { roots: ["~/a\u0000b"] } }]), valid: false },
  { name: "root too long", manifest: scoped([{ "fs.read": { roots: [`~/${"x".repeat(1024)}`] } }]), valid: false },
  { name: "spawn allow relative", manifest: scoped([{ spawn: { allow: ["git.exe"] } }]), valid: false },
  { name: "spawn wrong key", manifest: scoped([{ spawn: { roots: ["~/bin"] } }]), valid: false },

  // Invalid: entries
  { name: "main without the main permission", manifest: { ...base, main: "main.cjs" }, valid: false },
  { name: "main traversal", manifest: { ...base, permissions: ["main"], main: "../x.js" }, valid: false },
  { name: "main absolute", manifest: { ...base, permissions: ["main"], main: "C:/x.js" }, valid: false },
  { name: "main backslash", manifest: { ...base, permissions: ["main"], main: "bin\\x.js" }, valid: false },
  { name: "main with a colon segment", manifest: { ...base, permissions: ["main"], main: "a:b.js" }, valid: false },
  { name: "main empty", manifest: { ...base, permissions: ["main"], main: "" }, valid: false },
  { name: "main leading slash", manifest: { ...base, permissions: ["main"], main: "/x.js" }, valid: false },
  { name: "main double slash", manifest: { ...base, permissions: ["main"], main: "a//b.js" }, valid: false },
  { name: "main trailing slash", manifest: { ...base, permissions: ["main"], main: "x.js/" }, valid: false },
  { name: "main dot segment", manifest: { ...base, permissions: ["main"], main: "./x.js" }, valid: false },
  { name: "main dotdot segment", manifest: { ...base, permissions: ["main"], main: "a/../x.js" }, valid: false },
  { name: "main trailing dot segment", manifest: { ...base, permissions: ["main"], main: "a./x.js" }, valid: false },
  { name: "main trailing space segment", manifest: { ...base, permissions: ["main"], main: "a /x.js" }, valid: false },
  { name: "main reserved segment", manifest: { ...base, permissions: ["main"], main: "con/x.js" }, valid: false },
  { name: "main reserved segment with extension", manifest: { ...base, permissions: ["main"], main: "NUL.txt/x.js" }, valid: false },
  { name: "main wildcard char", manifest: { ...base, permissions: ["main"], main: "a?/x.js" }, valid: false },
  { name: "main not javascript", manifest: { ...base, permissions: ["main"], main: "main.txt" }, valid: false },
  { name: "renderer html", manifest: { ...base, renderer: "r.html" }, valid: false },
  { name: "renderer backslash", manifest: { ...base, renderer: "dist\\r.js" }, valid: false },
  { name: "renderer control character", manifest: { ...base, renderer: "a\u0001.js" }, valid: false },
  { name: "renderer number", manifest: { ...base, renderer: 7 }, valid: false },
];

describe("plugin.json schema", () => {
  const ajv = new Ajv({ allErrors: true, strict: false });

  beforeAll(() => {
    expect(ajv.validateSchema(schema)).toBe(true);
  });

  function schemaValid(manifest: unknown): boolean {
    const validate = ajv.getSchema("https://t3-patcher.local/schema/plugin.schema.json") ?? ajv.compile(schema);
    return validate(manifest) === true;
  }

  it.each(cases)("$name: validator and schema both say $valid", ({ manifest, valid }) => {
    const result = validateManifest(manifest);
    expect(result.ok).toBe(valid);
    expect(schemaValid(manifest)).toBe(valid);
    if (!valid) {
      // Both sides must be able to say WHY; a schema failure produces at least one error.
      expect(result.ok ? [] : result.errors.length).toBeGreaterThan(0);
    }
  });

  it("the folder name is a validator-only rule", () => {
    expect(validateManifest(base, "other-folder").ok).toBe(false);
    expect(schemaValid(base)).toBe(true);
  });
});
