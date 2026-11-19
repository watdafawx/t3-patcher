import { describe, expect, it } from "vitest";
import { BG_KINDS } from "../src/bg-model.js";
import {
  ActivityGate,
  AUTO_START,
  BG_QUALITIES,
  GOVERNOR_LIMITS,
  INPUT_QUIET_MS,
  isBgQuality,
  QualityGovernor,
  qualityProfile,
  startTier,
  STREAM_QUIET_MS,
  STREAM_RATE,
  TIERS,
  tierScale,
} from "../src/bg-perf.js";
import { blobAt } from "../src/drift.js";

describe("quality tiers", () => {
  it("every kind gets cheaper (or equal) down the tiers and static never animates", () => {
    for (const kind of BG_KINDS) {
      const p = TIERS.map((t) => qualityProfile(kind, t));
      expect(p[0]!.fps).toBeGreaterThanOrEqual(p[1]!.fps);
      expect(p[1]!.fps).toBeGreaterThanOrEqual(p[2]!.fps);
      expect(p[0]!.scale).toBeGreaterThanOrEqual(p[1]!.scale);
      expect(p[1]!.scale).toBeGreaterThanOrEqual(p[2]!.scale);
      expect(p[0]!.maxPixels).toBeGreaterThan(p[2]!.maxPixels);
      expect(p[3]!.fps).toBe(0);
      expect(p[1]!.fps).toBeLessThanOrEqual(30); // balanced (the auto start) never draws more than 30 fps
    }
  });

  it("auto starts at balanced, fixed qualities start at themselves; isBgQuality guards", () => {
    expect(startTier("auto")).toBe(AUTO_START);
    expect(AUTO_START).toBe("balanced");
    for (const q of BG_QUALITIES) if (q !== "auto") expect(startTier(q)).toBe(q);
    expect(isBgQuality("low")).toBe(true);
    expect(isBgQuality("ultra")).toBe(false);
    expect(isBgQuality(3)).toBe(false);
  });

  it("tierScale: the tier scale, never above the device ratio, inside the pixel budget, never zero", () => {
    const p = { scale: 1, maxPixels: 1_000_000 };
    expect(tierScale(800, 600, 2, p)).toBe(1);
    expect(tierScale(800, 600, 0.5, p)).toBe(0.5);
    const s = tierScale(2195, 1187, 1.75, p);
    expect(2195 * s * 1187 * s).toBeCloseTo(1_000_000, -3);
    expect(tierScale(100_000, 100_000, 2, p)).toBe(0.05);
    expect(tierScale(0, 600, 2, { scale: 0.2, maxPixels: 1 })).toBe(0.2);
  });
});

describe("activity gate (pause while typing / streaming)", () => {
  it("input makes it busy for the quiet period; more input extends it", () => {
    const g = new ActivityGate();
    expect(g.busy(0)).toBe(false);
    expect(g.input(100)).toBe(true);
    expect(g.input(500)).toBe(false); // already busy
    expect(g.busy(500 + INPUT_QUIET_MS - 1)).toBe(true);
    expect(g.remaining(500)).toBe(INPUT_QUIET_MS);
    expect(g.busy(500 + INPUT_QUIET_MS)).toBe(false);
    expect(g.remaining(10_000)).toBe(0);
  });

  it("a mutation burst (streaming) makes it busy, a slow trickle (a clock) never does", () => {
    const slow = new ActivityGate();
    for (let t = 0; t < 20_000; t += 1000) slow.mutations(2, t); // a clock ticking twice a second
    expect(slow.busy(20_000)).toBe(false);

    const g = new ActivityGate();
    let started = false;
    for (let t = 0; t < 1000; t += 50) started = g.mutations(1, t) || started; // 20 tokens a second
    expect(started).toBe(true);
    expect(g.busy(1000)).toBe(true);
    expect(g.busy(950 + STREAM_QUIET_MS + 1)).toBe(false);
    expect(STREAM_RATE).toBeGreaterThan(2);
  });

  it("reset clears everything", () => {
    const g = new ActivityGate();
    g.input(0);
    g.reset();
    expect(g.busy(1)).toBe(false);
  });
});

describe("quality governor (auto)", () => {
  const W = GOVERNOR_LIMITS.windowMs;
  /** Feeds one window of `n` frames, then ticks at its end. */
  const win = (gov: QualityGovernor, t: number, n: number, draw: number, gap: number, blocking = 0): string => {
    gov.tick(t);
    for (let i = 0; i < n; i++) gov.frame(draw, gap);
    if (blocking) gov.blocking(blocking);
    return gov.tick(t + W);
  };

  it("keeps the tier while frames are cheap and on time", () => {
    const gov = new QualityGovernor();
    expect(gov.tick(0)).toBe("keep");
    for (let i = 0; i < 4; i++) expect(win(gov, i * W, 90, 1, 33)).toBe("keep");
    expect(gov.tier).toBe("balanced");
  });

  it("steps down on slow draws, on stalled frame delivery and on page-wide long animation frames", () => {
    const slow = new QualityGovernor();
    expect(win(slow, 0, 60, GOVERNOR_LIMITS.drawMs + 1, 33)).toBe("down");
    expect(slow.tier).toBe("low");

    const stalled = new QualityGovernor();
    // cheap draws, but half of the frames came after a > 50 ms main-thread stall: the user feels that
    stalled.tick(0);
    for (let i = 0; i < 20; i++) stalled.frame(0.5, i % 2 ? 80 : 33);
    expect(stalled.tick(W)).toBe("down");

    const janky = new QualityGovernor();
    expect(win(janky, 0, 60, 0.5, 33, GOVERNOR_LIMITS.blockingMs + 1)).toBe("down");
  });

  it("ignores the stall ratio with too few frames, bottoms out at static", () => {
    const gov = new QualityGovernor();
    expect(win(gov, 0, 3, 0.5, 500)).toBe("keep");
    let t = W;
    for (let i = 0; i < 5; i++, t += W) win(gov, t, 60, 10, 33);
    expect(gov.tier).toBe("static");
    expect(win(gov, t, 60, 10, 33)).toBe("keep");
  });

  it("recovers one tier after clean windows, never above its start", () => {
    const gov = new QualityGovernor();
    win(gov, 0, 60, 10, 33);
    expect(gov.tier).toBe("low");
    let t = W;
    const verdicts: string[] = [];
    for (let i = 0; i < GOVERNOR_LIMITS.recoverWindows; i++, t += W) verdicts.push(win(gov, t, 60, 0.5, 33));
    expect(verdicts.at(-1)).toBe("up");
    expect(gov.tier).toBe("balanced");
    for (let i = 0; i < GOVERNOR_LIMITS.recoverWindows * 2; i++, t += W) win(gov, t, 60, 0.5, 33);
    expect(gov.tier).toBe("balanced");
    const high = new QualityGovernor("high");
    expect(high.tier).toBe("high");
  });
});

describe("gradient drift motion", () => {
  it("blobs stay near their anchors, move over time and are deterministic", () => {
    const a = blobAt(0, 0, 2000, 1000, 45);
    const b = blobAt(0, 25, 2000, 1000, 45);
    expect(blobAt(0, 0, 2000, 1000, 45)).toEqual(a);
    expect(b.x).not.toBeCloseTo(a.x, 1);
    for (let i = 0; i < 4; i++)
      for (let t = 0; t < 400; t += 7) {
        const p = blobAt(i, t, 2000, 1000, 45);
        expect(p.x).toBeGreaterThan(0);
        expect(p.x).toBeLessThan(2000);
        expect(p.y).toBeGreaterThan(0);
        expect(p.y).toBeLessThan(1000);
        expect(p.r).toBeGreaterThan(300); // 45 vmax of 2000 px, scale 0.9..1.2, radius = half
        expect(p.r).toBeLessThan(600);
      }
  });

  it("negative time (alternate direction) is continuous", () => {
    const p = blobAt(1, -0.01, 1000, 1000, 40);
    const q = blobAt(1, 0, 1000, 1000, 40);
    expect(Math.abs(p.x - q.x)).toBeLessThan(1);
  });
});
