import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { listAsarFiles, readAsarFiles, type AsarFile } from "./asar.js";

/**
 * The client bundle: the web UI that ships inside `server.asar`, plus (when the
 * archive is available) the server JS that registers the RPC methods.
 */
export interface ClientBundle {
  /** "asar" or "dir". */
  kind: "asar" | "dir";
  /** Absolute asar path or client directory, for the report. */
  origin: string;
  /** Archive or directory prefix the chunks are relative to. */
  root: string;
  /** Chunk name (relative, forward slashes) -> source text. */
  chunks: Map<string, string>;
  /** HTML files by the same relative names (usually just index.html). */
  html: Map<string, string>;
  /** Total bytes of the chunks and HTML that were read. */
  bytes: number;
}

export interface ServerSources {
  /** Absolute path or archive the text came from, for the report. */
  origin: string;
  /** "server" (the shipped server bundle) or "client" (fallback: call sites). */
  evidence: "server" | "client";
  text: string;
  files: number;
  bytes: number;
  /** Server evidence only: archive path (forward slashes) -> text, for the server patch check. */
  chunks?: Map<string, string>;
}

const JS_RE = /\.m?js$/i;
const HTML_RE = /\.html?$/i;
const CLIENT_HINT = /apps\/server\/dist\/client\/index\.html$/;
const MAX_HTML_BYTES = 4 * 1024 * 1024;

function toText(buffer: Buffer): string {
  return buffer.toString("utf8");
}

function relativeName(path: string, root: string): string {
  return path.startsWith(root) ? path.slice(root.length) : path;
}

/** Picks the client root out of an archive listing: the dir holding `client/index.html`. */
export function findClientRoot(files: AsarFile[]): string | undefined {
  const indexFiles = files.filter((file) => file.path.endsWith("client/index.html"));
  const preferred = indexFiles.find((file) => CLIENT_HINT.test(file.path));
  const chosen = preferred ?? indexFiles.sort((a, b) => a.path.length - b.path.length)[0];
  if (!chosen) return undefined;
  return chosen.path.slice(0, -"index.html".length);
}

/** Reads the client out of a shipped `server.asar` (or `app.asar`). */
export function loadClientFromAsar(asarPath: string): ClientBundle {
  const files = listAsarFiles(asarPath);
  const root = findClientRoot(files);
  if (root === undefined) {
    throw new Error(
      `${asarPath}: no */client/index.html inside this archive, so it does not hold a T3 Code client`,
    );
  }
  const wanted = files.filter(
    (file) => file.path.startsWith(root) && (JS_RE.test(file.path) || HTML_RE.test(file.path)),
  );
  const contents = readAsarFiles(asarPath, wanted);

  const chunks = new Map<string, string>();
  const html = new Map<string, string>();
  let bytes = 0;
  for (const file of wanted) {
    const buffer = contents.get(file.path);
    if (!buffer) continue;
    bytes += buffer.length;
    const name = relativeName(file.path, root);
    if (HTML_RE.test(file.path)) {
      if (buffer.length <= MAX_HTML_BYTES) html.set(name, toText(buffer));
      continue;
    }
    chunks.set(name, toText(buffer));
  }
  return { kind: "asar", origin: asarPath, root, chunks, html, bytes };
}

function walkFiles(dir: string, base = dir, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) walkFiles(full, base, out);
    else out.push(full);
  }
  return out;
}

/** Reads an already-extracted client directory (the dir that holds `index.html`). */
export function loadClientFromDir(clientDir: string): ClientBundle {
  const all = walkFiles(clientDir);
  const chunks = new Map<string, string>();
  const html = new Map<string, string>();
  let bytes = 0;
  for (const file of all) {
    if (!JS_RE.test(file) && !HTML_RE.test(file)) continue;
    const buffer = readFileSync(file);
    bytes += buffer.length;
    const name = relative(clientDir, file).split(sep).join("/");
    if (HTML_RE.test(file)) {
      if (buffer.length <= MAX_HTML_BYTES) html.set(name, toText(buffer));
      continue;
    }
    chunks.set(name, toText(buffer));
  }
  if (chunks.size === 0) {
    throw new Error(`${clientDir}: no JavaScript chunks found (pass the directory that holds index.html)`);
  }
  if (!html.has("index.html") && !Array.from(html.keys()).some((name) => name.endsWith("index.html"))) {
    throw new Error(`${clientDir}: no index.html found; this is not a T3 Code client directory`);
  }
  return { kind: "dir", origin: clientDir, root: "", chunks, html, bytes };
}

/**
 * Text the RPC method list is read from: the shipped server bundle when the
 * archive is available, else the client's own call sites (less precise).
 */
export function loadServerSources(input: {
  asarPath?: string;
  clientDir?: string;
  bundle?: ClientBundle;
}): ServerSources {
  if (input.asarPath) {
    const files = listAsarFiles(input.asarPath).filter(
      (file) =>
        file.path.includes("apps/server/dist/") &&
        !file.path.includes("/client/") &&
        JS_RE.test(file.path) &&
        file.size > 0,
    );
    if (files.length > 0) {
      const contents = readAsarFiles(input.asarPath, files);
      const parts: string[] = [];
      const chunks = new Map<string, string>();
      let bytes = 0;
      for (const file of files) {
        const buffer = contents.get(file.path);
        if (!buffer) continue;
        bytes += buffer.length;
        const text = toText(buffer);
        parts.push(text);
        chunks.set(file.path, text);
      }
      if (parts.length > 0) {
        return {
          origin: input.asarPath,
          evidence: "server",
          text: parts.join("\n"),
          files: files.length,
          bytes,
          chunks,
        };
      }
    }
  }

  const bundle = input.bundle;
  if (!bundle) throw new Error("no server sources available: pass an asar or a client dir");
  const parts = Array.from(bundle.chunks.values());  const bytes = parts.reduce((total, text) => total + text.length, 0);
  return {
    origin: bundle.origin,
    evidence: "client",
    text: parts.join("\n"),
    files: bundle.chunks.size,
    bytes,
  };
}
