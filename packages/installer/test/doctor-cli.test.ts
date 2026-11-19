import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { doctor } from "../src/doctor.js";
import { install } from "../src/install.js";
import { simulateUpstreamUpdate, createFakeInstall, createRuntimeSource, safeReadFuses, type FakeInstall } from "./fake-install.js";

const CLI = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
const CHECK_NAMES = [
  "install found",
  "fuses safe",
  "version supported",
  "layout patched",
  "_app.asar hash equals manifest",
  "junction",
  "runtime present",
  "exe signature",
  "crash-loop guard",
  "internal: atomRegistry",
  "internal: router",
  "internal: shortcutDispatcher",
  "internal: settingsNav",
  "internal: commandPalette",
  "shim log",
];

let tree: FakeInstall;
let runtimeSource: string;

const opts = () => ({
  path: tree.installDir,
  homeDir: tree.homeDir,
  readFuses: safeReadFuses,
  runtimeSource,
  verifySignature: async () => ({ ok: true, detail: "Valid (CN=T3 Tools Inc)" }),
});

beforeEach(async () => {
  tree = await createFakeInstall();
  runtimeSource = createRuntimeSource(tree.root);
});

afterEach(() => {
  tree.cleanup();
});

function runCli(args: string[], env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, T3P_HOME: tree.homeDir, ...env },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("doctor: tier 2 captures", () => {
  it("reads internals-status.json: captured and fallback are ok, failed is not", async () => {
    await install(opts());
    const base = join(tree.homeDir, ".t3-patcher");
    mkdirSync(base, { recursive: true });
    const cap = (state: string, detail: string) => ({ state, detail, at: null, patches: [] });
    writeFileSync(
      join(base, "internals-status.json"),
      JSON.stringify({
        version: 1,
        updatedAt: "2026-11-19T00:00:00Z",
        appVersion: "0.1.10",
        captures: {
          atomRegistry: cap("failed", "patch failed"),
          router: cap("captured", "app object captured by patch"),
          shortcutDispatcher: cap("fallback", "guarded document keydown listener"),
          settingsNav: cap("captured", "ok"),
          commandPalette: cap("pending", "no report yet"),
        },
      }),
    );
    const { checks } = await doctor(opts());
    const by = (name: string) => checks.find((c) => c.name === `internal: ${name}`)!;
    expect(by("router")).toMatchObject({ ok: true, detail: expect.stringMatching(/^captured/) });
    expect(by("shortcutDispatcher")).toMatchObject({ ok: true, detail: expect.stringMatching(/^fallback/) });
    expect(by("atomRegistry")).toMatchObject({ ok: false, detail: expect.stringMatching(/^failed/) });
    expect(by("commandPalette").ok).toBe(true);
  });

  it("says no status yet without the file", async () => {
    await install(opts());
    const { checks } = await doctor(opts());
    expect(checks.find((c) => c.name === "internal: router")).toMatchObject({ ok: true, detail: expect.stringMatching(/no status yet/) });
  });
});

describe("doctor", () => {
  it("reports every check for a healthy install", async () => {
    await install(opts());
    const logDir = join(tree.homeDir, ".t3-patcher", "logs");
    mkdirSync(logDir, { recursive: true });
    const lines = ["one", "two", "three", "four", "five", "six"].map((line, index) => `2026-11-19T00:00:0${index}Z ${line}`);
    writeFileSync(join(logDir, "shim.log"), `${lines.join("\n")}\n`);

    const { checks } = await doctor(opts());

    expect(checks.map((check) => check.name)).toEqual(CHECK_NAMES);
    expect(checks.filter((check) => !check.ok)).toEqual([]);
    const shimLog = checks.find((check) => check.name === "shim log");
    expect(shimLog?.detail).toContain("six");
    expect(shimLog?.detail).not.toContain("one");
    expect(checks.find((check) => check.name === "junction")?.detail).toMatch(/app\.asar\.unpacked/);
    expect(checks.find((check) => check.name === "exe signature")?.detail).toBe("Valid (CN=T3 Tools Inc)");
  });

  it("reports failures instead of throwing for an unpatched tree", async () => {
    const { checks } = await doctor(opts());

    expect(checks.map((check) => check.name)).toEqual(CHECK_NAMES);
    expect(checks.find((check) => check.name === "install found")?.ok).toBe(true);
    expect(checks.find((check) => check.name === "layout patched")?.ok).toBe(false);
    expect(checks.find((check) => check.name === "runtime present")?.ok).toBe(false);
  });

  it("reports no install without throwing", async () => {
    const { checks } = await doctor({
      homeDir: join(tree.root, "empty-home"),
      localAppDataDir: join(tree.root, "nothing-here"),
      platform: "linux",
      registryQuery: () => null,
    });

    expect(checks.find((check) => check.name === "install found")?.ok).toBe(false);
    expect(checks.find((check) => check.name === "exe signature")?.detail).toBe("skipped (no install)");
  });
});

describe("cli", () => {
  it("prints valid JSON and exits 0 for a patched tree", async () => {
    await install(opts());

    const result = runCli(["status", "--path", tree.installDir, "--json"]);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { layout: string; manifestPresent: boolean };
    expect(parsed.layout).toBe("patched");
    expect(parsed.manifestPresent).toBe(true);
  });

  it("exits 1 for a stale tree", async () => {
    await install(opts());
    await simulateUpstreamUpdate(tree, { version: "0.1.11" });

    const result = runCli(["status", "--path", tree.installDir, "--json"]);

    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout) as { layout: string };
    expect(parsed.layout).toBe("stale");
  });

  it("exits 1 and still prints valid JSON for doctor on an unpatched tree", () => {
    // --path keeps the CLI away from findInstalls and from this machine's real install.
    const result = runCli(["doctor", "--path", tree.installDir, "--json"]);

    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout) as { checks: { name: string; ok: boolean }[] };
    expect(parsed.checks.map((check) => check.name)).toEqual(CHECK_NAMES);
    expect(parsed.checks.find((check) => check.name === "install found")?.ok).toBe(true);
    expect(parsed.checks.find((check) => check.name === "layout patched")?.ok).toBe(false);
  });

  it("exits 2 for a missing or unknown command", () => {
    expect(runCli([]).status).toBe(2);
    expect(runCli(["frobnicate"]).status).toBe(2);
    expect(runCli(["status", "--bogus"]).status).toBe(2);
  });

  it("uninstalls through the CLI", async () => {
    await install(opts());

    const removed = runCli(["uninstall", "--path", tree.installDir, "--json"]);

    expect(removed.status, removed.stderr).toBe(0);
    expect(JSON.parse(removed.stdout)).toEqual({ ok: true, installDir: tree.installDir });
    expect((JSON.parse(runCli(["status", "--path", tree.installDir, "--json"]).stdout) as { layout: string }).layout).toBe(
      "unpatched",
    );
  });

  it("prints human-readable status output", async () => {
    await install(opts());

    const result = runCli(["status", "--path", tree.installDir]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("layout:   patched");
    expect(result.stdout).toContain("manifest: present");
  });
});
