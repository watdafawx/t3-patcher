import { T3PermissionError, type T3Api, type ThreadSummary, type TurnStartContext } from "@t3p/api";
import { describe, expect, it, vi } from "vitest";

import { enrichContext } from "../src/guard.js";
import { bootstrap } from "../src/runtime.js";
import { entry, envFor, fakeImporter, fakeNative } from "./helpers.js";

const ctx: TurnStartContext = {
  requestId: "g1",
  commandType: "message.dispatch",
  kind: "message",
  threadId: "t1",
  parentThreadId: null,
  provider: null,
  model: null,
  modelSource: null,
  isSubagent: false,
  source: "web",
  createdBy: "user",
  continuation: null,
  textPreview: "hi",
  at: 1,
};

async function start(perms: Record<string, Record<string, true>>) {
  const apis: Record<string, T3Api> = {};
  const ids = Object.keys(perms);
  const { importModule } = fakeImporter(Object.fromEntries(ids.map((id) => [id, { start: (t3: T3Api) => void (apis[id] = t3) }])));
  const native = fakeNative(ids.map((id) => entry(id, { effective: perms[id] })));
  await bootstrap(envFor(native, importModule));
  return { apis, native };
}

const answers = (native: { calls: Array<[string, unknown]> }) => native.calls.filter(([c]) => c === "t3p:guard:answer").map(([, p]) => p);

describe("t3.threads.beforeStart", () => {
  it("needs the guard permission, not rpc", async () => {
    const { apis, native } = await start({ a: { guard: true }, b: { rpc: true } });
    expect(() => apis.b!.threads.beforeStart(() => undefined)).toThrow(T3PermissionError);
    apis.a!.threads.beforeStart(() => undefined, { timeoutMs: 5000 });
    // A page load first drops what the main process still holds.
    const guardCalls = native.calls.filter(([c]) => c.startsWith("t3p:guard:"));
    expect(guardCalls).toEqual([
      ["t3p:guard:unregister", {}],
      ["t3p:guard:register", { plugin: "a", timeoutMs: 5000 }],
    ]);
  });

  it("runs handlers in load order and answers the main process", async () => {
    const { apis, native } = await start({ a: { guard: true }, c: { guard: true } });
    const seenByC: TurnStartContext[] = [];
    apis.a!.threads.beforeStart(() => ({ action: "modify", provider: "codex", model: "gpt-6.1-sol" }));
    apis.c!.threads.beforeStart((x) => {
      seenByC.push(x);
      return x.textPreview === "stop" ? { action: "block", reason: "c says no" } : undefined;
    });
    native.push("t3p:event", { type: "guard-request", id: "r1", ctx: { ...ctx, provider: "claudeAgent", model: "claude-opus-5-5" } });
    await vi.waitFor(() => expect(answers(native)).toHaveLength(1));
    expect(seenByC[0]).toMatchObject({ provider: "codex", model: "gpt-6.1-sol" });
    expect(answers(native)[0]).toEqual({ id: "r1", decision: { action: "modify", provider: "codex", model: "gpt-6.1-sol", plugin: "a" } });

    native.push("t3p:event", { type: "guard-request", id: "r2", ctx: { ...ctx, textPreview: "stop" } });
    await vi.waitFor(() => expect(answers(native)).toHaveLength(2));
    expect(answers(native)[1]).toEqual({ id: "r2", decision: { action: "block", reason: "c says no", plugin: "c" } });
  });

  it("counts a throwing handler as allow and unregisters on dispose", async () => {
    const { apis, native } = await start({ a: { guard: true } });
    const handle = apis.a!.threads.beforeStart(() => {
      throw new Error("boom");
    });
    native.push("t3p:event", { type: "guard-request", id: "r1", ctx });
    await vi.waitFor(() => expect(answers(native)).toEqual([{ id: "r1", decision: { action: "allow" } }]));
    handle.dispose();
    expect(native.calls.at(-1)).toEqual(["t3p:guard:unregister", { plugin: "a" }]);
    native.push("t3p:event", { type: "guard-request", id: "r2", ctx });
    await vi.waitFor(() => expect(answers(native)).toHaveLength(2));
    expect(answers(native)[1]).toEqual({ id: "r2", decision: { action: "allow" } });
  });
});

describe("enrichContext", () => {
  const row = (over: Partial<ThreadSummary>): ThreadSummary => ({
    threadId: "t1",
    title: "",
    projectId: null,
    providerInstanceId: "claudeAgent",
    model: "claude-opus-5-5",
    updatedAt: null,
    running: false,
    raw: {} as ThreadSummary["raw"],
    ...over,
  });

  it("fills provider and model from the thread list", async () => {
    await expect(enrichContext(ctx, async () => [row({})], 100)).resolves.toMatchObject({ provider: "claudeAgent", model: "claude-opus-5-5", modelSource: "thread" });
  });

  it("keeps a context that named its model, or when the lookup fails or is slow", async () => {
    const named = { ...ctx, provider: "codex", model: "x", modelSource: "command" as const };
    await expect(enrichContext(named, async () => [row({})], 100)).resolves.toBe(named);
    await expect(enrichContext(ctx, () => Promise.reject(new Error("no rpc")), 100)).resolves.toBe(ctx);
    await expect(enrichContext(ctx, () => new Promise(() => undefined), 10)).resolves.toBe(ctx);
    await expect(enrichContext(ctx, async () => [row({ threadId: "other" })], 100)).resolves.toBe(ctx);
  });
});
