import { describe, expect, it } from "vitest";

import {
  accentColor,
  cleanName,
  dataUrlBytes,
  durationSeconds,
  findArtwork,
  fitSize,
  imageBudget,
  isSafeImageUrl,
  layerOpacity,
  layerVars,
  mainGlowOpacity,
  nextPreset,
  shiftedColor,
  uniqueName,
  type ArtworkConfig,
} from "../src/model.js";

const cfg: ArtworkConfig = { preset: "aurora", intensity: 60, speed: 40, hue: -1, fadeHeight: 180, blur: 24, angle: 160 };

describe("color math", () => {
  it("derives from --primary live when hue is negative", () => {
    expect(accentColor(-1)).toContain("var(--primary");
    expect(shiftedColor(-1, 35)).toContain("calc(h + 35)");
  });
  it("uses a fixed hue and wraps shifts", () => {
    expect(accentColor(200)).toBe("oklch(0.74 0.15 200)");
    expect(shiftedColor(350, 35)).toBe("oklch(0.74 0.15 25)");
    expect(shiftedColor(10, -30)).toBe("oklch(0.74 0.15 340)");
  });
});

describe("speed and opacity", () => {
  it("speed 0 is still", () => {
    expect(durationSeconds(0)).toBeNull();
    expect(durationSeconds(100)!).toBeLessThan(durationSeconds(1)!);
  });
  it("clamps", () => {
    expect(layerOpacity(500)).toBe(0.85);
    expect(layerOpacity(-5)).toBe(0);
    expect(mainGlowOpacity(100)).toBe(0.3);
  });
});

describe("layerVars", () => {
  it("maps config to css variables", () => {
    const v = layerVars(cfg);
    expect(v["--t3p-art-height"]).toBe("180px");
    expect(v["--t3p-art-blur"]).toBe("24px");
    expect(v["--t3p-art-opacity"]).toBe("0.51");
    expect(v["--t3p-art-angle"]).toBe("160deg");
  });
  it("clamps wild values", () => {
    const v = layerVars({ ...cfg, fadeHeight: 9999, blur: -3 });
    expect(v["--t3p-art-height"]).toBe("600px");
    expect(v["--t3p-art-blur"]).toBe("0px");
  });
});

describe("presets", () => {
  it("cycles both ways and recovers from unknown", () => {
    expect(nextPreset("aurora")).toBe("gradient");
    expect(nextPreset("none")).toBe("aurora");
    expect(nextPreset("aurora", -1)).toBe("none");
    expect(nextPreset("bogus")).toBe("gradient");
  });
});

describe("image sizing", () => {
  it("downscales the long edge, keeps aspect, never upscales", () => {
    expect(fitSize(3200, 1600, 1600)).toEqual({ width: 1600, height: 800 });
    expect(fitSize(800, 600, 1600)).toEqual({ width: 800, height: 600 });
    expect(fitSize(0, 10, 100)).toEqual({ width: 1, height: 1 });
  });
  it("measures data urls", () => {
    expect(dataUrlBytes("data:image/png;base64,QUJD")).toBe(3);
    expect(dataUrlBytes("data:image/png;base64,QUI=")).toBe(2);
    expect(dataUrlBytes("nope")).toBe(0);
  });
  it("budget is capped at 2 MB and by the quota", () => {
    expect(imageBudget(10_000_000, 0)).toBe(2_000_000);
    expect(imageBudget(1_048_576, 100_000)).toBe(1_048_576 - 100_000 - 16_000);
    expect(imageBudget(1_000, 5_000)).toBe(0);
    expect(imageBudget(1_048_576, 1_000_000, 500_000)).toBeGreaterThan(500_000);
  });
  it("only allows our own data urls in css", () => {
    expect(isSafeImageUrl("data:image/jpeg;base64,/9j/4AAQ")).toBe(true);
    expect(isSafeImageUrl("https://x.test/a.png")).toBe(false);
    expect(isSafeImageUrl("data:image/svg+xml;base64,AAAA")).toBe(false);
    expect(isSafeImageUrl('data:image/png;base64,AAA");x{')).toBe(false);
  });
});

describe("names", () => {
  it("cleans file names", () => {
    expect(cleanName("My  Sky.PNG")).toBe("My Sky");
    expect(cleanName(".png")).toBe("Artwork");
  });
  it("makes names unique and finds by name", () => {
    expect(uniqueName("Sky", ["sky", "Sky 2"])).toBe("Sky 3");
    expect(uniqueName("Sea", ["sky"])).toBe("Sea");
    expect(findArtwork([{ id: "1", name: "Sky", bytes: 1 }], " sky ")?.id).toBe("1");
  });
});
