import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { decodeUrlSegments, lexicalCheck, lexicalNormalize, resolveAllowedPath } from "../src/native/path-guard.js";

const win = { platform: "win32" as const, home: "C:\\Users\\me" };
const ROOT = "C:\\Users\\me\\.t3\\caches";

describe("path guard: lexical (path.win32 rules)", () => {
  it.each([
    ["parent traversal", "C:\\Users\\me\\.t3\\caches\\..\\secrets.txt"],
    ["parent traversal with forward slashes", "C:/Users/me/.t3/caches/../../me/x"],
    ["mixed slashes traversal", "C:\\Users/me\\.t3/caches\\..//..\\x"],
    ["dot segment", "C:\\Users\\me\\.t3\\caches\\.\\x"],
    ["sibling prefix", "C:\\Users\\me\\.t3\\caches-evil\\x"],
    ["sibling prefix no sep", "C:\\Users\\me\\.t3\\cachesx"],
    ["other drive", "D:\\Users\\me\\.t3\\caches\\x"],
    ["drive-relative", "C:Users\\me\\.t3\\caches\\x"],
    ["root-relative", "\\Users\\me\\.t3\\caches\\x"],
    ["relative", ".t3\\caches\\x"],
    ["UNC", "\\\\server\\share\\x"],
    ["UNC forward", "//server/share/x"],
    ["device namespace", "\\\\.\\C:\\Users\\me\\.t3\\caches\\x"],
    ["long path prefix", "\\\\?\\C:\\Users\\me\\.t3\\caches\\x"],
    ["NT object namespace", "\\??\\C:\\Users\\me\\.t3\\caches\\x"],
    ["UNC via long prefix", "\\\\?\\UNC\\server\\share"],
    ["alternate data stream", "C:\\Users\\me\\.t3\\caches\\x.txt:secret"],
    ["ADS on dir", "C:\\Users\\me\\.t3\\caches::$INDEX_ALLOCATION\\x"],
    ["trailing dot", "C:\\Users\\me\\.t3\\caches\\x."],
    ["trailing space", "C:\\Users\\me\\.t3\\caches\\x "],
    ["trailing dots in dir", "C:\\Users\\me\\.t3\\caches\\..."],
    ["CON", "C:\\Users\\me\\.t3\\caches\\CON"],
    ["nul with extension", "C:\\Users\\me\\.t3\\caches\\nul.txt"],
    ["COM1", "C:\\Users\\me\\.t3\\caches\\com1"],
    ["COM superscript", "C:\\Users\\me\\.t3\\caches\\COM\u00b9"],
    ["LPT9 with spaces", "C:\\Users\\me\\.t3\\caches\\LPT9  .log"],
    ["CONIN$", "C:\\Users\\me\\.t3\\caches\\CONIN$"],
    ["NUL char", "C:\\Users\\me\\.t3\\caches\\x\u0000.txt"],
    ["control char", "C:\\Users\\me\\.t3\\caches\\x\u0007"],
    ["wildcard", "C:\\Users\\me\\.t3\\caches\\*.db"],
    ["question mark", "C:\\Users\\me\\.t3\\caches\\a?b"],
    ["pipe", "C:\\Users\\me\\.t3\\caches\\a|b"],
    ["quote", 'C:\\Users\\me\\.t3\\caches\\"x"'],
    ["tilde traversal", "~\\.t3\\caches\\..\\..\\Desktop\\x"],
    ["tilde user form", "~other\\x"],
    ["empty", ""],
    ["non-string", 42],
    ["too long", `C:\\${"a\\".repeat(3000)}`],
  ])("rejects %s", (_name, input) => {
    expect(lexicalCheck(input, [ROOT], win).ok).toBe(false);
  });

  it.each([
    ["plain", "C:\\Users\\me\\.t3\\caches\\a.json"],
    ["forward slashes", "C:/Users/me/.t3/caches/sub/a.json"],
    ["case differs", "c:\\USERS\\ME\\.T3\\CACHES\\a.json"],
    ["doubled separators", "C:\\Users\\me\\.t3\\caches\\\\sub\\\\a.json"],
    ["tilde", "~/.t3/caches/a.json"],
    ["the root itself", "C:\\Users\\me\\.t3\\caches"],
    ["dotfile", "C:\\Users\\me\\.t3\\caches\\.hidden"],
    ["name containing con", "C:\\Users\\me\\.t3\\caches\\console.log"],
  ])("accepts %s", (_name, input) => {
    expect(lexicalCheck(input, [ROOT], win).ok).toBe(true);
  });

  it("normalizes drive letter and separators", () => {
    expect(lexicalNormalize("c:/a//b/", win)).toEqual({ ok: true, path: "C:\\a\\b" });
  });

  it("posix rules", () => {
    const posix = { platform: "posix" as const, home: "/home/me" };
    expect(lexicalCheck("/home/me/.t3/a", ["/home/me/.t3"], posix).ok).toBe(true);
    expect(lexicalCheck("/home/me/.t3/../x", ["/home/me/.t3"], posix).ok).toBe(false);
    expect(lexicalCheck("/home/me/.t3x/a", ["/home/me/.t3"], posix).ok).toBe(false);
    expect(lexicalCheck("/HOME/me/.t3/a", ["/home/me/.t3"], posix).ok).toBe(false);
  });
});

describe("path guard: realpath stage", () => {
  it("rejects a path whose real target escapes the root (fake symlink)", () => {
    const realpath = (p: string): string => (p.toLowerCase().startsWith(`${ROOT.toLowerCase()}\\link`) ? `C:\\Windows${p.slice(`${ROOT}\\link`.length)}` : p);
    expect(resolveAllowedPath(`${ROOT}\\link\\system.ini`, [ROOT], { ...win, realpath }).ok).toBe(false);
    expect(resolveAllowedPath(`${ROOT}\\file.txt`, [ROOT], { ...win, realpath })).toEqual({ ok: true, path: `${ROOT}\\file.txt` });
  });

  it("rejects a missing file and accepts the long-path form of a real path", () => {
    const realpath = (p: string): string => {
      if (p.endsWith("missing")) throw new Error("ENOENT");
      return `\\\\?\\${p}`;
    };
    expect(resolveAllowedPath(`${ROOT}\\missing`, [ROOT], { ...win, realpath }).ok).toBe(false);
    expect(resolveAllowedPath(`${ROOT}\\ok.txt`, [ROOT], { ...win, realpath }).ok).toBe(true);
  });
});

describe.runIf(process.platform === "win32")("path guard: real junctions and symlinks", () => {
  let base: string;
  let root: string;
  let outside: string;
  beforeAll(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), "t3p-guard-")));
    root = join(base, "root");
    outside = join(base, "outside");
    mkdirSync(join(root, "sub"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(root, "sub", "in.txt"), "in");
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(root, "junction"), "junction");
    symlinkSync(join(root, "sub"), join(root, "inner-junction"), "junction");
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  const opts = (): { platform: "win32"; home: string } => ({ platform: "win32", home: base });

  it("allows a real file inside the root", () => {
    expect(resolveAllowedPath(join(root, "sub", "in.txt"), [root], opts()).ok).toBe(true);
  });
  it("rejects a junction that points outside the root", () => {
    const r = resolveAllowedPath(join(root, "junction", "secret.txt"), [root], opts());
    expect(r.ok).toBe(false);
  });
  it("allows a junction that stays inside the root", () => {
    expect(resolveAllowedPath(join(root, "inner-junction", "in.txt"), [root], opts()).ok).toBe(true);
  });
  it("rejects the outside file directly", () => {
    expect(resolveAllowedPath(join(outside, "secret.txt"), [root], opts()).ok).toBe(false);
  });
});

describe("decodeUrlSegments", () => {
  it.each(["..%2fx.js", "%2e%2e/x.js", "a%5cb.js", "a%3ab.js", "a/../b.js", "a//b.js", "nul.js", "x.js.", "%00.js", "%E0%A4%A.js", ""])("rejects %j", (rest) => {
    expect(decodeUrlSegments(rest)).toBeNull();
  });
  it("decodes plain segments", () => {
    expect(decodeUrlSegments("dist/my%20file.js")).toEqual(["dist", "my file.js"]);
  });
});
