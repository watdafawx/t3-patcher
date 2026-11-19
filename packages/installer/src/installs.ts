import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

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

/** Parses `reg query ... /s` output and returns InstallLocation of T3 Code uninstall keys. */
export function parseRegistryInstallLocations(stdout: string): string[] {
  const found: string[] = [];
  let displayName: string | null = null;
  let installLocation: string | null = null;
  const flush = (): void => {
    if (displayName && /t3 code/i.test(displayName) && installLocation) found.push(installLocation);
    displayName = null;
    installLocation = null;
  };
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("HKEY_")) {
      flush();
      continue;
    }
    const match = /^\s+(DisplayName|InstallLocation)\s+REG_[A-Z_]+\s+(.*)$/i.exec(line);
    if (!match) continue;
    if (match[1].toLowerCase() === "displayname") displayName = match[2].trim();
    else installLocation = match[2].trim();
  }
  flush();
  return found;
}

function defaultRegistryQuery(): string | null {
  const result = spawnSync("reg", ["query", UNINSTALL_KEY, "/s"], { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) return null;
  return result.stdout ?? null;
}

/**
 * Finds T3 Code installs: %LOCALAPPDATA%\\Programs\\<dir with "T3 Code" in its
 * name>, then the HKCU Uninstall keys' InstallLocation on Windows.
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
      if (entry.isDirectory() && /t3 code/i.test(entry.name)) candidates.push(join(programs, entry.name));
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
