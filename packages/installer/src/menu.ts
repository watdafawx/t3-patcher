import { basename } from "node:path";

import { AppRunningError, T3pError } from "./errors.js";
import { SUPPORTED_VERSIONS, type Channel, type InstallInfo, type InstallResult, type Layout, type StatusReport } from "./types.js";

/**
 * Guided console menu for `t3p.exe` double-clicked from Explorer.
 * Everything here is pure or takes its side effects through MenuDeps, so tests
 * drive it with scripted answers. The real wiring is in menu-cli.ts.
 */

export type MenuAction = "install" | "update" | "repair" | "uninstall" | "safe" | "quit";

export interface MenuOption {
  action: MenuAction;
  /** Shortcut letter, shown as [I]. */
  key: string;
  label: string;
  hint: string;
  recommended: boolean;
}

export interface Compat {
  level: "ok" | "untested" | "unknown";
  text: string;
}

/** Is this T3 Code version one the patcher is tested against? */
export function compatibility(version: string | null, supported: readonly string[] = SUPPORTED_VERSIONS): Compat {
  if (!version) return { level: "unknown", text: "unknown version (the patcher cannot tell if it is compatible)" };
  if (supported.includes(version)) return { level: "ok", text: `compatible (tested with ${version})` };
  return {
    level: "untested",
    text: `not tested (the patcher supports ${supported.join(", ")}); Install may stop and ask for --force from a terminal`,
  };
}

const CHANNEL_NAMES: Record<Channel, string> = {
  stable: "T3 Code",
  beta: "T3 Code (Beta)",
  nightly: "T3 Code (Nightly)",
  unknown: "T3 Code",
};

export function channelName(channel: Channel): string {
  return CHANNEL_NAMES[channel];
}

/** Plain-English patcher status for one layout. */
export function describeLayout(layout: Layout): string {
  switch (layout) {
    case "patched":
      return "installed and healthy";
    case "unpatched":
      return "not installed (stock app)";
    case "stale":
      return "needs repair (an app update removed the patcher)";
    case "broken":
      return "damaged (use Repair, or Uninstall to get the stock app back)";
    default:
      return "unknown";
  }
}

/** Which choices make sense for this layout, in display order. */
export function menuOptions(layout: Layout, safePending = false, runtimeOutdated = false): MenuOption[] {
  const update: MenuOption = {
    action: "update",
    key: "P",
    label: "Update",
    hint: runtimeOutdated ? "a newer patcher runtime is bundled: refresh it (plugins and settings are kept)" : "refresh the patcher runtime from this program (does nothing when already up to date)",
    recommended: runtimeOutdated,
  };
  const install: MenuOption = { action: "install", key: "I", label: "Install", hint: "add the patcher and plugins to T3 Code", recommended: layout === "unpatched" };
  const repair: MenuOption = {
    action: "repair",
    key: "R",
    label: "Repair",
    hint: layout === "patched" ? "check the patcher and fix it if needed (does nothing when all is healthy)" : "fix the patcher after an app update or a problem",
    recommended: layout === "stale" || layout === "broken",
  };
  const uninstall: MenuOption = { action: "uninstall", key: "U", label: "Uninstall", hint: "restore the original T3 Code exactly as it was", recommended: false };
  const safe: MenuOption = {
    action: "safe",
    key: "S",
    label: safePending ? "Cancel safe mode" : "Safe mode",
    hint: safePending
      ? "T3 Code will start normally again"
      : "next T3 Code start skips all plugins and patches (use if something breaks)",
    recommended: false,
  };
  const quit: MenuOption = { action: "quit", key: "Q", label: "Quit", hint: "close this window", recommended: false };
  switch (layout) {
    case "unpatched":
      return [install, quit];
    case "patched":
      return [update, repair, uninstall, safe, quit];
    case "stale":
    case "broken":
      return [repair, uninstall, safe, quit];
    default:
      return [quit];
  }
}

/** Parses a typed answer: a 1-based number or the option's letter. Null when invalid. */
export function parseChoice<T extends { key?: string }>(input: string, options: readonly T[]): T | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return n >= 1 && n <= options.length ? options[n - 1] : null;
  }
  return options.find((o) => o.key?.toLowerCase() === text) ?? null;
}

/** Decides whether a no-argument launch should open the guided menu instead of printing help. */
export function shouldShowMenu(input: {
  argCount: number;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  /** Image name of the parent process, when known (e.g. "explorer.exe"). */
  parentName: string | null;
  env?: Record<string, string | undefined>;
}): boolean {
  if (input.argCount > 0) return false;
  const force = input.env?.T3P_MENU;
  if (force === "0") return false;
  if (force === "1") return true;
  if (!input.stdinIsTTY || !input.stdoutIsTTY) return false;
  return input.parentName?.toLowerCase() === "explorer.exe";
}

/** Does `tasklist /FO CSV /NH` output show this image name? */
export function parseTasklistRunning(stdout: string, imageName: string): boolean {
  const want = imageName.toLowerCase();
  return stdout.split(/\r?\n/).some((line) => {
    const m = /^"([^"]+)"/.exec(line.trim());
    return m !== null && m[1].toLowerCase() === want;
  });
}

/** The image name from one `tasklist /FO CSV /NH` row for a PID, or null. */
export function parseTasklistName(stdout: string): string | null {
  const m = /^"([^"]+)"/m.exec(stdout.trim());
  return m ? m[1] : null;
}

export interface MenuIO {
  print(line?: string): void;
  /** Resolves with the typed line, or null when input is closed (EOF): callers treat that as cancel. */
  ask(question: string): Promise<string | null>;
}

export interface MenuDeps {
  io: MenuIO;
  findInstalls(): Promise<InstallInfo[]>;
  status(installDir: string): Promise<StatusReport>;
  isRunning(info: InstallInfo): boolean;
  install(info: InstallInfo): Promise<InstallResult>;
  update(info: InstallInfo): Promise<InstallResult>;
  /** True when the bundled runtime differs from the installed one. */
  runtimeOutdated?(info: InstallInfo): boolean;
  repair(info: InstallInfo): Promise<InstallResult | "noop">;
  uninstall(info: InstallInfo): Promise<void>;
  safeMode(off: boolean): { pending: boolean };
  safePending(): boolean;
  version: string;
  /** Test seam: pause between app-running checks. */
  sleep?(ms: number): Promise<void>;
}

const RULE = "------------------------------------------------------------";

/** Asks until the user closes T3 Code, or cancels. True when it is closed. */
export async function ensureClosed(deps: MenuDeps, info: InstallInfo): Promise<boolean> {
  const { io } = deps;
  while (deps.isRunning(info)) {
    io.print();
    io.print(`${channelName(info.channel)} is open. Close it first (right-click its tray icon > Quit if you cannot find the window).`);
    const raw = await io.ask("Press Enter when it is closed, or type C to cancel: ");
    const answer = (raw ?? "c").trim().toLowerCase();
    if (answer === "c" || answer === "cancel" || answer === "q") return false;
    await deps.sleep?.(300);
  }
  return true;
}

function summarize(info: InstallInfo, report: StatusReport, safePending: boolean): string[] {
  const compat = compatibility(info.version);
  const lines = [
    `  App:           ${channelName(info.channel)}`,
    `  Version:       ${info.version ?? "unknown"}`,
    `  Compatibility: ${compat.text}`,
    `  Patcher:       ${describeLayout(report.layout)}`,
    `  Folder:        ${info.installDir}`,
  ];
  if (safePending) lines.push("  Safe mode:     ON for the next start (plugins and patches are skipped)");
  return lines;
}

async function chooseInstall(deps: MenuDeps, installs: InstallInfo[]): Promise<InstallInfo | null> {
  if (installs.length === 1) return installs[0];
  const { io } = deps;
  io.print("Found more than one T3 Code:");
  installs.forEach((info, i) => io.print(`  ${i + 1}. ${channelName(info.channel)} ${info.version ?? "unknown version"} - ${info.installDir}`));
  for (;;) {
    const answer = await io.ask(`Which one? [1-${installs.length}, or Q to quit]: `);
    if (answer === null || /^q/i.test(answer.trim())) return null;
    const picked = parseChoice(answer, installs.map((info, i) => ({ key: String(i + 1), info })));
    if (picked) return picked.info;
    io.print("Type a number from the list.");
  }
}

async function runAction(deps: MenuDeps, info: InstallInfo, action: MenuAction): Promise<void> {
  const { io } = deps;
  if (action === "safe") {
    const off = deps.safePending();
    const result = deps.safeMode(off);
    io.print(result.pending
      ? "Safe mode is set. Start T3 Code now: it opens without plugins or patches, one time only."
      : "Safe mode cancelled. T3 Code starts normally.");
    return;
  }
  if (action === "uninstall") {
    io.print("This restores the original T3 Code. Your plugins and settings stay in the .t3-patcher folder in your user folder.");
    const sure = ((await io.ask("Type Y to uninstall the patcher: ")) ?? "").trim().toLowerCase();
    if (sure !== "y" && sure !== "yes") {
      io.print("Cancelled. Nothing changed.");
      return;
    }
  }
  if (!(await ensureClosed(deps, info))) {
    io.print("Cancelled. Nothing changed.");
    return;
  }
  if (action === "install") {
    io.print("Installing...");
    const result = await deps.install(info);
    io.print(result.status === "noop" ? "Already installed. Nothing to do." : "Done. Start T3 Code as usual; the patcher loads with it.");
    for (const warning of result.warnings) io.print(`  note: ${warning}`);
  } else if (action === "update") {
    io.print("Updating...");
    const result = await deps.update(info);
    if (result.status === "noop") io.print("Already up to date. Nothing to do.");
    else {
      io.print(`Updated runtime ${result.runtimeUpdate?.from ?? "none"} -> ${result.runtimeUpdate?.to ?? "?"}. Start T3 Code as usual.`);
    }
    for (const warning of result.warnings) io.print(`  note: ${warning}`);
  } else if (action === "repair") {
    io.print("Repairing...");
    const result = await deps.repair(info);
    if (result === "noop") io.print("Nothing needed repair.");
    else {
      io.print("Done. Start T3 Code as usual.");
      for (const warning of result.warnings) io.print(`  note: ${warning}`);
    }
  } else if (action === "uninstall") {
    io.print("Uninstalling...");
    await deps.uninstall(info);
    io.print("Done. T3 Code is back to stock.");
  }
}

/** Runs the menu until Quit, then waits for Enter so the window stays readable. Returns the exit code. */
export async function runMenu(deps: MenuDeps): Promise<number> {
  const { io } = deps;
  let code = 0;
  try {
    io.print(RULE);
    io.print(`  T3 Patcher ${deps.version}`);
    io.print(RULE);
    const installs = await deps.findInstalls();
    if (installs.length === 0) {
      io.print();
      io.print("No T3 Code found on this PC.");
      io.print("Install T3 Code first, run it once, then open this program again.");
      io.print("Installed in an unusual place? Open a terminal and run:  t3p install --path <folder>");
      return 1;
    }
    const info = await chooseInstall(deps, installs);
    if (!info) return 0;
    for (;;) {
      let report: StatusReport;
      try {
        report = await deps.status(info.installDir);
      } catch (error) {
        io.print(`Could not read the install: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
      }
      const pending = deps.safePending();
      io.print();
      for (const line of summarize(info, report, pending)) io.print(line);
      const options = menuOptions(report.layout, pending, report.layout === "patched" && (deps.runtimeOutdated?.(info) ?? false));
      io.print();
      io.print("What do you want to do?");
      options.forEach((o, i) => io.print(`  ${i + 1}. [${o.key}] ${o.label}${o.recommended ? " (recommended)" : ""} - ${o.hint}`));
      io.print();
      const answer = await io.ask(`Choose 1-${options.length}: `);
      if (answer === null) return code;
      const choice = parseChoice(answer, options);
      if (!choice) {
        io.print("Type a number from the list, or its letter.");
        continue;
      }
      if (choice.action === "quit") return code;
      io.print();
      try {
        await runAction(deps, info, choice.action);
        code = 0;
      } catch (error) {
        code = 1;
        if (error instanceof AppRunningError) io.print(`T3 Code is still open: ${error.message}`);
        else if (error instanceof T3pError) io.print(`Could not finish: ${error.message}`);
        else io.print(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
        io.print("Nothing was left half-done; you can try again or choose another option.");
      }
    }
  } finally {
    io.print();
    await io.ask("Press Enter to close this window. ");
  }
}

/** For the cli: the exe name used by the app-running check. */
export function runningImageName(info: InstallInfo): string {
  return basename(info.exePath);
}
