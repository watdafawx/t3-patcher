import { existsSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { readAsarPackageJson, uncacheAsar } from "./asar.js";
import { AppRunningError, T3pError, errorMessage, isBusyError } from "./errors.js";
import { inspectInstall, resolveInstall } from "./installs.js";
import { junctionInfo, layoutPaths } from "./layout.js";
import { installKey, readManifest, removeManifestEntry, sha256File } from "./manifest.js";
import { removeJunction } from "./install.js";
import { status } from "./status.js";
import type { InstallInfo, InstallManifest, UninstallOpts } from "./types.js";

function manifestOnlyInstall(manifest: InstallManifest | null): InstallInfo | null {
  if (!manifest) return null;
  const entries = Object.values(manifest.installs);
  if (entries.length !== 1) return null;
  return inspectInstall(entries[0].installDir);
}

function purgeRuntime(homeDir: string): void {
  rmSync(join(homeDir, ".t3-patcher", "runtime"), { recursive: true, force: true });
  rmSync(join(homeDir, ".t3-patcher", "bin"), { recursive: true, force: true });
}

/**
 * Restores the stock layout: verifies the replacement asar against the manifest,
 * replaces it with _app.asar in one rename, removes the junction without touching its target
 * and drops the manifest entry.
 */
export async function uninstall(opts: UninstallOpts = {}): Promise<void> {
  const home = opts.homeDir ?? homedir();
  const log = opts.log ?? ((): void => undefined);
  const manifest = readManifest(home);

  let install: InstallInfo;
  try {
    install = await resolveInstall(opts);
  } catch (error) {
    const fromManifest = manifestOnlyInstall(manifest);
    if (opts.path || !fromManifest) {
      // The install is gone but the manifest may still record it: drop the entry.
      const entries = manifest ? Object.values(manifest.installs) : [];
      if (!opts.path && entries.length === 1 && !existsSync(entries[0].installDir)) {
        removeManifestEntry(home, entries[0].installDir);
        if (opts.purge) purgeRuntime(home);
        log(`${entries[0].installDir} no longer exists; removed its manifest entry`);
        return;
      }
      throw error;
    }
    install = fromManifest;
  }

  const paths = layoutPaths(install.installDir);
  const entry = manifest?.installs[installKey(install.installDir)] ?? null;
  const report = await status({ ...opts, path: install.installDir });

  if (report.layout === "unknown" || report.layout === "unpatched") {
    removeManifestEntry(home, install.installDir);
    if (opts.purge) purgeRuntime(home);
    log(`${install.installDir} is not patched; nothing to restore`);
    return;
  }

  if (report.layout === "stale") {
    // An upstream update replaced app.asar; only our junction and manifest may remain.
    const junction = junctionInfo(paths.resourcesDir);
    if (junction.isSymlink) removeJunction(paths.resourcesDir);
    removeManifestEntry(home, install.installDir);
    if (opts.purge) purgeRuntime(home);
    log(`${install.installDir} was replaced by an upstream update; removed the manifest entry`);
    return;
  }

  // Without a manifest entry, fall back to detection: our replacement asar plus
  // the original. Anything else is unknown and must not be deleted.
  const detected =
    !entry &&
    existsSync(paths.originalAsar) &&
    readAsarPackageJson(paths.appAsar)?.main === "index.js";

  if ((report.layout === "broken" && !detected) || (!entry && !detected)) {
    const reasons = report.reasons.map((reason) => `  - ${reason}`).join("\n");
    throw new T3pError(
      `Refusing to uninstall ${install.installDir}: the layout is inconsistent.\n${reasons}\nReinstall T3 Code to get a clean app.asar.`,
    );
  }

  // patched: verify before deleting anything.
  if (entry) {
    const actual = sha256File(paths.appAsar);
    if (actual !== entry.replacementAsarSha256) {
      throw new T3pError(
        `Refusing to uninstall: ${paths.appAsar} does not match the recorded replacement hash (expected ${entry.replacementAsarSha256}, found ${actual}).`,
      );
    }
  }

  // One atomic rename: the original replaces the shim in a single step (rename onto an existing
  // file replaces it on Windows and POSIX), so there is never a moment without an app.asar and a
  // failure changes nothing. A move-aside-and-restore sequence would leave no app.asar if the
  // restore failed as well.
  try {
    renameSync(paths.originalAsar, paths.appAsar);
  } catch (error) {
    if (isBusyError(error)) throw new AppRunningError();
    throw new T3pError(
      `could not rename ${paths.originalAsar} back to app.asar: ${errorMessage(error)}. The patched layout was kept; run "t3p uninstall" again.`,
    );
  }
  // Leftover from an older uninstall that used a backup file.
  rmSync(`${paths.appAsar}.t3p-backup`, { force: true });

  // The junction is only needed by the replacement; a failure here leaves a harmless link.
  try {
    removeJunction(paths.resourcesDir);
  } catch (error) {
    log(`could not remove the _app.asar.unpacked junction: ${errorMessage(error)}`);
  }

  uncacheAsar(paths.appAsar);
  uncacheAsar(paths.originalAsar);

  removeManifestEntry(home, install.installDir);
  if (opts.purge) purgeRuntime(home);

  log(`restored ${paths.appAsar}`);
}
