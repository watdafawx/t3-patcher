import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "neutral",
  dts: true,
  sourcemap: true,
  clean: true,
  // type-only package; never inline its 11 MB of declarations
  deps: { neverBundle: ["@t3p/contracts-vendor"] },
});
