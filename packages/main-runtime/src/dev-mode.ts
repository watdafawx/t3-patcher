import { existsSync } from "node:fs";

export interface DevModeInput {
  env: NodeJS.ProcessEnv;
  /** <T3P_HOME>/.t3-patcher/dev-mode, written by `t3p dev`. */
  markerPath: string;
}

export interface DevModeResult {
  dev: boolean;
  reason: string | null;
}

/**
 * Dev mode switches on the WP-3A hot-reload watcher and `t3.__dev`.
 * Two triggers: `T3P_DEV=1` for one launch, or the persistent `dev-mode`
 * marker that `t3p dev` writes. Unlike the safe-mode marker, this one is not
 * consumed: it lasts until `t3p dev --unlink` removes the last dev link.
 */
export function detectDevMode(input: DevModeInput): DevModeResult {
  if (input.env.T3P_DEV === "1") return { dev: true, reason: "T3P_DEV=1" };
  try {
    if (existsSync(input.markerPath)) return { dev: true, reason: "dev-mode marker" };
  } catch {
    // unreadable marker: not dev mode
  }
  return { dev: false, reason: null };
}
