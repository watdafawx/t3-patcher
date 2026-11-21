import type { Stats } from "node:fs";

/** T3 Code builds this installer knows how to patch. */
export const SUPPORTED_VERSIONS: readonly string[] = ["0.1.10", "0.1.11", "0.1.12"];

/**
 * True for a supported release and for its channel builds
 * (`0.1.12-nightly.20261121.5051`). The suffix carries only a date and build
 * number; the leading release is what says which client the patches were
 * checked against. `--force` is still required for any other release.
 */
export function isSupportedVersion(
  version: string | null | undefined,
  supported: readonly string[] = SUPPORTED_VERSIONS,
): boolean {
  if (!version) return false;
  return supported.some((base) => version === base || version.startsWith(`${base}-`));
}

/** The three Electron fuses that decide whether a replacement app.asar can load. */
export interface FuseState {
  onlyLoadAppFromAsar: boolean;
  embeddedAsarIntegrityValidation: boolean;
  runAsNode: boolean;
}

export type ReadFuses = (exePath: string) => Promise<FuseState>;

export type Channel = "beta" | "nightly" | "stable" | "unknown";

export interface InstallInfo {
  installDir: string;
  exePath: string;
  resourcesDir: string;
  version: string | null;
  channel: Channel;
}

export type Layout = "unpatched" | "patched" | "stale" | "broken" | "unknown";

export interface StatusReport {
  layout: Layout;
  install?: InstallInfo;
  manifestPresent: boolean;
  reasons: string[];
}

/** One file the installer copied into the runtime folder. */
export interface RuntimeFile {
  /** Path relative to the runtime folder, with forward slashes. */
  path: string;
  sha256: string;
}

export interface InstallEntry {
  installDir: string;
  exePath: string;
  appVersion: string | null;
  installedAt: string;
  originalAsarSha256: string;
  replacementAsarSha256: string;
  junction: boolean;
  runtimeFiles: RuntimeFile[];
}

export interface InstallManifest {
  version: 1;
  installs: Record<string, InstallEntry>;
}

export interface SwapHooks {
  /** Called after the replacement asar is built and before app.asar is touched. */
  beforeSwap?: () => void | Promise<void>;
}

/** Options every entry point accepts, so tests can point at a fake tree. */
export interface CommonOpts {
  homeDir?: string;
  platform?: NodeJS.Platform;
  readFuses?: ReadFuses;
  /** Injectable fs.renameSync, used to simulate a running app (EBUSY/EPERM). */
  rename?: (from: string, to: string) => void;
  hooks?: SwapHooks;
  /** Overridable for tests; defaults to console.log. */
  log?: (message: string) => void;
}

export interface FindInstallsOpts {
  homeDir?: string;
  platform?: NodeJS.Platform;
  /** Defaults to %LOCALAPPDATA% (Windows) or <homeDir>/AppData/Local. */
  localAppDataDir?: string;
  /** Raw `reg query` stdout, or null to skip the registry. Injectable for tests. */
  registryQuery?: () => string | null;
}

export interface StatusOpts extends CommonOpts, FindInstallsOpts {
  /** Install directory. Omit to use the single detected install. */
  path?: string;
  localAppDataDir?: string;
}

export interface InstallOpts extends CommonOpts, FindInstallsOpts {
  path?: string;
  force?: boolean;
  /** Directory copied to <home>/.t3-patcher/runtime. */
  runtimeSource?: string;
  /** Leave <home>/.t3-patcher/runtime as it is (the repair worker runs from there). */
  skipRuntime?: boolean;
  /**
   * Repair-worker interpreter: "auto" copies the app's Electron exe to
   * <home>/.t3-patcher/bin when there is no node.exe on PATH, "copy" always
   * copies, "skip" never does. Default "auto"; ignored with skipRuntime.
   */
  workerNode?: "auto" | "copy" | "skip";
  /** Test seam for the PATH lookup of the worker interpreter. */
  env?: NodeJS.ProcessEnv;
  /** Test seam: the text of the shim entry. Defaults to @t3p/shim SHIM_SOURCE. */
  shimSource?: string;
  /**
   * Internal, used by repair after an upstream update: accept a version that is
   * not in SUPPORTED_VERSIONS without asking for --force. Fuses are still checked.
   */
  allowUnsupportedVersion?: boolean;
  /**
   * On an already patched app: refresh <home>/.t3-patcher/runtime (and the shim
   * when it changed) from the runtime source. Default true; repair turns it off.
   */
  refreshRuntime?: boolean;
}

export interface InstallResult {
  /**
   * "installed" when the layout changed, "updated" when an already patched app
   * got a newer runtime, "noop" when it was already patched and up to date.
   */
  status: "installed" | "updated" | "noop";
  /** Set for "updated": runtime labels before and after (from is null when no runtime was installed). */
  runtimeUpdate?: { from: string | null; to: string; shimChanged: boolean };
  install: InstallInfo;
  changed: boolean;
  manifestPath: string;
  originalAsarSha256: string;
  replacementAsarSha256: string;
  runtime: { source: string | null; files: number } | null;
  /** What ensureWorkerNode did, or null when skipped. */
  workerNode?: "system-node" | "copied" | "present" | "not-windows" | "failed" | null;
  warnings: string[];
}

export interface UninstallOpts {
  path?: string;
  purge?: boolean;
  homeDir?: string;
  platform?: NodeJS.Platform;
  localAppDataDir?: string;
  log?: (message: string) => void;
}

export interface RepairOpts extends InstallOpts {
  /** Only act when the layout is stale-after-update. */
  ifStale?: boolean;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SignatureCheck {
  ok: boolean;
  detail: string;
}

export interface DoctorOpts extends StatusOpts {
  /** Injectable Authenticode reader; defaults to powershell Get-AuthenticodeSignature. */
  verifySignature?: (exePath: string, platform: NodeJS.Platform) => Promise<SignatureCheck>;
}

/** Internal snapshot of one path, used to describe layouts in status reasons. */
export interface PathSnapshot {
  path: string;
  exists: boolean;
  stat?: Stats;
}
