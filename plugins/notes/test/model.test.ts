import { describe, expect, it } from "vitest";

import { Autosaver, baseName, clampHeight, describeCount, GENERAL, menuEntries, noteKey, parseUi, projectFromWire, resolveProject, selectedId, type ProjectInfo, type SaveStatus } from "../src/model.js";

const proj = (id: string, name: string): ProjectInfo => ({ id, name, workspaceRoot: null });
const projects = new Map([
  ["p1", proj("p1", "demo-app")],
  ["p2", proj("p2", "demo-docs")],
]);

describe("keys and parsing", () => {
  it("builds storage keys", () => {
    expect(noteKey("p1")).toBe("notes:p1");
    expect(noteKey(GENERAL)).toBe("notes:@general");
  });
  it("reads a shell project", () => {
    expect(projectFromWire({ id: "p1", title: "demo-app", workspaceRoot: "C:\\x\\demo-app" })).toEqual({ id: "p1", name: "demo-app", workspaceRoot: "C:\\x\\demo-app" });
    expect(projectFromWire({ id: "p1", workspaceRoot: "/a/b/c/" })?.name).toBe("c");
    expect(projectFromWire({ id: "p1", title: "x", archivedAt: "2026-01-01" })).toBeNull();
    expect(projectFromWire({ title: "x" })).toBeNull();
    expect(projectFromWire(null)).toBeNull();
  });
  it("base name", () => {
    expect(baseName("C:\\a\\b")).toBe("b");
    expect(baseName("")).toBeNull();
  });
  it("clamps height and parses ui state", () => {
    expect(clampHeight(5)).toBe(60);
    expect(clampHeight(9999)).toBe(600);
    expect(clampHeight("x")).toBe(120);
    expect(parseUi({ collapsed: true, height: 200 })).toEqual({ collapsed: true, height: 200 });
    expect(parseUi(undefined)).toEqual({ collapsed: false, height: 120 });
  });
  it("counts", () => {
    expect(describeCount("")).toBe("0 characters, 0 words");
    expect(describeCount("a bc")).toBe("4 characters, 2 words");
    expect(describeCount("a")).toBe("1 character, 1 word");
  });
});

describe("project resolution", () => {
  it("resolves a known project", () => {
    expect(resolveProject("t1", { projectId: "p1" }, projects)).toEqual({ kind: "project", project: proj("p1", "demo-app") });
  });
  it("reports what is missing", () => {
    expect(resolveProject(null, undefined, projects).kind).toBe("no-thread");
    expect(resolveProject("t1", undefined, projects)).toMatchObject({ kind: "no-project" });
    expect(resolveProject("t1", { projectId: null }, projects)).toMatchObject({ kind: "no-project", reason: "thread has no project" });
    expect(resolveProject("t1", { projectId: "zz" }, projects)).toEqual({ kind: "unknown-project", projectId: "zz" });
  });
  it("selection: pin wins, else project, else General", () => {
    const r = resolveProject("t1", { projectId: "p1" }, projects);
    expect(selectedId(null, r)).toBe("p1");
    expect(selectedId("p2", r)).toBe("p2");
    expect(selectedId(null, { kind: "no-thread" })).toBe(GENERAL);
    expect(selectedId(null, { kind: "unknown-project", projectId: "zz" })).toBe("zz");
  });
  it("menu: current first, General last", () => {
    expect(menuEntries(projects, "p2")).toEqual([
      { id: "p2", label: "demo-docs", current: true },
      { id: "p1", label: "demo-app", current: false },
      { id: GENERAL, label: "General", current: false },
    ]);
  });
});

describe("Autosaver", () => {
  function setup(fail = false) {
    const writes: Array<[string, string]> = [];
    const statuses: SaveStatus[] = [];
    let timer: (() => void) | null = null;
    let broken = fail;
    const saver = new Autosaver({
      save: async (k, t) => {
        if (broken) throw new Error("quota");
        writes.push([k, t]);
      },
      onStatus: (s) => statuses.push(s),
      setTimer: (fn) => ((timer = fn), 1),
      clearTimer: () => (timer = null),
    });
    return { saver, writes, statuses, hasTimer: () => timer !== null, fix: () => (broken = false) };
  }

  it("debounces: one write for a burst", async () => {
    const s = setup();
    s.saver.edit("a", "h");
    s.saver.edit("a", "he");
    expect(s.saver.status).toBe("dirty");
    await s.saver.flush();
    expect(s.writes).toEqual([["a", "he"]]);
    expect(s.saver.status).toBe("saved");
    expect(s.statuses).toEqual(["dirty", "saving", "saved"]);
  });
  it("flush writes at once and cancels the timer", async () => {
    const s = setup();
    s.saver.edit("a", "x");
    await s.saver.flush();
    expect(s.writes).toEqual([["a", "x"]]);
    expect(s.hasTimer()).toBe(false);
  });
  it("switching key writes the old text first", async () => {
    const s = setup();
    s.saver.edit("a", "one");
    s.saver.edit("b", "two");
    await s.saver.flush();
    expect(s.writes).toEqual([
      ["a", "one"],
      ["b", "two"],
    ]);
  });
  it("shows unsaved text and clears it after the write", async () => {
    const s = setup();
    s.saver.edit("a", "x");
    expect(s.saver.pendingText("a")).toBe("x");
    expect(s.saver.pendingText("b")).toBeUndefined();
    await s.saver.flush();
    expect(s.saver.pendingText("a")).toBeUndefined();
  });
  it("keeps the text and reports error when a write fails, then recovers", async () => {
    const s = setup(true);
    s.saver.edit("a", "x");
    await s.saver.flush();
    expect(s.saver.status).toBe("error");
    expect(s.saver.pendingText("a")).toBe("x");
    s.fix();
    await s.saver.flush();
    expect(s.writes).toEqual([["a", "x"]]);
    expect(s.saver.status).toBe("saved");
  });
  it("flush with nothing pending is a no-op", async () => {
    const s = setup();
    await s.saver.flush();
    expect(s.statuses).toEqual([]);
  });
});
