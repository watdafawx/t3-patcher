import { existsSync, lstatSync, readlinkSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export interface LayoutPaths {
  installDir: string;
  resourcesDir: string;
  appAsar: string;
  originalAsar: string;
  unpacked: string;
  junction: string;
}

export function layoutPaths(installDir: string): LayoutPaths {
  const resourcesDir = join(installDir, "resources");
  return {
    installDir,
    resourcesDir,
    appAsar: join(resourcesDir, "app.asar"),
    originalAsar: join(resourcesDir, "_app.asar"),
    unpacked: join(resourcesDir, "app.asar.unpacked"),
    junction: join(resourcesDir, "_app.asar.unpacked"),
  };
}

export interface JunctionInfo {
  path: string;
  present: boolean;
  isSymlink: boolean;
  /** Resolved absolute target, when the link can be read. */
  target: string | null;
  targetExists: boolean;
}

/** Inspects resources/_app.asar.unpacked without following it. */
export function junctionInfo(resourcesDir: string): JunctionInfo {
  const path = join(resourcesDir, "_app.asar.unpacked");
  let present = false;
  let isSymlink = false;
  let target: string | null = null;
  try {
    const stat = lstatSync(path);
    present = true;
    isSymlink = stat.isSymbolicLink();
    if (isSymlink) {
      const raw = readlinkSync(path);
      target = resolve(resourcesDir, raw);
    }
  } catch {
    return { path, present: false, isSymlink: false, target: null, targetExists: false };
  }
  let targetExists = false;
  if (target) {
    try {
      targetExists = statSync(target).isDirectory();
    } catch {
      targetExists = false;
    }
  }
  return { path, present, isSymlink, target, targetExists };
}

export function pathExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}
