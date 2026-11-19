import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Tests normalize fixtures with the real normalizer; use its source so no build order is needed.
      "@t3p/timeline": fileURLToPath(new URL("../../packages/timeline/src/index.ts", import.meta.url)),
    },
  },
  test: { include: ["test/**/*.test.ts"] },
});
