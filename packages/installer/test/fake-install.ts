import { createPackage } from "@electron/asar";
import { mkdtempSync, mkdirSync, lstatSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { FuseState } from "../src/types.js";

export const SAFE_FUSES: FuseState = {
  onlyLoadAppFromAsar: false,
  embeddedAsarIntegrityValidation: false,
  runAsNode: true,
};

export const safeReadFuses = async (): Promise<FuseState> => ({ ...SAFE_FUSES });

export interface FakeInstall {
  root: string;
  installDir: string;
  exePath: string;
  resourcesDir: string;
  homeDir: string;
  packageJson: Record<string, unknown>;
  cleanup: () => void;
}

export interface FakeInstallOptions {
  /** Folder name under programs/, default "T3 Code (Beta)". */
  dirName?: string;
  exeName?: string;
  version?: string;
  packageJson?: Record<string, unknown>;
  /** Parent temp root; a new mkdtemp is used when omitted. */
  root?: string;
}

const BASE_PACKAGE_JSON = {
  name: "t3code",
  version: "0.1.10",
  main: "apps/desktop/dist-electron/boot.cjs",
  t3codeCommitHash: "7d32075e3757",
  dependencies: {},
};

/** Builds a fake, stock T3 Code install tree plus an empty fake home. */
export async function createFakeInstall(options: FakeInstallOptions = {}): Promise<FakeInstall> {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "t3p-fake-"));
  const dirName = options.dirName ?? "T3 Code (Beta)";
  const installDir = join(root, "Programs", dirName);
  const resourcesDir = join(installDir, "resources");
  mkdirSync(resourcesDir, { recursive: true });

  const exeName = options.exeName ?? "T3 Code (Beta).exe";
  const exePath = join(installDir, exeName);
  writeFileSync(exePath, "fake exe bytes");
  writeFileSync(join(installDir, `Uninstall ${basename(exeName, ".exe")}.exe`), "fake uninstaller bytes");

  const packageJson = {
    ...BASE_PACKAGE_JSON,
    version: options.version ?? "0.1.10",
    ...options.packageJson,
  };
  await writeStockAsar(resourcesDir, packageJson);

  mkdirSync(join(resourcesDir, "app.asar.unpacked", "node_modules", "x"), { recursive: true });
  writeFileSync(join(resourcesDir, "app.asar.unpacked", "node_modules", "x", "x.node"), "native bytes");
  writeFileSync(join(resourcesDir, "app-update.yml"), "provider: github\nreleaseType: release\n");

  const homeDir = join(root, "home");
  mkdirSync(homeDir, { recursive: true });

  return {
    root,
    installDir,
    exePath,
    resourcesDir,
    homeDir,
    packageJson,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function writeStockAsar(resourcesDir: string, packageJson: Record<string, unknown>): Promise<void> {
  const contentDir = mkdtempSync(join(tmpdir(), "t3p-asar-src-"));
  mkdirSync(join(contentDir, "apps", "desktop", "dist-electron"), { recursive: true });
  writeFileSync(join(contentDir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  writeFileSync(join(contentDir, "apps", "desktop", "dist-electron", "boot.cjs"), 'require("./main.cjs");\n');
  await createPackage(contentDir, join(resourcesDir, "app.asar"));
  rmSync(contentDir, { recursive: true, force: true });
}

export interface SimulatedUpdateOptions {
  version: string;
  /** New exe name when the channel changes, e.g. "T3 Code (Nightly).exe". */
  exeName?: string;
  packageJson?: Record<string, unknown>;
}

/**
 * Simulates what an NSIS update does: wipes the whole install dir (so
 * _app.asar, the junction and every T3P file vanish), then installs a new
 * app.asar and possibly a renamed exe.
 */
export async function simulateUpstreamUpdate(tree: FakeInstall, options: SimulatedUpdateOptions): Promise<void> {
  for (const name of ["_app.asar", "_app.asar.unpacked"]) {
    rmSync(join(tree.resourcesDir, name), { recursive: true, force: true });
  }
  rmSync(join(tree.resourcesDir, "app.asar"), { force: true });
  await writeStockAsar(tree.resourcesDir, {
    ...BASE_PACKAGE_JSON,
    ...tree.packageJson,
    ...options.packageJson,
    version: options.version,
  });

  if (options.exeName && options.exeName !== basename(tree.exePath)) {
    rmSync(tree.exePath, { force: true });
    rmSync(join(tree.installDir, `Uninstall ${basename(tree.exePath, ".exe")}.exe`), { force: true });
    writeFileSync(join(tree.installDir, options.exeName), "fake exe bytes");
    writeFileSync(join(tree.installDir, `Uninstall ${basename(options.exeName, ".exe")}.exe`), "fake uninstaller bytes");
    tree.exePath = join(tree.installDir, options.exeName);
  }
}

/** Writes a runtime folder with a main.cjs entry and one nested file. */
export function createRuntimeSource(root: string, name = "runtime-src"): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(join(dir, "main.cjs"), "// t3p runtime stub\n");
  writeFileSync(join(dir, "lib", "patch.cjs"), "module.exports = {};\n");
  return dir;
}

export interface TreeEntry {
  path: string;
  type: "file" | "dir" | "link";
  size: number | null;
}

/** Sorted recursive listing that never descends into links. */
export function snapshotTree(root: string): TreeEntry[] {
  const out: TreeEntry[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = lstatSync(abs);
      if (stat.isSymbolicLink()) {
        out.push({ path: rel, type: "link", size: null });
      } else if (stat.isDirectory()) {
        out.push({ path: rel, type: "dir", size: null });
        walk(abs, rel);
      } else {
        out.push({ path: rel, type: "file", size: stat.size });
      }
    }
  };
  walk(root, "");
  return out;
}
