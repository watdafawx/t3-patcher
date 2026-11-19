import { homedir } from "node:os";
import { join } from "node:path";

/** Every location the runtime reads or writes, all under <home>/.t3-patcher. */
export interface RuntimePaths {
  /** The user's home (T3P_HOME overrides it, as in the shim). */
  home: string;
  base: string;
  runtime: string;
  logs: string;
  cache: string;
  plugins: string;
  state: string;
  bin: string;
  safeMarker: string;
  /** Written by `t3p dev`; presence switches the WP-3A watcher on. */
  devMarker: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): RuntimePaths {
  const userHome = env.T3P_HOME || home;
  const base = join(userHome, ".t3-patcher");
  return {
    home: userHome,
    base,
    runtime: join(base, "runtime"),
    logs: join(base, "logs"),
    cache: join(base, "cache"),
    plugins: join(base, "plugins"),
    state: join(base, "state.json"),
    bin: join(base, "bin"),
    safeMarker: join(base, "safe-mode"),
    devMarker: join(base, "dev-mode"),
  };
}
