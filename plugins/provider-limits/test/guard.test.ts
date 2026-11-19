import type { ProviderSnapshot, TurnStartContext } from "@t3p/api";
import { describe, expect, it } from "vitest";

import {
  CHOICE_MEMORY_MS,
  ChoiceMemory,
  evaluateTurn,
  type GuardEvaluation,
  parseFallback,
  promptBody,
  promptButtons,
  promptTitle,
  remainingOf,
  resolveChoice,
} from "../src/guard.js";
import { claudeProvider, makeProvider, NOW } from "./fixtures.js";

function ctx(overrides: Partial<TurnStartContext> = {}): TurnStartContext {
  return {
    requestId: "g1",
    commandType: "message.dispatch",
    kind: "message",
    threadId: "t1",
    parentThreadId: null,
    provider: "claudeAgent",
    model: "claude-opus-5-5",
    modelSource: "command",
    isSubagent: false,
    source: "web",
    createdBy: "user",
    continuation: null,
    textPreview: "fix the build",
    at: NOW,
    ...overrides,
  };
}

function withUsed(instanceId: string, used: number[], label = "Session"): ProviderSnapshot {
  return makeProvider({
    instanceId,
    usageLimits: {
      checkedAt: "2026-11-18T21:25:04.493Z",
      windows: used.map((u, i) => ({ id: `w${i}`, kind: "session", label: i === 0 ? label : `W${i}`, windowDurationMins: 300, usedPercent: u, resetsAt: null })),
    },
  } as Partial<ProviderSnapshot> & { instanceId: string });
}

const settings = { thresholdPercent: 5, fallback: "codex:gpt-6.1-sol", useFavorites: true };
type Ask = Extract<GuardEvaluation, { kind: "ask" }>;
const withModels = (p: ProviderSnapshot, slugs: string[]): ProviderSnapshot => ({ ...p, models: slugs.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })) }) as ProviderSnapshot;

describe("parseFallback", () => {
  it("splits at the first colon", () => {
    expect(parseFallback("codex:gpt-6.1-sol")).toEqual({ provider: "codex", model: "gpt-6.1-sol" });
    expect(parseFallback("opencode:opencode-go/deepseek:v4")).toEqual({ provider: "opencode", model: "opencode-go/deepseek:v4" });
  });
  it("takes a bare model as same-provider", () => {
    expect(parseFallback(" claude-sonnet-5-5 ")).toEqual({ provider: null, model: "claude-sonnet-5-5" });
  });
  it("rejects empty and malformed values", () => {
    expect(parseFallback("")).toBeNull();
    expect(parseFallback("codex:")).toBeNull();
    expect(parseFallback(42)).toBeNull();
  });
});

describe("remainingOf", () => {
  it("uses the tightest window", () => {
    expect(remainingOf(withUsed("x", [40, 97]))).toEqual({ percent: 3, windowLabel: "W1", resetsAt: null });
  });
  it("is null without windows", () => {
    expect(remainingOf(makeProvider({ instanceId: "x" }))).toBeNull();
  });
  it("reads the recorded Claude sample", () => {
    expect(remainingOf(claudeProvider())?.percent).toBeGreaterThan(5);
  });
});

describe("evaluateTurn", () => {
  const low = [withUsed("claudeAgent", [97]), withUsed("codex", [10])];

  it("passes when off, system-driven, unknown or with enough left", () => {
    const m = new ChoiceMemory();
    expect(evaluateTurn(ctx(), low, { ...settings, thresholdPercent: 0 }, m, NOW)).toEqual({ kind: "pass", why: "off" });
    expect(evaluateTurn(ctx({ createdBy: "system" }), low, settings, m, NOW)).toEqual({ kind: "pass", why: "system" });
    expect(evaluateTurn(ctx({ provider: null }), low, settings, m, NOW)).toEqual({ kind: "pass", why: "unknown-provider" });
    expect(evaluateTurn(ctx({ provider: "nope" }), low, settings, m, NOW)).toEqual({ kind: "pass", why: "unknown-provider" });
    expect(evaluateTurn(ctx(), [makeProvider({ instanceId: "claudeAgent" })], settings, m, NOW)).toEqual({ kind: "pass", why: "no-limits" });
    expect(evaluateTurn(ctx(), [withUsed("claudeAgent", [95])], settings, m, NOW)).toEqual({ kind: "pass", why: "enough-left" });
  });

  it("asks below the threshold and offers the override first", () => {
    const e = evaluateTurn(ctx(), low, settings, new ChoiceMemory(), NOW) as Ask;
    expect(e.kind).toBe("ask");
    expect(e.remaining).toMatchObject({ percent: 3, windowLabel: "Session" });
    expect(e.pick).toMatchObject({ provider: "codex", model: "gpt-6.1-sol", source: "override" });
    expect(promptButtons(e).labels).toEqual(["Switch to codex gpt-6.1-sol", "Keep going", "Cancel"]);
    expect(promptTitle(e)).toBe("claudeAgent is almost out (3% left)");
  });

  it("uses favorites in order when there is no override", () => {
    const providers = [withUsed("claudeAgent", [97]), withModels(withUsed("codex", [38]), ["gpt-6.1-sol"])];
    const e = evaluateTurn(ctx(), providers, { ...settings, fallback: "" }, new ChoiceMemory(), NOW, [{ provider: "codex", model: "gpt-6.1-sol" }]) as Ask;
    expect(e.pick).toMatchObject({ provider: "codex", model: "gpt-6.1-sol", source: "favorite" });
    expect(promptBody(ctx(), e, NOW)).toContain("(next favorite with 62% left)");
  });

  it("says no favorite has headroom and offers only keep/cancel", () => {
    const providers = [withUsed("claudeAgent", [97]), withModels(withUsed("codex", [99]), ["gpt-6.1-sol"])];
    const e = evaluateTurn(ctx(), providers, { ...settings, fallback: "" }, new ChoiceMemory(), NOW, [{ provider: "codex", model: "gpt-6.1-sol" }]) as Ask;
    expect(e.pick).toBeNull();
    expect(promptBody(ctx(), e, NOW)).toContain("No favorite has headroom: gpt-6.1-sol 1%.");
    expect(promptButtons(e).choices).toEqual(["keep", "cancel"]);
  });

  it("ignores favorites when guardUseFavorites is off", () => {
    const providers = [withUsed("claudeAgent", [97]), withModels(withUsed("codex", [10]), ["gpt-6.1-sol"])];
    const e = evaluateTurn(ctx(), providers, { ...settings, fallback: "", useFavorites: false }, new ChoiceMemory(), NOW, [{ provider: "codex", model: "x" }]) as Ask;
    expect(e.pick).toMatchObject({ source: "provider", model: "gpt-6.1-sol" });
  });

  it("asks delegated sub-sessions too", () => {
    const e = evaluateTurn(ctx({ kind: "delegate", commandType: "delegated_task.request", isSubagent: true, createdBy: "agent" }), low, settings, new ChoiceMemory(), NOW);
    expect(e.kind).toBe("ask");
    expect(promptBody(ctx({ kind: "delegate" }), e as Ask, NOW)).toMatch(/^A delegated sub-session would run on claudeAgent/);
  });

  it("offers no switch when the only candidate is the target itself", () => {
    const same = evaluateTurn(ctx(), low, { ...settings, fallback: "claude-opus-5-5" }, new ChoiceMemory(), NOW, []) as Ask;
    expect(promptButtons(same).labels).toContain("Keep going");
    const none = evaluateTurn(ctx(), [withUsed("claudeAgent", [97])], { ...settings, fallback: "claude-opus-5-5" }, new ChoiceMemory(), NOW) as Ask;
    expect(none.pick).toBeNull();
    expect(promptButtons(none).labels).toEqual(["Keep going", "Cancel"]);
  });
});

describe("resolveChoice and memory", () => {
  const low = [withUsed("claudeAgent", [99]), withUsed("codex", [10])];

  it("switch returns modify and is remembered for 10 minutes", () => {
    const m = new ChoiceMemory();
    const e = evaluateTurn(ctx(), low, settings, m, NOW) as Ask;
    expect(resolveChoice(ctx(), e, 0, m, NOW)).toEqual({ action: "modify", provider: "codex", model: "gpt-6.1-sol" });
    expect(evaluateTurn(ctx(), low, settings, m, NOW + 60_000)).toEqual({
      kind: "decided",
      decision: { action: "modify", provider: "codex", model: "gpt-6.1-sol" },
      why: "remembered-switch",
    });
    expect(evaluateTurn(ctx({ threadId: "other" }), low, settings, m, NOW).kind).toBe("ask");
    expect(evaluateTurn(ctx(), low, settings, m, NOW + CHOICE_MEMORY_MS).kind).toBe("ask");
  });

  it("keep allows and is remembered", () => {
    const m = new ChoiceMemory();
    const e = evaluateTurn(ctx(), low, settings, m, NOW) as Ask;
    expect(resolveChoice(ctx(), e, 1, m, NOW)).toEqual({ action: "allow" });
    expect(evaluateTurn(ctx(), low, settings, m, NOW + 1000)).toMatchObject({ kind: "decided", why: "remembered-keep" });
  });

  it("cancel blocks with a reason and is not remembered", () => {
    const m = new ChoiceMemory();
    const e = evaluateTurn(ctx(), low, settings, m, NOW) as Ask;
    expect(resolveChoice(ctx(), e, 2, m, NOW)).toEqual({ action: "block", reason: "Cancelled: claudeAgent has 1% left in the Session window (provider-limits guard)." });
    expect(evaluateTurn(ctx(), low, settings, m, NOW).kind).toBe("ask");
  });

  it("closing the prompt (-1) means keep going", () => {
    const m = new ChoiceMemory();
    const e = evaluateTurn(ctx(), low, settings, m, NOW) as Ask;
    expect(resolveChoice(ctx(), e, -1, m, NOW)).toEqual({ action: "allow" });
    expect(evaluateTurn(ctx(), low, settings, m, NOW + 1000)).toMatchObject({ why: "remembered-keep" });
  });
});
