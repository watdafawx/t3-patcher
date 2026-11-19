// Copies the preload and renderer bundles and the sqlite query worker next to main.cjs so dist/ is the
// complete runtime folder the installer copies to <home>/.t3-patcher/runtime.
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const assets = [
  [join(root, "..", "preload-runtime", "dist", "preload.cjs"), join(root, "dist", "preload.cjs")],
  [join(root, "..", "renderer-runtime", "dist", "renderer.js"), join(root, "dist", "renderer.js")],
  [join(root, "src", "native", "sqlite-worker.cjs"), join(root, "dist", "sqlite-worker.cjs")],
];
let missing = 0;
for (const [from, to] of assets) {
  if (!existsSync(from)) {
    console.error(`copy-assets: missing ${from} (build that package first)`);
    missing++;
    continue;
  }
  copyFileSync(from, to);
  console.log(`copy-assets: ${to}`);
}
process.exitCode = missing ? 1 : 0;
