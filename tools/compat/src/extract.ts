import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

import type { Log } from "./release.js";

/**
 * Pulling `resources/server.asar` out of the Windows NSIS installer without
 * running it: 7-Zip reads the NSIS container, which holds a single
 * `$PLUGINSDIR/app-64.7z`; the second pass reads `resources/server.asar` out of
 * that archive. Nothing is installed, nothing is executed.
 */

const SEVEN_ZIP_CANDIDATES = [
  "C:\\Program Files\\7-Zip\\7z.exe",
  "C:\\Program Files (x86)\\7-Zip\\7z.exe",
];

/** Finds a 7-Zip binary: `T3P_7Z`, PATH, then the usual install locations. */
export function findSevenZip(explicit?: string): string | undefined {
  if (explicit) return existsSync(explicit) ? explicit : undefined;
  const fromEnv = process.env.T3P_7Z;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const pathExt = process.platform === "win32" ? [".exe"] : [""];
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const names = process.platform === "win32" ? ["7z", "7za", "7zz"] : ["7z", "7za", "7zz"];
  for (const name of names) {
    for (const dir of dirs) {
      for (const ext of pathExt) {
        const candidate = join(dir, `${name}${ext}`);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  for (const candidate of SEVEN_ZIP_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function run(sevenZip: string, args: string[], timeoutMs = 900_000): void {
  const result = spawnSync(sevenZip, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`${sevenZip} failed: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim().split("\n").slice(-5).join("\n");
    throw new Error(`${sevenZip} ${args.join(" ")} exited ${result.status}\n${detail}`);
  }
}

function findNestedArchive(dir: string): string | undefined {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/^app-\d+\.7z$/i.test(entry.name) || /^app\.7z$/i.test(entry.name)) found.push(full);
    }
  };
  walk(dir);
  return found.sort((a, b) => statSync(b).size - statSync(a).size)[0];
}

export interface ExtractOptions {
  /** NSIS installer (.exe), or the inner `app-64.7z`. */
  installer: string;
  /** Where `server.asar` ends up. */
  outFile: string;
  /** Scratch directory (cleared before use). */
  workDir: string;
  sevenZip?: string;
  log: Log;
}

function exists(file: string): boolean {
  return existsSync(file);
}

/**
 * Extracts `resources/server.asar`. Accepts the NSIS installer or the
 * `app-64.7z` it contains; a `.zip` portable build is not supported (the
 * Windows release does not ship one).
 */
export function extractServerAsar(options: ExtractOptions): string {
  const sevenZip = findSevenZip(options.sevenZip);
  if (!sevenZip) {
    throw new Error(
      "7-Zip not found: install it, set T3P_7Z, or pass --seven-zip <path> (or --server-asar <path> to skip extraction)",
    );
  }
  if (!exists(options.installer)) throw new Error(`installer not found: ${options.installer}`);

  const name = options.installer.toLowerCase();
  if (name.endsWith(".zip")) {
    throw new Error(
      `${options.installer}: the portable Windows release is a .zip without server.asar; use the NSIS .exe installer`,
    );
  }

  mkdirSync(options.workDir, { recursive: true });
  let inner = options.installer;
  let scratch: string | undefined;

  if (!name.endsWith(".7z")) {
    scratch = join(options.workDir, "nsis");
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    mkdirSync(scratch, { recursive: true });
    options.log.info(`7z: reading the NSIS installer ${options.installer}`);
    run(sevenZip, ["x", "-y", `-o${scratch}`, options.installer]);
    const nested = findNestedArchive(scratch);
    if (!nested) throw new Error(`${options.installer}: no app-*.7z payload inside the installer`);
    inner = nested;
    options.log.info(`7z: payload ${nested}`);
  }

  const outDir = dirname(options.outFile);
  mkdirSync(outDir, { recursive: true });
  rmSync(options.outFile, { force: true });
  run(sevenZip, ["e", "-y", `-o${outDir}`, inner, "resources/server.asar"]);
  if (scratch) rmSync(scratch, { recursive: true, force: true });

  if (!exists(options.outFile)) {
    throw new Error(`${inner}: no resources/server.asar inside this archive`);
  }
  return options.outFile;
}
