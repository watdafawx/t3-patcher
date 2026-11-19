import { spawn as nodeSpawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { extname } from "node:path";

import { lexicalNormalize } from "./path-guard.js";
import { resolveAllowedExe, scrubEnv, type SpawnOptions } from "./spawn.js";

/** A long-lived allowlisted process. Main-side only (`ctx.native.spawnSession`). */
export interface SpawnSessionRequest {
  exe: string;
  args: string[];
  /** One call per stdout line (UTF-8, `\n` or `\r\n` stripped). Lines over 1 MiB are dropped. */
  onLine(line: string): void;
  /** Called once when the process ends (also after `kill()`). `stderr` is the last 8 KiB. */
  onExit?(info: { code: number | null; signal: string | null; stderr: string }): void;
}

export interface SpawnSession {
  readonly pid: number | undefined;
  /** Writes to stdin. `false` once the process ended. */
  write(text: string): boolean;
  /** Ends stdin, then kills the process. Idempotent. */
  kill(): void;
}

const MAX_LINE = 1024 * 1024;
const MAX_STDERR = 8 * 1024;
const MAX_ARGS = 24;

/** PowerShell switches a session may pass. Anything that can carry code (-Command, -EncodedCommand, -c, -e) is absent on purpose. */
const SAFE_FLAGS = new Set(["-noprofile", "-noninteractive", "-nologo", "-sta", "-mta"]);
const SAFE_FLAG_VALUES = new Map<string, Set<string>>([
  ["-executionpolicy", new Set(["bypass", "remotesigned", "unrestricted"])],
  ["-windowstyle", new Set(["hidden"])],
]);

/**
 * Validates session args: only the fixed safe switches, then `-File <script>` where `<script>` is a `.ps1`
 * whose real path equals the real path of a granted allowlist entry. No extra args after the script.
 * Returns the resolved script path, or a reason.
 */
export function checkSessionArgs(args: unknown, options: SpawnOptions): { ok: true; script: string } | { ok: false; reason: string } {
  if (!Array.isArray(args) || args.length === 0 || args.length > MAX_ARGS || !args.every((a) => typeof a === "string" && a.length <= 1024 && !a.includes("\0"))) {
    return { ok: false, reason: "args must be a short array of strings" };
  }
  const realpath = options.realpath ?? ((p: string) => realpathSync.native(p));
  const fold = (p: string): string => (options.platform === "win32" ? p.toLowerCase() : p);
  let i = 0;
  while (i < args.length) {
    const flag = (args[i] as string).toLowerCase();
    if (flag === "-file") break;
    if (SAFE_FLAGS.has(flag)) {
      i += 1;
      continue;
    }
    const values = SAFE_FLAG_VALUES.get(flag);
    if (values) {
      const value = (args[i + 1] ?? "").toLowerCase();
      if (!values.has(value)) return { ok: false, reason: `value for ${args[i]} is not allowed` };
      i += 2;
      continue;
    }
    return { ok: false, reason: `argument ${JSON.stringify(args[i])} is not allowed in a session` };
  }
  if (i >= args.length || args.length !== i + 2) return { ok: false, reason: "args must end with -File <script> and nothing after it" };
  const lexical = lexicalNormalize(args[i + 1], options);
  if (!lexical.ok) return lexical;
  if (extname(lexical.path).toLowerCase() !== ".ps1") return { ok: false, reason: "the script must be a .ps1" };
  let real: string;
  try {
    real = realpath(lexical.path);
  } catch {
    return { ok: false, reason: "script does not exist" };
  }
  for (const entry of options.allow) {
    const allowed = lexicalNormalize(entry, options);
    if (!allowed.ok || extname(allowed.path).toLowerCase() !== ".ps1") continue;
    try {
      if (fold(realpath(allowed.path)) === fold(real)) return { ok: true, script: real };
    } catch {
      continue;
    }
  }
  return { ok: false, reason: "script is not in the granted allowlist" };
}

/**
 * Starts one long-lived allowlisted process: the executable must be granted (as `spawn`), and the args are
 * restricted to `-File <granted .ps1>` plus a few safe switches, so a plugin cannot turn a granted
 * powershell.exe into arbitrary code. No shell, hidden window, scrubbed env, cwd = patcher home.
 */
export function createSpawnSession(options: SpawnOptions): (request: SpawnSessionRequest) => SpawnSession {
  const spawnImpl = options.spawnImpl ?? nodeSpawn;
  return (request) => {
    const exe = resolveAllowedExe(request.exe, options);
    if (!exe.ok) throw new Error(`t3p: spawnSession denied: ${exe.reason}`);
    const script = checkSessionArgs(request.args, options);
    if (!script.ok) throw new Error(`t3p: spawnSession denied: ${script.reason}`);
    if (typeof request.onLine !== "function") throw new Error("t3p: spawnSession: onLine must be a function");
    const child = spawnImpl(exe.path, request.args, {
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: false,
      env: scrubEnv(options.env ?? process.env, options.platform),
      cwd: options.home,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let ended = false;
    let buffer = "";
    let skipping = false;
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (skipping) skipping = false;
        else if (line.length <= MAX_LINE) {
          try {
            request.onLine(line);
          } catch {
            // a throwing consumer must not kill the reader
          }
        }
        nl = buffer.indexOf("\n");
      }
      if (buffer.length > MAX_LINE) {
        buffer = "";
        skipping = true;
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR);
    });
    child.stdin?.on("error", () => undefined);
    const finish = (code: number | null, signal: string | null): void => {
      if (ended) return;
      ended = true;
      try {
        request.onExit?.({ code, signal, stderr });
      } catch {
        // ignore
      }
    };
    child.once("error", (error) => {
      stderr += String(error.message);
      finish(null, null);
    });
    child.once("close", (code, signal) => finish(code, signal ?? null));
    return {
      pid: child.pid,
      write(text: string): boolean {
        if (ended || !child.stdin || child.stdin.destroyed || !child.stdin.writable) return false;
        child.stdin.write(String(text).slice(0, 64 * 1024));
        return true;
      },
      kill(): void {
        if (ended) return;
        try {
          child.stdin?.end();
        } catch {
          // ignore
        }
        try {
          child.kill();
        } catch {
          // ignore
        }
      },
    };
  };
}
