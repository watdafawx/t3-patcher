import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/index.ts", "src/cli.ts"],
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    // The shim text and the state helpers are embedded in the CLI, not loaded from node_modules at runtime.
    deps: { alwaysBundle: ["@t3p/shim", "@t3p/api"] },
    outExtensions: () => ({ js: ".mjs", dts: ".d.mts" }),
  },
  {
    // dist/standalone/t3p.cjs: the whole CLI in one file (no node_modules), used
    // by tools/rig/patch-slot.ps1 to run the real installer ON rig.
    entry: { t3p: "src/cli.ts" },
    outDir: "dist/standalone",
    format: ["cjs"],
    platform: "node",
    target: "node22",
    shims: true,
    clean: false,
    dts: false,
    deps: { alwaysBundle: [/.*/], neverBundle: ["original-fs", "electron"] },
    outExtensions: () => ({ js: ".cjs" }),
  },
]);
