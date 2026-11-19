/**
 * Detached repair worker (dist/repair-worker.cjs, copied to
 * <home>/.t3-patcher/runtime/). Started by the updater hook right before an
 * NSIS update replaces the install dir; re-applies the patched layout with
 * the bundled installer once the update has landed. Logs to
 * <home>/.t3-patcher/logs/repair.log.
 *
 *   node repair-worker.cjs --install-dir DIR --pid N
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { AppRunningError, repair, status } from "t3-patcher";

import { createFileLogger } from "./log.js";
import { resolvePaths } from "./paths.js";
import { runRepairLoop } from "./updater/worker-core.js";

async function main(): Promise<number> {
  // Under Electron-as-node (bin/t3p-node.exe) fs treats *.asar as archives:
  // stat/read of resources/app.asar fails with "ENOENT, not found in ...app.asar"
  // (measured on rig). The installer needs the plain files.
  if (process.versions.electron) (process as NodeJS.Process & { noAsar?: boolean }).noAsar = true;
  const paths = resolvePaths();
  const log = createFileLogger({ dir: paths.logs, file: "repair.log" });
  let values: { "install-dir"?: string; pid?: string };
  try {
    values = parseArgs({ options: { "install-dir": { type: "string" }, pid: { type: "string" } }, strict: true }).values;
  } catch (error) {
    log.error("bad arguments", error);
    return 2;
  }
  const installDir = values["install-dir"];
  const pid = Number(values.pid);
  if (!installDir || !Number.isSafeInteger(pid)) {
    log.error("usage: repair-worker --install-dir DIR --pid N");
    return 2;
  }
  log.info(`repair worker started (pid ${process.pid}) for ${installDir}, waiting for app pid ${pid}`);
  const opts = { path: installDir, homeDir: paths.home, log: (m: string) => log.info(`installer: ${m}`) };
  const outcome = await runRepairLoop(
    {
      log,
      pidAlive: (p) => {
        try {
          process.kill(p, 0);
          return true;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "EPERM";
        }
      },
      layout: async () => {
        const report = await status(opts);
        let fingerprint: string | null = null;
        try {
          const st = statSync(join(installDir, "resources", "app.asar"));
          fingerprint = `${st.size}:${st.mtimeMs}`;
        } catch {
          fingerprint = null;
        }
        return { state: report.layout, fingerprint };
      },
      repair: async () => {
        try {
          const result = await repair({ ...opts, ifStale: true, skipRuntime: true });
          return result === "noop" ? "noop" : "repaired";
        } catch (error) {
          if (error instanceof AppRunningError) return "busy";
          throw error;
        }
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
    },
    { pid },
  );
  log.info(`repair worker finished: ${outcome}`);
  return outcome === "repaired" || outcome === "already-patched" ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    process.exitCode = 1;
  },
);
