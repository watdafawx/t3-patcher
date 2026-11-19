/**
 * `t3-patcher/registry`: the plugin registry client shared by the `t3p plugins ...` CLI and the app's
 * main process (WP-14A). Node only, no Electron. See docs/registry.md.
 */
import { type RegistryEntry, type RegistryIndex, registryInstallState, type RegistryInstallState } from "@t3p/api";

import { installedInfo } from "./registry/install.js";

export { configPath, fetchRegistryIndex, findEntry, INDEX_TIMEOUT_MS, resolveRegistry, type FetchIndexOptions, type IndexResult, type RegistryConfig } from "./registry/client.js";
export { allowInsecureLocal, getCapped, GITHUB_DOWNLOAD_HOSTS, RegistryNetError, type FetchLike, type GetOptions, type ResponseLike } from "./registry/net.js";
export {
  applyInstallState,
  DOWNLOAD_TIMEOUT_MS,
  downloadVerified,
  installedInfo,
  installedVersion,
  installFromRegistry,
  pluginsDirOf,
  RegistryInstallError,
  uninstallPlugin,
  type InstalledInfo,
  type InstallFromRegistryOptions,
  type InstallFromRegistryResult,
  type UninstallResult,
} from "./registry/install.js";
export { checkZipPath, crc32, DEFAULT_ZIP_LIMITS, readZip, writeZip, ZipError, type ZipFile, type ZipLimits, type ZipWriteEntry } from "./registry/zip.js";

export interface RegistryRow {
  entry: RegistryEntry;
  installed: string | null;
  devLink: boolean;
  state: RegistryInstallState;
}

/** Each registry entry with what is installed locally. */
export function registryRows(index: RegistryIndex, homeDir?: string): RegistryRow[] {
  return index.plugins.map((entry) => {
    const info = installedInfo(entry.id, homeDir);
    return { entry, installed: info?.version ?? null, devLink: info?.devLink ?? false, state: info ? registryInstallState(entry, info.version ?? "0.0.0-unknown") : "install" };
  });
}
