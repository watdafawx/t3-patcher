import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { InstallEntry, InstallManifest, RuntimeFile } from "./types.js";

export function manifestPath(homeDir: string): string {
  return join(homeDir, ".t3-patcher", "install-manifest.json");
}

export function installKey(installDir: string): string {
  return installDir.toLowerCase();
}

export function readManifest(homeDir: string): InstallManifest | null {
  const file = manifestPath(homeDir);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as InstallManifest;
    if (parsed && parsed.version === 1 && parsed.installs && typeof parsed.installs === "object") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/** Writes the manifest, or deletes it when no installs remain. */
export function writeManifest(homeDir: string, manifest: InstallManifest): void {
  const file = manifestPath(homeDir);
  if (Object.keys(manifest.installs).length === 0) {
    // Nothing left to record: drop the file so a clean tree looks untouched.
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function removeManifestEntry(homeDir: string, installDir: string): boolean {
  const manifest = readManifest(homeDir);
  if (!manifest) return false;
  const key = installKey(installDir);
  if (!(key in manifest.installs)) return false;
  delete manifest.installs[key];
  writeManifest(homeDir, manifest);
  return true;
}

export function manifestEntry(homeDir: string, installDir: string): InstallEntry | null {
  const manifest = readManifest(homeDir);
  if (!manifest) return null;
  return manifest.installs[installKey(installDir)] ?? null;
}

export function sha256File(file: string): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(file));
  return hash.digest("hex");
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Recursively hashes every file under `root`; paths are relative with forward slashes. */
export function hashTree(root: string): RuntimeFile[] {
  const out: RuntimeFile[] = [];
  const walk = (dir: string, prefix: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) out.push({ path: rel, sha256: sha256File(abs) });
    }
  };
  walk(root, "");
  return out;
}
