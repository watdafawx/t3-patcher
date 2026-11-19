import type { ProviderSnapshot } from "@t3p/api";
import { describe, expect, it } from "vitest";

import { chooseFallback, parseFavorites } from "../src/model.js";
import { makeProvider } from "./fixtures.js";

function prov(instanceId: string, used: number[] | null, models: string[], extra: Partial<ProviderSnapshot> = {}): ProviderSnapshot {
  return makeProvider({
    instanceId,
    models: models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
    ...(used
      ? { usageLimits: { checkedAt: "2026-11-18T21:25:04.493Z", windows: used.map((u, i) => ({ id: `w${i}`, kind: i === 0 ? "session" : "weekly", label: i === 0 ? "Session" : "Weekly", windowDurationMins: 300, usedPercent: u, resetsAt: null })) } }
      : {}),
    ...extra,
  } as Partial<ProviderSnapshot> & { instanceId: string });
}

const request = { provider: "claudeAgent", model: "claude-opus-5-5" };

describe("chooseFallback", () => {
  const claude = prov("claudeAgent", [97], ["claude-opus-5-5", "claude-sonnet-5-5"]);

  it("picks the first favorite with headroom, in favorite order", () => {
    const r = chooseFallback({
      request,
      favorites: [{ provider: "codex", model: "gpt-6.1-sol" }, { provider: "opencode", model: "deepseek" }],
      limits: [claude, prov("codex", [38, 10], ["gpt-6.1-sol"]), prov("opencode", [5], ["deepseek"])],
      threshold: 5,
    });
    expect(r.pick).toMatchObject({ provider: "codex", model: "gpt-6.1-sol", source: "favorite" });
    expect(r.pick?.remaining?.percent).toBe(62);
    expect(r.skipped).toEqual([]);
  });

  it("the lower of session and weekly remaining wins and can skip a candidate", () => {
    const r = chooseFallback({
      request,
      favorites: [{ provider: "codex", model: "gpt-6.1-sol" }, { provider: "opencode", model: "deepseek" }],
      limits: [claude, prov("codex", [10, 98], ["gpt-6.1-sol"]), prov("opencode", [20], ["deepseek"])],
      threshold: 5,
    });
    expect(r.skipped).toEqual([{ provider: "codex", model: "gpt-6.1-sol", source: "favorite", reason: "2% left", percent: 2 }]);
    expect(r.pick?.provider).toBe("opencode");
  });

  it("skips a different model of the same exhausted provider", () => {
    const r = chooseFallback({ request, favorites: [{ provider: "claudeAgent", model: "claude-sonnet-5-5" }, { provider: "codex", model: "gpt-6.1-sol" }], limits: [claude, prov("codex", [10], ["gpt-6.1-sol"])], threshold: 5 });
    expect(r.skipped[0]).toMatchObject({ provider: "claudeAgent", model: "claude-sonnet-5-5", reason: "3% left" });
    expect(r.pick?.provider).toBe("codex");
  });

  it("never offers the blocked model itself", () => {
    const r = chooseFallback({ request, favorites: [{ provider: "claudeAgent", model: "claude-opus-5-5" }], limits: [claude], threshold: 5 });
    expect(r.pick).toBeNull();
    expect(r.skipped).toEqual([]);
  });

  it("ranks unknown limits after known-good candidates but still allows them", () => {
    const limits = [claude, prov("opencode", null, ["deepseek"]), prov("codex", [10], ["gpt-6.1-sol"])];
    const favorites = [{ provider: "opencode", model: "deepseek" }, { provider: "codex", model: "gpt-6.1-sol" }];
    expect(chooseFallback({ request, favorites, limits, threshold: 5 }).pick?.provider).toBe("codex");
    const only = chooseFallback({ request, favorites: [favorites[0]!], limits: [claude, limits[1]!], threshold: 5 });
    expect(only.pick).toMatchObject({ provider: "opencode", remaining: null });
  });

  it("skips signed-out, errored, disabled, missing providers and unknown models", () => {
    const r = chooseFallback({
      request,
      favorites: [
        { provider: "a", model: "m" },
        { provider: "b", model: "m" },
        { provider: "c", model: "m" },
        { provider: "ghost", model: "m" },
        { provider: "d", model: "nope" },
      ],
      limits: [
        claude,
        prov("a", [1], ["m"], { auth: { status: "unauthenticated" } }),
        prov("b", [1], ["m"], { status: "error" }),
        prov("c", [1], ["m"], { enabled: false }),
        prov("d", [1], ["m"]),
      ],
      threshold: 5,
    });
    expect(r.skipped.map((s) => s.reason)).toEqual(["not signed in", "provider error", "disabled", "provider unavailable", "model not offered"]);
    expect(r.pick).toBeNull();
  });

  it("override is tried first and wins when healthy", () => {
    const r = chooseFallback({
      request,
      favorites: [{ provider: "codex", model: "gpt-6.1-sol" }],
      limits: [claude, prov("codex", [10], ["gpt-6.1-sol", "gpt-5.4"])],
      threshold: 5,
      override: { provider: "codex", model: "gpt-5.4" },
    });
    expect(r.pick).toMatchObject({ model: "gpt-5.4", source: "override" });
  });

  it("falls through when the override is unhealthy", () => {
    const r = chooseFallback({
      request,
      favorites: [{ provider: "codex", model: "gpt-6.1-sol" }],
      limits: [claude, prov("codex", [10], ["gpt-6.1-sol"]), prov("opencode", [99], ["x"])],
      threshold: 5,
      override: { provider: "opencode", model: "x" },
    });
    expect(r.skipped[0]).toMatchObject({ source: "override", provider: "opencode" });
    expect(r.pick?.source).toBe("favorite");
  });

  it("bare override model means the request's provider", () => {
    const r = chooseFallback({ request, favorites: [], limits: [claude], threshold: 5, override: { provider: null, model: "claude-sonnet-5-5" } });
    expect(r.skipped[0]).toMatchObject({ provider: "claudeAgent", model: "claude-sonnet-5-5", source: "override" });
  });

  it("no favorites: falls back to each other provider's default model", () => {
    const codex = prov("codex", [10], ["gpt-a", "gpt-b"]);
    codex.models = codex.models.map((m, i) => ({ ...m, isDefault: i === 1 }));
    const r = chooseFallback({ request, favorites: [], limits: [claude, codex, prov("opencode", [99], ["x"])], threshold: 5 });
    expect(r.pick).toMatchObject({ provider: "codex", model: "gpt-b", source: "provider" });
    expect(r.skipped).toEqual([{ provider: "opencode", model: "x", source: "provider", reason: "1% left", percent: 1 }]);
  });

  it("all skipped gives a null pick and every reason", () => {
    const r = chooseFallback({ request, favorites: [{ provider: "codex", model: "g" }], limits: [claude, prov("codex", [99], ["g"])], threshold: 5 });
    expect(r.pick).toBeNull();
    expect(r.skipped).toHaveLength(1);
  });
});

describe("parseFavorites", () => {
  it("keeps valid rows, drops malformed ones, null is empty", () => {
    expect(parseFavorites([{ provider: "codex", model: "g" }, { provider: "x" }, null, { provider: "", model: "m" }])).toEqual([{ provider: "codex", model: "g" }]);
    expect(parseFavorites(null)).toEqual([]);
    expect(parseFavorites(undefined)).toEqual([]);
  });
});
