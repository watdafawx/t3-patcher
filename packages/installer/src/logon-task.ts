import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

import { isSingleFileExe } from "./runtime-pack.js";
import { WORKER_NODE_EXE, findSystemNode } from "./worker-node.js";

/**
 * Second repair trigger: a per-user logon scheduled task that runs
 * `t3p repair --if-stale`. It covers a manual installer run (or an update that
 * happened while the app was closed), where the runtime's updater hook never
 * fired.
 *
 * Files (all outside the T3 Code install dir, so an NSIS install cannot wipe them):
 *   <home>/.t3-patcher/t3p.cjs           copy of the standalone installer bundle
 *   <home>/.t3-patcher/repair-logon.cmd  wrapper the task runs (sets T3P_HOME, picks the interpreter)
 *   <home>/.t3-patcher/logs/logon-repair.log
 */
export const DEFAULT_TASK_NAME = "t3-patcher-repair";

export interface LogonTaskOpts {
  homeDir: string;
  /** The running standalone bundle (process.argv[1]); must be a .cjs file. */
  selfPath?: string;
  /** The running single-file t3p.exe (defaults to process.execPath when running as the exe). */
  selfExe?: string;
  installDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Defaults to env T3P_TASK_NAME, then DEFAULT_TASK_NAME. */
  taskName?: string;
  /** DOMAIN\user the task is scoped to. Defaults to USERDOMAIN\USERNAME. */
  user?: string;
  /** Test seam. Returns the exit status. */
  schtasks?: (args: string[]) => { status: number | null; stderr: string };
  log?: (message: string) => void;
}

export type LogonTaskResult = "registered" | "skipped-not-windows" | "skipped-not-bundle" | "skipped-no-interpreter" | "failed" | "removed" | "absent";

function runSchtasks(args: string[]): { status: number | null; stderr: string } {
  const r = spawnSync("schtasks.exe", args, { encoding: "utf8", windowsHide: true });
  return { status: r.status, stderr: `${r.stderr ?? ""}${r.stdout ?? ""}`.trim() };
}

export function taskNameFor(opts: { env?: NodeJS.ProcessEnv; taskName?: string }): string {
  return opts.taskName ?? opts.env?.T3P_TASK_NAME ?? process.env.T3P_TASK_NAME ?? DEFAULT_TASK_NAME;
}

/** The wrapper script text. Exported for tests. */
export function buildWrapper(opts: { home: string; bundle: string; logFile: string; node: { exe: string; electron: boolean }; hasHomeOverride: boolean }): string {
  const lines = ["@echo off"];
  if (opts.hasHomeOverride) lines.push(`set "T3P_HOME=${opts.home}"`);
  if (opts.node.electron) {
    lines.push('set "ELECTRON_RUN_AS_NODE=1"', 'set "ELECTRON_NO_ASAR=1"');
  }
  lines.push(`"${opts.node.exe}" "${opts.bundle}" repair --if-stale --json >> "${opts.logFile}" 2>&1`);
  return `${lines.join("\r\n")}\r\n`;
}

const TASK_NS = "http://schemas.microsoft.com/windows/2004/02/mit/task";

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** DOMAIN\user of the account the task is scoped to. */
export function currentTaskUser(env: NodeJS.ProcessEnv): string {
  let user = env.USERNAME ?? env.USER ?? "";
  if (!user) {
    try {
      user = userInfo().username;
    } catch {
      // no passwd entry: leave empty, validateTaskXml then refuses to register
    }
  }
  const domain = env.USERDOMAIN ?? env.COMPUTERNAME ?? "";
  return domain && user ? `${domain}\\${user}` : user;
}

/**
 * Task Scheduler definition (schema 1.2) for the repair task. Replaces `schtasks /SC ONLOGON`
 * flags, which cannot scope the trigger to one user: without /RU an ONLOGON task fires for every
 * user's logon. Here the trigger and the principal both name the current user, the principal logs
 * on with the interactive token (no stored password, no prompt) at the lowest run level, and the
 * task is Hidden (not listed in the Task Scheduler UI by default).
 */
export function buildTaskXml(opts: { taskName: string; user: string; command: string }): string {
  const user = xmlEscape(opts.user);
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    `<Task version="1.2" xmlns="${TASK_NS}">`,
    "  <RegistrationInfo>",
    "    <Description>T3 Patcher: re-applies the patcher layout after a T3 Code update (t3p repair --if-stale).</Description>",
    `    <URI>\\${xmlEscape(opts.taskName)}</URI>`,
    "  </RegistrationInfo>",
    "  <Triggers>",
    "    <LogonTrigger>",
    "      <Enabled>true</Enabled>",
    `      <UserId>${user}</UserId>`,
    "    </LogonTrigger>",
    "  </Triggers>",
    "  <Principals>",
    '    <Principal id="Author">',
    `      <UserId>${user}</UserId>`,
    "      <LogonType>InteractiveToken</LogonType>",
    "      <RunLevel>LeastPrivilege</RunLevel>",
    "    </Principal>",
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <AllowHardTerminate>true</AllowHardTerminate>",
    "    <StartWhenAvailable>true</StartWhenAvailable>",
    "    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
    "    <AllowStartOnDemand>true</AllowStartOnDemand>",
    "    <Enabled>true</Enabled>",
    "    <Hidden>true</Hidden>",
    "    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>",
    "    <Priority>7</Priority>",
    "  </Settings>",
    '  <Actions Context="Author">',
    "    <Exec>",
    `      <Command>${xmlEscape(opts.command)}</Command>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ].join("\r\n");
}

function tagValues(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, "g"))].map((m) => m[1] ?? "");
}

/**
 * Checks a task definition against the constraints the repair task relies on. Returns the problems
 * (empty = valid). Not a full XSD validation: it pins the elements that matter for safety.
 */
export function validateTaskXml(xml: string): string[] {
  const problems: string[] = [];
  const one = (tag: string): string | undefined => tagValues(xml, tag)[0];
  if (!new RegExp(`<Task\\b[^>]*xmlns="${TASK_NS.replace(/\./g, "\\.")}"`).test(xml)) problems.push("root <Task> must use the 2004/02/mit/task namespace");
  if (!/<Task\b[^>]*\bversion="1\.[2-9]"/.test(xml)) problems.push('<Task> version must be "1.2" or later');
  const triggers = xml.match(/<Triggers>([\s\S]*?)<\/Triggers>/)?.[1] ?? "";
  const kinds = [...triggers.matchAll(/<([A-Za-z]+Trigger)\b/g)].map((m) => m[1]);
  if (kinds.length !== 1 || kinds[0] !== "LogonTrigger") problems.push(`trigger must be exactly one LogonTrigger (found: ${kinds.join(", ") || "none"})`);
  const trigger = triggers.match(/<LogonTrigger>([\s\S]*?)<\/LogonTrigger>/)?.[1] ?? "";
  const triggerUser = tagValues(trigger, "UserId")[0];
  if (!triggerUser) problems.push("LogonTrigger must be scoped with <UserId> (otherwise it fires for every user)");
  const principalUser = tagValues(xml.match(/<Principal\b[\s\S]*?<\/Principal>/)?.[0] ?? "", "UserId")[0];
  if (!principalUser) problems.push("Principal must name a <UserId>");
  else if (triggerUser && triggerUser.toLowerCase() !== principalUser.toLowerCase()) problems.push("LogonTrigger user and Principal user differ");
  if (one("LogonType") !== "InteractiveToken") problems.push("LogonType must be InteractiveToken (no stored password, no prompt)");
  if (one("RunLevel") !== "LeastPrivilege") problems.push("RunLevel must be LeastPrivilege (no elevation)");
  if (/<Password>/.test(xml) || /S4U|Password<\/LogonType>/.test(xml)) problems.push("no password logon types allowed");
  if (one("Hidden") !== "true") problems.push("Settings/Hidden must be true");
  if (one("Enabled") === "false") problems.push("task must be enabled");
  const limit = one("ExecutionTimeLimit");
  if (!limit || limit === "PT0S") problems.push("ExecutionTimeLimit must be set (a stuck repair must not run forever)");
  if (!one("Command")) problems.push("Exec/Command is required");
  if ((xml.match(/<Exec>/g) ?? []).length !== 1) problems.push("exactly one <Exec> action is required");
  return problems;
}

/** Compact summary of a valid task definition, for `t3p doctor`. */
export function describeTaskXml(xml: string): string {
  const user = tagValues(xml, "UserId")[0] ?? "?";
  return `LogonTrigger for ${user}, ${tagValues(xml, "LogonType")[0] ?? "?"}, ${tagValues(xml, "RunLevel")[0] ?? "?"}, Hidden=${tagValues(xml, "Hidden")[0] ?? "?"}, runs ${tagValues(xml, "Command")[0] ?? "?"}`;
}

export function taskXmlPath(homeDir: string): string {
  return join(homeDir, ".t3-patcher", "repair-task.xml");
}

export function ensureLogonTask(opts: LogonTaskOpts): LogonTaskResult {
  const log = opts.log ?? (() => {});
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return "skipped-not-windows";
  const env = opts.env ?? process.env;
  const root = join(opts.homeDir, ".t3-patcher");
  const exe = opts.selfExe ?? (isSingleFileExe() ? process.execPath : undefined);
  if (exe) {
    // Single-file t3p.exe: it runs by itself, no Node needed. Keep a copy outside the install dir.
    mkdirSync(join(root, "logs"), { recursive: true });
    const copy = join(root, "t3p.exe");
    try {
      copyFileSync(exe, copy);
    } catch (error) {
      if (!existsSync(copy)) {
        log(`logon task skipped: cannot copy t3p.exe (${error instanceof Error ? error.message : String(error)})`);
        return "failed";
      }
    }
    const wrapper = join(root, "repair-logon.cmd");
    const lines = ["@echo off"];
    if (env.T3P_HOME) lines.push(`set "T3P_HOME=${opts.homeDir}"`);
    lines.push(`"${copy}" repair --if-stale --json >> "${join(root, "logs", "logon-repair.log")}" 2>&1`);
    writeFileSync(wrapper, `${lines.join("\r\n")}\r\n`);
    return registerFromXml(opts, env, wrapper, log);
  }
  const self = opts.selfPath ?? process.argv[1];
  if (!self || !/\.cjs$/i.test(self) || !existsSync(self)) {
    log("logon task skipped: not running from the standalone t3p.cjs bundle");
    return "skipped-not-bundle";
  }
  const binDir = join(root, "bin");
  const system = findSystemNode(env, opts.installDir ?? "");
  const copy = join(binDir, WORKER_NODE_EXE);
  const node = system ? { exe: system, electron: false } : existsSync(copy) ? { exe: copy, electron: true } : null;
  if (!node) {
    log("logon task skipped: no node.exe on PATH and no worker interpreter copy");
    return "skipped-no-interpreter";
  }
  mkdirSync(join(root, "logs"), { recursive: true });
  const bundle = join(root, "t3p.cjs");
  copyFileSync(self, bundle);
  const wrapper = join(root, "repair-logon.cmd");
  writeFileSync(
    wrapper,
    buildWrapper({ home: opts.homeDir, bundle, logFile: join(root, "logs", "logon-repair.log"), node, hasHomeOverride: Boolean(env.T3P_HOME) }),
  );
  return registerFromXml(opts, env, wrapper, log);
}

/** Registers the logon task from a generated, validated XML definition (shared by the exe and bundle routes). */
function registerFromXml(opts: LogonTaskOpts, env: NodeJS.ProcessEnv, wrapper: string, log: (message: string) => void): LogonTaskResult {
  const name = taskNameFor(opts);
  const xml = buildTaskXml({ taskName: name, user: opts.user ?? currentTaskUser(env), command: wrapper });
  const problems = validateTaskXml(xml);
  if (problems.length > 0) {
    log(`logon task not registered, generated definition is invalid: ${problems.join("; ")}`);
    return "failed";
  }
  // schtasks /XML wants UTF-16 with a BOM.
  writeFileSync(taskXmlPath(opts.homeDir), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]));
  const r = (opts.schtasks ?? runSchtasks)(["/Create", "/TN", name, "/XML", taskXmlPath(opts.homeDir), "/F"]);
  if (r.status !== 0) {
    log(`logon task registration failed: ${r.stderr}`);
    return "failed";
  }
  log(`logon task ${name} registered -> ${wrapper}`);
  return "registered";
}

export function removeLogonTask(opts: LogonTaskOpts): LogonTaskResult {
  if ((opts.platform ?? process.platform) !== "win32") return "skipped-not-windows";
  const name = taskNameFor(opts);
  const r = (opts.schtasks ?? runSchtasks)(["/Delete", "/TN", name, "/F"]);
  const root = join(opts.homeDir, ".t3-patcher");
  for (const f of ["t3p.cjs", "t3p.exe", "repair-logon.cmd", "repair-task.xml"]) {
    try {
      rmSync(join(root, f), { force: true });
    } catch {
      // a copy that is running right now cannot be deleted; harmless
    }
  }
  return r.status === 0 ? "removed" : "absent";
}
