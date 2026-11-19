import { describe, expect, it } from "vitest";

import { capEntries, filterEntries, parseLogLine, pluginOf, splitTail, toPluginEntries } from "../src/logic/logs.js";

describe("log line parsing", () => {
  it("parses the main.log header and levels", () => {
    expect(parseLogLine("2026-11-19T10:00:00.123Z INFO  [renderer:cache-watch] started")).toEqual({
      at: "2026-11-19T10:00:00.123Z",
      level: "info",
      tag: "renderer:cache-watch",
      message: "started",
    });
    expect(parseLogLine("2026-11-19T10:00:00.123Z ERROR [plugin:devtools] boom: x")?.level).toBe("error");
    expect(parseLogLine("2026-11-19T10:00:00Z WARN  no tag here")?.tag).toBe("");
    expect(parseLogLine("    continuation of the previous line")).toBeNull();
    expect(parseLogLine("")).toBeNull();
  });

  it("extracts plugin ids from renderer and main tags", () => {
    expect(pluginOf("renderer:cache-watch")).toBe("cache-watch");
    expect(pluginOf("plugin:devtools")).toBe("devtools");
    expect(pluginOf("renderer:")).toBeNull();
    expect(pluginOf("plugin:")).toBeNull();
    expect(pluginOf("renderer")).toBeNull();
    expect(pluginOf("")).toBeNull();
  });

  it("keeps only plugin lines", () => {
    const entries = toPluginEntries([
      "2026-11-19T10:00:00Z INFO  [renderer] core renderer log",
      "2026-11-19T10:00:01Z INFO  [renderer:cache-watch] one",
      "2026-11-19T10:00:02Z WARN  [plugin:devtools] two",
      "    indented continuation",
      "2026-11-19T10:00:03Z INFO  [patch] patch applied",
    ]);
    expect(entries.map((e) => `${e.plugin}:${e.message}`)).toEqual(["cache-watch:one", "devtools:two"]);
    expect(filterEntries(entries, "devtools")).toHaveLength(1);
    expect(filterEntries(entries, null)).toHaveLength(2);
  });
});

describe("tail splitting", () => {
  it("keeps a partial line for the next chunk", () => {
    const first = splitTail("", "line one\nline two");
    expect(first.lines).toEqual(["line one"]);
    expect(first.carry).toBe("line two");
    const second = splitTail(first.carry, " done\nline three\n");
    expect(second.lines).toEqual(["line two done", "line three"]);
    expect(second.carry).toBe("");
  });

  it("handles empty chunks and caps a runaway carry", () => {
    expect(splitTail("", "")).toEqual({ lines: [], carry: "" });
    const huge = "x".repeat(70_000);
    expect(splitTail("", huge).carry.length).toBe(64_000);
  });
});

describe("entry cap", () => {
  it("keeps the newest entries", () => {
    expect(capEntries([1, 2, 3], 2)).toEqual([2, 3]);
    expect(capEntries([1], 5)).toEqual([1]);
  });
});
