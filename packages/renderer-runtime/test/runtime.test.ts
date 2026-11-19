import { describe, expect, it } from "vitest";

import { bootstrap, createEventBus } from "../src/runtime.js";
import { entry, envFor, fakeImporter, fakeNative } from "./helpers.js";

describe("renderer bootstrap", () => {
  it("installs window.__t3p and loads renderer plugins with per-plugin isolation", async () => {
    const native = fakeNative([
      entry("good", { effective: { "fs.read": { roots: ["C:/x"] } } }),
      entry("bad"),
      entry("after"),
      entry("off", { status: "disabled", rendererUrl: null }),
    ]);
    const started: string[] = [];
    const { importModule } = fakeImporter({
      good: { start: (t3: { id: string; native: { fsRead(r: object): Promise<unknown> } }) => (started.push(t3.id), void t3.native.fsRead({ path: "C:/x" })) },
      bad: {
        start: () => {
          throw new Error("boom in renderer");
        },
      },
      after: { start: (t3: { id: string }) => void started.push(t3.id) },
    });
    const env = envFor(native, importModule);
    const ready = bootstrap(env);
    const t3p = env.win.__t3p as { version: string };
    expect(typeof t3p.version).toBe("string");
    expect(Object.isFrozen(t3p)).toBe(true);
    const results = await ready;
    expect(results).toEqual([
      { id: "good", ok: true },
      { id: "bad", ok: false, error: "Error: boom in renderer" },
      { id: "after", ok: true },
    ]);
    expect(started).toEqual(["good", "after"]);
    expect(Object.keys(env.win.__t3p_plugins as object).sort()).toEqual(["after", "bad", "good", "t3p.core"]);
    expect(native.calls).toContainEqual(["t3p:native:fs.read", { path: "C:/x", plugin: "good" }]);
    expect(native.calls.some(([c, p]) => c === "t3p:log" && (p as { plugin?: string }).plugin === "bad")).toBe(true);
    expect((env.win.__t3p_order as unknown[][]).map((m) => m[0])).toEqual(["t3p-renderer", "plugin:good", "plugin:after", "t3p-ready"]);
  });

  it("a plugin cannot spoof another plugin id in native calls", async () => {
    const native = fakeNative([entry("a", { effective: { "fs.read": { roots: ["C:/x"] } } })]);
    const { importModule } = fakeImporter({
      a: { start: (t3: { native: { fsRead(r: object): Promise<unknown> } }) => void t3.native.fsRead({ path: "C:/x", plugin: "other" }) },
    });
    await bootstrap(envFor(native, importModule));
    expect(native.calls).toContainEqual(["t3p:native:fs.read", { path: "C:/x", plugin: "a" }]);
    expect(native.calls.some(([, p]) => (p as { plugin?: string } | undefined)?.plugin === "other")).toBe(false);
  });

  it("works without the native bridge (preload missing)", async () => {
    const env = envFor(null, async () => ({}));
    const results = await bootstrap(env);
    expect(results).toEqual([]);
    expect((env.win.__t3p as { native: unknown }).native).toBeNull();
  });

  it("does not install twice", async () => {
    const env = envFor(null, async () => ({}));
    const a = bootstrap(env);
    const first = env.win.__t3p;
    const b = bootstrap(env);
    expect(env.win.__t3p).toBe(first);
    expect(await a).toBe(await b);
  });

  it("main-side plugin events reach renderer listeners, scoped by plugin id", async () => {
    const native = fakeNative([entry("listener")]);
    const got: unknown[] = [];
    const { importModule } = fakeImporter({
      listener: { start: (t3: { events: { bus: { onFrom(id: string, n: string, cb: (p: unknown) => void): void } } }) => t3.events.bus.onFrom("emitter", "ping", (p) => got.push(p)) },
    });
    await bootstrap(envFor(native, importModule));
    native.push("t3p:plugin-event", { plugin: "emitter", name: "ping", payload: { n: 1 } });
    native.push("t3p:plugin-event", { plugin: "someone-else", name: "ping", payload: { n: 2 } });
    expect(got).toEqual([{ n: 1 }]);
  });

  it("event bus isolates listener errors", () => {
    const errors: unknown[] = [];
    const bus = createEventBus((e) => errors.push(e));
    const got: unknown[] = [];
    bus.on("x", () => {
      throw new Error("listener");
    });
    const off = bus.on("x", (p) => got.push(p));
    bus.emit("x", 1);
    off();
    bus.emit("x", 2);
    expect(got).toEqual([1]);
    expect(errors).toHaveLength(2);
  });
});
