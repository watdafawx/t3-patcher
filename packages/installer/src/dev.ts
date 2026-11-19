import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { isValidPluginId, validateManifest } from "@t3p/api";

import { T3pError } from "./errors.js";
import { enable, patcherBase, statePath } from "./plugin-admin.js";

/**
 * `t3p dev <folder>`: a plugin under development is linked (junction on Windows,
 * directory symlink elsewhere) into `<T3P_HOME>/.t3-patcher/plugins/<id>/`,
 * enabled in state.json, and dev-mode hot reload is switched on with the
 * `dev-mode` marker that the main runtime reads (the WP-3A watcher).
 *
 * A real (non-link) `plugins/<id>` folder is never overwritten or deleted.
 */

export const DEV_MARKER = "dev-mode";

export interface DevOptions {
  /** T3P home override; tests pass a temp dir. */
  homeDir?: string;
  /** Test seam. Defaults to process.platform. */
  platform?: NodeJS.Platform;
}

export interface DevLinkOptions extends DevOptions {
  /** The plugin folder to link. */
  folder: string;
}

export interface DevLinkResult {
  id: string;
  /** Absolute source folder. */
  folder: string;
  /** Absolute path of the link inside the plugins dir. */
  link: string;
  /** Absolute state.json path. */
  stateFile: string;
  /** Absolute dev-mode marker path. */
  marker: string;
  /** False when the link already pointed at this folder. */
  changed: boolean;
}

export interface DevUnlinkResult {
  id: string;
  link: string;
  removed: boolean;
  /** True when no dev link is left and the dev-mode marker was removed. */
  devModeOff: boolean;
}

export function pluginsDir(homeDir?: string): string {
  return join(patcherBase(homeDir), "plugins");
}

export function devMarkerPath(homeDir?: string): string {
  return join(patcherBase(homeDir), DEV_MARKER);
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function samePath(link: string, folder: string): boolean {
  try {
    return resolve(realpathSync(link)) === resolve(realpathSync(folder));
  } catch {
    return false;
  }
}

/** Reads the id from `<folder>/plugin.json` and validates the manifest (folder name is not checked). */
export function readDevPluginId(folder: string): string {
  const file = join(folder, "plugin.json");
  if (!existsSync(file)) throw new T3pError(`no plugin.json in ${folder}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new T3pError(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  const result = validateManifest(raw);
  if (!result.ok) throw new T3pError(`${file} is invalid: ${result.errors.join("; ")}`);
  return result.manifest.id;
}

/** Plugin ids that are currently dev links (symbolic links or junctions). */
export function devLinkedIds(homeDir?: string): string[] {
  const dir = pluginsDir(homeDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => isValidPluginId(name) && isLink(join(dir, name)))
    .sort();
}

function writeMarker(homeDir: string | undefined, ids: string[]): string {
  const marker = devMarkerPath(homeDir);
  if (ids.length === 0) {
    rmSync(marker, { force: true });
    return marker;
  }
  mkdirSync(patcherBase(homeDir), { recursive: true });
  writeFileSync(marker, `${JSON.stringify({ version: 1, plugins: ids, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  return marker;
}

export function devLink(options: DevLinkOptions): DevLinkResult {
  const folder = resolve(options.folder);
  if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new T3pError(`not a plugin folder: ${folder}`);
  const id = readDevPluginId(folder);

  const dir = pluginsDir(options.homeDir);
  mkdirSync(dir, { recursive: true });
  const link = join(dir, id);

  let changed = true;
  if (existsSync(link) || isLink(link)) {
    if (!isLink(link)) {
      throw new T3pError(`${link} is a real plugin folder, not a dev link; refusing to overwrite it (move it away first)`);
    }
    if (!samePath(link, folder)) {
      let target = link;
      try {
        target = realpathSync(link);
      } catch {
        // keep the raw path for the message
      }
      throw new T3pError(`${link} already links to ${target}; run "t3p dev --unlink ${id}" first`);
    }
    changed = false;
  } else {
    const type = (options.platform ?? process.platform) === "win32" ? "junction" : "dir";
    symlinkSync(folder, link, type);
  }

  const stateFile = statePath(options.homeDir);
  enable({ homeDir: options.homeDir, id, enabled: true });
  const marker = writeMarker(options.homeDir, devLinkedIds(options.homeDir));

  return { id, folder, link, stateFile, marker, changed };
}

export function devUnlink(id: string, options: DevOptions = {}): DevUnlinkResult {
  if (!isValidPluginId(id)) throw new T3pError(`invalid plugin id ${JSON.stringify(id)}`);
  const link = join(pluginsDir(options.homeDir), id);
  if (!existsSync(link) && !isLink(link)) throw new T3pError(`no plugin folder ${link}`);
  if (!isLink(link)) throw new T3pError(`${link} is a real plugin folder, not a dev link; refusing to delete it`);

  unlinkSync(link);
  enable({ homeDir: options.homeDir, id, enabled: false });
  const remaining = devLinkedIds(options.homeDir);
  writeMarker(options.homeDir, remaining);
  return { id, link, removed: true, devModeOff: remaining.length === 0 };
}
