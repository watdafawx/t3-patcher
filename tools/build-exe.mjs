// Builds dist-exe/t3p.exe: the installer CLI as a single-file Node SEA (Single Executable Application).
//
//   node tools/build-exe.mjs [--skip-build]
//
// What goes in: packages/installer/dist/standalone/t3p.cjs (the whole CLI, shim text included, no
// node_modules) as the main script, and the runtime folder (packages/main-runtime/dist) as ONE
// gzip asset ("runtime.pack.gz", see packages/installer/src/runtime-pack.ts). At run time the exe
// unpacks that asset to a temp folder when `install` needs a runtime source.
// Output: dist-exe/t3p.exe and dist-exe/t3p.exe.sha256 (sha256sum format). Why SEA: docs/release.md.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "dist-exe");
const work = join(outDir, ".work");
const installerDir = join(root, "packages", "installer");
const bundle = join(installerDir, "dist", "standalone", "t3p.cjs");
const runtimeDir = join(root, "packages", "main-runtime", "dist");
const skipBuild = process.argv.includes("--skip-build");

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: root });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status ?? r.error})`);
}

/** Runs pnpm without a shell: through the script that started us when it is pnpm, else via corepack/PATH. */
function runPnpm(args) {
  const exec = process.env.npm_execpath;
  if (exec && /pnpm/i.test(exec) && /\.c?js$/i.test(exec)) return run(process.execPath, [exec, ...args]);
  const r = spawnSync(`pnpm ${args.join(" ")}`, { stdio: "inherit", cwd: root, shell: true });
  if (r.status !== 0) throw new Error(`pnpm ${args.join(" ")} failed (${r.status ?? r.error})`);
}

if (process.platform !== "win32") console.warn("build-exe: not Windows; the output is a Node binary for this OS, not a t3p.exe");
const [major] = process.versions.node.split(".").map(Number);
if (major < 22) throw new Error(`Node 22+ needed (SEA assets), running ${process.version}`);

if (!skipBuild) runPnpm(["--filter", "@t3p/installer", "--filter", "@t3p/main-runtime...", "build"]);
for (const f of [bundle, join(runtimeDir, "main.cjs")]) {
  if (!existsSync(f)) throw new Error(`missing ${f}; run without --skip-build`);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

// 1. the runtime asset
const { packRuntime, RUNTIME_PACK_ASSET } = await import(pathToFileURL(join(installerDir, "dist", "runtime-pack.mjs")).href);
const packed = packRuntime(runtimeDir);
const assetPath = join(work, RUNTIME_PACK_ASSET);
writeFileSync(assetPath, packed.buffer);
console.log(`build-exe: runtime asset ${packed.files.length} files, ${(packed.buffer.length / 1024).toFixed(0)} KB gzip`);

// 2. the SEA blob
const seaConfig = join(work, "sea-config.json");
const blob = join(work, "sea.blob");
writeFileSync(
  seaConfig,
  JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, assets: { [RUNTIME_PACK_ASSET]: assetPath } }, null, 2),
);
run(process.execPath, ["--experimental-sea-config", seaConfig]);

// 3. copy this node binary and inject the blob
const exe = join(outDir, process.platform === "win32" ? "t3p.exe" : "t3p");
copyFileSync(process.execPath, exe);
const { inject } = await import("postject");
await inject(exe, "NODE_SEA_BLOB", readFileSync(blob), { sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2" });

// 4. checksum (sha256sum format, so `sha256sum -c` works)
const hash = createHash("sha256").update(readFileSync(exe)).digest("hex");
writeFileSync(`${exe}.sha256`, `${hash} *${exe.slice(outDir.length + 1)}\n`);
rmSync(work, { recursive: true, force: true });

// 5. smoke test: the exe starts, reports its version and finds its embedded runtime
const smoke = spawnSync(exe, ["--version"], { encoding: "utf8" });
if (smoke.status !== 0) throw new Error(`smoke test failed: ${smoke.stderr || smoke.error}`);
const self = spawnSync(exe, ["selftest"], { encoding: "utf8" });
if (self.status !== 0) throw new Error(`selftest failed (embedded runtime missing?): ${self.stdout}${self.stderr}`);
console.log(`build-exe: selftest ${self.stdout.trim()}`);
console.log(`build-exe: ${exe}`);
console.log(`build-exe: version ${smoke.stdout.trim()}, ${(statSync(exe).size / 1024 / 1024).toFixed(1)} MB, sha256 ${hash}`);
