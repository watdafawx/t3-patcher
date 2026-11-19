import { isRootPermission, PERMISSION_NAMES, type PermissionName, type PermissionSet } from "./permissions.js";
import { grantPermission, type PatcherStateJson, revokePermission } from "./state.js";

/**
 * Plain-English descriptions of every permission, shared by the Plugins settings page, the main
 * process' native grant dialog and the CLI. Keep them short and concrete: the user reads them while
 * deciding whether to trust a plugin.
 */

export type PermissionRisk = "high" | "medium" | "low";

export interface PermissionInfo {
  /** Short label: "Run programs". */
  title: string;
  /** What the plugin can do with it, one or two sentences. */
  meaning: string;
  risk: PermissionRisk;
}

export const PERMISSION_INFO: Readonly<Record<PermissionName, PermissionInfo>> = Object.freeze({
  main: {
    title: "Run code in the main process",
    meaning: "Runs its own code in T3 Code's main process with full Node.js and Electron access: the same as installing a program.",
    risk: "high",
  },
  patches: {
    title: "Rewrite the app's code",
    meaning: "Changes T3 Code's own interface code as it loads, so it can see and change anything the app shows or does.",
    risk: "high",
  },
  spawn: {
    title: "Run programs",
    meaning: "Starts the listed programs on your PC as you. Granting a shell or script interpreter means it can run anything.",
    risk: "high",
  },
  "fs.read": {
    title: "Read files",
    meaning: "Reads any file inside the listed folders.",
    risk: "high",
  },
  guard: {
    title: "Watch and stop turns",
    meaning: "Sees the start of every message and delegated task before it runs, and can hold, block or move it to another model.",
    risk: "high",
  },
  "embed.youtube": {
    title: "Change YouTube embed requests",
    meaning: "The main process adds a Referer header to YouTube nocookie embed frames so videos play. No other site or header is touched.",
    risk: "high",
  },
  "sqlite.read": {
    title: "Read databases",
    meaning: "Runs read-only queries on SQLite databases inside the listed folders. It cannot write to them.",
    risk: "medium",
  },
  "log.tail": {
    title: "Follow log files",
    meaning: "Reads the end of files inside the listed folders as they grow.",
    risk: "medium",
  },
  rpc: {
    title: "Talk to the T3 server",
    meaning: "Calls the T3 Code server through t3.rpc: read threads and settings, start turns. Renderer code can reach the server anyway, so this is a consent record.",
    risk: "medium",
  },
});

/**
 * Permissions that always need the native confirmation dialog. Hardcoded on purpose: there is no
 * setting, flag or "don't ask again" that skips it. (Today every grant from the UI shows the dialog;
 * this list is the floor that must never shrink.)
 */
export const HIGH_RISK_PERMISSIONS: readonly PermissionName[] = Object.freeze(["spawn", "main", "patches", "fs.read", "guard", "embed.youtube"] as PermissionName[]);

export function isHighRisk(name: string): boolean {
  return (HIGH_RISK_PERMISSIONS as readonly string[]).includes(name);
}

export function permissionInfo(name: string): PermissionInfo {
  return (PERMISSION_INFO as Record<string, PermissionInfo>)[name] ?? { title: name, meaning: "Unknown permission.", risk: "high" };
}

/** Names present in a permission set, in the canonical order. */
export function permissionNames(set: PermissionSet): PermissionName[] {
  return PERMISSION_NAMES.filter((name) => (set as Record<string, unknown>)[name] !== undefined);
}

/** The scope list (roots or executables) a permission carries, or an empty list for unscoped ones. */
export function permissionScope(set: PermissionSet, name: string): string[] {
  if (isRootPermission(name)) return [...(set[name]?.roots ?? [])];
  if (name === "spawn") return [...(set.spawn?.allow ?? [])];
  return [];
}

/** One line for a dialog or a terminal: `fs.read (high risk): Read files. Reads any file inside the listed folders. Scope: ~/x, ~/y`. */
export function describePermission(name: string, declared: PermissionSet): string {
  const info = permissionInfo(name);
  const scope = permissionScope(declared, name);
  return `${name} (${info.risk} risk): ${info.title}. ${info.meaning}${scope.length > 0 ? ` Scope: ${scope.join(", ")}` : ""}`;
}

/** Declared permissions that are not effective yet (what a "Grant" button may ask for). */
export function missingPermissionNames(declared: PermissionSet, effective: PermissionSet): PermissionName[] {
  return permissionNames(declared).filter((name) => (effective as Record<string, unknown>)[name] === undefined);
}

/**
 * Grants `names` to plugin `id` with exactly the scope the manifest declares (roots or executables).
 * The single writer of grant logic: the CLI (`t3p grant` without --root/--allow) and the main process'
 * confirmed dialog both call it. Names the manifest does not declare are refused.
 */
export function grantDeclared(state: PatcherStateJson, id: string, declared: PermissionSet, names: readonly string[]): PatcherStateJson {
  for (const name of names) {
    if ((declared as Record<string, unknown>)[name] === undefined) throw new Error(`plugin ${id} does not declare "${name}"`);
  }
  for (const name of names) grantPermission(state, id, name, permissionScope(declared, name));
  return state;
}

/** Revokes every name in `names` (no-op for names that were not granted). */
export function revokeNames(state: PatcherStateJson, id: string, names: readonly string[]): PatcherStateJson {
  for (const name of names) revokePermission(state, id, name);
  return state;
}
