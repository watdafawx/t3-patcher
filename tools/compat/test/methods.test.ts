import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compareVersionTags } from "../src/release.js";
import { diffMethods, methodTables, usedMethods } from "../src/methods.js";
import { pickInstallerAsset } from "../src/release.js";

const table = readFileSync(join(import.meta.dirname, "fixtures", "server-methods.txt"), "utf8");

const baseline = [
  "server.getConfig",
  "server.refreshProviders",
  "orchestration.subscribeThread",
  "terminal.create",
  "provider.auth.cancel",
];

describe("RPC method diff", () => {
  it("finds no change when every baseline method is present", () => {
    const diff = diffMethods(baseline.slice(0, 4), { evidence: "server", text: table });
    expect(diff.removed).toEqual([]);
    expect(diff.added).toEqual([]);
    expect(diff.found).toBe(4);
  });

  it("reports a removed method, including a hyphenated or nested name", () => {
    const withNested = `${table} var E={a:"provider.chatgpt.import-profile",b:"provider.auth.cancel"};`;
    const diff = diffMethods(baseline, { evidence: "server", text: withNested });
    expect(diff.removed).toEqual([]);

    const without = table.replace('terminalCreate: "terminal.create"', "");
    const diff2 = diffMethods(baseline.slice(0, 4), { evidence: "server", text: without });
    expect(diff2.removed).toEqual(["terminal.create"]);
    expect(diff2.found).toBe(3);
  });

  it("reports additions only from a table that already holds baseline methods", () => {
    const text = table.replace('terminalCreate: "terminal.create"', 'terminalCreate: "terminal.create", issuesList: "issues.list"');
    const diff = diffMethods(baseline.slice(0, 4), { evidence: "server", text });
    expect(diff.added).toEqual(["issues.list"]);
    // the keyboard-command table is not an RPC table: none of its ids show up
    expect(diff.added).not.toContain("sidebar.toggle");
    expect(diff.added).not.toContain("palette.open");
  });

  it("splits entries into tables by proximity", () => {
    const tables = methodTables(table);
    expect(tables).toHaveLength(2);
    expect(tables[0]).toContain("server.getConfig");
    expect(tables[1]).toContain("sidebar.toggle");
  });

  it("collects only baseline methods from our own sources", () => {
    const sources = [
      'await rpc.call("server.getConfig", {});',
      "subscribe(`orchestration.subscribeThread`)",
      'const x = "not.a.method";',
      'const y = "server.getConfig";',
    ];
    expect(usedMethods(sources, new Set(baseline))).toEqual(["orchestration.subscribeThread", "server.getConfig"]);
  });
});

describe("release helpers", () => {
  it("prefers the x64 NSIS installer", () => {
    const names = [
      "T3-Code-0.1.10-arm64.exe",
      "T3-Code-0.1.10-x64.exe",
      "T3-Code-0.1.10-x64.dmg",
      "latest.yml",
    ];
    expect(pickInstallerAsset(names)).toBe("T3-Code-0.1.10-x64.exe");
  });

  it("returns undefined when a release has no Windows installer", () => {
    expect(pickInstallerAsset(["T3-Code-0.1.10-x64.dmg", "latest.yml"])).toBeUndefined();
  });

  it("orders nightly tags below the release they build towards", () => {
    const tags = [
      "v0.1.11-nightly.20261118.4903",
      "v0.1.11-nightly.20261119.4918",
      "v0.1.10",
      "v0.1.10-nightly.20261116.4800",
      "v0.1.11",
    ];
    expect([...tags].sort(compareVersionTags)).toEqual([
      "v0.1.10-nightly.20261116.4800",
      "v0.1.10",
      "v0.1.11-nightly.20261118.4903",
      "v0.1.11-nightly.20261119.4918",
      "v0.1.11",
    ]);
  });
});
