import { spawn as nodeSpawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { extname } from "node:path";

import { lexicalNormalize, type PathPlatform } from "./path-guard.js";

export interface SpawnRequest {
  exe: string;
  args?: string[];
  timeoutMs?: number;
  /** Text written to stdin, then stdin is closed. */
  stdin?: string;
}

export interface SpawnResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  ms: number;
}

export interface SpawnOptions {
  /** Exact executables (absolute paths) the plugin declared AND the user granted. Empty = spawn unavailable. */
  allow: readonly string[];
  platform: PathPlatform;
  home: string;
  env?: NodeJS.ProcessEnv;
  realpath?: (p: string) => string;
  spawnImpl?: typeof nodeSpawn;
}

export const SPAWN_DEFAULT_TIMEOUT = 10_000;
export const SPAWN_MAX_TIMEOUT = 120_000;
export const SPAWN_MAX_OUTPUT = 1024 * 1024;
const MAX_ARGS = 64;
const MAX_ARG = 8192;

/** Variables passed through to the child. Everything else (tokens, ELECTRON_*, NODE_OPTIONS, T3 secrets) is dropped. */
const ENV_KEEP_WIN = ["SystemRoot", "SystemDrive", "windir", "PATH", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA", "ProgramFiles", "ProgramFiles(x86)", "ProgramData", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS"];
const ENV_KEEP_POSIX = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER"];

export function scrubEnv(env: NodeJS.ProcessEnv, platform: PathPlatform): Record<string, string> {
  const keep = platform === "win32" ? ENV_KEEP_WIN : ENV_KEEP_POSIX;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const allowed = platform === "win32" ? keep.some((k) => k.toLowerCase() === key.toLowerCase()) : keep.includes(key);
    if (allowed) out[key] = value;
  }
  return out;
}

const norm = (p: string, platform: PathPlatform): string => (platform === "win32" ? p.toLowerCase() : p);

/**
 * Resolves `exe` against the allowlist: absolute, lexically clean, and the real
 * path equal to the real path of one allowed entry. On Windows only .exe/.com
 * (no .bat/.cmd: they run through cmd.exe and re-parse arguments).
 */
export function resolveAllowedExe(exe: unknown, options: SpawnOptions): { ok: true; path: string } | { ok: false; reason: string } {
  if (options.allow.length === 0) return { ok: false, reason: "spawn is not granted" };
  const lexical = lexicalNormalize(exe, options);
  if (!lexical.ok) return lexical;
  if (options.platform === "win32" && ![".exe", ".com"].includes(extname(lexical.path).toLowerCase())) {
    return { ok: false, reason: "only .exe or .com executables can be spawned" };
  }
  const realpath = options.realpath ?? ((p: string) => realpathSync.native(p));
  let real: string;
  try {
    real = realpath(lexical.path);
  } catch {
    return { ok: false, reason: "executable does not exist" };
  }
  for (const entry of options.allow) {
    const allowed = lexicalNormalize(entry, options);
    if (!allowed.ok) continue;
    let allowedReal: string;
    try {
      allowedReal = realpath(allowed.path);
    } catch {
      continue;
    }
    if (norm(allowedReal, options.platform) === norm(real, options.platform)) return { ok: true, path: real };
  }
  return { ok: false, reason: "executable is not in the granted allowlist" };
}

/**
 * Runs an allowlisted executable with an argv array: no shell, hidden window,
 * scrubbed env, timeout, capped output. Unavailable unless `spawn` was
 * declared and granted with an allowlist.
 */
export function createSpawn(options: SpawnOptions): (request: SpawnRequest) => Promise<SpawnResult> {
  const spawnImpl = options.spawnImpl ?? nodeSpawn;
  return (request) => {
    const exe = resolveAllowedExe(request.exe, options);
    if (!exe.ok) return Promise.reject(new Error(`t3p: spawn denied: ${exe.reason}`));
    const args = request.args ?? [];
    if (!Array.isArray(args) || args.length > MAX_ARGS || !args.every((a) => typeof a === "string" && a.length <= MAX_ARG && !a.includes("\0"))) {
      return Promise.reject(new Error(`t3p: spawn: args must be up to ${MAX_ARGS} strings without NUL`));
    }
    const timeoutMs = Math.min(Math.max(100, request.timeoutMs ?? SPAWN_DEFAULT_TIMEOUT), SPAWN_MAX_TIMEOUT);
    const started = Date.now();
    return new Promise((resolve, reject) => {
      let child: ReturnType<typeof nodeSpawn>;
      try {
        child = spawnImpl(exe.path, args, {
          shell: false,
          windowsHide: true,
          windowsVerbatimArguments: false,
          env: scrubEnv(options.env ?? process.env, options.platform),
          cwd: options.home,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        reject(new Error(`t3p: spawn failed: ${(error as Error).message}`));
        return;
      }
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let truncated = false;
      let timedOut = false;
      const collect = (chunks: Buffer[], size: number, chunk: Buffer): number => {
        const room = SPAWN_MAX_OUTPUT - size;
        if (room <= 0) {
          truncated = true;
          return size;
        }
        if (chunk.length > room) truncated = true;
        chunks.push(chunk.subarray(0, room));
        return size + Math.min(room, chunk.length);
      };
      child.stdout?.on("data", (c: Buffer) => (outBytes = collect(out, outBytes, c)));
      child.stderr?.on("data", (c: Buffer) => (errBytes = collect(err, errBytes, c)));
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(new Error(`t3p: spawn failed: ${error.message}`));
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        resolve({
          exitCode: code,
          signal: signal ?? null,
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8"),
          truncated,
          timedOut,
          ms: Date.now() - started,
        });
      });
      child.stdin?.on("error", () => undefined);
      if (request.stdin !== undefined) child.stdin?.end(String(request.stdin).slice(0, SPAWN_MAX_OUTPUT));
      else child.stdin?.end();
    });
  };
}
