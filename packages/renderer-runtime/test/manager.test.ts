import type { T3Api } from "@t3p/api";
import { describe, expect, it, vi } from "vitest";

import { bootstrap } from "../src/runtime.js";
import { entry, envFor, fakeImporter, fakeNative } from "./helpers.js";

type Manager = {
  list(): Array<{ id: string; status: string; error: string | null; hostStatus: string }>;
  enable(id: string, o?: { grantRpc?: boolean }): Promise<unknown>;
  disable(id: string): Promise<{ restartRequired: boolean }>;
  reload(id: string): Promise<void>;
  setLoadOrder(order: string[]): Promise<string[]>;
};
const mgr = (win: Record<string, unknown>) => (win.__t3p as { manager: Manager }).manager;
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("plugin manager", () => {
  it("loads in list order (state.json loadOrder is applied by the main process)", async () => {
    const native = fakeNative([entry("zeta"), entry("alpha"), entry("mid")]);
    const order: string[] = [];
    const mk = (id: string) => ({ start: () => void order.push(id) });
    const { importModule } = fakeImporter({ zeta: mk("zeta"), alpha: mk("alpha"), mid: mk("mid") });
    await bootstrap(envFor(native, importModule));
    expect(order).toEqual(["zeta", "alpha", "mid"]);
  });

  it("isolates a throwing plugin and disposes what it registered before throwing", async () => {
    const native = fakeNative([entry("bad"), entry("good")]);
    const seen: unknown[] = [];
    const { importModule } = fakeImporter({
      bad: {
        start: (t3: T3Api) => {
          t3.events.bus.onFrom("good", "tick", () => seen.push("bad listener"));
          throw new Error("nope");
        },
      },
      good: { start: (t3: T3Api) => t3.events.bus.on("tick", () => seen.push("good listener")) },
    });
    const env = envFor(native, importModule);
    await bootstrap(env);
    expect(mgr(env.win).list().map((p) => [p.id, p.status])).toEqual([
      ["bad", "failed"],
      ["good", "started"],
    ]);
    expect(mgr(env.win).list()[0]!.error).toBe("Error: nope");
    // emit as `good`: only good's own listener is left, bad's was disposed
    (env.win.__t3p as { events: { emit(n: string, p?: unknown): void } }).events.emit("good:tick");
    expect(seen).toEqual(["good listener"]);
    expect(env.errors.length).toBeGreaterThan(0);
  });

  it("times out start() and import, marks the plugin failed, others load", async () => {
    const native = fakeNative([entry("slow-start"), entry("slow-import"), entry("fine")]);
    const never = new Promise<never>(() => undefined);
    const { importModule } = fakeImporter({
      "slow-start": { start: () => never },
      "slow-import": () => never,
      fine: { start: () => undefined },
    });
    const env = envFor(native, importModule, { timeoutMs: 30 });
    const results = await bootstrap(env);
    expect(results).toEqual([
      { id: "slow-start", ok: false, error: "Error: start() timed out after 30 ms" },
      { id: "slow-import", ok: false, error: "Error: import timed out after 30 ms" },
      { id: "fine", ok: true },
    ]);
  });

  it("accepts a default export, awaits async start, and runs the returned cleanup on stop", async () => {
    const native = fakeNative([entry("p")]);
    const log: string[] = [];
    const { importModule } = fakeImporter({
      p: {
        default: {
          async start(this: { tag: string }, _t3: T3Api) {
            await flush();
            log.push(`start ${this.tag}`);
            return () => void log.push("cleanup");
          },
          stop(this: { tag: string }) {
            log.push(`stop ${this.tag}`);
          },
          tag: "owner",
        },
      },
    });
    const env = envFor(native, importModule);
    await bootstrap(env);
    expect(log).toEqual(["start owner"]);
    await mgr(env.win).disable("p");
    expect(log).toEqual(["start owner", "cleanup", "stop owner"]);
  });

  it("stop disposes listeners, settings listeners and rpc state listeners, and emits lifecycle events", async () => {
    const native = fakeNative([entry("p", { effective: { rpc: true } })]);
    const hits: string[] = [];
    let t3ref!: T3Api;
    const { importModule } = fakeImporter({
      p: {
        start: (t3: T3Api) => {
          t3ref = t3;
          t3.events.bus.on("e", () => hits.push("bus"));
          t3.events.on("plugin:started", () => hits.push("sys"));
          t3.settings.define([{ key: "k", type: "boolean", default: false, label: "K" }]);
          t3.settings.onChange(() => hits.push("setting"));
        },
      },
    });
    const env = envFor(native, importModule);
    await bootstrap(env);
    const bus = (env.win.__t3p as { events: { emit(n: string, p?: unknown): void } }).events;
    bus.emit("p:e");
    await t3ref.settings.set("k", true);
    expect(hits).toEqual(["sys", "bus", "setting"]); // sys: its own plugin:started
    await mgr(env.win).disable("p");
    bus.emit("p:e");
    expect(hits).toEqual(["sys", "bus", "setting"]);
    // a stale t3 refuses new registrations
    expect(() => t3ref.events.bus.on("e", () => undefined)).toThrow(/stopped/);
    expect(() => t3ref.events.on("app:ready", () => undefined)).toThrow(/stopped/);
    expect(() => t3ref.settings.define([])).toThrow(/stopped/);
    await expect(t3ref.storage.set("a", 1)).rejects.toThrow(/stopped/);
  });

  it("fires app:ready once with the started plugins, and plugin:started / plugin:stopped", async () => {
    const native = fakeNative([entry("a"), entry("b")]);
    const events: Array<[string, unknown]> = [];
    const { importModule } = fakeImporter({
      a: {
        start: (t3: T3Api) => {
          for (const name of ["app:ready", "plugin:started", "plugin:stopped", "plugin:failed"] as const) t3.events.on(name, (p) => events.push([name, p]));
        },
      },
      b: {
        start: () => {
          throw new Error("x");
        },
      },
    });
    const env = envFor(native, importModule);
    await bootstrap(env);
    expect(events).toEqual([
      ["plugin:started", { id: "a" }],
      ["plugin:failed", { id: "b", error: "Error: x" }],
      ["app:ready", { plugins: ["a"] }],
    ]);
  });

  it("t3 is frozen, carries the plugin identity and the API version", async () => {
    const native = fakeNative([entry("p", { version: "2.3.4", tier: 2 })]);
    let t3ref!: T3Api;
    const { importModule } = fakeImporter({ p: { start: (t3: T3Api) => void (t3ref = t3) } });
    await bootstrap(envFor(native, importModule));
    expect(Object.isFrozen(t3ref)).toBe(true);
    for (const ns of ["rpc", "providers", "threads", "storage", "settings", "native", "events", "plugin"] as const) expect(Object.isFrozen(t3ref[ns])).toBe(true);
    expect(t3ref.id).toBe("p");
    expect(t3ref.plugin).toEqual({ id: "p", version: "2.3.4", tier: 2 });
    expect(t3ref.apiVersion).toBe("1.0");
    expect(t3ref.__dev).toBeUndefined();
    expect(() => {
      (t3ref as unknown as { id: string }).id = "other";
    }).toThrow();
  });

  describe("hot reload", () => {
    it("t3.__dev.reload re-imports with a cache-busting query, disposes the old run, keeps storage", async () => {
      const native = fakeNative([entry("p")], { dev: true });
      let runs = 0;
      const disposed: number[] = [];
      let dev!: NonNullable<T3Api["__dev"]>;
      const { importModule, urls } = fakeImporter({
        p: () => {
          const run = ++runs;
          return {
            start: async (t3: T3Api) => {
              dev = t3.__dev!;
              const prev = await t3.storage.get<number>("runs");
              await t3.storage.set("runs", (prev ?? 0) + 1);
              t3.events.bus.on("x", () => undefined);
              return () => void disposed.push(run);
            },
          };
        },
      });
      const env = envFor(native, importModule);
      await bootstrap(env);
      expect(dev).toBeDefined();
      await dev.reload("p");
      expect(runs).toBe(2);
      expect(disposed).toEqual([1]);
      expect(urls).toEqual(["t3code://app/__t3p/plugins/p/r.js", "t3code://app/__t3p/plugins/p/r.js?t3pv=1"]);
      expect(native.storage.get("p")!.kv.runs).toBe(2);
      expect(mgr(env.win).list()[0]!.status).toBe("started");
      expect((env.win.__t3p as { loadResults: unknown[] }).loadResults).toEqual([{ id: "p", ok: true }]);
    });

    it("runtime-renderer-changed reloads the page in dev mode only", async () => {
      for (const dev of [true, false]) {
        const native = fakeNative([entry("p")], { dev });
        const { importModule } = fakeImporter({ p: () => ({ start: async () => undefined }) });
        let reloads = 0;
        const env = { ...envFor(native, importModule), reloadPage: () => void reloads++ };
        await bootstrap(env);
        native.push("t3p:event", { type: "runtime-renderer-changed" });
        expect(reloads).toBe(dev ? 1 : 0);
      }
    });

    it("reload of a plugin whose folder is gone stops it and forgets it", async () => {
      const native = fakeNative([entry("p"), entry("q")], { dev: true });
      const disposed: string[] = [];
      const { importModule } = fakeImporter({
        p: () => ({ start: async () => () => void disposed.push("p") }),
        q: () => ({ start: async () => () => void disposed.push("q") }),
      });
      const env = envFor(native, importModule);
      await bootstrap(env);
      native.entries.splice(0, 1);
      await mgr(env.win).reload("p");
      expect(disposed).toEqual(["p"]);
      expect(mgr(env.win).list().map((x) => x.id)).toEqual(["q"]);
      expect(mgr(env.win).list()[0]!.status).toBe("started");
    });

    it("a t3p:event plugin-files-changed reloads in dev mode and is ignored otherwise", async () => {
      for (const dev of [true, false]) {
        const native = fakeNative([entry("p")], { dev });
        let runs = 0;
        const { importModule } = fakeImporter({ p: () => (runs++, { start: () => undefined }) });
        await bootstrap(envFor(native, importModule));
        native.push("t3p:event", { type: "plugin-files-changed", plugin: "p" });
        native.push("t3p:event", { type: "other", plugin: "p" });
        await flush();
        await flush();
        expect(runs).toBe(dev ? 2 : 1);
      }
    });

    it("a reload that fails leaves the plugin failed and the others running; a later reload recovers", async () => {
      const native = fakeNative([entry("p"), entry("q")], { dev: true });
      let broken = false;
      const { importModule } = fakeImporter({
        p: () => ({
          start: () => {
            if (broken) throw new Error("syntax");
          },
        }),
        q: { start: () => undefined },
      });
      const env = envFor(native, importModule);
      await bootstrap(env);
      broken = true;
      await mgr(env.win).reload("p");
      expect(mgr(env.win).list().map((p) => p.status)).toEqual(["failed", "started"]);
      broken = false;
      await mgr(env.win).reload("p");
      expect(mgr(env.win).list().map((p) => p.status)).toEqual(["started", "started"]);
    });
  });

  describe("enable and disable", () => {
    it("enable persists through IPC, then starts; disable stops, then persists", async () => {
      const native = fakeNative([entry("p", { status: "disabled", rendererUrl: null })]);
      const starts: string[] = [];
      const { importModule } = fakeImporter({ p: { start: () => void starts.push("p") } });
      const env = envFor(native, importModule);
      await bootstrap(env);
      expect(starts).toEqual([]);
      expect(mgr(env.win).list()[0]!.status).toBe("inactive");
      await mgr(env.win).enable("p", { grantRpc: true });
      expect(starts).toEqual(["p"]);
      expect(native.calls).toContainEqual(["t3p:plugins:set-enabled", { id: "p", enabled: true, grantRpc: true }]);
      expect(mgr(env.win).list()[0]!.status).toBe("started");
      await expect(mgr(env.win).disable("p")).resolves.toEqual({ restartRequired: false });
      expect(native.calls).toContainEqual(["t3p:plugins:set-enabled", { id: "p", enabled: false }]);
      expect(mgr(env.win).list()[0]!.status).toBe("inactive");
    });

    it("enable surfaces the main process' refusal", async () => {
      const native = fakeNative([entry("p", { status: "disabled", rendererUrl: null })]);
      const original = native.invoke;
      native.invoke = vi.fn(async (c: string, p?: unknown) => {
        if (c === "t3p:plugins:set-enabled") throw new Error("t3p: enable it with `t3p enable`");
        return original(c, p);
      });
      const env = envFor(native, fakeImporter({}).importModule);
      await bootstrap(env);
      await expect(mgr(env.win).enable("p")).rejects.toThrow(/t3p enable/);
    });

    it("setLoadOrder sends the order", async () => {
      const native = fakeNative([entry("a"), entry("b")]);
      const env = envFor(native, fakeImporter({ a: {}, b: {} }).importModule);
      await bootstrap(env);
      await expect(mgr(env.win).setLoadOrder(["b", "a"])).resolves.toEqual(["b", "a"]);
      expect(native.calls).toContainEqual(["t3p:plugins:set-load-order", { order: ["b", "a"] }]);
    });
  });
});

describe("crash-loop guard reports", () => {
  const healthCalls = (native: { calls: Array<[string, unknown]> }) => native.calls.filter(([c]) => c === "t3p:plugin-health").map(([, p]) => p);

  it("reports a failed start", async () => {
    const native = fakeNative([entry("bad")]);
    const { importModule } = fakeImporter({ bad: { start: () => { throw new Error("nope"); } } });
    await bootstrap(envFor(native, importModule));
    expect(healthCalls(native)).toEqual([{ plugin: "bad", ok: false, error: "Error: nope" }]);
  });

  it("reports ok after a quiet window", async () => {
    const native = fakeNative([entry("fine")]);
    const { importModule } = fakeImporter({ fine: { start: () => undefined } });
    await bootstrap(envFor(native, importModule, { healthWindowMs: 20, watchErrors: () => () => undefined }));
    expect(healthCalls(native)).toEqual([]);
    await new Promise((r) => setTimeout(r, 60));
    expect(healthCalls(native)).toEqual([{ plugin: "fine", ok: true }]);
  });

  it("an uncaught error whose stack names the plugin file fails the window; others are ignored", async () => {
    const native = fakeNative([entry("flaky"), entry("other")]);
    const { importModule } = fakeImporter({ flaky: { start: () => undefined }, other: { start: () => undefined } });
    const cbs: Array<(m: string, s: string) => void> = [];
    const emit = (m: string, st: string): void => cbs.forEach((cb) => cb(m, st));
    await bootstrap(envFor(native, importModule, { healthWindowMs: 40, watchErrors: (cb) => { cbs.push(cb); return () => undefined; } }));
    emit("unrelated", "at x (t3code://app/assets/index.js:1:1)");
    emit("kaboom", "Error: kaboom\n    at f (t3code://app/__t3p/plugins/flaky/r.js:3:9)");
    await new Promise((r) => setTimeout(r, 80));
    const calls = healthCalls(native);
    expect(calls).toContainEqual({ plugin: "flaky", ok: false, error: "uncaught: kaboom" });
    expect(calls).toContainEqual({ plugin: "other", ok: true });
    expect(calls).not.toContainEqual({ plugin: "flaky", ok: true });
  });
});
