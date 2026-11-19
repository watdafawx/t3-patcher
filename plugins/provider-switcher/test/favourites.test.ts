import { describe, expect, it } from "vitest";

import { parseFavourites } from "../src/logic/favourites.js";

describe("parseFavourites", () => {
  it("reads one instanceId:model per line, in order", () => {
    expect(parseFavourites("claudeAgent:claude-sonnet-5-5\ncodex:gpt-6.1-sol")).toEqual([
      { providerInstanceId: "claudeAgent", model: "claude-sonnet-5-5" },
      { providerInstanceId: "codex", model: "gpt-6.1-sol" },
    ]);
  });

  it("skips blank lines, comments and malformed lines", () => {
    const text = [
      "",
      "   ",
      "# a comment",
      "no-colon-here",
      ":model-without-provider",
      "provider-without-model:",
      "  claudeAgent : claude-sonnet-5-5  ",
      "codex:gpt:with:colons",
      "",
    ].join("\r\n");
    expect(parseFavourites(text)).toEqual([{ providerInstanceId: "claudeAgent", model: "claude-sonnet-5-5" }]);
  });

  it("keeps the first of a duplicate", () => {
    expect(parseFavourites("a:m\nb:n\na:m")).toEqual([
      { providerInstanceId: "a", model: "m" },
      { providerInstanceId: "b", model: "n" },
    ]);
  });

  it("handles an empty setting", () => {
    expect(parseFavourites("")).toEqual([]);
  });
});
