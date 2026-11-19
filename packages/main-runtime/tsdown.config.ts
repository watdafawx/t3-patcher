import { defineConfig, type UserConfig } from "tsdown";

// Two separate single-file CJS bundles (no shared chunks): main.cjs is what the
// shim requires, repair-worker.cjs runs detached under plain node / Electron-as-node.
// Only electron (and Electron's original-fs, used by @electron/asar) stay external.
const common: UserConfig = {
  format: ["cjs"],
  platform: "node",
  target: "node22",
  dts: false,
  sourcemap: false,
  shims: true,
  outExtensions: () => ({ js: ".cjs" }),
  deps: { neverBundle: ["electron", "original-fs"] },
};

export default defineConfig([
  { ...common, entry: { main: "src/index.ts" }, clean: true },
  { ...common, entry: { "repair-worker": "src/repair-worker.ts" }, clean: false },
  {
    // Read by tools/compat so the checker runs the same capture patches the
    // runtime ships instead of a copy. ESM and electron-free on purpose.
    entry: { "patch-catalog": "src/patches/captures.ts" },
    format: ["esm"],
    platform: "node",
    target: "node22",
    dts: true,
    sourcemap: false,
    clean: false,
    outExtensions: () => ({ js: ".mjs", dts: ".d.mts" }),
  },
  {
    // Same for the server-side turn guard patch (WP-6C), read by tools/compat.
    entry: { "server-patch-catalog": "src/guard/server-patch.ts" },
    format: ["esm"],
    platform: "node",
    target: "node22",
    dts: true,
    sourcemap: false,
    clean: false,
    outExtensions: () => ({ js: ".mjs", dts: ".d.mts" }),
  },
  {
    // Preloaded into the T3 server process (`--import`), see src/guard/server-hook.ts. Self-contained ESM.
    entry: { "server-hook": "src/guard/server-hook.ts" },
    format: ["esm"],
    platform: "node",
    target: "node22",
    dts: false,
    sourcemap: false,
    clean: false,
    outExtensions: () => ({ js: ".mjs" }),
    deps: { neverBundle: ["electron", "original-fs"] },
  },
]);
