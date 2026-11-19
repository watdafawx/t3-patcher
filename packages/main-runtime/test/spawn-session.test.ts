import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { checkSessionArgs, createSpawnSession } from "../src/native/spawn-session.js";

const EXE = "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const SCRIPT = "C:/Users/u/.t3-patcher/plugins/media/smtc.ps1";
const options = { allow: [EXE, SCRIPT], platform: "win32" as const, home: "C:/Users/u", realpath: (p: string) => p };
const good = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT];

describe("checkSessionArgs", () => {
  it("accepts safe switches then -File <granted script>", () => {
    expect(checkSessionArgs(good, options)).toMatchObject({ ok: true });
  });
  it("is case-insensitive for the script path on Windows", () => {
    expect(checkSessionArgs(["-File", SCRIPT.toUpperCase()], { ...options, realpath: (p) => p })).toMatchObject({ ok: true });
  });
  it.each([
    [["-Command", "calc"]],
    [["-EncodedCommand", "AAAA", "-File", SCRIPT]],
    [["-c", "calc", "-File", SCRIPT]],
    [["-NoProfile", "-File", SCRIPT, "extra"]],
    [["-ExecutionPolicy", "Restricted2", "-File", SCRIPT]],
    [["-NoProfile"]],
    [[]],
  ])("rejects %j", (args) => {
    expect(checkSessionArgs(args, options)).toMatchObject({ ok: false });
  });
  it("rejects scripts that are not granted or not .ps1", () => {
    expect(checkSessionArgs(["-File", "C:/other/evil.ps1"], options)).toMatchObject({ ok: false });
    expect(checkSessionArgs(["-File", EXE], options)).toMatchObject({ ok: false });
  });
});

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; pid: number; kill(): void };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = 4242;
  child.kill = () => child.emit("close", null, "SIGTERM");
  return child;
}

describe("createSpawnSession", () => {
  it("splits stdout into lines, writes to stdin, reports exit once", async () => {
    const child = fakeChild();
    const seen: string[] = [];
    const exits: unknown[] = [];
    const session = createSpawnSession({ ...options, spawnImpl: (() => child) as never })({
      exe: EXE,
      args: good,
      onLine: (l) => seen.push(l),
      onExit: (i) => exits.push(i),
    });
    child.stdout.write('{"a":1}\r\npart');
    child.stdout.write('ial\n{"b":2}\n');
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual(['{"a":1}', "partial", '{"b":2}']);
    expect(session.write("1 poll\n")).toBe(true);
    session.kill();
    session.kill();
    expect(exits).toHaveLength(1);
    expect(session.write("x")).toBe(false);
  });

  it("denies a non-allowlisted exe or bad args before spawning", () => {
    let spawned = 0;
    const make = createSpawnSession({ ...options, spawnImpl: (() => (spawned += 1, fakeChild())) as never });
    expect(() => make({ exe: "C:/Windows/System32/cmd.exe", args: good, onLine: () => undefined })).toThrow(/denied/);
    expect(() => make({ exe: EXE, args: ["-Command", "calc"], onLine: () => undefined })).toThrow(/denied/);
    expect(spawned).toBe(0);
  });
});
