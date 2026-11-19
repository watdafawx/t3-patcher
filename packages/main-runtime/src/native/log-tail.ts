import { closeSync, fstatSync, openSync, readSync } from "node:fs";

import { type PathPlatform, resolveAllowedPath } from "./path-guard.js";

export interface LogTailRequest {
  path: string;
  /** Byte offset returned by the previous call. Omit to get the last maxBytes. */
  cursor?: number;
  maxBytes?: number;
}

export interface LogTailResult {
  path: string;
  data: string;
  /** Pass back as `cursor` to continue. */
  cursor: number;
  size: number;
  /** The file shrank below the cursor (rotated/truncated); reading restarted from the tail. */
  reset: boolean;
  /** More data is available after `cursor`. */
  truncated: boolean;
}

export interface LogTailOptions {
  roots: readonly string[];
  platform: PathPlatform;
  home: string;
  realpath?: (p: string) => string;
}

export const LOG_TAIL_DEFAULT = 64 * 1024;
export const LOG_TAIL_MAX = 1024 * 1024;

/** Incremental, size-capped, read-only tail of a log file inside the granted roots. */
export function createLogTail(options: LogTailOptions): (request: LogTailRequest) => LogTailResult {
  return (request) => {
    const check = resolveAllowedPath(request.path, options.roots, options);
    if (!check.ok) throw new Error(`t3p: log.tail denied: ${check.reason}`);
    const max = Math.min(request.maxBytes ?? LOG_TAIL_DEFAULT, LOG_TAIL_MAX);
    if (!Number.isSafeInteger(max) || max < 1) throw new Error("t3p: log.tail: bad maxBytes");
    if (request.cursor !== undefined && (!Number.isSafeInteger(request.cursor) || request.cursor < 0)) throw new Error("t3p: log.tail: bad cursor");
    const fd = openSync(check.path, "r");
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) throw new Error("t3p: log.tail denied: not a regular file");
      const size = st.size;
      let reset = false;
      let start: number;
      if (request.cursor === undefined) start = Math.max(0, size - max);
      else if (request.cursor > size) {
        reset = true;
        start = Math.max(0, size - max);
      } else start = request.cursor;
      const end = Math.min(size, start + max);
      const buffer = Buffer.alloc(end - start);
      let read = 0;
      while (read < buffer.length) {
        const n = readSync(fd, buffer, read, buffer.length - read, start + read);
        if (n === 0) break;
        read += n;
      }
      return {
        path: check.path,
        data: buffer.subarray(0, read).toString("utf8"),
        cursor: start + read,
        size,
        reset,
        truncated: start + read < size,
      };
    } finally {
      closeSync(fd);
    }
  };
}
