import { describe, expect, it } from "vitest";

import { isThreadSettled } from "../src/index.js";

describe("isThreadSettled", () => {
  it("is true only for settledOverride 'settled'", () => {
    expect(isThreadSettled({ settledOverride: "settled" })).toBe(true);
    expect(isThreadSettled({ settledOverride: "active" })).toBe(false);
    expect(isThreadSettled({ settledOverride: null })).toBe(false);
    expect(isThreadSettled({})).toBe(false);
    expect(isThreadSettled(null)).toBe(false);
  });
});
