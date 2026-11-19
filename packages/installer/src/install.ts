import { extractFile } from "@electron/asar";
import { SHIM_SOURCE } from "@t3p/shim";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildReplacementAsar, uncacheAsar } from "./asar.js";
import { AppRunningError, T3pError, errorMessage, isBusyError } from "./errors.js";
import { describeFuses, fusesAreSafe, readFusesFromExe } from "./fuses.js";
import { ensureWorkerNode, type WorkerNodeResult } from "./worker-node.js";
import { layoutPaths, junctionInfo, type LayoutPaths } from "./layout.js";
import { hashTree, installKey, manifestPath, readManifest, sha256File, writeManifest } from "./manifest.js";
import { resolveInstall } from "./installs.js";
import { extractEmbeddedRuntime } from "./runtime-pack.js";
import { status } from "./status.js";
import {
  SUPPORTED_VERSIONS,
  type InstallEntry,
  type InstallInfo,
  type InstallOpts,
  type InstallResult,
  type RuntimeFile,
} from "./types.js";

const defaultRename = (from: string, to: string): void => renameSync(from, to);

/** Removes the _app.asar.unpacked junction without ever touching its target. */
export function removeJunction(resourcesDir: string): boolean {
  const info = junctionInfo(resourcesDir);
  if (!info.present) return false;
  if (!info.isSymlink) {
    throw new T3pError(`${info.path} exists and is not a junction; refusing to delete it.`);
  }
  try {
    // A Windows junction is a directory: rmdir removes the link, never its target.
    rmdirSync(info.path);
  } catch {
    // POSIX dir symlinks are removed with unlink instead.
    unlinkSync(info.path);
  }
  return true;
}

function ensureJunction(paths: LayoutPaths): boolean {
  if (!existsSync(paths.unpacked) || !statSync(paths.unpacked).isDirectory()) return false;
  const info = junctionInfo(paths.resourcesDir);
  if (info.present) {
    if (!info.isSymlink) {
      throw new T3pError(`${info.path} exists and is not a junction; refusing to touch it.`);
    }
    if (!info.targetExists) {
      throw new T3pError(`the junction ${info.path} points at ${info.target}, which does not exist.`);
    }
    return true;
  }
  symlinkSync(paths.unpacked, paths.junction, "junction");
  return true;
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Where the runtime to install comes from, first hit wins:
 * 1. the runtime embedded in the single-file t3p.exe (unpacked to a temp folder),
 * 2. <package>/../main-runtime/dist (this monorepo, from src/ or dist/),
 * 3. <package>/runtime (the published npm package, staged by `prepack`).
 */
export function defaultRuntimeSource(): string | null {
  try {
    const embedded = extractEmbeddedRuntime();
    if (embedded) return embedded;
  } catch {
    // fall through to the on-disk locations
  }
  let packageRoot: string;
  try {
    packageRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
  } catch {
    return null;
  }
  for (const candidate of [resolve(packageRoot, "..", "main-runtime", "dist"), resolve(packageRoot, "runtime")]) {
    if (isDirectory(candidate)) return candidate;
  }
  return null;
}

function copyRuntime(
  source: string,
  homeDir: string,
): RuntimeFile[] {
  const base = join(homeDir, ".t3-patcher");
  const target = join(base, "runtime");
  const incoming = `${target}.new`;
  const previous = `${target}.old`;
  mkdirSync(base, { recursive: true });
  rmSync(incoming, { recursive: true, force: true });
  rmSync(previous, { recursive: true, force: true });
  cpSync(source, incoming, { recursive: true });
  if (existsSync(target)) renameSync(target, previous);
  renameSync(incoming, target);
  rmSync(previous, { recursive: true, force: true });
  return hashTree(target);
}

/** Best-effort restore of the runtime folder after a failed copy. */
function recoverRuntime(homeDir: string): void {
  const base = join(homeDir, ".t3-patcher");
  const target = join(base, "runtime");
  const incoming = `${target}.new`;
  const previous = `${target}.old`;
  try {
    if (existsSync(previous) && !existsSync(target)) renameSync(previous, target);
  } catch {
    // leave it; the shim skips a missing runtime
  }
  try {
    rmSync(incoming, { recursive: true, force: true });
  } catch {
    // nothing else to do
  }
}

function selectRuntimeSource(opts: InstallOpts, warnings: string[]): string | null {
  if (opts.skipRuntime) return null;
  if (opts.runtimeSource) {
    const abs = resolve(opts.runtimeSource);
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) throw new T3pError(`--runtime ${opts.runtimeSource} is not a directory.`);
    return abs;
  }
  const found = defaultRuntimeSource();
  if (!found) {
    warnings.push(
      "no runtime source found (packages/main-runtime/dist); installed without a runtime, so the shim will start the stock app",
    );
    return null;
  }
  return found;
}

/**
 * Installs the T3P layout into one T3 Code install:
 * replacement app.asar, original as _app.asar, _app.asar.unpacked junction,
 * runtime in <home>/.t3-patcher/runtime and a manifest entry.
 */
export async function install(opts: InstallOpts = {}): Promise<InstallResult> {
  const home = opts.homeDir ?? homedir();
  const log = opts.log ?? ((): void => undefined);
  const readFuses = opts.readFuses ?? readFusesFromExe;
  const rename = opts.rename ?? defaultRename;
  const warnings: string[] = [];

  const info = await resolveInstall(opts);
  const paths = layoutPaths(info.installDir);
  const report = await status({ ...opts, path: info.installDir });

  if (report.layout === "patched" && opts.refreshRuntime !== false && !opts.skipRuntime) {
    return refreshPatched(opts, info, paths, home, log, rename, warnings);
  }

  if (report.layout === "patched") {
    const entry = readManifest(home)?.installs[installKey(info.installDir)] ?? null;
    log(`already patched: ${info.installDir}`);
    return {
      status: "noop",
      install: info,
      changed: false,
      manifestPath: manifestPath(home),
      originalAsarSha256: entry?.originalAsarSha256 ?? sha256File(paths.originalAsar),
      replacementAsarSha256: entry?.replacementAsarSha256 ?? sha256File(paths.appAsar),
      runtime: null,
      warnings,
    };
  }

  if (report.layout === "broken") {
    const reasons = report.reasons.map((reason) => `  - ${reason}`).join("\n");
    throw new T3pError(
      `The T3 Code install at ${info.installDir} is in a broken layout, refusing to touch it:\n${reasons}\nReinstall T3 Code, or run "t3p uninstall" if it can restore the stock layout by detection, then run "t3p install" again.`,
    );
  }

  const fuses = await readFuses(info.exePath);
  if (!fusesAreSafe(fuses)) {
    if (!opts.force) {
      throw new T3pError(
        `Unsafe Electron fuses in ${info.exePath}: ${describeFuses(fuses)}. A replacement app.asar cannot load. Upgrade T3 Patcher or use --force if you verified this build.`,
      );
    }
    warnings.push(`installing with unsafe fuses because of --force: ${describeFuses(fuses)}`);
  }

  if (info.version === null) {
    if (!opts.force && !opts.allowUnsupportedVersion) {
      throw new T3pError(`Could not read the T3 Code version from the asar in ${info.resourcesDir}. Use --force to install anyway.`);
    }
    warnings.push("T3 Code version is unknown");
  } else if (!SUPPORTED_VERSIONS.includes(info.version)) {
    if (!opts.force && !opts.allowUnsupportedVersion) {
      throw new T3pError(
        `T3 Code ${info.version} is not supported (supported: ${SUPPORTED_VERSIONS.join(", ")}). Use --force to install anyway.`,
      );
    }
    warnings.push(
      opts.force
        ? `T3 Code ${info.version} is outside the supported versions (installing because of --force)`
        : `T3 Code ${info.version} is outside the supported versions`,
    );
  }

  if (existsSync(paths.originalAsar)) {
    throw new T3pError(`${paths.originalAsar} already exists; refusing to overwrite an unknown file.`);
  }

  const runtimeSource = selectRuntimeSource(opts, warnings);
  const shimSource = opts.shimSource ?? SHIM_SOURCE;
  const staging = mkdtempSync(join(info.installDir, ".t3p-build-"));
  const newAsar = `${paths.appAsar}.t3p-new`;

  let movedOriginal = false;
  let installedReplacement = false;
  let junctionCreated = false;
  let runtimeFiles: RuntimeFile[] = [];

  try {
    log(`building replacement asar at ${newAsar}`);
    await buildReplacementAsar({
      sourceAsar: paths.appAsar,
      destAsar: newAsar,
      workDir: staging,
      shimSource,
    });

    await opts.hooks?.beforeSwap?.();

    rename(paths.appAsar, paths.originalAsar);
    movedOriginal = true;
    rename(newAsar, paths.appAsar);
    installedReplacement = true;
    // @electron/asar cached the original package.json under the app.asar path.
    uncacheAsar(paths.appAsar);
    uncacheAsar(paths.originalAsar);

    junctionCreated = ensureJunction(paths);
    if (junctionCreated) log(`junction ${paths.junction} -> ${paths.unpacked}`);
    if (runtimeSource) {
      runtimeFiles = copyRuntime(runtimeSource, home);
      log(`copied runtime ${runtimeSource} -> ${join(home, ".t3-patcher", "runtime")} (${runtimeFiles.length} files)`);
    }
  } catch (error) {
    const rollbackErrors = rollbackLayout(paths, { movedOriginal, installedReplacement, junctionCreated });
    if (existsSync(newAsar)) {
      try {
        rmSync(newAsar, { force: true });
      } catch {
        // staging removal below still runs
      }
    }
    recoverRuntime(home);
    if (isBusyError(error)) {
      const busy = new AppRunningError();
      if (rollbackErrors.length > 0) {
        throw new AppRunningError(`${busy.message} Rollback problems: ${rollbackErrors.join("; ")}`);
      }
      throw busy;
    }
    const suffix = rollbackErrors.length > 0 ? ` (rollback problems: ${rollbackErrors.join("; ")})` : "";
    if (error instanceof T3pError) throw error;
    throw new T3pError(`install failed and was rolled back${suffix}: ${errorMessage(error)}`);
  } finally {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      // A leftover staging dir is harmless; never mask the real error.
    }
  }

  const entry: InstallEntry = {
    installDir: info.installDir,
    exePath: info.exePath,
    appVersion: info.version,
    installedAt: new Date().toISOString(),
    originalAsarSha256: sha256File(paths.originalAsar),
    replacementAsarSha256: sha256File(paths.appAsar),
    junction: junctionCreated,
    runtimeFiles,
  };

  const manifest = readManifest(home) ?? { version: 1 as const, installs: {} };
  if (opts.skipRuntime) entry.runtimeFiles = manifest.installs[installKey(info.installDir)]?.runtimeFiles ?? [];
  manifest.installs[installKey(info.installDir)] = entry;
  try {
    writeManifest(home, manifest);
  } catch (error) {
    warnings.push(`could not write the install manifest (${errorMessage(error)}); uninstall will fall back to detection`);
  }

  let workerNode: WorkerNodeResult | "failed" | null = null;
  if (!opts.skipRuntime && (opts.workerNode ?? "auto") !== "skip") {
    try {
      workerNode = ensureWorkerNode(info, home, { env: opts.env, platform: opts.platform, force: opts.workerNode === "copy", log });
    } catch (error) {
      workerNode = "failed";
      warnings.push(`could not copy the repair-worker interpreter (${errorMessage(error)}); updates will need a manual "t3p repair"`);
    }
  }

  return {
    status: "installed",
    install: info,
    changed: true,
    manifestPath: manifestPath(home),
    originalAsarSha256: entry.originalAsarSha256,
    replacementAsarSha256: entry.replacementAsarSha256,
    runtime: runtimeSource ? { source: runtimeSource, files: runtimeFiles.length } : null,
    workerNode,
    warnings,
  };
}

/** Short label for a runtime tree: "rt-" plus 8 hex of a digest over every path and hash. */
export function runtimeLabel(files: RuntimeFile[]): string {
  const digest = createHash("sha256");
  for (const f of files) digest.update(`${f.path}\0${f.sha256}\n`);
  return `rt-${digest.digest("hex").slice(0, 8)}`;
}

function installedRuntimeFiles(home: string): RuntimeFile[] | null {
  const dir = join(home, ".t3-patcher", "runtime");
  return isDirectory(dir) ? hashTree(dir) : null;
}

export interface RuntimeComparison {
  /** Label of what is in <home>/.t3-patcher/runtime, or null when absent. */
  installed: string | null;
  /** Label of the runtime this binary would install, or null when it has no source. */
  bundled: string | null;
  outdated: boolean;
}

/** Compares the installed runtime with the one this binary would install. Never throws. */
export function compareRuntime(opts: { homeDir?: string; runtimeSource?: string } = {}): RuntimeComparison {
  try {
    const home = opts.homeDir ?? homedir();
    const source = opts.runtimeSource ? resolve(opts.runtimeSource) : defaultRuntimeSource();
    const bundledFiles = source && isDirectory(source) ? hashTree(source) : null;
    const installedFiles = installedRuntimeFiles(home);
    const installed = installedFiles ? runtimeLabel(installedFiles) : null;
    const bundled = bundledFiles ? runtimeLabel(bundledFiles) : null;
    return { installed, bundled, outdated: bundled !== null && bundled !== installed };
  } catch {
    return { installed: null, bundled: null, outdated: false };
  }
}

function readShim(appAsar: string): string | null {
  try {
    uncacheAsar(appAsar);
    return extractFile(appAsar, "index.js").toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Refreshes the runtime (and the shim, only if it changed) of an already
 * patched app. The new runtime is staged next to the old one and swapped by
 * rename; any failure puts everything back.
 */
async function refreshPatched(
  opts: InstallOpts,
  info: InstallInfo,
  paths: LayoutPaths,
  home: string,
  log: (message: string) => void,
  rename: (from: string, to: string) => void,
  warnings: string[],
): Promise<InstallResult> {
  const manifest = readManifest(home) ?? { version: 1 as const, installs: {} };
  const key = installKey(info.installDir);
  const entry = manifest.installs[key] ?? null;
  const base = {
    install: info,
    manifestPath: manifestPath(home),
    originalAsarSha256: entry?.originalAsarSha256 ?? sha256File(paths.originalAsar),
    replacementAsarSha256: entry?.replacementAsarSha256 ?? sha256File(paths.appAsar),
    warnings,
  };
  const runtimeSource = selectRuntimeSource(opts, warnings);
  const shimSource = opts.shimSource ?? SHIM_SOURCE;
  const shimChanged = runtimeSource !== null && readShim(paths.appAsar) !== shimSource;
  const oldFiles = installedRuntimeFiles(home);
  const newFiles = runtimeSource ? hashTree(runtimeSource) : null;
  const same = oldFiles !== null && newFiles !== null && JSON.stringify(oldFiles) === JSON.stringify(newFiles);
  if (!runtimeSource || !newFiles || (same && !shimChanged)) {
    log(`already up to date: ${info.installDir}`);
    return { ...base, status: "noop", changed: false, runtime: null };
  }

  const target = join(home, ".t3-patcher", "runtime");
  const incoming = `${target}.new`;
  const previous = `${target}.old`;
  const newAsar = `${paths.appAsar}.t3p-new`;
  const oldAsar = `${paths.appAsar}.t3p-old`;
  let staging: string | null = null;
  let swappedRuntime = false;
  let hadOldRuntime = false;
  let swappedShim = false;
  let replacementHash = base.replacementAsarSha256;
  try {
    mkdirSync(join(home, ".t3-patcher"), { recursive: true });
    rmSync(incoming, { recursive: true, force: true });
    rmSync(previous, { recursive: true, force: true });
    rmSync(oldAsar, { force: true });
    cpSync(runtimeSource, incoming, { recursive: true });
    if (shimChanged) {
      staging = mkdtempSync(join(info.installDir, ".t3p-build-"));
      await buildReplacementAsar({ sourceAsar: paths.originalAsar, destAsar: newAsar, workDir: staging, shimSource });
    }
    await opts.hooks?.beforeSwap?.();

    if (existsSync(target)) {
      rename(target, previous);
      hadOldRuntime = true;
    }
    rename(incoming, target);
    swappedRuntime = true;
    if (shimChanged) {
      rename(paths.appAsar, oldAsar);
      swappedShim = true;
      rename(newAsar, paths.appAsar);
      uncacheAsar(paths.appAsar);
      replacementHash = sha256File(paths.appAsar);
    }
    manifest.installs[key] = entry
      ? { ...entry, runtimeFiles: newFiles, replacementAsarSha256: replacementHash }
      : {
          installDir: info.installDir,
          exePath: info.exePath,
          appVersion: info.version,
          installedAt: new Date().toISOString(),
          originalAsarSha256: base.originalAsarSha256,
          replacementAsarSha256: replacementHash,
          junction: junctionInfo(paths.resourcesDir).present,
          runtimeFiles: newFiles,
        };
    writeManifest(home, manifest);
  } catch (error) {
    const problems: string[] = [];
    const attempt = (what: string, fn: () => void): void => {
      try {
        fn();
      } catch (e) {
        problems.push(`could not ${what}: ${errorMessage(e)}`);
      }
    };
    if (swappedShim) {
      attempt("restore the shim", () => {
        rmSync(paths.appAsar, { force: true });
        renameSync(oldAsar, paths.appAsar);
        uncacheAsar(paths.appAsar);
      });
    }
    if (swappedRuntime) {
      attempt("restore the runtime", () => {
        rmSync(target, { recursive: true, force: true });
        if (hadOldRuntime) renameSync(previous, target);
      });
    } else if (hadOldRuntime && existsSync(previous) && !existsSync(target)) {
      attempt("restore the runtime", () => renameSync(previous, target));
    }
    attempt("remove staged files", () => {
      rmSync(incoming, { recursive: true, force: true });
      rmSync(newAsar, { force: true });
    });
    if (isBusyError(error)) {
      const busy = new AppRunningError();
      throw problems.length > 0 ? new AppRunningError(`${busy.message} Rollback problems: ${problems.join("; ")}`) : busy;
    }
    if (error instanceof T3pError) throw error;
    const suffix = problems.length > 0 ? ` (rollback problems: ${problems.join("; ")})` : "";
    throw new T3pError(`runtime update failed and was rolled back${suffix}: ${errorMessage(error)}`);
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
  }

  for (const leftover of [previous, oldAsar]) {
    try {
      rmSync(leftover, { recursive: true, force: true });
    } catch {
      warnings.push(`could not delete ${leftover}; it is safe to remove by hand`);
    }
  }
  const from = oldFiles ? runtimeLabel(oldFiles) : null;
  const to = runtimeLabel(newFiles);
  log(`updated runtime ${from ?? "none"} -> ${to} (${newFiles.length} files)`);

  let workerNode: WorkerNodeResult | "failed" | null = null;
  if ((opts.workerNode ?? "auto") !== "skip") {
    try {
      workerNode = ensureWorkerNode(info, home, { env: opts.env, platform: opts.platform, force: opts.workerNode === "copy", log });
    } catch (error) {
      workerNode = "failed";
      warnings.push(`could not copy the repair-worker interpreter (${errorMessage(error)}); updates will need a manual "t3p repair"`);
    }
  }
  return {
    ...base,
    replacementAsarSha256: replacementHash,
    status: "updated",
    changed: true,
    runtime: { source: runtimeSource, files: newFiles.length },
    runtimeUpdate: { from, to, shimChanged },
    workerNode,
  };
}

interface SwapState {
  movedOriginal: boolean;
  installedReplacement: boolean;
  junctionCreated: boolean;
}

/** Puts the original asar back in place and removes everything this run added. */
function rollbackLayout(paths: LayoutPaths, state: SwapState): string[] {
  const problems: string[] = [];
  const fail = (what: string, error: unknown): void => {
    problems.push(`could not ${what}: ${errorMessage(error)}`);
  };
  if (state.junctionCreated) {
    try {
      removeJunction(paths.resourcesDir);
    } catch (error) {
      fail("remove the junction", error);
    }
  }
  if (state.installedReplacement) {
    try {
      rmSync(paths.appAsar, { force: true });
    } catch (error) {
      fail("delete the replacement app.asar", error);
    }
  }
  if (state.movedOriginal) {
    try {
      renameSync(paths.originalAsar, paths.appAsar);
    } catch (error) {
      fail("restore the original app.asar", error);
    }
  }
  return problems;
}
