import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectDevMode } from "../src/dev-mode.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "t3p-dev-mode-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("detectDevMode", () => {
  const markerPath = () => join(dir, "dev-mode");

  it("is off without the env var or the marker", () => {
    expect(detectDevMode({ env: {}, markerPath: markerPath() })).toEqual({ dev: false, reason: null });
  });

  it("turns on with T3P_DEV=1", () => {
    expect(detectDevMode({ env: { T3P_DEV: "1" }, markerPath: markerPath() })).toEqual({ dev: true, reason: "T3P_DEV=1" });
    expect(detectDevMode({ env: { T3P_DEV: "0" }, markerPath: markerPath() })).toEqual({ dev: false, reason: null });
  });

  it("turns on with the t3p dev marker and keeps it across launches", () => {
    writeFileSync(markerPath(), "{}\n");
    expect(detectDevMode({ env: {}, markerPath: markerPath() })).toEqual({ dev: true, reason: "dev-mode marker" });
    expect(detectDevMode({ env: {}, markerPath: markerPath() })).toEqual({ dev: true, reason: "dev-mode marker" });
  });
});
