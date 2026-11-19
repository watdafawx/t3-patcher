import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { extname, join } from "node:path";

import { isValidPluginId } from "@t3p/api";

import type { Logger } from "../log.js";
import { decodeUrlSegments, type PathPlatform, resolveAllowedPath } from "../native/path-guard.js";

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};
const MAX_FILE = 16 * 1024 * 1024;

export interface VirtualRoutesDeps {
  runtimeDir: string;
  /** Plugin folder for an id when its renderer files may be served (enabled, valid, compatible), else null. */
  pluginDir(id: string): string | null;
  platform: PathPlatform;
  log: Logger;
}

function notFound(): Response {
  return new Response(null, { status: 404 });
}

function readCapped(file: string): Uint8Array | null {
  const fd = openSync(file, "r");
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_FILE) return null;
    const buffer = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < st.size) {
      const n = readSync(fd, buffer, offset, st.size - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    return new Uint8Array(buffer.buffer, buffer.byteOffset, offset);
  } finally {
    closeSync(fd);
  }
}

function fileResponse(file: string): Response {
  const type = CONTENT_TYPES[extname(file).toLowerCase()];
  if (!type) return notFound();
  const body = readCapped(file);
  if (!body) return notFound();
  return new Response(body, {
    status: 200,
    headers: { "content-type": type, "cache-control": "no-cache", "x-content-type-options": "nosniff" },
  });
}

/**
 * `t3code://app/__t3p/*`, answered by the runtime without calling the app's handler:
 * - `/__t3p/renderer.js`: the renderer bootstrap from the runtime dir.
 * - `/__t3p/plugins/<id>/<path>`: a file of an enabled plugin, only inside its folder.
 * Anything else below /__t3p/ is a 404. Only GET and HEAD.
 */
export function serveVirtual(url: URL, method: string, deps: VirtualRoutesDeps): Response {
  if (method !== "GET" && method !== "HEAD") return new Response(null, { status: 405 });
  const path = url.pathname;
  if (path === "/__t3p/renderer.js") return fileResponse(join(deps.runtimeDir, "renderer.js"));

  const m = /^\/__t3p\/plugins\/([^/]+)\/(.+)$/.exec(path);
  if (!m) return notFound();
  let id: string;
  try {
    id = decodeURIComponent(m[1]!);
  } catch {
    return notFound();
  }
  if (!isValidPluginId(id)) return notFound();
  const dir = deps.pluginDir(id);
  if (!dir) return notFound();
  const segments = decodeUrlSegments(m[2]!);
  if (!segments) {
    deps.log.warn(`plugin file route: rejected ${path}`);
    return notFound();
  }
  const candidate = join(dir, ...segments);
  const check = resolveAllowedPath(candidate, [dir], { platform: deps.platform, home: dir });
  if (!check.ok) {
    deps.log.warn(`plugin file route: rejected ${path}: ${check.reason}`);
    return notFound();
  }
  return fileResponse(check.path);
}
