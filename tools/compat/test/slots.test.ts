import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { diffSlots, extractSlots, requiredSlots } from "../src/slots.js";

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "client-chunk.jsonl"), "utf8"),
) as { body: string };

function bundleOf(chunk: string, html = ""): { chunks: Map<string, string>; html: Map<string, string> } {
  return {
    chunks: new Map([["assets/chunk.js", chunk]]),
    html: new Map(html ? [["index.html", html]] : []),
  };
}

describe("data-slot extraction", () => {
  it("reads prop-object, HTML-string and quoted values", () => {
    const slots = extractSlots(bundleOf(fixture.body));
    expect(slots).toContain("sidebar-content");
    expect(slots).toContain("thread-header");
  });

  it("reads slots from index.html too", () => {
    const slots = extractSlots(bundleOf("export const x=1;", '<div data-slot="settings-page"></div>'));
    expect(slots).toEqual(["settings-page"]);
  });

  it("ignores an attribute with no value", () => {
    expect(extractSlots(bundleOf("const x=[data-slot];"))).toEqual([]);
  });

  it("collects the anchors our selectors use", () => {
    const sources = [
      'const a = document.querySelector(\'[data-slot="sidebar-content"]\');',
      'const b = document.querySelector(\'[data-slot="menu-popup"],[role="menu"]\');',
      'const c = "[data-slot]";',
    ];
    expect(requiredSlots(sources)).toEqual(["menu-popup", "sidebar-content"]);
  });

  it("diffs added and removed anchors", () => {
    expect(diffSlots(["a", "b", "c"], ["b", "c", "d"])).toEqual({ added: ["d"], removed: ["a"] });
    expect(diffSlots(["a"], ["a"])).toEqual({ added: [], removed: [] });
  });
});
