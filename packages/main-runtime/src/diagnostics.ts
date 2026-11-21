import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Troubleshooting switches, for bisecting a misbehaving install without safe mode
 * (which turns everything off at once). Each is `T3P_NO_<NAME>=1` or a marker file
 * under `<home>/.t3-patcher/` that stays until deleted. Plugins are unaffected
 * except that disabling injection also hides renderer-only plugins.
 */
export interface DiagnosticToggles {
  /** No protocol wrap and no renderer bootstrap: the stock page, no plugin UI. */
  noInject: boolean;
  /** No plugin host load: e.g. no MCP Relay, no devtools poller. */
  noPlugins: boolean;
  /** No turn guard and no server hook: no spawn wrap, no server patches. */
  noGuard: boolean;
  reasons: string[];
}

export interface DiagnosticsInput {
  env: NodeJS.ProcessEnv;
  /** `<home>/.t3-patcher`. */
  baseDir: string;
  exists?: (path: string) => boolean;
}

const TOGGLES = [
  ["noInject", "no-inject", "T3P_NO_INJECT"],
  ["noPlugins", "no-plugins", "T3P_NO_PLUGINS"],
  ["noGuard", "no-guard", "T3P_NO_GUARD"],
] as const;

export function detectDiagnostics(input: DiagnosticsInput): DiagnosticToggles {
  const exists = input.exists ?? existsSync;
  const result: DiagnosticToggles = { noInject: false, noPlugins: false, noGuard: false, reasons: [] };
  for (const [key, marker, envName] of TOGGLES) {
    if (input.env[envName] === "1") {
      result[key] = true;
      result.reasons.push(`${envName}=1`);
      continue;
    }
    try {
      if (exists(join(input.baseDir, marker))) {
        result[key] = true;
        result.reasons.push(`${marker} marker`);
      }
    } catch {
      // unreadable marker: off
    }
  }
  return result;
}
