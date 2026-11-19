import { settingVisible, type SettingSchema, type SettingValue } from "@t3p/api";
import { describe, expect, it } from "vitest";

import { BG_KINDS } from "../src/bg-model.js";
import { settings } from "../src/index.js";

/** Every key (and its default and type) that shipped before the Background regrouping. */
const OLD_KEYS: Record<string, [string, SettingValue]> = {
  preset: ["enum", "aurora"],
  intensity: ["range", 60],
  speed: ["range", 40],
  hue: ["number", -1],
  fadeHeight: ["range", 190],
  blur: ["range", 24],
  angle: ["range", 160],
  scrim: ["boolean", true],
  artworkName: ["string", ""],
  mainGlow: ["boolean", false],
  logoMode: ["enum", "keep"],
  logoText: ["string", "T3 Code"],
  logoHeight: ["range", 18],
  oceanOn: ["boolean", false],
  bgKind: ["enum", "ocean"],
  bgIntensity: ["range", 60],
  bgSpeed: ["range", 50],
  bgDensity: ["range", 50],
  bgPointer: ["boolean", true],
  bgFollowAccent: ["boolean", true],
  bgLowPower: ["boolean", false],
  oceanIntensity: ["range", 60],
  oceanSpeed: ["range", 50],
  oceanRipples: ["boolean", true],
  allowRemoteAssets: ["boolean", false],
};

const byKey = (key: string): SettingSchema => settings.find((s) => s.key === key)!;

/** Keys the Background group shows for a kind, in order. */
function backgroundRows(kind: string): string[] {
  const get = (key: string): SettingValue | undefined => (key === "bgKind" ? kind : undefined);
  return settings.filter((s) => s.group === "Background" && settingVisible(s, get)).map((s) => s.key);
}

describe("artwork settings schema", () => {
  it("keeps every old key with its old type and default (installs migrate untouched)", () => {
    for (const [key, [type, value]] of Object.entries(OLD_KEYS)) {
      expect(byKey(key), key).toBeDefined();
      expect(byKey(key).type, key).toBe(type);
      expect(byKey(key).default, key).toBe(value);
    }
  });

  it("adds bgDim and bgBlur with defaults 0 so old installs look the same", () => {
    expect(byKey("bgDim")).toMatchObject({ type: "range", default: 0, min: 0, max: 80 });
    expect(byKey("bgBlur")).toMatchObject({ type: "range", default: 0, min: 0 });
    expect((byKey("bgBlur") as { max: number }).max).toBeLessThanOrEqual(20);
  });

  it("lists sections in order: Sidebar artwork, Logo, Background, Custom HTML/CSS", () => {
    const order: string[] = [];
    for (const s of settings) if (s.group && !order.includes(s.group)) order.push(s.group);
    expect(order).toEqual(["Sidebar artwork", "Logo", "Background", "Custom HTML/CSS"]);
    expect(settings.every((s) => s.group)).toBe(true);
  });

  it("puts the master switch and the kind first in the Background group", () => {
    expect(settings.filter((s) => s.group === "Background").slice(0, 2).map((s) => s.key)).toEqual(["oceanOn", "bgKind"]);
  });

  it("shows only what each kind uses", () => {
    expect(backgroundRows("ocean")).toEqual(["oceanOn", "bgKind", "oceanIntensity", "oceanSpeed", "bgDim", "bgBlur", "oceanRipples", "bgQuality", "bgPauseWhileTyping"]);
    expect(backgroundRows("antigravity")).toEqual(["oceanOn", "bgKind", "bgIntensity", "bgSpeed", "bgDensity", "bgDim", "bgBlur", "bgPointer", "bgFollowAccent", "bgLowPower", "bgQuality", "bgPauseWhileTyping"]);
    expect(backgroundRows("starfield")).toEqual(["oceanOn", "bgKind", "bgIntensity", "bgSpeed", "bgDensity", "bgDim", "bgBlur", "bgPointer", "bgFollowAccent", "bgLowPower", "bgQuality", "bgPauseWhileTyping"]);
    expect(backgroundRows("drift")).toEqual(["oceanOn", "bgKind", "bgIntensity", "bgSpeed", "bgDensity", "bgDim", "bgBlur", "bgFollowAccent", "bgLowPower", "bgQuality", "bgPauseWhileTyping"]);
  });

  it("never shows two rows with the same label at once", () => {
    for (const kind of BG_KINDS) {
      const labels = backgroundRows(kind).map((k) => byKey(k).label);
      expect(new Set(labels).size, kind).toBe(labels.length);
    }
  });

  it("only points showWhen at settings that exist", () => {
    for (const s of settings) if (s.showWhen) expect(byKey(s.showWhen.key), s.key).toBeDefined();
  });
});
