// prepack: copy the built runtime (packages/main-runtime/dist) into packages/installer/runtime so the
// published npm package carries it. Source maps and type files are left out. Run via `npm pack` / `pnpm publish`.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "..", "main-runtime", "dist");
const target = join(root, "runtime");

if (!existsSync(join(source, "main.cjs"))) {
  console.error(`stage-runtime: ${source} has no main.cjs. Build it first: pnpm --filter @t3p/main-runtime... build`);
  process.exit(1);
}
rmSync(target, { recursive: true, force: true });
cpSync(source, target, {
  recursive: true,
  filter: (file) => !/\.(map|d\.mts)$/i.test(file),
});
console.log(`stage-runtime: ${source} -> ${target}`);
