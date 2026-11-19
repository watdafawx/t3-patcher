#!/usr/bin/env node
/**
 * Builds the plugin registry from plugins/*: one deterministic zip per plugin plus index.json.
 * Run after `pnpm -r build` (it reads each plugin's built dist/ and the built @t3p/api and
 * t3-patcher/registry modules). See docs/registry.md and docs/release.md.
 *
 *   node tools/registry/build-registry.mjs [--out dist-registry] [--version 0.1.2]
 *        [--repo watdafawx/t3-patcher] [--base-url <url>] [--write-index] [--only id,id]
 *
 * --out          folder for the zips and index.json (default dist-registry)
 * --version      release version; download URLs point at release tag v<version>
 *                (default: packages/installer/package.json version)
 * --repo         GitHub owner/name for the download and homepage URLs
 * --base-url     use <base-url>/<asset> as download URL instead of the GitHub release (local test registries)
 * --write-index  also write registry/index.json in the repo (commit-ready; never pushed by this script)
 * --only         build only these plugin ids
 *
 * A zip holds plugin.json, README*, LICENSE*, dist/** (no source maps), assets/**, and the root
 * *.cjs / *.ps1 files a main-process plugin loads (media). Never node_modules, src or tests.
 * Folders starting with "_" (samples) are skipped. Curated fields (tags, homepage, icon,
 * screenshots, author, license) are kept from the existing registry/index.json entry.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const { values } = parseArgs({
  options: {
    out: { type: "string", default: "dist-registry" },
    version: { type: "string" },
    repo: { type: "string", default: "watdafawx/t3-patcher" },
    "base-url": { type: "string" },
    "write-index": { type: "boolean", default: false },
    only: { type: "string" },
  },
});

async function load(rel) {
  const file = join(ROOT, rel);
  if (!existsSync(file)) {
    console.error(`build-registry: ${rel} is missing; run pnpm -r build first`);
    process.exit(1);
  }
  return import(pathToFileURL(file).href);
}

const api = await load("packages/api/dist/index.mjs");
const reg = await load("packages/installer/dist/registry.mjs");

/** Default tags for the first-party plugins (the index's own tags win when present). */
const DEFAULT_TAGS = {
  artwork: ["appearance", "ui"],
  "cache-watch": ["usage", "status-bar"],
  devtools: ["developer", "logs"],
  "keep-warm": ["usage", "cache"],
  media: ["media", "youtube"],
  notes: ["productivity", "ui"],
  "provider-limits": ["usage", "providers"],
  "provider-switcher": ["providers", "ui"],
  "session-inspector": ["developer", "sessions"],
};

const version = values.version ?? JSON.parse(readFileSync(join(ROOT, "packages/installer/package.json"), "utf8")).version;
if (!api.isSemver(version)) throw new Error(`--version ${version} is not semver`);
const repo = values.repo;
const outDir = resolve(ROOT, values.out);
const only = values.only ? new Set(values.only.split(",").map((s) => s.trim())) : null;
const indexPath = join(ROOT, "registry", "index.json");
const previous = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) : { plugins: [] };
const curated = new Map((previous.plugins ?? []).map((e) => [e.id, e]));
const license = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).license;

function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full, base));
    else if (st.isFile()) out.push(relative(base, full).split("\\").join("/"));
  }
  return out;
}

/** The files that go into a plugin's zip (relative, forward slashes). */
export function zipFileList(pluginDir, manifest) {
  const files = new Set(["plugin.json"]);
  for (const name of readdirSync(pluginDir)) {
    const full = join(pluginDir, name);
    if (!statSync(full).isFile()) continue;
    if (/^(README|LICENSE|NOTICE)(\.[a-z]+)?$/i.test(name)) files.add(name);
    if (/\.(cjs|ps1)$/i.test(name)) files.add(name);
  }
  for (const sub of ["dist", "assets"]) {
    if (!existsSync(join(pluginDir, sub))) continue;
    for (const f of walk(join(pluginDir, sub))) if (!f.endsWith(".map")) files.add(`${sub}/${f}`);
  }
  for (const entry of [manifest.main, manifest.renderer]) {
    if (entry && !files.has(entry)) throw new Error(`${manifest.id}: entry ${entry} is not in the zip (build the plugin first?)`);
  }
  return [...files].sort();
}

const pluginsDir = join(ROOT, "plugins");
const ids = readdirSync(pluginsDir)
  .filter((name) => !name.startsWith("_") && existsSync(join(pluginsDir, name, "plugin.json")))
  .filter((name) => !only || only.has(name))
  .sort();

mkdirSync(outDir, { recursive: true });
const entries = [];
for (const id of ids) {
  const dir = join(pluginsDir, id);
  const raw = JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8"));
  const check = api.validateManifest(raw, id);
  if (!check.ok) throw new Error(`${id}: invalid plugin.json: ${check.errors.join("; ")}`);
  const files = zipFileList(dir, raw);
  const zip = reg.writeZip(files.map((name) => ({ name, data: readFileSync(join(dir, ...name.split("/"))) })));
  // Same reader and limits the installer uses.
  const back = reg.readZip(zip);
  if (back.length !== files.length) throw new Error(`${id}: zip round trip lost files`);
  const asset = api.registryAssetName(id, raw.version);
  writeFileSync(join(outDir, asset), zip);
  const sha256 = createHash("sha256").update(zip).digest("hex");
  const old = curated.get(id) ?? {};
  const homepage = old.homepage ?? `https://github.com/${repo}/tree/main/plugins/${id}`;
  const url = values["base-url"] ? `${values["base-url"].replace(/\/+$/, "")}/${asset}` : `https://github.com/${repo}/releases/download/v${version}/${asset}`;
  const entry = {
    id,
    name: raw.name ?? id,
    description: raw.description ?? old.description ?? raw.name ?? id,
    author: old.author ?? "T3 Patcher",
    homepage,
    source: old.source ?? `https://github.com/${repo}/tree/main/plugins/${id}`,
    license: old.license ?? license,
    version: raw.version,
    apiVersion: raw.t3pApi ?? "1",
    permissions: raw.permissions,
    tags: old.tags ?? DEFAULT_TAGS[id] ?? [],
    ...(old.icon ? { icon: old.icon } : {}),
    ...(old.screenshots ? { screenshots: old.screenshots } : {}),
    ...(old.minRuntime ? { minRuntime: old.minRuntime } : {}),
    download: { url, sha256, size: zip.length },
  };
  entries.push(entry);
  console.log(`${asset}  ${zip.length} bytes  ${files.length} files  sha256 ${sha256}`);
}

// Entries this run did not rebuild (--only, or third-party entries) stay as they are.
for (const old of previous.plugins ?? []) if (!entries.some((e) => e.id === old.id)) entries.push(old);
entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const index = { schemaVersion: api.REGISTRY_SCHEMA_VERSION, plugins: entries };
const result = api.validateRegistry(index, { allowInsecureLocal: Boolean(values["base-url"]) });
if (!result.ok) throw new Error(`generated index is invalid:\n  ${result.errors.join("\n  ")}`);
const text = `${JSON.stringify(index, null, 2)}\n`;
writeFileSync(join(outDir, "index.json"), text);
console.log(`index.json  ${entries.length} plugins  -> ${relative(ROOT, outDir) || "."}`);
if (values["write-index"]) {
  if (values["base-url"]) throw new Error("--write-index with --base-url would commit test URLs; refusing");
  writeFileSync(indexPath, text);
  console.log("registry/index.json updated (commit it; this script never pushes)");
}
