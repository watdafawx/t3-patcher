import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFsRead } from "../src/native/fs-read.js";
import { createNativeServices } from "../src/native/index.js";
import { createLogTail } from "../src/native/log-tail.js";
import { createSpawn, resolveAllowedExe, scrubEnv } from "../src/native/spawn.js";
import { checkSelect, createSqliteQuery, forkLauncher, type QueryLauncher, type QueryProcess } from "../src/native/sqlite.js";

const workerFile = fileURLToPath(new URL("../src/native/sqlite-worker.cjs", import.meta.url));

const platform = process.platform === "win32" ? ("win32" as const) : ("posix" as const);
let base: string;
let root: string;
let outside: string;

beforeAll(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "t3p-native-")));
  root = join(base, "root");
  outside = join(base, "outside");
  mkdirSync(join(root, "dir"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, "a.txt"), "hello world");
  writeFileSync(join(root, "big.bin"), Buffer.alloc(10_000, 7));
  writeFileSync(join(outside, "secret.txt"), "secret");
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("fs.read", () => {
  const read = () => createFsRead({ roots: [root], platform, home: base });

  it("reads a file inside the root", () => {
    expect(read()({ path: join(root, "a.txt") })).toMatchObject({ data: "hello world", size: 11, truncated: false });
  });
  it("caps the size and supports offset/base64", () => {
    const r = read()({ path: join(root, "big.bin"), maxBytes: 100, offset: 10, encoding: "base64" });
    expect(r.bytesRead).toBe(100);
    expect(r.truncated).toBe(true);
    expect(Buffer.from(r.data, "base64")).toEqual(Buffer.alloc(100, 7));
  });
  it("denies outside the root, traversal and directories", () => {
    expect(() => read()({ path: join(outside, "secret.txt") })).toThrow(/denied/);
    expect(() => read()({ path: `${root}${platform === "win32" ? "\\" : "/"}..${platform === "win32" ? "\\" : "/"}outside${platform === "win32" ? "\\" : "/"}secret.txt` })).toThrow(/denied/);
    expect(() => read()({ path: join(root, "dir") })).toThrow(/not a regular file/);
    expect(() => read()({ path: join(root, "missing.txt") })).toThrow(/denied/);
  });
});

describe("log.tail", () => {
  it("tails with a cursor, caps and resets on truncation", () => {
    const file = join(root, "app.log");
    writeFileSync(file, "line1\nline2\n");
    const tail = createLogTail({ roots: [root], platform, home: base });
    const first = tail({ path: file });
    expect(first).toMatchObject({ data: "line1\nline2\n", cursor: 12, reset: false, truncated: false });
    appendFileSync(file, "line3\n");
    expect(tail({ path: file, cursor: first.cursor })).toMatchObject({ data: "line3\n", cursor: 18 });
    expect(tail({ path: file, cursor: 0, maxBytes: 4 })).toMatchObject({ data: "line", cursor: 4, truncated: true });
    expect(tail({ path: file, maxBytes: 6 }).data).toBe("line3\n");
    truncateSync(file, 0);
    writeFileSync(file, "new\n");
    expect(tail({ path: file, cursor: 18 })).toMatchObject({ data: "new\n", reset: true, cursor: 4 });
    expect(() => tail({ path: join(outside, "secret.txt") })).toThrow(/denied/);
    expect(tail({ path: file, maxBytes: 50_000_000 }).data.length).toBeLessThanOrEqual(1024 * 1024);
  });
});

describe("sqlite.read", () => {
  let db: string;
  beforeAll(async () => {
    db = join(root, "t.sqlite");
    const { DatabaseSync } = await import("node:sqlite");
    const d = new DatabaseSync(db);
    d.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT, blob BLOB); ");
    const ins = d.prepare("INSERT INTO t(name, blob) VALUES (?, ?)");
    for (let i = 0; i < 50; i++) ins.run(`n${i}`, Buffer.from([i]));
    d.close();
  });
  const launch = forkLauncher(workerFile, scrubEnv(process.env, platform));
  const q = (l: QueryLauncher = launch) => createSqliteQuery({ roots: [root], platform, home: base, launch: l });

  it("runs a SELECT read-only with params and a row cap", async () => {
    const r = await q()({ path: db, sql: "SELECT id, name FROM t WHERE id > ? ORDER BY id", params: [40], maxRows: 3 });
    expect(r.columns).toEqual(["id", "name"]);
    expect(r.rows).toEqual([
      [41, "n40"],
      [42, "n41"],
      [43, "n42"],
    ]);
    expect(r.truncated).toBe(true);
  });

  it("caps one huge text cell and the aggregate payload before it reaches main", async () => {
    const r = await q()({ path: db, sql: "SELECT printf('%.*c', 5000000, 'x') AS big", maxRows: 10 });
    const cell = r.rows[0]![0] as { $text: string; length: number; truncated: boolean };
    expect(cell.truncated).toBe(true);
    expect(cell.length).toBe(5000000);
    expect(cell.$text.length).toBe(256 * 1024);
  });

  it.each([
    "INSERT INTO t(name) VALUES ('x')",
    "UPDATE t SET name='x'",
    "DELETE FROM t",
    "DROP TABLE t",
    "PRAGMA journal_mode=DELETE",
    "ATTACH DATABASE 'x.db' AS x",
    "SELECT 1; DELETE FROM t",
    "SELECT 1 -- ; DELETE FROM t",
    "SELECT 1 /* x */",
    "WITH x AS (SELECT 1) DELETE FROM t",
    "VACUUM INTO 'copy.db'",
    "",
  ])("rejects %j", async (sql) => {
    expect(checkSelect(sql).ok).toBe(false);
    await expect(q()({ path: db, sql })).rejects.toThrow(/denied/);
  });

  it("keeps keywords inside string literals legal", () => {
    expect(checkSelect("SELECT 'delete me; now' AS x;").ok).toBe(false);
    expect(checkSelect("SELECT 'please delete' AS x").ok).toBe(true);
    expect(checkSelect("select replace(name, 'a', 'b') from t").ok).toBe(true);
  });

  it("times out a query stuck in SQLite's C code and kills its process", async () => {
    // count(*) over an endless CTE never returns to JS: a worker thread could
    // not be stopped (measured: worker.terminate() hangs), a process can.
    const sql = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c";
    const procs: QueryProcess[] = [];
    let exited: number | null | undefined;
    const tracking: QueryLauncher = async () => {
      const p = await launch();
      p.onExit((code) => (exited = code));
      procs.push(p);
      return p;
    };
    await expect(q(tracking)({ path: db, sql, timeoutMs: 300 })).rejects.toThrow(/timed out after 300 ms/);
    for (let i = 0; i < 50 && exited === undefined; i++) await new Promise((r) => setTimeout(r, 50));
    expect(procs).toHaveLength(1);
    expect(exited).not.toBeUndefined();
  });

  it("reports a query process that dies or cannot start", async () => {
    const dead: QueryLauncher = async () => {
      let onExit: (code: number | null) => void = () => undefined;
      return { send: () => setTimeout(() => onExit(3), 5), onMessage: () => undefined, onExit: (l) => (onExit = l), kill: () => undefined };
    };
    await expect(q(dead)({ path: db, sql: "SELECT 1" })).rejects.toThrow("query process exited (3)");
    await expect(q(() => Promise.reject(new Error("no fork")))({ path: db, sql: "SELECT 1" })).rejects.toThrow(/cannot start query process: no fork/);
  });

  it("is absent without a launcher (fail closed)", () => {
    expect(createNativeServices({ "sqlite.read": { roots: [root] } }, { platform, home: base })).not.toHaveProperty("sqliteQuery");
    expect(createNativeServices({ "sqlite.read": { roots: [root] } }, { platform, home: base, sqliteLaunch: launch })).toHaveProperty("sqliteQuery");
  });

  it("denies files outside the roots and non-database extensions", async () => {
    await expect(q()({ path: join(outside, "secret.txt"), sql: "SELECT 1" })).rejects.toThrow(/denied/);
    await expect(q()({ path: join(root, "a.txt"), sql: "SELECT 1" })).rejects.toThrow(/not a .sqlite/);
  });

  it("never writes: the database file is unchanged after queries", async () => {
    const { statSync } = await import("node:fs");
    const before = statSync(db).mtimeMs;
    await q()({ path: db, sql: "SELECT count(*) FROM t" });
    expect(statSync(db).mtimeMs).toBe(before);
  });
});

describe("spawn", () => {
  const node = realpathSync.native(process.execPath);

  it("is absent unless granted with an allowlist", () => {
    expect(createNativeServices({}, { platform, home: base }).spawn).toBeUndefined();
    expect(createNativeServices({ "fs.read": { roots: [root] } }, { platform, home: base })).toHaveProperty("fsRead");
    expect(Object.isFrozen(createNativeServices({}, { platform, home: base }))).toBe(true);
    expect(resolveAllowedExe(node, { allow: [], platform, home: base })).toMatchObject({ ok: false, reason: "spawn is not granted" });
  });

  it("denies executables that are not allowlisted, scripts and relative names", () => {
    const opts = { allow: [node], platform, home: base };
    expect(resolveAllowedExe("C:\\Windows\\System32\\cmd.exe", opts).ok).toBe(false);
    expect(resolveAllowedExe("node.exe", opts).ok).toBe(false);
    if (platform === "win32") expect(resolveAllowedExe("C:\\x\\run.bat", { ...opts, allow: ["C:\\x\\run.bat"] })).toMatchObject({ ok: false });
  });

  it("passes argv verbatim without a shell and scrubs the env", async () => {
    const spawn = createSpawn({ allow: [node], platform, home: base, env: { ...process.env, T3_SECRET_TOKEN: "leak" } });
    const tricky = ["a b", '"quoted"', "&& echo pwned", "%PATH%", "$(whoami)", "back\\slash\\"];
    const r = await spawn({ exe: node, args: ["-e", "console.log(JSON.stringify({a:process.argv.slice(1),s:process.env.T3_SECRET_TOKEN||null}))", ...tricky] });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ a: tricky, s: null });
  });

  it("enforces the timeout and output cap", async () => {
    const spawn = createSpawn({ allow: [node], platform, home: base });
    const slow = await spawn({ exe: node, args: ["-e", "setTimeout(()=>{}, 10000)"], timeoutMs: 300 });
    expect(slow.timedOut).toBe(true);
    const loud = await spawn({ exe: node, args: ["-e", "process.stdout.write('x'.repeat(3*1024*1024))"] });
    expect(loud.truncated).toBe(true);
    expect(loud.stdout.length).toBe(1024 * 1024);
  });

  it("keeps only safe env vars", () => {
    const env = scrubEnv({ PATH: "p", SystemRoot: "s", NODE_OPTIONS: "--inspect", ELECTRON_RUN_AS_NODE: "1", T3CODE_BEARER: "b" }, "win32");
    expect(env).toEqual({ PATH: "p", SystemRoot: "s" });
  });
});
