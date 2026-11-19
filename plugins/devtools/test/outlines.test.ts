import { describe, expect, it } from "vitest";

import { buildOutlineCss, OUTLINE_ATTR, outlineLabel, SLOT_ANCHORS } from "../src/logic/outlines.js";

describe("outline labels", () => {
  it("builds plugin · slot and falls back for missing parts", () => {
    expect(outlineLabel({ plugin: "cache-watch", slot: "sidebarSection" })).toBe("cache-watch · sidebarSection");
    expect(outlineLabel({})).toBe("? · ?");
    expect(outlineLabel({ plugin: "", slot: null })).toBe("? · ?");
  });
});

describe("outline stylesheet", () => {
  it("covers every documented slot anchor and scopes by the html attribute", () => {
    const css = buildOutlineCss();
    for (const anchor of SLOT_ANCHORS) for (const part of anchor.selector.split(",")) expect(css).toContain(part.trim());
    expect(css).toContain(`html[${OUTLINE_ATTR}="1"]`);
    expect(css).toContain(`html[${OUTLINE_ATTR}="1"] [role="menu"]`);
    expect(css).toContain("[data-t3p-root]");
    expect(css).toContain('content: attr(data-t3p-plugin) " · " attr(data-t3p-slot)');
    expect(SLOT_ANCHORS.map((a) => a.slot)).toEqual([
      "sidebarSection",
      "threadHeader",
      "composerBanner",
      "rightPanel",
      "statusBar",
      "settingsPage",
      "timelineRowDecorator",
      "contextMenuItem",
    ]);
  });

  it("uses concrete theme values when given, variables otherwise", () => {
    const themed = buildOutlineCss({ "--primary": "#ff00ff", "--destructive": "#00ff00", "--background": "#000000" });
    expect(themed).toContain("#ff00ff");
    expect(themed).toContain("#00ff00");
    expect(themed).toContain("#000000");
    expect(buildOutlineCss()).toContain("var(--primary, currentColor)");
  });
});
