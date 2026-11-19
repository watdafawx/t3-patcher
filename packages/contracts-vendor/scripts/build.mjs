#!/usr/bin/env node
// Builds the TYPE-ONLY vendor of upstream packages/contracts (see README.md).
//   node scripts/build.mjs [--upstream <path>] [--skip-tsc]
// 1. copies upstream src (no tests) to dist/_src
// 2. tsc --emitDeclarationOnly -> dist/ (dist/index.d.ts is the entry)
// 3. writes UPSTREAM.json and dist/methods.json, compares with the WP-0D fixture
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { fileURLToPath } from "node:url";
import { excludeModules, patches } from "./vendor-patches.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..");
const repo = path.resolve(pkg, "../..");
const argv = process.argv.slice(2);
const argOf = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);

// Worktrees do not have .upstream (gitignored); fall back to the main checkout location.
const candidates = [argOf("--upstream"), process.env.T3P_UPSTREAM, path.join(repo, ".upstream"), "X:/Dev/T3-Patcher/.upstream"].filter(Boolean);
const upstream = candidates.find((c) => existsSync(path.join(c, "packages/contracts/src/index.ts")));
if (!upstream) {
  console.error("upstream checkout not found; tried:\n  " + candidates.join("\n  "));
  process.exit(1);
}
const srcDir = path.join(upstream, "packages/contracts/src");

// Tag and commit come from docs/upstream-version.md (single source of truth).
const doc = readFileSync(path.join(repo, "docs/upstream-version.md"), "utf8");
const tag = doc.match(/\|\s*Tag\s*\|\s*`([^`]+)`/)?.[1];
const commit = doc.match(/\|\s*Commit\s*\|\s*`([0-9a-f]{40})`/)?.[1];
if (!tag || !commit) {
  console.error("cannot read tag/commit from docs/upstream-version.md");
  process.exit(1);
}
const head = spawnSync("git", ["-C", upstream, "rev-parse", "HEAD"], { encoding: "utf8" });
if (head.status === 0 && head.stdout.trim() !== commit) {
  console.error(`upstream HEAD ${head.stdout.trim()} != docs/upstream-version.md ${commit}`);
  process.exit(1);
}

const buildDir = path.join(pkg, "dist/_src");
const dist = path.join(pkg, "dist");
rmSync(buildDir, { recursive: true, force: true });
rmSync(dist, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });
cpSync(srcDir, buildDir, { recursive: true, filter: (s) => !/\.test\.tsx?$/.test(s) });

for (const m of excludeModules) {
  rmSync(path.join(buildDir, m));
  const idx = path.join(buildDir, "index.ts");
  const t = readFileSync(idx, "utf8");
  const line = `export * from "./${m}";`;
  if (!t.includes(line)) { console.error("index.ts has no export for excluded module " + m); process.exit(1); }
  writeFileSync(idx, t.replace(line, ""));
}
for (const p of patches) {
  const f = path.join(buildDir, p.file);
  const text = readFileSync(f, "utf8");
  const n = text.split(p.find).length - 1;
  if (n !== 1) {
    console.error(`vendor patch for ${p.file} matched ${n} times (need exactly 1): ${p.find.slice(0, 80)}`);
    process.exit(1);
  }
  writeFileSync(f, text.replace(p.find, () => p.replace));
}

if (!argv.includes("--skip-tsc")) {
  const tsc = path.join(pkg, "node_modules/typescript/bin/tsc");
  const r = spawnSync(process.execPath, [tsc, "-p", path.join(pkg, "tsconfig.vendor.json")], { cwd: pkg, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
rmSync(buildDir, { recursive: true, force: true }); // keep dist/ to .d.ts only
mkdirSync(dist, { recursive: true });

// --- RPC methods (same extraction as docs/spikes/wp-0d/list-methods.mjs) ---
const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
const maps = {};
for (const f of files) {
  const s = readFileSync(path.join(srcDir, f), "utf8");
  for (const m of s.matchAll(/export const (\w*WS_METHODS|\w*_METHODS)\s*=\s*\{([\s\S]*?)\}\s*as const/g)) {
    for (const e of m[2].matchAll(/(\w+):\s*"([^"]+)"/g)) maps[`${m[1]}.${e[1]}`] = e[2];
  }
}
const methods = {};
for (const f of files) {
  const s = readFileSync(path.join(srcDir, f), "utf8");
  for (const p of s.split(/Rpc\.make\(/).slice(1)) {
    const head = p.slice(0, 80).match(/^\s*(\w+)\.(\w+)/);
    const body = p.split(/\n(?:export )?const /)[0];
    const kind = /stream:\s*true/.test(body) ? "stream" : "unary";
    const wire = head ? maps[`${head[1]}.${head[2]}`] : p.match(/^\s*"([^"]+)"/)?.[1];
    if (wire) methods[wire] = { tag: wire, kind };
  }
}
const list = Object.values(methods).sort((a, b) => a.tag.localeCompare(b.tag));
writeFileSync(path.join(dist, "methods.json"), JSON.stringify({ tag, commit, count: list.length, streams: list.filter((m) => m.kind === "stream").length, methods: list }, null, 1) + "\n");

// --- compare with WP-0D fixture ---
const fixturePath = path.join(repo, "docs/spikes/wp-0d/fixtures/methods.json");
if (existsSync(fixturePath)) {
  const fx = JSON.parse(readFileSync(fixturePath, "utf8"));
  const a = new Map(fx.methods.map((m) => [m.name, m.stream ? "stream" : "unary"]));
  const b = new Map(list.map((m) => [m.tag, m.kind]));
  const onlyFx = [...a.keys()].filter((k) => !b.has(k));
  const onlyNew = [...b.keys()].filter((k) => !a.has(k));
  const kindDiff = [...a.keys()].filter((k) => b.has(k) && b.get(k) !== a.get(k));
  console.log(`methods.json: ${list.length} methods, ${list.filter((m) => m.kind === "stream").length} streams (fixture: ${fx.count}/${fx.streams}); only in fixture: ${onlyFx.length}, only in new: ${onlyNew.length}, kind differs: ${kindDiff.length}`);
  for (const k of onlyFx) console.log("  only in fixture:", k);
  for (const k of onlyNew) console.log("  only in new:", k);
  for (const k of kindDiff) console.log("  kind differs:", k, a.get(k), "->", b.get(k));
}

writeFileSync(path.join(pkg, "UPSTREAM.json"), JSON.stringify({ tag, commit, builtAt: new Date().toISOString() }, null, 2) + "\n");
console.log(`contracts-vendor built from ${tag} (${commit.slice(0, 7)}) -> dist/`);
