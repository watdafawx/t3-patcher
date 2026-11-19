import { describe, expect, it } from "vitest";

import { clearHealth, crashThreshold, disableWithReason, emptyHealth, emptyState, parseHealth, parseState, pluginState, recordOutcome, setEnabled } from "../src/index.js";

describe("crash-loop counter (pure)", () => {
  it("counts failures in a row and trips at the threshold", () => {
    const h = emptyHealth();
    expect(recordOutcome(h, "p", false, 3, "boom")).toEqual({ failures: 1, tripped: false });
    expect(recordOutcome(h, "p", false, 3)).toEqual({ failures: 2, tripped: false });
    expect(recordOutcome(h, "p", false, 3)).toEqual({ failures: 3, tripped: true });
    expect(h.plugins.p!.failures).toBe(3);
  });

  it("keeps the last error", () => {
    const h = emptyHealth();
    recordOutcome(h, "p", false, 3, "boom");
    expect(h.plugins.p!.lastError).toBe("boom");
  });

  it("a clean window resets the counter", () => {
    const h = emptyHealth();
    recordOutcome(h, "p", false, 3);
    recordOutcome(h, "p", false, 3);
    expect(recordOutcome(h, "p", true, 3)).toEqual({ failures: 0, tripped: false });
    expect(h.plugins.p).toBeUndefined();
    expect(recordOutcome(h, "p", false, 3).failures).toBe(1);
  });

  it("counters are per plugin; clearHealth removes one", () => {
    const h = emptyHealth();
    recordOutcome(h, "a", false, 3);
    recordOutcome(h, "b", false, 3);
    clearHealth(h, "a");
    expect(Object.keys(h.plugins)).toEqual(["b"]);
  });

  it("parseHealth drops junk; threshold env", () => {
    expect(parseHealth({ plugins: { ok: { failures: 2 }, "BAD ID": { failures: 1 }, z: { failures: -1 }, y: "x" } }).plugins).toEqual({ ok: { failures: 2 } });
    expect(parseHealth("nope")).toEqual(emptyHealth());
    expect(crashThreshold({})).toBe(3);
    expect(crashThreshold({ T3P_CRASH_LOOP_THRESHOLD: "1" })).toBe(1);
    expect(crashThreshold({ T3P_CRASH_LOOP_THRESHOLD: "0" })).toBe(3);
    expect(crashThreshold({ T3P_CRASH_LOOP_THRESHOLD: "x" })).toBe(3);
  });
});

describe("state disabledReason (backward compatible)", () => {
  it("disableWithReason sets it; enabling clears it; old files still parse", () => {
    const s = emptyState();
    disableWithReason(s, "p", "crash-loop");
    expect(pluginState(s, "p")).toMatchObject({ enabled: false, disabledReason: "crash-loop" });
    const round = parseState(JSON.parse(JSON.stringify(s))).state;
    expect(pluginState(round, "p").disabledReason).toBe("crash-loop");
    setEnabled(s, "p", true);
    expect(pluginState(s, "p").disabledReason).toBeUndefined();
    expect(parseState({ version: 1, plugins: { q: { enabled: true, granted: [] } } }).state.plugins.q).toEqual({ enabled: true, granted: [] });
  });
});
