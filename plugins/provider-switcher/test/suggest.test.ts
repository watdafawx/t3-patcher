import { describe, expect, it } from "vitest";

import { chooseSuggestion, createSuggestionGate, worstWindow } from "../src/logic/suggest.js";
import { limits, model, provider } from "./fixtures.js";

describe("worstWindow", () => {
  it("returns the highest usedPercent window", () => {
    const value = worstWindow(limits([{ id: "session", label: "5h", usedPercent: 42 }, { id: "weekly", label: "week", usedPercent: 91 }]));
    expect(value).toEqual({ windowId: "weekly", label: "week", percent: 91 });
  });

  it("is null without windows, without limits or when the probe is unavailable", () => {
    expect(worstWindow(undefined)).toBeNull();
    expect(worstWindow({ windows: [] })).toBeNull();
    expect(worstWindow({ windows: [], unavailable: { reason: "unsupported" } })).toBeNull();
  });

  it("keeps resetsAt when the provider reports one", () => {
    const value = worstWindow({ windows: [{ id: "w", kind: "weekly", label: "week", usedPercent: 55, resetsAt: "2026-11-20T00:00:00Z" }] });
    expect(value?.resetsAt).toBe("2026-11-20T00:00:00Z");
  });
});

describe("chooseSuggestion", () => {
  const claude = provider({ instanceId: "claudeAgent", displayName: "Claude", usageLimits: limits([{ id: "weekly", usedPercent: 96 }]) });
  const codex = provider({ instanceId: "codex", displayName: "Codex", usageLimits: limits([{ id: "session", usedPercent: 12 }]) });
  const cursor = provider({ instanceId: "cursor", displayName: "Cursor", usageLimits: limits([{ id: "session", usedPercent: 4 }]) });
  const unknown = provider({ instanceId: "gemini", displayName: "Gemini", models: [model("g", { isDefault: true })] });
  const broken = provider({ instanceId: "broken", status: "error", message: "signed out" });

  it("suggests nothing while the current provider is below the threshold", () => {
    expect(chooseSuggestion({ providers: [claude, codex, cursor], currentInstanceId: "claudeAgent", threshold: 97 })).toBeNull();
  });

  it("picks the least-used usable provider and ignores unusable ones", () => {
    const suggestion = chooseSuggestion({ providers: [claude, codex, cursor, broken], currentInstanceId: "claudeAgent", threshold: 90 });
    expect(suggestion).toEqual({
      providerInstanceId: "cursor",
      label: "Cursor",
      model: "model-a",
      percent: 4,
      currentPercent: 96,
      currentWindowLabel: "weekly",
    });
  });

  it("prefers a measured provider over one that reports no limits", () => {
    const onlyUnknown = chooseSuggestion({ providers: [claude, unknown], currentInstanceId: "claudeAgent", threshold: 90 });
    expect(onlyUnknown?.providerInstanceId).toBe("gemini");
    expect(onlyUnknown?.percent).toBeNull();
    const measured = chooseSuggestion({ providers: [claude, unknown, codex], currentInstanceId: "claudeAgent", threshold: 90 });
    expect(measured?.providerInstanceId).toBe("codex");
  });

  it("returns null when no other provider can take a turn", () => {
    expect(chooseSuggestion({ providers: [claude, broken], currentInstanceId: "claudeAgent", threshold: 90 })).toBeNull();
  });

  it("skips a provider without a text model", () => {
    const empty = provider({ instanceId: "empty", models: [model("x", { supportsTextGeneration: false })] });
    expect(chooseSuggestion({ providers: [claude, empty], currentInstanceId: "claudeAgent", threshold: 90 })).toBeNull();
  });

  it("needs limits on the current provider", () => {
    const noLimits = provider({ instanceId: "claudeAgent", displayName: "Claude" });
    expect(chooseSuggestion({ providers: [noLimits, codex], currentInstanceId: "claudeAgent", threshold: 90 })).toBeNull();
  });

  it("is deterministic when two providers report the same usage", () => {
    const a = provider({ instanceId: "aaa", usageLimits: limits([{ id: "s", usedPercent: 10 }]) });
    const b = provider({ instanceId: "bbb", usageLimits: limits([{ id: "s", usedPercent: 10 }]) });
    expect(chooseSuggestion({ providers: [claude, b, a], currentInstanceId: "claudeAgent", threshold: 90 })?.providerInstanceId).toBe("aaa");
  });
});

describe("suggestion gate", () => {
  it("fires once per crossing and again after dropping below the threshold", () => {
    const gate = createSuggestionGate();
    expect(gate.check("t1", "claudeAgent", 95, 90)).toBe(true);
    expect(gate.check("t1", "claudeAgent", 96, 90)).toBe(false);
    expect(gate.check("t1", "claudeAgent", 40, 90)).toBe(false);
    expect(gate.check("t1", "claudeAgent", 90, 90)).toBe(true);
  });

  it("is one-time per thread: another thread has its own crossing", () => {
    const gate = createSuggestionGate();
    expect(gate.check("t1", "claudeAgent", 95, 90)).toBe(true);
    expect(gate.check("t2", "claudeAgent", 95, 90)).toBe(true);
    expect(gate.check("t1", "claudeAgent", 95, 90)).toBe(false);
  });

  it("starts a fresh baseline when the thread moves to another provider", () => {
    const gate = createSuggestionGate();
    expect(gate.check("t1", "claudeAgent", 95, 90)).toBe(true);
    expect(gate.check("t1", "codex", 95, 90)).toBe(true);
    expect(gate.check("t1", "codex", 95, 90)).toBe(false);
  });

  it("can be forgotten and cleared", () => {
    const gate = createSuggestionGate();
    expect(gate.check("t1", "claudeAgent", 95, 90)).toBe(true);
    gate.forget("t1");
    expect(gate.check("t1", "claudeAgent", 95, 90)).toBe(true);
    gate.clear();
    expect(gate.check("t1", "claudeAgent", 95, 90)).toBe(true);
  });
});
