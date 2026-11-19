import { readAsarFiles, listAsarFiles } from "./asar.js";

export interface AsarIdentity {
  /** "name" from the packaged package.json, e.g. "t3code". */
  name?: string;
  /** "version", e.g. "0.1.11-nightly.20261118.4903". */
  version?: string;
  /** "t3codeCommitHash" when the build recorded one. */
  commit?: string;
}

/**
 * The version a `server.asar`/`app.asar` reports about itself. Used when the
 * target is a local file rather than a tag, so the report can still say what it
 * is looking at.
 */
export function readAsarIdentity(asarPath: string): AsarIdentity {
  const files = listAsarFiles(asarPath);
  const candidates = files.filter(
    (file) => /(^|\/)package\.json$/.test(file.path) && !file.path.includes("node_modules/"),
  );
  const preferred =
    candidates.find((file) => file.path === "apps/server/package.json") ??
    candidates.find((file) => file.path === "package.json") ??
    candidates[0];
  if (!preferred) return {};
  try {
    const contents = readAsarFiles(asarPath, [preferred]).get(preferred.path);
    if (!contents) return {};
    const parsed = JSON.parse(contents.toString("utf8")) as Record<string, unknown>;
    return {
      name: typeof parsed.name === "string" ? parsed.name : undefined,
      version: typeof parsed.version === "string" ? parsed.version : undefined,
      commit: typeof parsed.t3codeCommitHash === "string" ? parsed.t3codeCommitHash : undefined,
    };
  } catch {
    return {};
  }
}
