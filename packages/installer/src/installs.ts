import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { readAsarPackageJson } from "./asar.js";
import { T3pError } from "./errors.js";
import { layoutPaths } from "./layout.js";
import type { Channel, FindInstallsOpts, InstallInfo } from "./types.js";

const UNINSTALL_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";

/** Beta, Nightly, stable, or unknown, from the exe file name. */
export function channelFromExeName(name: string): Channel {
  if (/\(beta\)/i.test(name)) return "beta";
  if (/\(nightly\)/i.test(name)) return "nightly";
  if (/^t3 code\.exe$/i.test(name)) return "stable";
  return "unknown";
}

/**
 * Qualifies a directory as a T3 Code install: a resources/app.asar or
 * resources/_app.asar, and a "T3 Code*.exe" (not the uninstaller) next to resources.
 */
export function inspectInstall(dir: string): InstallInfo | null {
  const installDir = resolve(dir);
  const paths = layoutPaths(installDir);
  if (!existsSync(paths.appAsar) && !existsSync(paths.originalAsar)) return null;

  let exeName: string | null = null;
  try {
    const exes = readdirSync(installDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => /^T3 Code.*\.exe$/i.test(name) && !/^uninstall(\s|\.)/i.test(name))
      .sort((a, b) => a.localeCompare(b));
    exeName = exes[0] ?? null;
  } catch {
    return null;
  }
  if (!exeName) return null;

  // The version always comes from the original asar, never from the replacement.
  const source = existsSync(paths.originalAsar) ? paths.originalAsar : paths.appAsar;
  const pkg = readAsarPackageJson(source);
  const version = pkg && typeof pkg.version === "string" ? pkg.version : null;

  return {
    installDir,
    exePath: join(installDir, exeName),
    resourcesDir: paths.resourcesDir,
    version,
    channel: channelFromExeName(basename(exeName)),
  };
}

/** Parses `reg query ... /s` output and returns install dirs of T3 Code uninstall keys. */
export function parseRegistryInstallLocations(stdout: string): string[] {
  const found: string[] = [];
  let displayName: string | null = null;
  let installLocation: string | null = null;
  let uninstallString: string | null = null;
  let displayIcon: string | null = null;
  const flush = (): void => {
    if (displayName && /t3 code/i.test(displayName)) {
      // electron-builder (T3 Code) often omits InstallLocation; the uninstaller and the icon sit
      // in the install directory, so their path is the same answer.
      const dir =
        installLocation ??
        installDirFromCommand(uninstallString) ??
        installDirFromCommand(displayIcon);
      if (dir) found.push(dir);
    }
    displayName = null;
    installLocation = null;
    uninstallString = null;
    displayIcon = null;
  };
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("HKEY_")) {
      flush();
      continue;
    }
    const match = /^\s+(DisplayName|InstallLocation|UninstallString|DisplayIcon)\s+REG_[A-Z_]+\s+(.*)$/i.exec(line);
    if (!match) continue;
    switch (match[1]!.toLowerCase()) {
      case "displayname":
        displayName = match[2]!.trim();
        break;
      case "installlocation":
        installLocation = match[2]!.trim();
        break;
      case "uninstallstring":
        uninstallString = match[2]!.trim();
        break;
      case "displayicon":
        displayIcon = match[2]!.trim();
        break;
    }
  }
  flush();
  return found;
}

/**
 * The directory of the exe in an UninstallString ("C:\x\Uninstall T3 Code.exe" /currentuser) or a
 * DisplayIcon ("C:\x\T3 Code.exe,0"). Null when the value does not name a Windows executable.
 */
export function installDirFromCommand(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const quoted = /^"([^"]+)"/.exec(trimmed);
  let exe = quoted ? quoted[1]! : trimmed;
  if (!quoted) {
    const switchAt = exe.search(/\s+\/|\s+--/);
    if (switchAt > 0) exe = exe.slice(0, switchAt);
  }
  exe = exe.replace(/,\d+$/, "").trim();
  if (!/\.exe$/i.test(exe)) return null;
  const dir = dirname(exe);
  return dir && dir !== exe ? dir : null;
}

function defaultRegistryQuery(): string | null {
  const result = spawnSync("reg", ["query", UNINSTALL_KEY, "/s"], { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) return null;
  return result.stdout ?? null;
}

/**
 * Finds T3 Code installs: %LOCALAPPDATA%\\Programs\\<dir with "T3 Code" in its
 * name>, then the HKCU Uninstall keys' InstallLocation (or uninstaller path) on Windows.
 */
export async function findInstalls(opts: FindInstallsOpts = {}): Promise<InstallInfo[]> {
  const platform = opts.platform ?? process.platform;
  const home = opts.homeDir ?? homedir();
  const localAppData =
    opts.localAppDataDir ?? process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");

  const candidates: string[] = [];
  const programs = join(localAppData, "Programs");
  try {
    for (const entry of readdirSync(programs, { withFileTypes: true })) {
      // NSIS installs use "T3 Code (Beta)"; some builds use "t3code". inspectInstall still has to
      // find the exe and the asar, so a loose name match cannot produce a false positive.
      if (entry.isDirectory() && /^t3[\s._-]?code/i.test(entry.name)) candidates.push(join(programs, entry.name));
    }
  } catch {
    // No Programs folder: not an install location, not an error.
  }

  if (platform === "win32") {
    let stdout: string | null = null;
    try {
      stdout = (opts.registryQuery ?? defaultRegistryQuery)();
    } catch {
      stdout = null;
    }
    if (stdout) candidates.push(...parseRegistryInstallLocations(stdout));
  }

  const seen = new Set<string>();
  const installs: InstallInfo[] = [];
  for (const candidate of candidates) {
    let info: InstallInfo | null = null;
    try {
      info = inspectInstall(candidate);
    } catch {
      info = null;
    }
    if (!info) continue;
    const key = info.installDir.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    installs.push(info);
  }
  return installs;
}

/**
 * Resolves the install to act on: opts.path, or the single detected install.
 * Throws a T3pError when that is ambiguous or absent.
 */
export async function resolveInstall(
  opts: FindInstallsOpts & { path?: string },
): Promise<InstallInfo> {
  if (opts.path) {
    const info = inspectInstall(opts.path);
    if (!info) {
      throw new T3pError(
        `${resolve(opts.path)} is not a T3 Code install (needs resources/app.asar or resources/_app.asar and a "T3 Code*.exe").`,
      );
    }
    return info;
  }

  const installs = await findInstalls(opts);
  if (installs.length === 0) {
    throw new T3pError("No T3 Code install found. Pass --path <install dir>.");
  }
  if (installs.length > 1) {
    const list = installs.map((install) => `  ${install.installDir}`).join("\n");
    throw new T3pError(`Several T3 Code installs found:\n${list}\nPass --path <install dir> to choose one.`);
  }
  return installs[0];
}
