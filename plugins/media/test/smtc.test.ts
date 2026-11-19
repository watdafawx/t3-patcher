import { describe, expect, it } from "vitest";

import { currentPosition, formatTime, parseMediaPoll, pollInterval, progressFraction } from "../src/smtc.js";

const media = { title: "Song", artist: "Artist", album: "Album", status: "Playing", posSec: 10, durSec: 100, updated: 1_000_000, canPrev: true, canNext: false, canToggle: true, thumb: "data:image/jpeg;base64,/9j/4AAQ", key: "k" };

describe("parseMediaPoll", () => {
  it("accepts a valid state", () => {
    const r = parseMediaPoll({ state: "ok", media });
    expect(r).toEqual({ state: "ok", media });
  });
  it("drops a thumbnail that is not a jpeg/png data URL", () => {
    const r = parseMediaPoll({ state: "ok", media: { ...media, thumb: "https://evil.example/x.png" } });
    expect(r.state === "ok" && r.media.thumb).toBeNull();
    const js = parseMediaPoll({ state: "ok", media: { ...media, thumb: 'data:image/svg+xml;base64,AAAA' } });
    expect(js.state === "ok" && js.media.thumb).toBeNull();
  });
  it("strips control characters and caps long text", () => {
    const r = parseMediaPoll({ state: "ok", media: { ...media, title: `a\u0000b\n${"x".repeat(500)}` } });
    expect(r.state === "ok" && r.media.title.length).toBe(300);
    expect(r.state === "ok" && r.media.title.startsWith("a b ")).toBe(true);
  });
  it("maps odd status and bad numbers safely", () => {
    const r = parseMediaPoll({ state: "ok", media: { ...media, status: "Changing", posSec: -3, durSec: "x", updated: NaN } });
    expect(r.state === "ok" && r.media).toMatchObject({ status: "Other", posSec: 0, durSec: 0, updated: 0 });
  });
  it("is idle without a title and artist", () => {
    expect(parseMediaPoll({ state: "ok", media: { ...media, title: "", artist: "" } })).toEqual({ state: "idle" });
    expect(parseMediaPoll({ state: "idle" })).toEqual({ state: "idle" });
  });
  it("turns garbage into unavailable, never throws", () => {
    for (const bad of [null, undefined, 5, "x", {}, { state: "ok" }, { state: "wat" }]) expect(parseMediaPoll(bad).state).toBe("unavailable");
    expect(parseMediaPoll({ state: "unavailable", retryInMs: 1234 })).toEqual({ state: "unavailable", retryInMs: 1234 });
  });
});

describe("progress", () => {
  it("extrapolates only while playing and clamps to the duration", () => {
    expect(currentPosition({ status: "Playing", posSec: 10, durSec: 100, updated: 1_000_000 }, 1_005_000)).toBe(15);
    expect(currentPosition({ status: "Paused", posSec: 10, durSec: 100, updated: 1_000_000 }, 1_005_000)).toBe(10);
    expect(currentPosition({ status: "Playing", posSec: 99, durSec: 100, updated: 1_000_000 }, 1_900_000)).toBe(100);
    expect(currentPosition({ status: "Playing", posSec: 10, durSec: 100, updated: 2_000_000 }, 1_000_000)).toBe(10); // clock skew
  });
  it("fraction is null without a duration", () => {
    expect(progressFraction({ status: "Playing", posSec: 10, durSec: 0, updated: 0 }, 5)).toBeNull();
    expect(progressFraction({ status: "Paused", posSec: 25, durSec: 100, updated: 0 }, 5)).toBe(0.25);
  });
  it("formats time", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(187.9)).toBe("3:07");
    expect(formatTime(3723)).toBe("1:02:03");
    expect(formatTime(-5)).toBe("0:00");
  });
});

describe("pollInterval", () => {
  it("polls only while something needs it", () => {
    expect(pollInterval({ view: false, chip: false })).toBeNull();
    expect(pollInterval({ view: true, chip: false })).toBe(1000);
    expect(pollInterval({ view: true, chip: true })).toBe(1000);
    expect(pollInterval({ view: false, chip: true })).toBe(5000);
    expect(pollInterval({ view: true, chip: false }, 30_000)).toBe(30_000);
  });
});
