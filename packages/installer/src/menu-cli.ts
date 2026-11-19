import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

import { findInstalls } from "./installs.js";
import { compareRuntime, install } from "./install.js";
import { parseTasklistName, parseTasklistRunning, runMenu, runningImageName, shouldShowMenu, type MenuDeps, type MenuIO } from "./menu.js";
import { repair } from "./repair.js";
import { safeMode, safeModePending } from "./plugin-admin.js";
import { status } from "./status.js";
import { uninstall } from "./uninstall.js";

/** Image name of this process's parent via tasklist (fast, no PowerShell), or null. */
export function parentProcessName(): string | null {
  if (process.platform !== "win32" || !process.ppid) return null;
  const r = spawnSync("tasklist", ["/FI", `PID eq ${process.ppid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
  return r.status === 0 ? parseTasklistName(r.stdout ?? "") : null;
}

/** True when a no-argument launch should open the guided menu (double-click from Explorer). */
export function wantsMenu(argCount: number): boolean {
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  // Skip the process lookup unless it could matter.
  const parentName = argCount === 0 && tty && process.env.T3P_MENU === undefined ? parentProcessName() : null;
  return shouldShowMenu({ argCount, stdinIsTTY: Boolean(process.stdin.isTTY), stdoutIsTTY: Boolean(process.stdout.isTTY), parentName, env: process.env });
}

function readlineIO(): MenuIO & { close(): void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  const waiting: Array<(value: string | null) => void> = [];
  rl.on("close", () => {
    closed = true;
    for (const resolve of waiting.splice(0)) resolve(null);
  });
  return {
    print: (line = "") => console.log(line),
    ask: (question) =>
      new Promise((resolve) => {
        if (closed) return resolve(null);
        waiting.push(resolve);
        rl.question(question, (answer) => {
          waiting.splice(waiting.indexOf(resolve), 1);
          resolve(answer);
        });
      }),
    close: () => rl.close(),
  };
}

export interface RealMenuOpts {
  version: string;
  homeDir: string | undefined;
  /** Registers/removes the logon repair task; provided by the cli. */
  afterInstall(installDir: string): string | null;
  afterUninstall(): void;
}

/** Runs the guided menu against the real machine. */
export async function runRealMenu(opts: RealMenuOpts): Promise<number> {
  const io = readlineIO();
  const deps: MenuDeps = {
    io,
    version: opts.version,
    findInstalls: () => findInstalls({ homeDir: opts.homeDir }),
    status: (installDir) => status({ homeDir: opts.homeDir, path: installDir }),
    isRunning: (info) => {
      const r = spawnSync("tasklist", ["/FI", `IMAGENAME eq ${runningImageName(info)}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
      return r.status === 0 && parseTasklistRunning(r.stdout ?? "", runningImageName(info));
    },
    install: async (info) => {
      const result = await install({ homeDir: opts.homeDir, path: info.installDir });
      const warn = opts.afterInstall(info.installDir);
      if (warn) result.warnings.push(warn);
      return result;
    },
    update: async (info) => {
      const result = await install({ homeDir: opts.homeDir, path: info.installDir });
      const warn = opts.afterInstall(info.installDir);
      if (warn) result.warnings.push(warn);
      return result;
    },
    runtimeOutdated: () => compareRuntime({ homeDir: opts.homeDir }).outdated,
    repair: async (info) => {
      const result = await repair({ homeDir: opts.homeDir, path: info.installDir });
      if (result !== "noop") {
        const warn = opts.afterInstall(info.installDir);
        if (warn) result.warnings.push(warn);
      }
      return result;
    },
    uninstall: async (info) => {
      await uninstall({ homeDir: opts.homeDir, path: info.installDir });
      opts.afterUninstall();
    },
    safeMode: (off) => safeMode({ homeDir: opts.homeDir, off }),
    safePending: () => safeModePending(opts.homeDir),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
  try {
    return await runMenu(deps);
  } finally {
    io.close();
  }
}
