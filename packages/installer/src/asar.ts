import { createPackage, extractFile, listPackage, uncache } from "@electron/asar";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** @electron/asar caches parsed archives per path; drop the entry after a file changes. */
export function uncacheAsar(asarPath: string): void {
  try {
    uncache(asarPath);
  } catch {
    // nothing cached, nothing to do
  }
}

/** package.json of an asar, or null when it cannot be read or parsed. */
export function readAsarPackageJson(asarPath: string): Record<string, unknown> | null {
  try {
    uncacheAsar(asarPath);
    const raw = extractFile(asarPath, "package.json").toString("utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

/** True when the asar is a T3 Patcher replacement (its entry point is index.js). */
export function isReplacementAsar(asarPath: string): boolean {
  const pkg = readAsarPackageJson(asarPath);
  return pkg !== null && pkg.main === "index.js";
}

export interface BuildReplacementOptions {
  /** The original app.asar: its package.json is copied. */
  sourceAsar: string;
  /** Where to write the replacement (resources/app.asar.t3p-new). */
  destAsar: string;
  /** Scratch directory for the asar contents. */
  workDir: string;
  /** The shim source, written verbatim as index.js. */
  shimSource: string;
}

/**
 * Builds the small replacement asar: the original package.json with
 * `main` -> "index.js", plus index.js holding the shim.
 */
export async function buildReplacementAsar(options: BuildReplacementOptions): Promise<Record<string, unknown>> {
  const original = readAsarPackageJson(options.sourceAsar);
  if (!original) {
    throw new Error(`cannot read package.json from ${options.sourceAsar}`);
  }
  const appDir = join(options.workDir, "app");
  mkdirSync(appDir, { recursive: true });

  const pkg = { ...original, main: "index.js" };
  writeFileSync(join(appDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  writeFileSync(join(appDir, "index.js"), options.shimSource, "utf8");

  uncacheAsar(options.destAsar);
  await createPackage(appDir, options.destAsar);
  uncacheAsar(options.destAsar);

  // listPackage returns archive-style paths ("\\index.js" on Windows).
  const entries = listPackage(options.destAsar, { isPack: false }).map((entry) =>
    entry.replace(/^[\\/]+/, "").replace(/\\/g, "/"),
  );
  for (const required of ["index.js", "package.json"]) {
    if (!entries.includes(required)) {
      throw new Error(`built asar ${options.destAsar} is missing ${required}`);
    }
  }
  return pkg;
}
