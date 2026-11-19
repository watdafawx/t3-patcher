import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SHIM_SOURCE } from "../src/index.js";

const shimPath = fileURLToPath(new URL("../src/shim.cjs", import.meta.url));

describe("@t3p/shim", () => {
  it("exports the exact bytes of src/shim.cjs", () => {
    expect(SHIM_SOURCE).toBe(readFileSync(shimPath, "utf8"));
  });

  it("stays a small, fail-open CommonJS shim", () => {
    expect(SHIM_SOURCE.length).toBeLessThan(2000);
    expect(SHIM_SOURCE.split("\n").length).toBeLessThanOrEqual(20);
    expect(SHIM_SOURCE).toContain("require(path.join(process.resourcesPath, '_app.asar'));");
    expect(SHIM_SOURCE).toContain("process.env.T3P_HOME || os.homedir()");
    expect(SHIM_SOURCE).toContain("T3P_SAFE");
    expect(SHIM_SOURCE).toContain("--t3p-safe");
    expect(SHIM_SOURCE).toContain("fail-open");
    expect(SHIM_SOURCE).not.toMatch(/getPath|electron/);
  });
});

/** Runs the shim in a child node with a fake resources dir; returns the order log and shim.log. */
describe("shim behaviour (child process)", () => {
  let root: string;
  let home: string;
  let resources: string;
  let order: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "t3p-shim-"));
    home = join(root, "home");
    resources = join(root, "resources");
    order = join(root, "order.txt");
    // A fake original app: a folder named _app.asar with an index.js (require() resolves folders).
    mkdirSync(join(resources, "_app.asar"), { recursive: true });
    writeFileSync(join(resources, "_app.asar", "package.json"), '{"main":"index.js"}');
    writeFileSync(
      join(resources, "_app.asar", "index.js"),
      `require('fs').appendFileSync(${JSON.stringify(order)}, 'app\\n');`,
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function writeRuntime(body: string): void {
    const dir = join(home, ".t3-patcher", "runtime");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "main.cjs"), body);
  }
  function run(env: Record<string, string> = {}, args: string[] = []): { order: string[]; log: string; status: number | null } {
    const runner = join(root, "run.cjs");
    writeFileSync(runner, `process.resourcesPath = ${JSON.stringify(resources)}; require(${JSON.stringify(shimPath)});`);
    const r = spawnSync(process.execPath, [runner, ...args], { env: { ...process.env, T3P_HOME: home, ...env }, encoding: "utf8" });
    const logFile = join(home, ".t3-patcher", "logs", "shim.log");
    return {
      order: existsSync(order) ? readFileSync(order, "utf8").trim().split("\n") : [],
      log: existsSync(logFile) ? readFileSync(logFile, "utf8") : "",
      status: r.status,
    };
  }
  const runtimeMarker = (): string => `require('fs').appendFileSync(${JSON.stringify(order)}, 'runtime\\n');`;

  it("loads the runtime from T3P_HOME before the app", () => {
    writeRuntime(runtimeMarker());
    expect(run()).toMatchObject({ order: ["runtime", "app"], status: 0 });
  });

  it("starts the stock app and logs when the runtime is missing", () => {
    const r = run();
    expect(r.order).toEqual(["app"]);
    expect(r.log).toContain("runtime missing");
  });

  it("starts the stock app and logs when the runtime throws", () => {
    writeRuntime("throw new Error('boom from runtime');");
    const r = run();
    expect(r.order).toEqual(["app"]);
    expect(r.log).toContain("fail-open");
    expect(r.log).toContain("boom from runtime");
  });

  it.each([
    ["T3P_SAFE=1", { T3P_SAFE: "1" }, []],
    ["--t3p-safe", {}, ["--t3p-safe"]],
  ])("skips the runtime with %s", (_name, env, args) => {
    writeRuntime(runtimeMarker());
    const r = run(env as Record<string, string>, args as string[]);
    expect(r.order).toEqual(["app"]);
    expect(r.log).toContain("safe mode");
  });

  it("consumes the safe-mode marker once", () => {
    writeRuntime(runtimeMarker());
    const marker = join(home, ".t3-patcher", "safe-mode");
    writeFileSync(marker, "");
    expect(run().order).toEqual(["app"]);
    expect(existsSync(marker)).toBe(false);
    rmSync(order);
    expect(run().order).toEqual(["runtime", "app"]);
  });
});
