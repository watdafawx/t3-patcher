import { describe, expect, it } from "vitest";

import { checkZipPath, crc32, DEFAULT_ZIP_LIMITS, readZip, writeZip, ZipError } from "../src/registry/zip.js";

const txt = (s: string): Buffer => Buffer.from(s, "utf8");

/** Offset of the first central directory entry of a zip written by writeZip. */
function cdOffset(zip: Buffer): number {
  return zip.readUInt32LE(zip.length - 22 + 16);
}

describe("zip writer and reader", () => {
  it("round-trips and is deterministic", () => {
    const entries = [
      { name: "plugin.json", data: txt("{}") },
      { name: "dist/renderer.js", data: txt("export default {};".repeat(100)) },
      { name: "dist/", data: Buffer.alloc(0) },
    ];
    const a = writeZip(entries);
    const b = writeZip([...entries].reverse());
    expect(a.equals(b)).toBe(true);
    const files = readZip(a);
    expect(files.map((f) => f.name).sort()).toEqual(["dist/renderer.js", "plugin.json"]);
    expect(files.find((f) => f.name === "dist/renderer.js")!.data.toString()).toBe("export default {};".repeat(100));
  });

  it("crc32 matches the reference value", () => expect(crc32(txt("123456789"))).toBe(0xcbf43926));

  it.each([
    ["../evil.js", "traversal"],
    ["a/../../evil.js", "nested traversal"],
    ["/etc/passwd", "absolute"],
    ["C:/Windows/evil.js", "drive letter"],
    ["a\\b.js", "backslash"],
    ["CON.js", "reserved name"],
    ["dir/aux", "reserved name in a folder"],
    ["x.js:stream", "alternate data stream"],
    ["bad. /x.js", "trailing dot or space"],
    ["a//b.js", "empty segment"],
    ["./a.js", "dot segment"],
    ["a\u0001.js", "control character"],
  ])("rejects %s (%s)", (name) => {
    expect(checkZipPath(name)).not.toBeNull();
    expect(() => readZip(writeZip([{ name, data: txt("x") }]))).toThrow(ZipError);
  });

  it("accepts normal nested paths", () => {
    expect(checkZipPath("dist/assets/icon.png")).toBeNull();
    expect(checkZipPath("dist/", true)).toBeNull();
  });

  it("rejects symlinks and special files made on Unix", () => {
    expect(() => readZip(writeZip([{ name: "link", data: txt("/etc/passwd"), unixMode: 0o120777 }]))).toThrow(/symlink/);
    expect(() => readZip(writeZip([{ name: "fifo", data: txt(""), unixMode: 0o010644 }]))).toThrow(/special/);
    // a plain Unix regular file is fine
    expect(readZip(writeZip([{ name: "ok.js", data: txt("x"), unixMode: 0o100644 }]))).toHaveLength(1);
  });

  it("rejects more than 500 entries", () => {
    const many = Array.from({ length: 501 }, (_, i) => ({ name: `f${i}.txt`, data: txt("x") }));
    expect(() => readZip(writeZip(many))).toThrow(/more than 500 entries/);
    expect(readZip(writeZip(many.slice(0, 500)))).toHaveLength(500);
  });

  it("rejects a zip bomb by ratio", () => {
    const zeros = Buffer.alloc(4 * 1024 * 1024);
    expect(() => readZip(writeZip([{ name: "bomb.bin", data: zeros }]))).toThrow(/ratio/);
  });

  it("rejects more than the unpacked cap (declared sizes)", () => {
    const limits = { ...DEFAULT_ZIP_LIMITS, maxUnpackedBytes: 1000 };
    const zip = writeZip([
      { name: "a.bin", data: Buffer.alloc(600, 1), store: true },
      { name: "b.bin", data: Buffer.alloc(600, 2), store: true },
    ]);
    expect(() => readZip(zip, limits)).toThrow(/bytes unpacked/);
  });

  it("rejects an entry that inflates beyond its declared size (lying header)", () => {
    const zip = writeZip([{ name: "a.txt", data: txt("hello world ".repeat(200)) }]);
    zip.writeUInt32LE(10, cdOffset(zip) + 24); // central uncompressed size: 10
    expect(() => readZip(zip)).toThrow(/inflate|differs/);
  });

  it("rejects a CRC mismatch", () => {
    const zip = writeZip([{ name: "a.txt", data: txt("hello") }]);
    zip.writeUInt32LE(0xdeadbeef, cdOffset(zip) + 16);
    expect(() => readZip(zip)).toThrow(/CRC/);
  });

  it("rejects encrypted entries and unknown methods", () => {
    const enc = writeZip([{ name: "a.txt", data: txt("hello") }]);
    enc.writeUInt16LE(enc.readUInt16LE(cdOffset(enc) + 8) | 1, cdOffset(enc) + 8);
    expect(() => readZip(enc)).toThrow(/encrypted/);
    const m = writeZip([{ name: "a.txt", data: txt("hello"), store: true }]);
    m.writeUInt16LE(12, cdOffset(m) + 10); // bzip2
    expect(() => readZip(m)).toThrow(/method/);
  });

  it("rejects duplicate names (case-insensitive) and files below files", () => {
    expect(() => readZip(writeZip([{ name: "a.js", data: txt("1") }, { name: "A.js", data: txt("2") }]))).toThrow(/duplicate/);
    expect(() => readZip(writeZip([{ name: "a", data: txt("1") }, { name: "a/b.js", data: txt("2") }]))).toThrow(/below a file/);
  });

  it("rejects a central name that differs from the local name", () => {
    const zip = writeZip([{ name: "safe.js", data: txt("x") }]);
    // rename the local header's copy to ../x.js-length name: same length, different bytes
    const at = zip.indexOf(Buffer.from("safe.js"));
    Buffer.from("evil.js").copy(zip, at);
    expect(() => readZip(zip)).toThrow(/local name differs/);
  });

  it("rejects garbage, truncation and ZIP64 markers", () => {
    expect(() => readZip(Buffer.from("not a zip at all, definitely not"))).toThrow(ZipError);
    const zip = writeZip([{ name: "a.txt", data: txt("hello") }]);
    expect(() => readZip(zip.subarray(0, zip.length - 5))).toThrow(ZipError);
    const z64 = Buffer.from(zip);
    z64.writeUInt32LE(0xffffffff, z64.length - 22 + 16);
    expect(() => readZip(z64)).toThrow(/ZIP64/);
  });
});
