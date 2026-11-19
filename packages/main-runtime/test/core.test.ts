import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFileLogger, guard } from "../src/log.js";
import { resolvePaths } from "../src/paths.js";
import { detectSafeMode } from "../src/safe-mode.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "t3p-core-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("logger", () => {
  it("writes, rotates and keeps N files", () => {
    const log = createFileLogger({ dir, maxBytes: 200, keep: 2, now: () => new Date(0) });
    for (let i = 0; i < 20; i++) log.info(`line ${i} ${"x".repeat(30)}`);
    expect(existsSync(join(dir, "main.log"))).toBe(true);
    expect(existsSync(join(dir, "main.log.1"))).toBe(true);
    expect(existsSync(join(dir, "main.log.2"))).toBe(true);
    expect(existsSync(join(dir, "main.log.3"))).toBe(false);
    expect(readFileSync(join(dir, "main.log"), "utf8")).toContain("line 19");
  });

  it("never throws, even when the log dir is a file", () => {
    const file = join(dir, "blocker");
    writeFileSync(file, "x");
    const log = createFileLogger({ dir: join(file, "logs") });
    expect(() => {
      log.info("a");
      log.error("b", new Error("c"));
      log.child("t").warn("d");
    }).not.toThrow();
  });

  it("formats errors, tags and multi-line messages", () => {
    const log = createFileLogger({ dir, now: () => new Date(0) });
    log.child("plugin:x").error("failed", new Error("boom"));
    const text = readFileSync(join(dir, "main.log"), "utf8");
    expect(text).toMatch(/^1970-01-01T00:00:00.000Z ERROR \[plugin:x\] failed: Error: boom\n +at /);
  });

  it("guard returns the fallback on throw", () => {
    const log = createFileLogger({ dir });
    expect(guard(log, "x", () => { throw new Error("no"); }, 7)).toBe(7);
    expect(guard(log, "x", () => 3, 7)).toBe(3);
  });
});

describe("safe mode and paths", () => {
  it("detects env, argv and a one-shot marker", () => {
    const marker = join(dir, "safe-mode");
    expect(detectSafeMode({ env: { T3P_SAFE: "1" }, argv: [], markerPath: marker })).toEqual({ safe: true, reason: "T3P_SAFE=1" });
    expect(detectSafeMode({ env: {}, argv: ["x", "--t3p-safe"], markerPath: marker }).safe).toBe(true);
    writeFileSync(marker, "");
    expect(detectSafeMode({ env: {}, argv: [], markerPath: marker })).toEqual({ safe: true, reason: "safe-mode marker" });
    expect(existsSync(marker)).toBe(false);
    expect(detectSafeMode({ env: {}, argv: [], markerPath: marker }).safe).toBe(false);
  });

  it("resolves everything under T3P_HOME/.t3-patcher", () => {
    mkdirSync(join(dir, "h"));
    const p = resolvePaths({ T3P_HOME: join(dir, "h") }, "C:\\ignored");
    expect(p.base).toBe(join(dir, "h", ".t3-patcher"));
    expect(p.runtime).toBe(join(p.base, "runtime"));
    expect(resolvePaths({}, join(dir, "home")).home).toBe(join(dir, "home"));
  });
});
