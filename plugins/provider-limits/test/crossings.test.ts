import { describe, expect, it } from "vitest";

import { detectCrossings, windowKey, type CrossingState } from "../src/crossings.js";
import { DEFAULT_THRESHOLDS, type LimitWindow } from "../src/limits.js";
import { bareProvider, claudeProvider, codexProvider, makeProvider, unavailableProvider } from "./fixtures.js";

const CHECKED_AT = "2026-11-18T21:25:04.493Z";

/** One provider with exactly one session window at `usedPercent`. */
function providerAt(usedPercent: number, instanceId = "codex") {
  const window: LimitWindow = { id: "primary", kind: "session", label: "Session", usedPercent };
  return makeProvider({
    instanceId,
    usageLimits: { checkedAt: CHECKED_AT, windows: [window] },
  });
}

describe("windowKey", () => {
  it("is stable per instance and window", () => {
    expect(windowKey("codex", "primary")).toBe("codex\u0000primary");
    expect(windowKey("codex", "primary")).not.toBe(windowKey("codex", "secondary"));
    expect(windowKey("codex", "primary")).not.toBe(windowKey("claudeAgent", "primary"));
  });
});

describe("detectCrossings", () => {
  it("only seeds the state on the first snapshot", () => {
    const result = detectCrossings(null, [claudeProvider(), codexProvider()], DEFAULT_THRESHOLDS);
    expect(result.events).toEqual([]);
    expect(result.state[windowKey("codex", "secondary")]).toBe("ok");
    expect(Object.keys(result.state)).toHaveLength(5);
  });

  it("fires once when a window rises into warn, then stays quiet", () => {
    const base = detectCrossings(null, [providerAt(50)], DEFAULT_THRESHOLDS);
    expect(base.events).toEqual([]);

    const warn = detectCrossings(base.state, [providerAt(85)], DEFAULT_THRESHOLDS);
    expect(warn.events).toHaveLength(1);
    expect(warn.events[0]).toMatchObject({
      instanceId: "codex",
      windowId: "primary",
      windowLabel: "Session",
      from: "ok",
      to: "warn",
      usedPercent: 85,
    });

    const repeated = detectCrossings(warn.state, [providerAt(88)], DEFAULT_THRESHOLDS);
    expect(repeated.events).toEqual([]);
    expect(repeated.state[windowKey("codex", "primary")]).toBe("warn");
  });

  it("fires again on a warn -> critical rise, but not on the way down", () => {
    const warnState: CrossingState = { [windowKey("codex", "primary")]: "warn" };
    const critical = detectCrossings(warnState, [providerAt(99)], DEFAULT_THRESHOLDS);
    expect(critical.events[0]).toMatchObject({ from: "warn", to: "critical" });

    const backToWarn = detectCrossings(critical.state, [providerAt(85)], DEFAULT_THRESHOLDS);
    expect(backToWarn.events).toEqual([]);
    expect(backToWarn.state[windowKey("codex", "primary")]).toBe("warn");

    const dropToOk = detectCrossings(backToWarn.state, [providerAt(10)], DEFAULT_THRESHOLDS);
    expect(dropToOk.events).toEqual([]);
    expect(dropToOk.state[windowKey("codex", "primary")]).toBe("ok");

    const again = detectCrossings(dropToOk.state, [providerAt(85)], DEFAULT_THRESHOLDS);
    expect(again.events).toHaveLength(1);
    expect(again.events[0]?.from).toBe("ok");
  });

  it("fires when a window jumps straight from ok to critical", () => {
    const previous: CrossingState = { [windowKey("codex", "primary")]: "ok" };
    const result = detectCrossings(previous, [providerAt(100)], DEFAULT_THRESHOLDS);
    expect(result.events[0]).toMatchObject({ from: "ok", to: "critical" });
  });

  it("uses the active thresholds", () => {
    const previous: CrossingState = { [windowKey("codex", "primary")]: "ok" };
    const result = detectCrossings(previous, [providerAt(76)], { warnThreshold: 70, criticalThreshold: 90 });
    expect(result.events[0]?.to).toBe("warn");
  });

  it("treats an unseen window as ok", () => {
    const previous: CrossingState = {};
    const result = detectCrossings(previous, [providerAt(85)], DEFAULT_THRESHOLDS);
    expect(result.events).toHaveLength(1);
  });

  it("forgets windows that disappeared and ignores providers without limits", () => {
    const first = detectCrossings(null, [providerAt(85), bareProvider(), unavailableProvider()], DEFAULT_THRESHOLDS);
    expect(Object.keys(first.state)).toEqual([windowKey("codex", "primary")]);

    const empty = detectCrossings(first.state, [bareProvider()], DEFAULT_THRESHOLDS);
    expect(empty.events).toEqual([]);
    expect(empty.state).toEqual({});

    const returned = detectCrossings(empty.state, [providerAt(85)], DEFAULT_THRESHOLDS);
    expect(returned.events[0]).toMatchObject({ from: "ok", to: "warn" });
  });

  it("keeps provider instance ids apart", () => {
    const first = detectCrossings(null, [providerAt(95, "a"), providerAt(20, "b")], DEFAULT_THRESHOLDS);
    expect(first.state).toEqual({ [windowKey("a", "primary")]: "critical", [windowKey("b", "primary")]: "ok" });

    const next = detectCrossings(first.state, [providerAt(95, "a"), providerAt(96, "b")], DEFAULT_THRESHOLDS);
    expect(next.events).toHaveLength(1);
    expect(next.events[0]?.instanceId).toBe("b");
  });

  it("uses the recorded fixtures as-is", () => {
    const result = detectCrossings(null, [claudeProvider()], DEFAULT_THRESHOLDS);
    expect(result.state[windowKey("claudeAgent", "seven_day")]).toBe("ok");
  });
});
