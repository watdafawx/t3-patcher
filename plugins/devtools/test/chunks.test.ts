import { describe, expect, it } from "vitest";

import { collectChunkUrls } from "../src/logic/chunks.js";

const base = "t3code://app/#/chat";

describe("chunk discovery", () => {
  it("keeps same-origin JS from scripts, preloads and resource timings, once each", () => {
    const result = collectChunkUrls({
      baseUrl: base,
      scripts: ["/assets/index-abc.js", "t3code://app/assets/index-abc.js"],
      modulePreloads: ["/assets/vendor-def.mjs"],
      resources: [
        "t3code://app/assets/lazy-ghi.js?v=1",
        "/assets/lazy-ghi.js?v=1",
        "https://cdn.example/x.js",
        "/assets/style.css",
        "/__t3p/renderer.js",
        "/__t3p/plugins/devtools/dist/renderer.js",
      ],
    });
    expect(result.chunks.map((c) => c.name)).toEqual(["assets/index-abc.js", "assets/lazy-ghi.js", "assets/vendor-def.mjs"]);
    expect(result.chunks[1]!.url).toBe("t3code://app/assets/lazy-ghi.js?v=1");
    expect(result.overflow).toBe(0);
    expect(result.ignored).toBeGreaterThanOrEqual(3);
  });

  it("caps the candidate list and reports the overflow", () => {
    const scripts = Array.from({ length: 5 }, (_, i) => `/assets/c${i}.js`);
    const result = collectChunkUrls({ baseUrl: base, scripts, modulePreloads: [], resources: [], max: 2 });
    expect(result.chunks).toHaveLength(2);
    expect(result.overflow).toBe(3);
  });

  it("ignores other protocols and unusable inputs", () => {
    const result = collectChunkUrls({
      baseUrl: base,
      scripts: ["http://127.0.0.1:5173/main.js", "", "data:text/javascript,1"],
      modulePreloads: [],
      resources: [],
    });
    expect(result.chunks).toEqual([]);
    expect(result.ignored).toBe(3);
  });
});
