import { existsSync, rmSync } from "node:fs";

export interface SafeModeInput {
  env: NodeJS.ProcessEnv;
  argv: readonly string[];
  markerPath: string;
}

export interface SafeModeResult {
  safe: boolean;
  reason: string | null;
}

/**
 * Safe mode: no plugins and no patches. The shim already skips the runtime for
 * these triggers; the runtime checks again so that it also holds when it is
 * loaded some other way (tests, a future shim). The marker file is consumed.
 */
export function detectSafeMode(input: SafeModeInput): SafeModeResult {
  if (input.env.T3P_SAFE === "1") return { safe: true, reason: "T3P_SAFE=1" };
  if (input.argv.includes("--t3p-safe")) return { safe: true, reason: "--t3p-safe" };
  try {
    if (existsSync(input.markerPath)) {
      rmSync(input.markerPath, { force: true });
      return { safe: true, reason: "safe-mode marker" };
    }
  } catch {
    // unreadable marker: not safe mode
  }
  return { safe: false, reason: null };
}
