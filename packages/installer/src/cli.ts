#!/usr/bin/env node
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { doctor } from "./doctor.js";
import { devLink, devUnlink, devMarkerPath } from "./dev.js";
import { AppRunningError, T3pError } from "./errors.js";
import { install, defaultRuntimeSource } from "./install.js";
import { enable, grant, revoke, safeMode, statePath } from "./plugin-admin.js";
import { runPluginsCommand, stdinPrompt, UsageError } from "./registry-cli.js";
import { ensureLogonTask, removeLogonTask } from "./logon-task.js";
import { readManifest } from "./manifest.js";
import { repair, repairRecorded } from "./repair.js";
import { runRealMenu, wantsMenu } from "./menu-cli.js";
import { isSingleFileExe } from "./runtime-pack.js";
import { status } from "./status.js";
import type { DoctorCheck, InstallResult, StatusReport } from "./types.js";
import { uninstall } from "./uninstall.js";

declare const __T3P_VERSION__: string | undefined;
const VERSION = typeof __T3P_VERSION__ === "string" ? __T3P_VERSION__ : "dev";

const USAGE = `t3p - T3 Code patcher installer

Usage:
  t3p install   [--path DIR] [--force] [--runtime DIR] [--json]
  t3p uninstall [--path DIR] [--purge] [--json]
  t3p repair    [--path DIR] [--if-stale] [--force] [--runtime DIR] [--json]
  t3p status    [--path DIR] [--json]
  t3p doctor    [--path DIR] [--json]
  t3p plugins   [--json]                      installed plugins (= plugins list --installed)
  t3p plugins   list [--installed] [--tag T]... [--json]
  t3p plugins   search <text> [--tag T]... [--json]
  t3p plugins   info <id> [--json]
  t3p plugins   install <id> [--yes]
  t3p plugins   update <id> | --all [--yes]
  t3p plugins   uninstall <id> [--yes]
  t3p grant     <id> <permission> [--root DIR]... [--allow EXE]...
  t3p revoke    <id> <permission>
  t3p enable    <id>
  t3p disable   <id>
  t3p dev       <plugin-folder> [--json]
  t3p dev       --unlink <id> [--json]
  t3p safe      [--off]
  t3p --version
  t3p selftest

Options:
  --path DIR    T3 Code install directory (default: auto-detect)
  --force       install even when the fuses or the version are not supported
  --runtime DIR runtime folder to install instead of packages/main-runtime/dist
  --purge       uninstall: also delete ~/.t3-patcher/runtime
  --if-stale    repair: only act after an upstream update
  --json        machine-readable output
  --unlink      dev: remove the plugin's dev link instead of creating one
  --no-logon-task  install/repair: do not register the logon repair task
  --worker-node auto|copy|skip  install/repair: copy the app's Electron exe to
                ~/.t3-patcher/bin for the update repair worker (auto: only
                when there is no node.exe on PATH)
  --root DIR    grant fs.read / sqlite.read / log.tail under DIR (~ = T3P home);
                without --root/--allow the plugin's declared scope is granted
  --allow EXE   grant spawn of this absolute .exe path
  --off         safe: cancel a pending safe-mode start
  --yes, -y     plugins install/update/uninstall: do not ask
  --installed   plugins list: installed plugins instead of the registry
  --all         plugins update: every installed registry plugin with an update
  --tag T       plugins list/search: only entries with this tag (repeatable)

Permissions: main, patches, rpc, guard, embed.youtube, fs.read, sqlite.read, log.tail, spawn. A plugin
gets only what its plugin.json declares AND you grant. The app reads the state
at its next start. "t3p safe" makes the next start skip all plugins and
patches (also: T3P_SAFE=1 or --t3p-safe on the app command line).

Dev: "t3p dev <folder>" links a plugin folder into
~/.t3-patcher/plugins/<id> (junction on Windows, no admin needed), enables it
and turns hot reload on by writing ~/.t3-patcher/dev-mode. Restart T3 Code to
apply the first time; later rebuilds reload by themselves.

Registry: "t3p plugins install <id>" downloads a plugin from the registry,
checks its SHA-256 against the registry entry before unpacking, and installs it
DISABLED with NO permissions granted. Enable and grant afterwards. Plugins run
code on your PC with your user rights: install only what you trust.

Environment:
  T3P_HOME      patcher home directory (default: your OS home)
  T3P_REGISTRY_URL  plugin registry index (https); also "registryUrl" in
                ~/.t3-patcher/config.json. Default: the T3 Patcher repo's
                registry/index.json

Exit codes: 0 ok, 1 failure/unhealthy, 2 usage.`;

function usageError(message?: string): void {
  if (message) console.error(`t3p: ${message}`);
  console.error(USAGE);
  process.exitCode = 2;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printInstall(result: InstallResult): void {
  const info = result.install;
  if (result.status === "noop") {
    console.log(`Already up to date: ${info.installDir} (${info.channel}, ${info.version ?? "unknown version"})`);
  } else if (result.status === "updated") {
    const u = result.runtimeUpdate;
    console.log(`Updated runtime ${u?.from ?? "none"} -> ${u?.to ?? "?"}: ${info.installDir} (${info.channel}, ${info.version ?? "unknown version"})`);
    if (u?.shimChanged) console.log("  shim:       rewritten");
    if (result.runtime) console.log(`  runtime:    ${result.runtime.source} (${result.runtime.files} files)`);
  } else {
    console.log(`patched: ${info.installDir} (${info.channel}, ${info.version ?? "unknown version"})`);
    console.log(`  exe:        ${info.exePath}`);
    console.log(`  original:   ${result.originalAsarSha256}`);
    console.log(`  replacement:${result.replacementAsarSha256}`);
    console.log(
      result.runtime
        ? `  runtime:    ${result.runtime.source} (${result.runtime.files} files)`
        : "  runtime:    not installed",
    );
  }
  for (const warning of result.warnings) console.log(`  warning:    ${warning}`);
}

function printStatus(report: StatusReport): void {
  if (report.install) {
    console.log(`install:  ${report.install.installDir}`);
    console.log(`exe:      ${report.install.exePath}`);
    console.log(`version:  ${report.install.version ?? "unknown"} (${report.install.channel})`);
  } else {
    console.log("install:  none");
  }
  console.log(`layout:   ${report.layout}`);
  console.log(`manifest: ${report.manifestPresent ? "present" : "absent"}`);
  for (const reason of report.reasons) console.log(`  - ${reason}`);
}

function printDoctor(checks: DoctorCheck[]): void {
  for (const check of checks) {
    console.log(`${check.ok ? "ok  " : "FAIL"}  ${check.name}: ${check.detail}`);
  }
}

function registerLogonTask(skip: boolean, homeDir: string | undefined, installDir: string): string | null {
  if (skip) return null;
  const res = ensureLogonTask({ homeDir: homeDir ?? homedir(), installDir });
  return res === "registered" || res.startsWith("skipped") ? null : `logon repair task: ${res}`;
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (command === "--version" || command === "-v" || command === "version") {
    console.log(VERSION);
    return 0;
  }
  if (command === "selftest") {
    // Support aid: which runtime this binary would install, and whether it is complete.
    const source = defaultRuntimeSource();
    const ok = source !== null && existsSync(join(source, "main.cjs"));
    console.log(JSON.stringify({ version: VERSION, singleFileExe: isSingleFileExe(), runtimeSource: source ? (isSingleFileExe() ? "embedded" : source) : null, runtimeFiles: source ? readdirSync(source).length : 0, ok }));
    return ok ? 0 : 1;
  }
  if (!command && wantsMenu(argv.length)) {
    const homeForMenu = process.env.T3P_HOME || undefined;
    return runRealMenu({
      version: VERSION,
      homeDir: homeForMenu,
      afterInstall: (installDir) => registerLogonTask(false, homeForMenu, installDir),
      afterUninstall: () => {
        if (!Object.keys(readManifest(homeForMenu ?? homedir())?.installs ?? {}).length) removeLogonTask({ homeDir: homeForMenu ?? homedir() });
      },
    });
  }
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(USAGE);
    return command ? 0 : 2;
  }

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv.slice(1),
      allowPositionals: true,
      options: {
        path: { type: "string" },
        force: { type: "boolean", default: false },
        runtime: { type: "string" },
        purge: { type: "boolean", default: false },
        "if-stale": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        "worker-node": { type: "string" },
        "no-logon-task": { type: "boolean", default: false },
        root: { type: "string", multiple: true },
        allow: { type: "string", multiple: true },
        off: { type: "boolean", default: false },
        unlink: { type: "boolean", default: false },
        yes: { type: "boolean", short: "y", default: false },
        installed: { type: "boolean", default: false },
        all: { type: "boolean", default: false },
        tag: { type: "string", multiple: true },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    usageError(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const values = parsed.values as {
    path?: string;
    force: boolean;
    runtime?: string;
    purge: boolean;
    "if-stale": boolean;
    json: boolean;
    help: boolean;
    "worker-node"?: string;
    "no-logon-task": boolean;
    root?: string[];
    allow?: string[];
    off: boolean;
    unlink: boolean;
    yes: boolean;
    installed: boolean;
    all: boolean;
    tag?: string[];
  };
  const positionals = parsed.positionals;
  const takesPositionals = ["grant", "revoke", "enable", "disable", "dev", "plugins"].includes(command);
  if (!takesPositionals && positionals.length > 0) {
    usageError(`unexpected argument "${positionals[0]}"`);
    return 2;
  }
  const workerNode = values["worker-node"];
  if (workerNode !== undefined && !["auto", "copy", "skip"].includes(workerNode)) {
    usageError("--worker-node must be auto, copy or skip");
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  const homeDir = process.env.T3P_HOME || undefined;
  const path = values.path;
  const common = { homeDir, path };

  switch (command) {
    case "install": {
      const result = await install({ ...common, force: values.force, runtimeSource: values.runtime, workerNode: workerNode as "auto" | "copy" | "skip" | undefined });
      const warnLogon = registerLogonTask(values["no-logon-task"], homeDir, result.install.installDir);
      if (warnLogon) result.warnings.push(warnLogon);
      if (values.json) printJson(result);
      else printInstall(result);
      return 0;
    }
    case "uninstall": {
      await uninstall({ ...common, purge: values.purge });
      if (!Object.keys(readManifest(homeDir ?? homedir())?.installs ?? {}).length) removeLogonTask({ homeDir: homeDir ?? homedir() });
      if (values.json) printJson({ ok: true, installDir: path ?? null });
      else console.log(path ? `restored ${path}` : "restored the patched install");
      return 0;
    }
    case "repair": {
      if (values["if-stale"] && !path) {
        const recorded = await repairRecorded({ homeDir, ifStale: true, force: values.force, runtimeSource: values.runtime });
        if (recorded) {
          if (values.json) printJson(recorded.map((r) => ({ installDir: r.installDir, result: r.error ? "error" : r.result === "noop" ? "noop" : "repaired", error: r.error?.message })));
          else for (const r of recorded) console.log(r.error ? `${r.installDir}: ${r.error.message}` : `${r.installDir}: ${r.result === "noop" ? "nothing to repair" : "repaired"}`);
          return recorded.some((r) => r.error) ? 1 : 0;
        }
      }
      const result = await repair({
        ...common,
        force: values.force,
        runtimeSource: values.runtime,
        ifStale: values["if-stale"],
        workerNode: workerNode as "auto" | "copy" | "skip" | undefined,
      });
      if (values.json) printJson(result);
      else if (result === "noop") console.log("nothing to repair");
      else printInstall(result);
      return 0;
    }
    case "status": {
      const report = await status(common);
      if (values.json) printJson(report);
      else printStatus(report);
      return report.layout === "patched" || report.layout === "unpatched" ? 0 : 1;
    }
    case "doctor": {
      const result = await doctor(common);
      if (values.json) printJson(result);
      else printDoctor(result.checks);
      return result.checks.every((check) => check.ok) ? 0 : 1;
    }
    case "plugins": {
      try {
        return await runPluginsCommand(positionals, { json: values.json, yes: values.yes, installed: values.installed, all: values.all, tag: values.tag }, {
          homeDir,
          out: (line) => console.log(line),
          err: (line) => console.error(line),
          prompt: stdinPrompt,
        });
      } catch (error) {
        if (error instanceof UsageError) {
          usageError(error.message);
          return 2;
        }
        throw error;
      }
    }
    case "grant":
    case "revoke": {
      const [id, permission] = positionals;
      if (!id || !permission || positionals.length > 2) {
        usageError(`${command} needs <id> <permission>`);
        return 2;
      }
      const scope = permission === "spawn" ? (values.allow ?? []) : (values.root ?? []);
      const state = command === "grant" ? grant({ homeDir, id, permission, scope }) : revoke({ homeDir, id, permission });
      if (values.json) printJson(state.plugins[id] ?? null);
      else console.log(`${command === "grant" ? "granted" : "revoked"} ${permission} for ${id} in ${statePath(homeDir)}; restart T3 Code to apply`);
      return 0;
    }
    case "enable":
    case "disable": {
      const [id] = positionals;
      if (!id || positionals.length > 1) {
        usageError(`${command} needs <id>`);
        return 2;
      }
      enable({ homeDir, id, enabled: command === "enable" });
      if (values.json) printJson({ ok: true, id, enabled: command === "enable" });
      else console.log(`${command}d ${id}; restart T3 Code to apply`);
      return 0;
    }
    case "safe": {
      const result = safeMode({ homeDir, off: values.off });
      if (values.json) printJson(result);
      else console.log(result.pending ? `next T3 Code start runs in safe mode (no plugins, no patches): ${result.marker}` : "safe-mode request removed");
      return 0;
    }
    case "dev": {
      const [arg, ...rest] = positionals;
      if (!arg || rest.length > 0) {
        usageError(values.unlink ? "dev --unlink needs one <id>" : "dev needs one <plugin-folder>");
        return 2;
      }
      if (values.unlink) {
        const result = devUnlink(arg, { homeDir });
        if (values.json) printJson(result);
        else {
          console.log(`unlinked ${result.id}: ${result.link} removed, plugin disabled`);
          console.log(
            result.devModeOff
              ? `hot reload off: no dev links left, removed ${devMarkerPath(homeDir)}`
              : `hot reload stays on: ${devMarkerPath(homeDir)}`,
          );
        }
        return 0;
      }
      const result = devLink({ homeDir, folder: arg });
      if (values.json) printJson(result);
      else {
        console.log(`${result.changed ? "linked" : "already linked"} ${result.id}: ${result.link} -> ${result.folder}`);
        console.log(`enabled ${result.id} in ${result.stateFile}`);
        console.log(`hot reload on: ${result.marker} (T3P_DEV=1 also works)`);
        console.log("restart T3 Code; after that every build reloads the plugin");
      }
      return 0;
    }
    default:
      usageError(`unknown command "${command}"`);
      return 2;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof AppRunningError || error instanceof T3pError) {
      console.error(`t3p: ${error.message}`);
    } else if (error instanceof Error) {
      console.error(`t3p: ${error.stack ?? error.message}`);
    } else {
      console.error(`t3p: ${String(error)}`);
    }
    process.exitCode = 1;
  });
