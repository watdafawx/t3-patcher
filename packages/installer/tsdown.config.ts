import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };
const define = { __T3P_VERSION__: JSON.stringify(pkg.version) };

export default defineConfig([
  {
    entry: ["src/index.ts", "src/cli.ts", "src/runtime-pack.ts"],
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    define,
    // The shim text and the state helpers are embedded in the CLI, not loaded from node_modules at runtime.
    deps: { alwaysBundle: ["@t3p/shim", "@t3p/api"] },
    outExtensions: () => ({ js: ".mjs", dts: ".d.mts" }),
  },
  {
    // dist/standalone/t3p.cjs: the whole CLI in one file (no node_modules), used
    // by tools/rig/patch-slot.ps1 and as the main script of the single-file t3p.exe.
    entry: { t3p: "src/cli.ts" },
    outDir: "dist/standalone",
    format: ["cjs"],
    platform: "node",
    target: "node22",
    shims: true,
    clean: false,
    dts: false,
    define,
    deps: { alwaysBundle: [/.*/], neverBundle: ["original-fs", "electron"] },
    outExtensions: () => ({ js: ".cjs" }),
  },
]);
