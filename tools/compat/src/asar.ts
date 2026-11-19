import { openSync, readSync, closeSync, statSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Minimal reader for Electron asar archives.
 *
 * `@electron/asar` 4.3.2 cannot read the archives Electron 44 ships: they carry
 * an extra preamble word (the header is a three-field pickle). This reader
 * handles both layouts:
 *
 *   old: [u32 4][u32 headerSize][header JSON ...][padding] -> data
 *   new: [u32 4][u32 headerSize][u32 headerSize-4][u32 jsonSize][header JSON][padding] -> data
 *
 * Only packed files are read here; `unpacked: true` entries come from
 * `<asar>.unpacked/<path>` when it exists, like Electron does.
 */

export interface AsarFile {
  /** Archive path with forward slashes, e.g. "apps/server/dist/client/index.html". */
  path: string;
  size: number;
  /** Offset of the file bytes from the start of the data area. */
  offset: number;
  unpacked: boolean;
}

export interface AsarFormat {
  layout: "old" | "new";
  headerSize: number;
  /** Offset of the header JSON. */
  jsonStart: number;
  /** Length of the header JSON in bytes. */
  jsonSize: number;
  dataOffset: number;
}

const HEAD_BYTES = 20;
const OLD_JSON_START = 8;
const NEW_JSON_START = 16;

function align4(value: number): number {
  return (value + 3) & ~3;
}

/** Reads and parses the archive header without touching the data area. */
export function readAsarFormat(asarPath: string): AsarFormat {
  const fd = openSync(asarPath, "r");
  try {
    const head = Buffer.alloc(HEAD_BYTES);
    const read = readSync(fd, head, 0, HEAD_BYTES, 0);
    if (read < 12) throw new Error(`${asarPath}: too small to be an asar archive`);
    const headerSize = head.readUInt32LE(4);
    if (head[OLD_JSON_START] === 0x7b) {
      // Old layout: [4][headerSize][JSON].
      return {
        layout: "old",
        headerSize,
        jsonStart: OLD_JSON_START,
        jsonSize: headerSize,
        dataOffset: OLD_JSON_START + headerSize,
      };
    }
    if (read >= NEW_JSON_START + 1 && head[NEW_JSON_START] === 0x7b) {
      // New layout: [4][headerSize][headerSize-4][jsonSize][JSON].
      const jsonSize = head.readUInt32LE(12);
      return {
        layout: "new",
        headerSize,
        jsonStart: NEW_JSON_START,
        jsonSize,
        dataOffset: align4(NEW_JSON_START + jsonSize),
      };
    }
    throw new Error(`${asarPath}: unrecognised asar header layout`);
  } finally {
    closeSync(fd);
  }
}

interface RawNode {
  files?: Record<string, RawNode>;
  size?: number;
  offset?: string | number;
  unpacked?: boolean;
}

function walk(node: RawNode, prefix: string, out: AsarFile[]): void {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (child.files) {
      walk(child, path, out);
      continue;
    }
    out.push({
      path,
      size: child.size ?? 0,
      offset: Number(child.offset ?? 0),
      unpacked: child.unpacked === true,
    });
  }
}

/**
 * Lists every file in the archive. Callers filter by prefix; the list itself
 * costs one header read, so it is cheap even for the 256 MB server archive.
 */
export function listAsarFiles(asarPath: string): AsarFile[] {
  const format = readAsarFormat(asarPath);
  const fd = openSync(asarPath, "r");
  try {
    const raw = Buffer.alloc(format.jsonSize);
    readSync(fd, raw, 0, format.jsonSize, format.jsonStart);
    const text = raw.toString("utf8").replace(/\0+$/, "").trimEnd();
    const header = JSON.parse(text) as RawNode;
    const out: AsarFile[] = [];
    walk(header, "", out);
    return out;
  } finally {
    closeSync(fd);
  }
}

/** Reads one file out of an asar archive. */
export function readAsarFile(asarPath: string, file: AsarFile): Buffer {
  if (file.unpacked) {
    const sidecar = join(`${asarPath}.unpacked`, ...file.path.split("/"));
    if (!existsSync(sidecar)) {
      throw new Error(`${asarPath}: ${file.path} is unpacked but ${sidecar} does not exist`);
    }
    return readFileSync(sidecar);
  }
  const { dataOffset } = readAsarFormat(asarPath);
  const fd = openSync(asarPath, "r");
  try {
    const buffer = Buffer.alloc(file.size);
    if (file.size === 0) return buffer;
    readSync(fd, buffer, 0, file.size, dataOffset + file.offset);
    return buffer;
  } finally {
    closeSync(fd);
  }
}

/**
 * Reads several files with one open handle. Preferred over `readAsarFile` in a
 * loop: the client is about a thousand files and the archive is on disk.
 */
export function readAsarFiles(asarPath: string, files: AsarFile[]): Map<string, Buffer> {
  const { dataOffset } = readAsarFormat(asarPath);
  const fd = openSync(asarPath, "r");
  const out = new Map<string, Buffer>();
  try {
    for (const file of files) {
      if (file.unpacked) {
        out.set(file.path, readAsarFile(asarPath, file));
        continue;
      }
      const buffer = Buffer.alloc(file.size);
      if (file.size > 0) readSync(fd, buffer, 0, file.size, dataOffset + file.offset);
      out.set(file.path, buffer);
    }
  } finally {
    closeSync(fd);
  }
  return out;
}

/** Byte size of an asar file, for report lines that quote what was read. */
export function asarSize(asarPath: string): number {
  return statSync(asarPath).size;
}
