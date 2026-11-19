import { deflateRawSync, inflateRawSync } from "node:zlib";

import { REGISTRY_MAX_FILES, REGISTRY_MAX_UNPACKED_BYTES } from "@t3p/api";

/**
 * A small, strict ZIP reader and a deterministic ZIP writer for plugin packages (WP-14A).
 *
 * The reader is the only thing that turns downloaded bytes into files, so it rejects anything a
 * plugin package never needs: encryption, ZIP64, multi-disk archives, symlinks and other special
 * files, compression other than stored/deflate, path traversal, absolute or drive paths, Windows
 * reserved names, duplicate names (case-insensitive), overlapping entries, more than 500 entries,
 * more than 50 MB unpacked, and suspicious compression ratios (zip bombs). Sizes are checked from
 * the central directory first and then again while inflating (`maxOutputLength`), and every entry's
 * CRC-32 must match. Nothing is written to disk here; the caller writes the returned buffers.
 */

export interface ZipLimits {
  maxFiles: number;
  maxUnpackedBytes: number;
  /** Largest allowed unpacked/packed ratio for an entry bigger than `ratioFloorBytes`. */
  maxRatio: number;
  ratioFloorBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxFiles: REGISTRY_MAX_FILES,
  maxUnpackedBytes: REGISTRY_MAX_UNPACKED_BYTES,
  maxRatio: 200,
  ratioFloorBytes: 1024 * 1024,
};

export interface ZipFile {
  /** Forward-slash relative path, validated by {@link checkZipPath}. Directories are not returned. */
  name: string;
  data: Buffer;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(`unsafe or invalid zip: ${message}`);
    this.name = "ZipError";
  }
}

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

let crcTable: Uint32Array | null = null;
export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Returns why `name` is not a safe relative path, or null. `dir` allows the trailing "/" of a
 * directory entry. Rules: forward slashes only, relative, no empty/`.`/`..` segments, no colon
 * (drive letters, NTFS streams), no control or `<>"|?*` characters, no trailing dot or space, no
 * Windows device names, at most 16 levels and 240 characters.
 */
export function checkZipPath(name: string, dir = false): string | null {
  if (name.length === 0 || name.length > 240) return "empty or too long name";
  if (name.includes("\\")) return "backslash in name";
  if (name.startsWith("/")) return "absolute path";
  if (name.includes(":")) return "':' in name (drive letter or stream)";
  const body = dir && name.endsWith("/") ? name.slice(0, -1) : name;
  const segments = body.split("/");
  if (segments.length > 16) return "too deeply nested";
  for (const s of segments) {
    if (s === "" || s === "." || s === "..") return "empty, '.' or '..' segment";
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
    if (/[<>"|?*\u0000-\u001f\u007f]/.test(s)) return "forbidden character in name";
    if (/[. ]$/.test(s)) return "segment ends with a dot or space";
    if (WINDOWS_RESERVED.test(s)) return "Windows reserved device name";
  }
  return null;
}

interface CentralEntry {
  name: string;
  dir: boolean;
  method: number;
  crc: number;
  csize: number;
  usize: number;
  offset: number;
  nameBytes: Buffer;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Reads and checks every entry. Throws {@link ZipError} on the first problem; never writes anything. */
export function readZip(buffer: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipFile[] {
  if (buffer.length < 22) throw new ZipError("too small");
  // End of central directory: last 22 bytes plus up to 65535 bytes of comment.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i--) {
    if (buffer.readUInt32LE(i) === SIG_EOCD && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("no end of central directory record");
  const disk = buffer.readUInt16LE(eocd + 4);
  const cdDisk = buffer.readUInt16LE(eocd + 6);
  const onDisk = buffer.readUInt16LE(eocd + 8);
  const total = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total) throw new ZipError("multi-disk archives are not supported");
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError("ZIP64 is not supported");
  if (total > limits.maxFiles) throw new ZipError(`more than ${limits.maxFiles} entries`);
  if (cdOffset + cdSize > eocd) throw new ZipError("central directory out of bounds");

  const entries: CentralEntry[] = [];
  const seen = new Set<string>();
  let unpacked = 0;
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > cdOffset + cdSize || buffer.readUInt32LE(p) !== SIG_CEN) throw new ZipError("bad central directory entry");
    const madeBy = buffer.readUInt16LE(p + 4);
    const flags = buffer.readUInt16LE(p + 8);
    const method = buffer.readUInt16LE(p + 10);
    const crc = buffer.readUInt32LE(p + 16);
    const csize = buffer.readUInt32LE(p + 20);
    const usize = buffer.readUInt32LE(p + 24);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const diskStart = buffer.readUInt16LE(p + 34);
    const extAttr = buffer.readUInt32LE(p + 38);
    const offset = buffer.readUInt32LE(p + 42);
    const next = p + 46 + nameLen + extraLen + commentLen;
    if (next > cdOffset + cdSize) throw new ZipError("central directory entry out of bounds");
    const nameBytes = buffer.subarray(p + 46, p + 46 + nameLen);
    p = next;

    let name: string;
    try {
      name = utf8.decode(nameBytes);
    } catch {
      throw new ZipError("entry name is not valid UTF-8");
    }
    if (!(flags & 0x0800) && /[^\x20-\x7e]/.test(name)) throw new ZipError(`non-ASCII name without the UTF-8 flag: ${JSON.stringify(name)}`);
    if (flags & 0x0001) throw new ZipError(`encrypted entry ${JSON.stringify(name)}`);
    if (diskStart !== 0) throw new ZipError("multi-disk archives are not supported");
    if (csize === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff) throw new ZipError("ZIP64 is not supported");
    const dir = name.endsWith("/");
    const bad = checkZipPath(name, true);
    if (bad) throw new ZipError(`${bad}: ${JSON.stringify(name)}`);
    // Unix-made entries carry the file type in the high 16 bits: only regular files and directories.
    if (madeBy >> 8 === 3) {
      const type = (extAttr >>> 16) & S_IFMT;
      if (type !== 0 && type !== S_IFREG && type !== S_IFDIR) throw new ZipError(`symlink or special file ${JSON.stringify(name)}`);
      if (type === S_IFDIR && !dir) throw new ZipError(`directory without a trailing slash ${JSON.stringify(name)}`);
    }
    // DOS attributes: 0x400 is a reparse point (symlink/junction).
    if ((extAttr & 0x400) !== 0) throw new ZipError(`reparse point ${JSON.stringify(name)}`);
    if (method !== 0 && method !== 8) throw new ZipError(`compression method ${method} is not supported (${JSON.stringify(name)})`);
    if (dir && usize !== 0) throw new ZipError(`directory entry with data ${JSON.stringify(name)}`);
    if (method === 0 && csize !== usize) throw new ZipError(`stored entry size mismatch ${JSON.stringify(name)}`);
    const key = name.replace(/\/$/, "").normalize("NFC").toLowerCase();
    if (seen.has(key)) throw new ZipError(`duplicate entry ${JSON.stringify(name)}`);
    seen.add(key);
    if (usize > limits.maxUnpackedBytes) throw new ZipError(`entry larger than ${limits.maxUnpackedBytes} bytes`);
    unpacked += usize;
    if (unpacked > limits.maxUnpackedBytes) throw new ZipError(`more than ${limits.maxUnpackedBytes} bytes unpacked`);
    if (usize > limits.ratioFloorBytes && usize > csize * limits.maxRatio) throw new ZipError(`compression ratio over ${limits.maxRatio}:1 (zip bomb?) in ${JSON.stringify(name)}`);
    entries.push({ name, dir, method, crc, csize, usize, offset, nameBytes });
  }
  // Every file must exist below a directory chain that is not itself a file.
  const files = new Set(entries.filter((e) => !e.dir).map((e) => e.name.normalize("NFC").toLowerCase()));
  for (const e of entries) {
    const parts = e.name.replace(/\/$/, "").split("/");
    for (let i = 1; i < parts.length; i++) if (files.has(parts.slice(0, i).join("/").normalize("NFC").toLowerCase())) throw new ZipError(`entry below a file: ${JSON.stringify(e.name)}`);
  }

  // Local headers: must match the central directory, data must not overlap (overlapping-entry bombs).
  const ranges: Array<[number, number]> = [];
  const out: ZipFile[] = [];
  for (const e of entries) {
    const o = e.offset;
    if (o + 30 > cdOffset || buffer.readUInt32LE(o) !== SIG_LOC) throw new ZipError(`bad local header for ${JSON.stringify(e.name)}`);
    const lFlags = buffer.readUInt16LE(o + 6);
    const lMethod = buffer.readUInt16LE(o + 8);
    const lNameLen = buffer.readUInt16LE(o + 26);
    const lExtraLen = buffer.readUInt16LE(o + 28);
    if (lFlags & 0x0001 || lMethod !== e.method) throw new ZipError(`local header disagrees with the central directory for ${JSON.stringify(e.name)}`);
    if (!buffer.subarray(o + 30, o + 30 + lNameLen).equals(e.nameBytes)) throw new ZipError(`local name differs from the central name for ${JSON.stringify(e.name)}`);
    const start = o + 30 + lNameLen + lExtraLen;
    const end = start + e.csize;
    if (end > cdOffset) throw new ZipError(`data of ${JSON.stringify(e.name)} out of bounds`);
    ranges.push([o, end]);
    if (e.dir) continue;
    const raw = buffer.subarray(start, end);
    let data: Buffer;
    if (e.method === 0) data = Buffer.from(raw);
    else {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(1, e.usize) });
      } catch (error) {
        throw new ZipError(`cannot inflate ${JSON.stringify(e.name)}: ${(error as Error).message}`);
      }
    }
    if (data.length !== e.usize) throw new ZipError(`size of ${JSON.stringify(e.name)} differs from the central directory`);
    if (crc32(data) !== e.crc) throw new ZipError(`CRC mismatch in ${JSON.stringify(e.name)}`);
    out.push({ name: e.name, data });
  }
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) if (ranges[i]![0] < ranges[i - 1]![1]) throw new ZipError("overlapping entries");
  return out;
}

export interface ZipWriteEntry {
  name: string;
  data: Uint8Array;
  /** Test seam: a Unix mode (e.g. 0o120777 for a symlink) marks the entry as made on Unix with that type. */
  unixMode?: number;
  /** Store instead of deflate. */
  store?: boolean;
}

/**
 * Writes a deterministic zip: entries sorted by name, fixed timestamp (1980-01-01), no extra fields,
 * UTF-8 names, deflate level 9 (stored when that is not smaller). Same input, same bytes, same SHA-256.
 */
export function writeZip(entries: readonly ZipWriteEntry[], opts: { sort?: boolean } = {}): Buffer {
  const list = opts.sort === false ? [...entries] : [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const DOS_TIME = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1;
  for (const e of list) {
    const name = Buffer.from(e.name, "utf8");
    const data = Buffer.from(e.data);
    const deflated = e.store ? null : deflateRawSync(data, { level: 9 });
    const useDeflate = deflated !== null && deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOC, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(SIG_CEN, 0);
    cen.writeUInt16LE(e.unixMode !== undefined ? (3 << 8) | 20 : 20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(DOS_TIME, 12);
    cen.writeUInt16LE(DOS_DATE, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(e.unixMode !== undefined ? (e.unixMode << 16) >>> 0 : e.name.endsWith("/") ? 0x10 : 0, 38);
    cen.writeUInt32LE(offset, 42);
    centrals.push(cen, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_EOCD, 0);
  end.writeUInt16LE(list.length, 8);
  end.writeUInt16LE(list.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
