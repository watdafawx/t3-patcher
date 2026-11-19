import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { doctor } from "../src/doctor.js";
import { buildTaskXml, ensureLogonTask, taskXmlPath, validateTaskXml } from "../src/logon-task.js";
import { createFakeInstall, safeReadFuses, type FakeInstall } from "./fake-install.js";

let tree: FakeInstall;
beforeEach(async () => {
  tree = await createFakeInstall();
});
afterEach(() => tree.cleanup());

function bundle(): string {
  const f = join(tree.root, "t3p.cjs");
  writeFileSync(f, "// bundle\n");
  return f;
}

function fakeNodeDir(name: string): string {
  const dir = join(tree.root, name);
  mkdirSync(dir);
  writeFileSync(join(dir, "node.exe"), "");
  return dir;
}

const good = () => buildTaskXml({ taskName: "t3-patcher-repair", user: "FOX\\Micha", command: "C:\\Users\\Micha\\.t3-patcher\\repair-logon.cmd" });

describe("logon task definition (XML)", () => {
  it("generated XML passes validation and has the intended shape", () => {
    const xml = good();
    expect(validateTaskXml(xml)).toEqual([]);
    expect(xml).toContain("<LogonTrigger>");
    expect(xml).not.toMatch(/<(Time|Boot|Idle|Session|Calendar|Event|Registration)\w*Trigger/);
    expect(xml.match(/<UserId>FOX\\Micha<\/UserId>/g)).toHaveLength(2); // trigger + principal
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(xml).toContain("<Hidden>true</Hidden>");
    expect(xml).not.toContain("Password");
  });

  it("escapes XML metacharacters in names and paths", () => {
    const xml = buildTaskXml({ taskName: "a&b", user: "D\\u<ser>", command: 'C:\\x "y"\\r.cmd' });
    expect(xml).toContain("a&amp;b");
    expect(xml).toContain("D\\u&lt;ser&gt;");
    expect(validateTaskXml(xml)).toEqual([]);
  });

  it("rejects each unsafe variation", () => {
    const cases: Array<[string, (x: string) => string, RegExp]> = [
      ["boot trigger", (x) => x.replace(/LogonTrigger/g, "BootTrigger"), /exactly one LogonTrigger/],
      ["unscoped trigger", (x) => x.replace(/(<LogonTrigger>[\s\S]*?)<UserId>[^<]*<\/UserId>/, "$1"), /scoped with <UserId>/],
      ["other user in principal", (x) => x.replace(/(<Principal[\s\S]*?<UserId>)[^<]*/, "$1SYSTEM"), /differ/],
      ["password logon", (x) => x.replace("InteractiveToken", "Password"), /InteractiveToken/],
      ["elevated", (x) => x.replace("LeastPrivilege", "HighestAvailable"), /LeastPrivilege/],
      ["visible", (x) => x.replace("<Hidden>true", "<Hidden>false"), /Hidden/],
      ["no time limit", (x) => x.replace("PT10M", "PT0S"), /ExecutionTimeLimit/],
      ["no command", (x) => x.replace(/<Command>[^<]*<\/Command>/, ""), /Command/],
      ["wrong namespace", (x) => x.replace("mit/task", "mit/other"), /namespace/],
    ];
    for (const [name, mutate, expected] of cases) {
      expect(validateTaskXml(mutate(good())).join("; "), name).toMatch(expected);
    }
  });

  it("is written as UTF-16 with a BOM and passed to schtasks /XML", () => {
    const calls: string[][] = [];
    ensureLogonTask({
      homeDir: tree.homeDir,
      selfPath: bundle(),
      platform: "win32",
      user: "FOX\\Micha",
      env: { PATH: fakeNodeDir("nx") },
      schtasks: (a) => (calls.push(a), { status: 0, stderr: "" }),
    });
    const file = taskXmlPath(tree.homeDir);
    expect(calls[0][calls[0].indexOf("/XML") + 1]).toBe(file);
    const raw = readFileSync(file);
    expect([raw[0], raw[1]]).toEqual([0xff, 0xfe]);
    const xml = raw.subarray(2).toString("utf16le");
    expect(validateTaskXml(xml)).toEqual([]);
    expect(xml).toContain(join(tree.homeDir, ".t3-patcher", "repair-logon.cmd"));
  });

  it("doctor reports the registered definition, and fails on a tampered one", async () => {
    const dopts = { path: tree.installDir, homeDir: tree.homeDir, readFuses: safeReadFuses, verifySignature: async () => ({ ok: true, detail: "ok" }) };
    const find = async () => (await doctor(dopts)).checks.find((c) => c.name === "logon task definition");
    expect((await find())?.ok).toBe(true); // nothing registered yet

    ensureLogonTask({
      homeDir: tree.homeDir,
      selfPath: bundle(),
      platform: "win32",
      user: "FOX\\Micha",
      env: { PATH: fakeNodeDir("nd") },
      schtasks: () => ({ status: 0, stderr: "" }),
    });
    const ok = await find();
    expect(ok?.ok).toBe(true);
    expect(ok?.detail).toMatch(/^valid: LogonTrigger for FOX\\Micha, InteractiveToken, LeastPrivilege, Hidden=true/);
    expect(ok?.detail).toContain("<LogonTrigger>");

    const tampered = readFileSync(taskXmlPath(tree.homeDir)).subarray(2).toString("utf16le").replace("LeastPrivilege", "HighestAvailable");
    writeFileSync(taskXmlPath(tree.homeDir), tampered, "utf16le");
    const bad = await find();
    expect(bad?.ok).toBe(false);
    expect(bad?.detail).toMatch(/LeastPrivilege/);
  });
});
