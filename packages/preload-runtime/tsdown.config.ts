import { defineConfig } from "tsdown";

// Single CJS file loaded by Electron as a sandboxed frame preload; only electron stays external.
export default defineConfig({
  entry: { preload: "src/index.ts" },
  format: ["cjs"],
  platform: "node",
  target: "node22",
  dts: false,
  sourcemap: false,
  clean: true,
  outExtensions: () => ({ js: ".cjs" }),
  deps: { neverBundle: ["electron"] },
});
