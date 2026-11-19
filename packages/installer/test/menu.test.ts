import { describe, expect, it } from "vitest";

import {
  compatibility,
  describeLayout,
  ensureClosed,
  menuOptions,
  parseChoice,
  parseTasklistName,
  parseTasklistRunning,
  runMenu,
  shouldShowMenu,
  type MenuDeps,
} from "../src/menu.js";
import type { InstallInfo, InstallResult, Layout } from "../src/types.js";

const info: InstallInfo = {
  installDir: "C:\\Apps\\T3 Code (Beta)",
  exePath: "C:\\Apps\\T3 Code (Beta)\\T3 Code (Beta).exe",
  resourcesDir: "C:\\Apps\\T3 Code (Beta)\\resources",
  version: "0.1.10",
  channel: "beta",
};

const result = (status: "installed" | "updated" | "noop" = "installed"): InstallResult => ({
  status,
  install: info,
  changed: status === "installed",
  manifestPath: "m",
  originalAsarSha256: "a",
  replacementAsarSha256: "b",
  runtime: null,
  warnings: [],
});

describe("compatibility", () => {
  it("flags supported, untested and unknown versions", () => {
    expect(compatibility("0.1.10").level).toBe("ok");
    expect(compatibility("9.9.9").level).toBe("untested");
    expect(compatibility(null).level).toBe("unknown");
  });
});

describe("menuOptions", () => {
  const actions = (layout: Layout, safe = false) => menuOptions(layout, safe).map((o) => o.action);
  it("offers only what makes sense per layout", () => {
    expect(actions("unpatched")).toEqual(["install", "quit"]);
    expect(actions("patched")).toEqual(["update", "repair", "uninstall", "safe", "quit"]);
    expect(actions("stale")).toEqual(["repair", "uninstall", "safe", "quit"]);
    expect(actions("unknown")).toEqual(["quit"]);
  });
  it("recommends install when unpatched and repair when stale or broken", () => {
    expect(menuOptions("unpatched")[0].recommended).toBe(true);
    expect(menuOptions("stale")[0].recommended).toBe(true);
    expect(menuOptions("broken")[0].recommended).toBe(true);
    expect(menuOptions("patched")[0].recommended).toBe(false);
    expect(menuOptions("patched", false, true)[0]).toMatchObject({ action: "update", recommended: true });
  });
  it("turns Safe mode into Cancel safe mode while pending", () => {
    expect(menuOptions("patched", true).find((o) => o.action === "safe")?.label).toBe("Cancel safe mode");
  });
  it("describes every layout in words", () => {
    for (const l of ["patched", "unpatched", "stale", "broken", "unknown"] as Layout[]) expect(describeLayout(l).length).toBeGreaterThan(3);
  });
});

describe("parseChoice", () => {
  const options = menuOptions("patched");
  it("accepts a number or a letter, any case, with spaces", () => {
    expect(parseChoice("3", options)?.action).toBe("uninstall");
    expect(parseChoice(" u ", options)?.action).toBe("uninstall");
    expect(parseChoice("Q", options)?.action).toBe("quit");
  });
  it("rejects blanks, out of range and unknown letters", () => {
    expect(parseChoice("", options)).toBeNull();
    expect(parseChoice("0", options)).toBeNull();
    expect(parseChoice("9", options)).toBeNull();
    expect(parseChoice("x", options)).toBeNull();
  });
});

describe("shouldShowMenu", () => {
  const base = { argCount: 0, stdinIsTTY: true, stdoutIsTTY: true, parentName: "explorer.exe" };
  it("shows the menu for a double-click (no args, console, parent explorer)", () => {
    expect(shouldShowMenu(base)).toBe(true);
    expect(shouldShowMenu({ ...base, parentName: "Explorer.EXE" })).toBe(true);
  });
  it("prints help from a terminal, with args, or when piped", () => {
    expect(shouldShowMenu({ ...base, parentName: "cmd.exe" })).toBe(false);
    expect(shouldShowMenu({ ...base, parentName: "pwsh.exe" })).toBe(false);
    expect(shouldShowMenu({ ...base, parentName: null })).toBe(false);
    expect(shouldShowMenu({ ...base, argCount: 1 })).toBe(false);
    expect(shouldShowMenu({ ...base, stdinIsTTY: false })).toBe(false);
    expect(shouldShowMenu({ ...base, stdoutIsTTY: false })).toBe(false);
  });
  it("T3P_MENU overrides the parent check but never beats arguments", () => {
    expect(shouldShowMenu({ ...base, parentName: "cmd.exe", env: { T3P_MENU: "1" } })).toBe(true);
    expect(shouldShowMenu({ ...base, env: { T3P_MENU: "0" } })).toBe(false);
    expect(shouldShowMenu({ ...base, argCount: 2, env: { T3P_MENU: "1" } })).toBe(false);
  });
});

describe("tasklist parsing", () => {
  const csv = '"T3 Code (Beta).exe","1234","Console","1","90,000 K"\r\n"explorer.exe","88","Console","1","10 K"\r\n';
  it("finds a running image", () => {
    expect(parseTasklistRunning(csv, "t3 code (beta).exe")).toBe(true);
    expect(parseTasklistRunning(csv, "T3 Code.exe")).toBe(false);
    expect(parseTasklistRunning("INFO: No tasks are running which match the specified criteria.", "T3 Code.exe")).toBe(false);
  });
  it("reads the parent's image name", () => {
    expect(parseTasklistName('"explorer.exe","88","Console","1","10 K"')).toBe("explorer.exe");
    expect(parseTasklistName("INFO: No tasks are running")).toBeNull();
  });
});

interface Harness {
  deps: MenuDeps;
  out: string[];
  calls: string[];
  questions: string[];
}

function harness(answers: string[], opts: { layout?: Layout; installs?: InstallInfo[]; running?: boolean[]; safe?: boolean; failInstall?: Error; upToDate?: boolean; outdated?: boolean } = {}): Harness {
  const out: string[] = [];
  const calls: string[] = [];
  const questions: string[] = [];
  const running = [...(opts.running ?? [])];
  let layout: Layout = opts.layout ?? "unpatched";
  const deps: MenuDeps = {
    version: "0.1.0",
    io: {
      print: (line = "") => out.push(line),
      ask: async (q) => {
        questions.push(q);
        return answers.shift() ?? "q";
      },
    },
    findInstalls: async () => opts.installs ?? [info],
    status: async () => ({ layout, install: info, manifestPresent: true, reasons: [] }),
    isRunning: () => running.shift() ?? false,
    install: async () => {
      if (opts.failInstall) throw opts.failInstall;
      calls.push("install");
      layout = "patched";
      return result();
    },
    update: async () => {
      calls.push("update");
      return { ...result("installed"), status: opts.upToDate ? "noop" : "updated", runtimeUpdate: { from: "rt-aaaaaaaa", to: "rt-bbbbbbbb", shimChanged: false } };
    },
    runtimeOutdated: () => opts.outdated ?? false,
    repair: async () => {
      calls.push("repair");
      layout = "patched";
      return result();
    },
    uninstall: async () => {
      calls.push("uninstall");
      layout = "unpatched";
    },
    safeMode: (off) => {
      calls.push(off ? "safe-off" : "safe-on");
      return { pending: !off };
    },
    safePending: () => opts.safe ?? false,
    sleep: async () => {},
  };
  return { deps, out, calls, questions };
}

describe("runMenu", () => {
  it("tells the user when there is no T3 Code, and still waits for Enter", async () => {
    const h = harness([""], { installs: [] });
    expect(await runMenu(h.deps)).toBe(1);
    expect(h.out.join("\n")).toMatch(/No T3 Code found/);
    expect(h.questions.at(-1)).toMatch(/Press Enter to close/);
  });

  it("shows version, compatibility and status, installs, then quits with a final Enter", async () => {
    const h = harness(["1", "q", ""], { layout: "unpatched" });
    expect(await runMenu(h.deps)).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain("T3 Code (Beta)");
    expect(text).toContain("0.1.10");
    expect(text).toMatch(/compatible \(tested with 0.1.10\)/);
    expect(text).toMatch(/not installed/);
    expect(h.calls).toEqual(["install"]);
    expect(text).toMatch(/installed and healthy/);
    expect(h.questions.at(-1)).toMatch(/Press Enter to close/);
  });

  it("Update runs update, reports the runtime change and recommends itself when outdated", async () => {
    const h = harness(["p", "q", ""], { layout: "patched", outdated: true });
    await runMenu(h.deps);
    expect(h.calls).toEqual(["update"]);
    const text = h.out.join("\n");
    expect(text).toMatch(/Update \(recommended\)/);
    expect(text).toMatch(/Updated runtime rt-aaaaaaaa -> rt-bbbbbbbb/);
  });

  it("Update says so when already up to date", async () => {
    const h = harness(["p", "q", ""], { layout: "patched", upToDate: true });
    await runMenu(h.deps);
    expect(h.out.join("\n")).toMatch(/Already up to date/);
  });

  it("asks to close T3 Code and waits until it is closed", async () => {
    const h = harness(["i", "", "", "q", ""], { running: [true, true, false] });
    await runMenu(h.deps);
    expect(h.out.join("\n")).toMatch(/is open\. Close it first/);
    expect(h.calls).toEqual(["install"]);
  });

  it("lets the user cancel instead of closing the app, and changes nothing", async () => {
    const h = harness(["i", "c", "q", ""], { running: [true, true, true] });
    await runMenu(h.deps);
    expect(h.calls).toEqual([]);
    expect(h.out.join("\n")).toMatch(/Nothing changed/);
  });

  it("asks for confirmation before uninstalling", async () => {
    const no = harness(["u", "n", "q", ""], { layout: "patched" });
    await runMenu(no.deps);
    expect(no.calls).toEqual([]);
    const yes = harness(["u", "y", "q", ""], { layout: "patched" });
    await runMenu(yes.deps);
    expect(yes.calls).toEqual(["uninstall"]);
  });

  it("repairs and toggles safe mode", async () => {
    const h = harness(["r", "s", "q", ""], { layout: "stale" });
    await runMenu(h.deps);
    expect(h.calls).toEqual(["repair", "safe-on"]);
    const off = harness(["s", "q", ""], { layout: "patched", safe: true });
    await runMenu(off.deps);
    expect(off.calls).toEqual(["safe-off"]);
  });

  it("reports an install failure in plain words and keeps the menu alive", async () => {
    const { T3pError } = await import("../src/errors.js");
    const h = harness(["1", "q", ""], { failInstall: new T3pError("fuses are not safe") });
    expect(await runMenu(h.deps)).toBe(1);
    expect(h.out.join("\n")).toMatch(/Could not finish: fuses are not safe/);
    expect(h.questions.at(-1)).toMatch(/Press Enter to close/);
  });

  it("re-asks on an invalid answer", async () => {
    const h = harness(["zzz", "q", ""]);
    await runMenu(h.deps);
    expect(h.out.join("\n")).toMatch(/Type a number/);
  });

  it("lets the user pick between several installs", async () => {
    const nightly: InstallInfo = { ...info, channel: "nightly", installDir: "C:\\Apps\\T3 Code (Nightly)", exePath: "C:\\Apps\\T3 Code (Nightly)\\T3 Code (Nightly).exe" };
    const h = harness(["9", "2", "q", ""], { installs: [info, nightly] });
    await runMenu(h.deps);
    const text = h.out.join("\n");
    expect(text).toMatch(/more than one T3 Code/);
    expect(text).toMatch(/App:\s+T3 Code \(Nightly\)/);
  });
});

describe("ensureClosed", () => {
  it("returns true at once when the app is not running", async () => {
    const h = harness([]);
    expect(await ensureClosed(h.deps, info)).toBe(true);
    expect(h.questions).toEqual([]);
  });
});

describe("closed input", () => {
  it("stops instead of looping when stdin ends", async () => {
    const h = harness([]);
    h.deps.io.ask = async () => null;
    h.deps.isRunning = () => true;
    expect(await runMenu(h.deps)).toBe(0);
    const h2 = harness([]);
    let n = 0;
    h2.deps.io.ask = async () => (n++ === 0 ? "i" : null);
    h2.deps.isRunning = () => true;
    await runMenu(h2.deps);
    expect(h2.calls).toEqual([]);
  });
});
