export { SUPPORTED_VERSIONS } from "./types.js";
export type {
  Channel,
  CommonOpts,
  DoctorCheck,
  DoctorOpts,
  FindInstallsOpts,
  FuseState,
  InstallEntry,
  InstallInfo,
  InstallManifest,
  InstallOpts,
  InstallResult,
  Layout,
  ReadFuses,
  RepairOpts,
  RuntimeFile,
  SignatureCheck,
  StatusOpts,
  StatusReport,
  SwapHooks,
  UninstallOpts,
} from "./types.js";

export { AppRunningError, T3pError } from "./errors.js";

export { findInstalls, inspectInstall, resolveInstall, channelFromExeName } from "./installs.js";
export { install, defaultRuntimeSource, removeJunction } from "./install.js";
export { uninstall } from "./uninstall.js";
export { repair, repairRecorded } from "./repair.js";
export { ensureLogonTask, removeLogonTask, buildWrapper, DEFAULT_TASK_NAME } from "./logon-task.js";
export { status } from "./status.js";
export { doctor } from "./doctor.js";
export { readFusesFromExe, fusesAreSafe, describeFuses } from "./fuses.js";
export { manifestPath, readManifest, sha256File } from "./manifest.js";
export { buildReplacementAsar, readAsarPackageJson, isReplacementAsar } from "./asar.js";
export { junctionInfo, layoutPaths } from "./layout.js";
