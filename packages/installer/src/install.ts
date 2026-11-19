import { SHIM_SOURCE } from "@t3p/shim";
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
import { status } from "./status.js";
import {
  SUPPORTED_VERSIONS,
  type InstallEntry,
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

/** <package>/../main-runtime/dist, resolved from src/ or dist/ alike. */
export function defaultRuntimeSource(): string | null {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const packageRoot = resolve(here, "..");
  const candidate = resolve(packageRoot, "..", "main-runtime", "dist");
  try {
    return existsSync(candidate) && statSync(candidate).isDirectory() ? candidate : null;
  } catch {
    return null;
  }
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
