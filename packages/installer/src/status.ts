import { existsSync } from "node:fs";
import { homedir } from "node:os";

import { readAsarPackageJson } from "./asar.js";
import { errorMessage } from "./errors.js";
import { resolveInstall } from "./installs.js";
import { junctionInfo, layoutPaths } from "./layout.js";
import { installKey, readManifest, sha256File } from "./manifest.js";
import type { InstallInfo, StatusOpts, StatusReport } from "./types.js";

const short = (hash: string): string => `${hash.slice(0, 12)}...`;

/**
 * Reports the layout of one install:
 * unpatched, patched, stale (an upstream update replaced app.asar), broken,
 * or unknown (no install found).
 */
export async function status(opts: StatusOpts = {}): Promise<StatusReport> {
  const home = opts.homeDir ?? homedir();
  const manifest = readManifest(home);
  const manifestPresent = manifest !== null;

  let install: InstallInfo;
  try {
    install = await resolveInstall(opts);
  } catch (error) {
    return { layout: "unknown", manifestPresent, reasons: [errorMessage(error)] };
  }

  const paths = layoutPaths(install.installDir);
  const entry = manifest?.installs[installKey(install.installDir)] ?? null;
  const reasons: string[] = [];
  const hasApp = existsSync(paths.appAsar);
  const hasOriginal = existsSync(paths.originalAsar);

  if (!hasApp) {
    reasons.push(`resources/app.asar is missing (only resources/_app.asar exists)`);
    return { layout: "broken", install, manifestPresent, reasons };
  }

  const pkg = readAsarPackageJson(paths.appAsar);
  const appHash = sha256File(paths.appAsar);
  const looksReplacement = pkg !== null && pkg.main === "index.js";
  const junction = junctionInfo(paths.resourcesDir);

  if (!entry) {
    reasons.push("no manifest entry for this install");
    if (looksReplacement) {
      reasons.push('resources/app.asar has main "index.js", which is a T3 Patcher replacement');
      reasons.push(
        hasOriginal
          ? "resources/_app.asar is present but was not recorded"
          : "resources/_app.asar is missing",
      );
      return { layout: "broken", install, manifestPresent, reasons };
    }
    if (hasOriginal) {
      reasons.push("resources/_app.asar is present but resources/app.asar is not a replacement");
      return { layout: "broken", install, manifestPresent, reasons };
    }
    reasons.push("resources/app.asar is the stock asar and there is no resources/_app.asar");
    if (junction.present) reasons.push("a resources/_app.asar.unpacked link exists without a manifest entry");
    return { layout: "unpatched", install, manifestPresent, reasons };
  }

  reasons.push(`manifest entry found (appVersion ${entry.appVersion ?? "unknown"})`);

  if (!hasOriginal) {
    if (appHash === entry.replacementAsarSha256) {
      reasons.push("resources/app.asar is still the recorded replacement but resources/_app.asar is missing");
      return { layout: "broken", install, manifestPresent, reasons };
    }
    reasons.push("resources/_app.asar is missing");
    reasons.push(
      `resources/app.asar hash ${short(appHash)} does not match the recorded replacement ${short(entry.replacementAsarSha256)}`,
    );
    if (pkg && typeof pkg.version === "string" && entry.appVersion && pkg.version !== entry.appVersion) {
      reasons.push(`resources/app.asar version ${pkg.version} differs from the recorded version ${entry.appVersion}`);
    }
    return { layout: "stale", install, manifestPresent, reasons };
  }

  if (appHash !== entry.replacementAsarSha256) {
    reasons.push(
      `resources/app.asar hash ${short(appHash)} does not match the recorded replacement ${short(entry.replacementAsarSha256)}`,
    );
    return { layout: "broken", install, manifestPresent, reasons };
  }
  reasons.push("replacement asar hash matches the manifest");

  if (pkg && typeof pkg.version === "string" && entry.appVersion && pkg.version !== entry.appVersion) {
    reasons.push(`resources/app.asar version ${pkg.version} differs from the recorded version ${entry.appVersion}`);
    return { layout: "stale", install, manifestPresent, reasons };
  }

  const originalHash = sha256File(paths.originalAsar);
  if (originalHash !== entry.originalAsarSha256) {
    reasons.push(
      `resources/_app.asar hash ${short(originalHash)} does not match the recorded original ${short(entry.originalAsarSha256)}`,
    );
    return { layout: "broken", install, manifestPresent, reasons };
  }
  reasons.push("original asar hash matches the manifest");

  if (entry.junction) {
    if (!junction.present) {
      reasons.push("resources/_app.asar.unpacked is missing");
      return { layout: "broken", install, manifestPresent, reasons };
    }
    if (!junction.isSymlink) {
      reasons.push("resources/_app.asar.unpacked is not a junction");
      return { layout: "broken", install, manifestPresent, reasons };
    }
    if (!junction.targetExists) {
      reasons.push(`resources/_app.asar.unpacked points at ${junction.target}, which is missing`);
      return { layout: "broken", install, manifestPresent, reasons };
    }
    reasons.push("junction resolves to resources/app.asar.unpacked");
  } else if (junction.present) {
    reasons.push("resources/_app.asar.unpacked exists but the manifest records no junction");
    return { layout: "broken", install, manifestPresent, reasons };
  }

  return { layout: "patched", install, manifestPresent, reasons };
}
