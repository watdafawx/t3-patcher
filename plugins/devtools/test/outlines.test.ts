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
    expect(buildOutlineCss()).toContain("var(--primary, currentColor)");
  });

  it("regression: never changes layout (outline only, no position, display or visibility)", () => {
    const css = buildOutlineCss({ "--primary": "#ff00ff" });
    // Forcing position:relative on [data-t3p-root] pulled fixed toasts, modal overlays, the status bar
    // and the dock into the page flow, hiding the settings view and the toggle.
    expect(css).not.toMatch(/position\s*:/);
    expect(css).not.toMatch(/(display|visibility|opacity|transform|z-index|width|height|margin|padding)\s*:/);
    expect(css).not.toContain("::before");
    expect(css).not.toContain("::after");
    const props = [...css.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
    expect(new Set(props)).toEqual(new Set(["outline", "outline-offset"]));
  });
});
