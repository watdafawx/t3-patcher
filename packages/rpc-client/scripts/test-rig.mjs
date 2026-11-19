// Runs the rig integration test (needs rig reachable over ssh). Sets T3P_RIG_E2E=1 cross-platform.
import { spawnSync } from "node:child_process";
import process from "node:process";

const r = spawnSync("pnpm", ["exec", "vitest", "run", "test/rig.integration.test.ts", ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, T3P_RIG_E2E: "1" },
});
process.exit(r.status ?? 1);
