import { chmodSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Deletes a directory tree, tolerating Windows read-only bits.
 *
 * `fs.rmSync(recursive)` gives up with EPERM on a file marked read-only, which
 * is what a `git clone --depth 1` leaves behind (its object files). The cache
 * holds those clones, so `--clean` clears the bit first.
 *
 * Returns the paths that could not be removed: a file another process holds
 * open (an antivirus scan of the 256 MB asar, say) should not stop the rest of
 * the cleanup or crash the command.
 */
export function removeTree(path: string): string[] {
  if (!existsSync(path)) return [];
  makeWritable(path);
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
    return [];
  } catch {
    const failures: string[] = [];
    for (const entry of readdirSync(path)) {
      const child = join(path, entry);
      makeWritable(child);
      try {
        rmSync(child, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
      } catch {
        failures.push(child);
      }
    }
    if (failures.length === 0) {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        failures.push(path);
      }
    }
    return failures;
  }
}

function makeWritable(path: string): void {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return;
  }
  if (!stat.isDirectory()) {
    try {
      chmodSync(path, 0o666);
    } catch {
      // already writable, or gone
    }
    return;
  }
  try {
    chmodSync(path, 0o777);
  } catch {
    // best effort
  }
  try {
    for (const entry of readdirSync(path)) makeWritable(join(path, entry));
  } catch {
    // unreadable directory: the delete below reports it
  }
}
