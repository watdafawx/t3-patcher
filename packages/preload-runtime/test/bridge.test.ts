import { describe, expect, it, vi } from "vitest";

import { createBridge, shouldExpose } from "../src/bridge.js";

function fakeIpc() {
  const listeners = new Map<string, Array<(event: unknown, ...args: unknown[]) => void>>();
  return {
    invoke: vi.fn(async (channel: string, ...args: unknown[]) => ({ channel, args })),
    on: vi.fn((channel: string, l: (event: unknown, ...args: unknown[]) => void) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), l]);
    }),
    removeListener: vi.fn((channel: string, l: (event: unknown, ...args: unknown[]) => void) => {
      listeners.set(channel, (listeners.get(channel) ?? []).filter((x) => x !== l));
    }),
    fire(channel: string, payload: unknown) {
      for (const l of listeners.get(channel) ?? []) l({ sender: "SECRET" }, payload);
    },
    count: (channel: string) => (listeners.get(channel) ?? []).length,
  };
}

describe("preload bridge", () => {
  it("is frozen and exposes only version, invoke, on", () => {
    const bridge = createBridge(fakeIpc());
    expect(Object.isFrozen(bridge)).toBe(true);
    expect(Object.keys(bridge).sort()).toEqual(["invoke", "on", "version"]);
  });

  it("forwards allowlisted channels with exactly one payload", async () => {
    const ipc = fakeIpc();
    const bridge = createBridge(ipc);
    await bridge.invoke("t3p:ping", { a: 1 });
    await bridge.invoke("t3p:plugin:test-plugin:echo", { x: 1 });
    expect(ipc.invoke.mock.calls).toEqual([
      ["t3p:ping", { a: 1 }],
      ["t3p:plugin:test-plugin:echo", { x: 1 }],
    ]);
  });

  it.each(["desktop:get-bearer", "t3p:native:fs.write", "t3p:plugin:Bad:x", "", "t3p:event"])("rejects channel %j", async (channel) => {
    const ipc = fakeIpc();
    await expect(createBridge(ipc).invoke(channel)).rejects.toThrow(/not allowed/);
    expect(ipc.invoke).not.toHaveBeenCalled();
  });

  it("delivers payload only (no IPC event) and unsubscribes", () => {
    const ipc = fakeIpc();
    const bridge = createBridge(ipc);
    const seen: unknown[][] = [];
    const off = bridge.on("t3p:event", (...args: unknown[]) => seen.push(args));
    ipc.fire("t3p:event", { hello: 1 });
    off();
    off();
    ipc.fire("t3p:event", { hello: 2 });
    expect(seen).toEqual([[{ hello: 1 }]]);
    expect(ipc.count("t3p:event")).toBe(0);
    expect(() => bridge.on("t3p:ping", () => undefined)).toThrow(/not allowed/);
  });

  it("exposes only in the t3code://app main frame", () => {
    expect(shouldExpose({ protocol: "t3code:", host: "app" }, true)).toBe(true);
    expect(shouldExpose({ protocol: "t3code:", host: "app" }, false)).toBe(false);
    expect(shouldExpose({ protocol: "https:", host: "app" }, true)).toBe(false);
    expect(shouldExpose({ protocol: "t3code:", host: "evil" }, true)).toBe(false);
  });
});
