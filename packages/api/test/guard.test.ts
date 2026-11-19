import { describe, expect, it } from "vitest";

import {
  clampGuardTimeout,
  effectivePermissions,
  grantPermission,
  GuardTimeoutError,
  normalizeTurnStartDecision,
  parsePermissions,
  permissionsToJson,
  runTurnStartHandlers,
  TURN_GUARD_MAX_TIMEOUT_MS,
  TURN_GUARD_TIMEOUT_MS,
  type TurnStartContext,
  withGuardTimeout,
} from "../src/index.js";

const ctx: TurnStartContext = {
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
  textPreview: "hi",
  at: 1,
};

describe("guard permission", () => {
  it("parses, grants and round-trips", () => {
    const declared = parsePermissions(["guard"]);
    expect(declared.errors).toEqual([]);
    expect(declared.set.guard).toBe(true);
    expect(permissionsToJson(declared.set)).toEqual(["guard"]);
    expect(effectivePermissions(declared.set, {}).guard).toBeUndefined();
    expect(effectivePermissions(declared.set, { guard: true }).guard).toBe(true);
    const state = grantPermission({ version: 1, plugins: {} }, "p", "guard");
    expect(JSON.stringify(state)).toContain('"guard"');
  });
});

describe("normalizeTurnStartDecision", () => {
  it("fails open on anything malformed", () => {
    expect(normalizeTurnStartDecision(undefined)).toEqual({ action: "allow" });
    expect(normalizeTurnStartDecision({ action: "nope" })).toEqual({ action: "allow" });
    expect(normalizeTurnStartDecision({ action: "modify" })).toEqual({ action: "allow" });
    expect(normalizeTurnStartDecision({ action: "modify", model: "bad model with spaces" })).toEqual({ action: "allow" });
  });

  it("keeps valid block and modify answers", () => {
    expect(normalizeTurnStartDecision({ action: "block" })).toEqual({ action: "block", reason: "Blocked by a T3 Patcher plugin." });
    expect(normalizeTurnStartDecision({ action: "block", reason: ` ${"x".repeat(900)} ` }).action === "block").toBe(true);
    expect((normalizeTurnStartDecision({ action: "block", reason: "x".repeat(900) }) as { reason: string }).reason).toHaveLength(500);
    expect(normalizeTurnStartDecision({ action: "modify", provider: "codex", model: "gpt-6.1-sol", extra: 1 })).toEqual({ action: "modify", provider: "codex", model: "gpt-6.1-sol" });
    expect(normalizeTurnStartDecision({ action: "modify", model: "opencode-go/deepseek-v4.1-flash" })).toEqual({ action: "modify", model: "opencode-go/deepseek-v4.1-flash" });
  });
});

describe("clampGuardTimeout", () => {
  it("defaults and clamps", () => {
    expect(clampGuardTimeout(undefined)).toBe(TURN_GUARD_TIMEOUT_MS);
    expect(clampGuardTimeout(5)).toBe(1000);
    expect(clampGuardTimeout(9e9)).toBe(TURN_GUARD_MAX_TIMEOUT_MS);
  });
});

describe("runTurnStartHandlers", () => {
  it("chains modifies and stops at the first block", async () => {
    const seen: Array<string | null> = [];
    const out = await runTurnStartHandlers(ctx, [
      { plugin: "a", timeoutMs: 1000, handler: () => ({ action: "modify", model: "claude-sonnet-5-5" }) },
      { plugin: "b", timeoutMs: 1000, handler: (c) => void seen.push(c.model) },
      { plugin: "c", timeoutMs: 1000, handler: () => ({ action: "block", reason: "no" }) },
      { plugin: "d", timeoutMs: 1000, handler: () => void seen.push("d ran") },
    ]);
    expect(seen).toEqual(["claude-sonnet-5-5"]);
    expect(out.decision).toEqual({ action: "block", reason: "no", plugin: "c" });
  });

  it("returns the full target of the last modify", async () => {
    const out = await runTurnStartHandlers(ctx, [{ plugin: "a", timeoutMs: 1000, handler: async () => ({ action: "modify", model: "claude-sonnet-5-5" }) }]);
    expect(out.decision).toEqual({ action: "modify", provider: "claudeAgent", model: "claude-sonnet-5-5", plugin: "a" });
  });

  it("counts throwing and slow handlers as allow and reports them", async () => {
    const errors: string[] = [];
    const out = await runTurnStartHandlers(
      ctx,
      [
        { plugin: "boom", timeoutMs: 1000, handler: () => { throw new Error("x"); } },
        { plugin: "slow", timeoutMs: 10, handler: () => new Promise(() => undefined) },
      ],
      (plugin, error) => errors.push(`${plugin}:${error instanceof GuardTimeoutError ? "timeout" : "error"}`),
    );
    expect(out.decision).toEqual({ action: "allow" });
    expect(errors).toEqual(["boom:error", "slow:timeout"]);
  });

  it("hands each handler a frozen copy", async () => {
    await runTurnStartHandlers(ctx, [
      {
        plugin: "a",
        timeoutMs: 1000,
        handler: (c) => {
          expect(Object.isFrozen(c)).toBe(true);
        },
      },
    ]);
  });
});

describe("withGuardTimeout", () => {
  it("passes values and errors through", async () => {
    await expect(withGuardTimeout(Promise.resolve(1), 100)).resolves.toBe(1);
    await expect(withGuardTimeout(Promise.reject(new Error("e")), 100)).rejects.toThrow("e");
  });
});
