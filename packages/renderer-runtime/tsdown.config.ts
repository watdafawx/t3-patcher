import { defineConfig } from "tsdown";

// Classic IIFE served at t3code://app/__t3p/renderer.js and injected before the app's first script.
export default defineConfig({
  entry: { renderer: "src/index.ts" },
  format: ["iife"],
  platform: "browser",
  target: "es2022",
  dts: false,
  sourcemap: false,
  clean: true,
  outputOptions: { entryFileNames: "[name].js" },
});
