import { describe, expect, it } from "vitest";

import {
  appendCapped,
  formatDuration,
  formatRpcError,
  isDangerousMethod,
  MAX_RPC_LOG,
  parsePayload,
  RPC_METHOD_SUGGESTIONS,
  summarizeJson,
} from "../src/logic/rpc-console.js";

describe("payload parsing", () => {
  it("treats empty text as {}", () => {
    expect(parsePayload("  ")).toEqual({ ok: true, value: {} });
  });
  it("accepts JSON objects only", () => {
    expect(parsePayload('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parsePayload("[1]")).toMatchObject({ ok: false });
    expect(parsePayload("null")).toMatchObject({ ok: false });
    expect(parsePayload('"x"')).toMatchObject({ ok: false });
    expect(parsePayload("{")).toMatchObject({ ok: false });
  });
});

describe("risky methods", () => {
  it("flags dispatch, delete, remove, terminal and auth in any case", () => {
    expect(isDangerousMethod("orchestration.dispatchCommand")).toBe(true);
    expect(isDangerousMethod("terminal.open")).toBe(true);
    expect(isDangerousMethod("auth.logout")).toBe(true);
    expect(isDangerousMethod("server.DeleteThing")).toBe(true);
    expect(isDangerousMethod("files.remove")).toBe(true);
    expect(isDangerousMethod("server.getConfig")).toBe(false);
    expect(isDangerousMethod("orchestration.subscribeThread")).toBe(false);
  });
});

describe("formatting", () => {
  it("formats durations", () => {
    expect(formatDuration(12.4)).toBe("12 ms");
    expect(formatDuration(1234)).toBe("1.23 s");
    expect(formatDuration(Number.NaN)).toBe("?");
  });
  it("summarizes JSON with a hard cap", () => {
    expect(summarizeJson({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(summarizeJson(undefined)).toBe("undefined");
    const long = summarizeJson({ text: "x".repeat(100) }, 20);
    expect(long.length).toBeLessThan(120);
    expect(long).toContain("more chars");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(summarizeJson(cyclic)).toContain("[object Object]");
  });
  it("formats structural and plain errors", () => {
    expect(formatRpcError(new Error("boom"))).toBe("boom");
    expect(formatRpcError("text")).toBe("text");
    expect(formatRpcError({ kind: "failure", tag: "OrchestrationV2DispatchCommandError", message: "busy" })).toContain("busy");
    expect(formatRpcError({ code: "T3P_PERMISSION", message: "no rpc" })).toContain("code=T3P_PERMISSION");
  });
});

describe("capped log", () => {
  it("keeps the newest items", () => {
    expect(appendCapped([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
    expect(appendCapped([], 1, 0)).toEqual([]);
    const full = Array.from({ length: MAX_RPC_LOG }, (_, i) => i);
    const next = appendCapped(full, -1, MAX_RPC_LOG);
    expect(next).toHaveLength(MAX_RPC_LOG);
    expect(next[0]).toBe(1);
    expect(next.at(-1)).toBe(-1);
  });
  it("offers the typed methods as suggestions", () => {
    expect(RPC_METHOD_SUGGESTIONS).toContain("server.getConfig");
    expect(RPC_METHOD_SUGGESTIONS).toContain("orchestration.subscribeThread");
  });
});
