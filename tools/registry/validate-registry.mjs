#!/usr/bin/env node
/**
 * Checks registry/index.json (or a given file): JSON schema, https URLs, unique ids, semver,
 * sha256 format, asset names. Run in CI after `pnpm -r build` (it uses the built @t3p/api).
 *
 *   node tools/registry/validate-registry.mjs [file] [--verify-downloads] [--strict]
 *
 * --verify-downloads  download every zip (through the same capped, redirect-checked client the
 *                     installer uses) and compare size and SHA-256 with the index; then unpack it
 *                     in memory with the installer's zip reader and check plugin.json id, version
 *                     and permissions. Needs the network; a download that fails is an error.
 * --strict            treat warnings (unknown keys, asset name not t3p-plugin-<id>-<version>.zip) as errors
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { values, positionals } = parseArgs({ allowPositionals: true, options: { "verify-downloads": { type: "boolean", default: false }, strict: { type: "boolean", default: false } } });

async function load(rel) {
  const file = join(ROOT, rel);
  if (!existsSync(file)) {
    console.error(`validate-registry: ${rel} is missing; run pnpm -r build first`);
    process.exit(1);
  }
  return import(pathToFileURL(file).href);
}
const api = await load("packages/api/dist/index.mjs");

const file = resolve(positionals[0] ?? join(ROOT, "registry", "index.json"));
let raw;
try {
  raw = JSON.parse(readFileSync(file, "utf8"));
} catch (error) {
  console.error(`validate-registry: cannot read ${file}: ${error.message}`);
  process.exit(1);
}

const errors = [];
const warnings = [];
const result = api.validateRegistry(raw);
if (!result.ok) errors.push(...result.errors);
warnings.push(...result.warnings);
if (result.ok) {
  for (const e of result.index.plugins) {
    const asset = api.registryAssetName(e.id, e.version);
    if (!e.download.url.endsWith(`/${asset}`)) warnings.push(`${e.id}: download URL does not end in ${asset}`);
  }
}

if (values["verify-downloads"] && result.ok) {
  const reg = await load("packages/installer/dist/registry.mjs");
  for (const e of result.index.plugins) {
    try {
      const zip = await reg.downloadVerified(e, { registryUrl: api.DEFAULT_REGISTRY_URL });
      const files = reg.readZip(zip);
      const pj = files.find((f) => f.name === "plugin.json");
      if (!pj) throw new Error("plugin.json missing at the zip root");
      const manifest = JSON.parse(pj.data.toString("utf8"));
      if (manifest.id !== e.id) throw new Error(`plugin.json id ${manifest.id} != ${e.id}`);
      if (manifest.version !== e.version) throw new Error(`plugin.json version ${manifest.version} != ${e.version}`);
      if (!api.permissionsEqual(manifest.permissions ?? [], e.permissions)) throw new Error("plugin.json permissions differ from the index");
      console.log(`ok  ${e.id} ${e.version}  sha256 ${createHash("sha256").update(zip).digest("hex")}`);
    } catch (error) {
      errors.push(`${e.id}: ${error.message}`);
    }
  }
}

for (const w of warnings) console.warn(`warning: ${w}`);
for (const e of errors) console.error(`error: ${e}`);
const failed = errors.length > 0 || (values.strict && warnings.length > 0);
console.log(`${file}: ${result.ok ? result.index.plugins.length : "?"} plugins, ${errors.length} errors, ${warnings.length} warnings`);
process.exit(failed ? 1 : 0);
