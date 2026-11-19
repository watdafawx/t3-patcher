import { closeSync, fstatSync, openSync, readSync } from "node:fs";

import { type PathPlatform, resolveAllowedPath } from "./path-guard.js";

export interface FsReadRequest {
  path: string;
  encoding?: "utf8" | "base64";
  /** Byte offset to start at (default 0). */
  offset?: number;
  maxBytes?: number;
}

export interface FsReadResult {
  path: string;
  size: number;
  offset: number;
  bytesRead: number;
  truncated: boolean;
  encoding: "utf8" | "base64";
  data: string;
}

export interface FsReadOptions {
  roots: readonly string[];
  platform: PathPlatform;
  home: string;
  /** Hard cap per call. */
  maxBytes?: number;
  realpath?: (p: string) => string;
}

export const FS_READ_MAX = 4 * 1024 * 1024;

/** Reads one regular file inside the granted roots. Read-only; never follows a path out of the roots. */
export function createFsRead(options: FsReadOptions): (request: FsReadRequest) => FsReadResult {
  const cap = Math.min(options.maxBytes ?? FS_READ_MAX, FS_READ_MAX);
  return (request) => {
    const check = resolveAllowedPath(request.path, options.roots, options);
    if (!check.ok) throw new Error(`t3p: fs.read denied: ${check.reason}`);
    const want = Math.min(request.maxBytes ?? cap, cap);
    const offset = request.offset ?? 0;
    if (!Number.isSafeInteger(want) || want < 0 || !Number.isSafeInteger(offset) || offset < 0) throw new Error("t3p: fs.read: bad offset or maxBytes");
    const fd = openSync(check.path, "r");
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) throw new Error("t3p: fs.read denied: not a regular file");
      const length = Math.max(0, Math.min(want, st.size - offset));
      const buffer = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const n = readSync(fd, buffer, read, length - read, offset + read);
        if (n === 0) break;
        read += n;
      }
      const encoding = request.encoding ?? "utf8";
      return {
        path: check.path,
        size: st.size,
        offset,
        bytesRead: read,
        truncated: offset + read < st.size,
        encoding,
        data: buffer.subarray(0, read).toString(encoding),
      };
    } finally {
      closeSync(fd);
    }
  };
}
