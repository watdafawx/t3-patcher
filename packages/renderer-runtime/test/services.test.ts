import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { T3PermissionError, type PermissionSet, type ProviderSnapshot, type T3Api } from "@t3p/api";
import { RpcError, type RpcClientState } from "@t3p/rpc-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RpcClientLike } from "../src/rpc.js";
import { bootstrap } from "../src/runtime.js";
import { threadIdFromLocation, type ThreadRouteWindow } from "../src/threads.js";
import { entry, envFor, fakeImporter, fakeNative } from "./helpers.js";

// ---------------------------------------------------------------------------------------------
// Recorded wire data (WP-0D) + a fake shared RPC client
// ---------------------------------------------------------------------------------------------

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../docs/spikes/wp-0d/fixtures/${name}`, import.meta.url)), "utf8"));

/** Recorded `server.getConfig` answer: 10 providers, one with `usageLimits.unavailable`. */
const serverConfig = fixture("server-getConfig.json") as { providers: ProviderSnapshot[] };

type Handler = (payload: unknown) => unknown;

interface FakeSub {
  method: string;
  payload: unknown;
  onItem: (item: unknown) => void;
  cancelled: boolean;
  emit(item: unknown): void;
}

/** In-process stand-in for the shared RpcClient (the seam `SharedRpc` takes). */
class FakeRpc implements RpcClientLike {
  state: RpcClientState = "idle";
  readonly calls: Array<[string, unknown]> = [];
  readonly subs: FakeSub[] = [];
  readonly #handlers = new Map<string, Handler>();
  readonly #stateListeners = new Set<(state: RpcClientState) => void>();

  handle(method: string, handler: Handler): this {
    this.#handlers.set(method, handler);
    return this;
  }

  /** Answers `server.getConfig` with the recorded fixture unless a test overrides it. */
  static withConfig(): FakeRpc {
    return new FakeRpc().handle("server.getConfig", () => serverConfig);
  }

  onState(callback: (state: RpcClientState) => void): () => void {
    this.#stateListeners.add(callback);
    return () => void this.#stateListeners.delete(callback);
  }

  async connect(): Promise<void> {
    this.state = "open";
  }

  async call(method: string, payload: unknown): Promise<unknown> {
    this.calls.push([method, payload]);
    const handler = this.#handlers.get(method);
    if (!handler) throw new Error(`fake rpc: unexpected call ${method}`);
    return await handler(payload);
  }

  subscribe(
    method: string,
    payload: unknown,
    onItem: (item: unknown) => void,
    _opts?: { onError?: (error: Error) => void; resume?: (last: unknown, payload: unknown) => unknown },
  ): { cancel(): void; done: Promise<void> } {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));
    const sub: FakeSub = {
      method,
      payload,
      onItem,
      cancelled: false,
      emit: (item) => {
        if (!sub.cancelled) onItem(item);
      },
    };
    this.subs.push(sub);
    return {
      done,
      cancel: () => {
        sub.cancelled = true;
        finish();
      },
    };
  }

  /** Delivers an item to every live subscription of `method`. */
  emit(method: string, item: unknown): void {
    for (const sub of this.subs) if (sub.method === method) sub.emit(item);
  }

  sub(method: string): FakeSub {
    const found = this.subs.filter((s) => s.method === method && !s.cancelled).at(-1);
    if (!found) throw new Error(`fake rpc: no subscription for ${method}`);
    return found;
  }

  callsOf(method: string): unknown[] {
    return this.calls.filter(([m]) => m === method).map(([, p]) => p);
  }
}

const bridge = {
  getLocalEnvironmentBearerToken: vi.fn(async () => "BEARER"),
  getLocalEnvironmentBootstraps: vi.fn(async () => [{ id: "local", httpBaseUrl: "http://127.0.0.1:3873/", wsBaseUrl: "ws://127.0.0.1:3873", bootstrapToken: "NEVER" }]),
};

interface Setup {
  apis: Record<string, T3Api>;
  t3: T3Api;
  fake: FakeRpc;
  win: Record<string, unknown>;
}

async function startPlugins(opts: { ids?: string[]; perms?: PermissionSet; fake?: FakeRpc } = {}): Promise<Setup> {
  const fake = opts.fake ?? FakeRpc.withConfig();
  const ids = opts.ids ?? ["p"];
  const perms: PermissionSet = opts.perms ?? { rpc: true };
  const apis: Record<string, T3Api> = {};
  const modules = Object.fromEntries(ids.map((id) => [id, { start: (t3: T3Api) => void (apis[id] = t3) }]));
  const { importModule } = fakeImporter(modules);
  const env = envFor(
    fakeNative(ids.map((id) => entry(id, { effective: perms }))),
    importModule,
    { desktopBridge: bridge, createRpcClient: () => fake, rpcConnect: { attempts: 1, delayMs: 1 } },
  );
  await bootstrap(env);
  return { apis, t3: apis[ids[0]!]!, fake, win: env.win };
}

async function waitForSub(fake: FakeRpc, method: string): Promise<FakeSub> {
  await vi.waitFor(() => {
    expect(fake.subs.some((s) => s.method === method && !s.cancelled)).toBe(true);
  });
  return fake.sub(method);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------------------------
// t3.providers
// ---------------------------------------------------------------------------------------------

describe("t3.providers", () => {
  it("loads once, starts ONE config stream for every plugin and serves the recorded payload", async () => {
    const { apis, fake } = await startPlugins({ ids: ["a", "b"] });
    const [listA, listB] = await Promise.all([apis.a!.providers.list(), apis.b!.providers.list()]);

    expect(fake.callsOf("server.getConfig")).toHaveLength(1);
    expect(fake.subs.filter((s) => s.method === "subscribeServerConfig")).toHaveLength(1);
    expect(listA.map((p) => p.instanceId)).toEqual(serverConfig.providers.map((p) => p.instanceId));
    expect(listB).toEqual(listA);
    // returned arrays are copies, not the cache itself
    (listA as ProviderSnapshot[]).length = 0;
    expect(await apis.a!.providers.list()).toHaveLength(serverConfig.providers.length);

    // the stream payload asks for live limits; accept flags are left out (WP-0D)
    expect(fake.sub("subscribeServerConfig").payload).toEqual({ usageLimitSources: true, usageLimitsCommand: true });
  });

  it("get/limits report exactly what the server sent, including an unavailable limit set", async () => {
    const { t3 } = await startPlugins();
    const claude = await t3.providers.get("claudeAgent");
    expect(claude).toMatchObject({ instanceId: "claudeAgent", installed: true, status: "error" });
    expect(claude?.usageLimits).toBeUndefined();

    const limits = await t3.providers.limits("opencode");
    expect(limits).toBeDefined();
    expect(limits?.windows).toEqual([]);
    expect(limits?.unavailable?.reason).toBe("unsupported");

    expect(await t3.providers.get("nope")).toBeUndefined();
    expect(await t3.providers.limits("nope")).toBeUndefined();
  });

  it("onChange fires with the full list on stream updates and stops with the plugin", async () => {
    const { t3, fake, win } = await startPlugins();
    const seen: ProviderSnapshot[][] = [];
    t3.providers.onChange((providers) => seen.push(providers));
    await t3.providers.list();
    expect(seen).toHaveLength(0); // the initial load is not a change

    fake.emit("subscribeServerConfig", {
      version: 1,
      type: "providerStatuses",
      payload: { providers: serverConfig.providers.map((p) => (p.instanceId === "claudeAgent" ? { ...p, status: "ready" } : p)) },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.find((p) => p.instanceId === "claudeAgent")?.status).toBe("ready");

    // deltas omit the lists the client already holds: models survive the merge
    fake.emit("subscribeServerConfig", {
      version: 1,
      type: "providerStatusDeltas",
      payload: { providers: [{ instanceId: "claudeAgent", status: "warning" }] },
    });
    expect(seen).toHaveLength(2);
    const claude = seen[1]!.find((p) => p.instanceId === "claudeAgent");
    expect(claude?.status).toBe("warning");
    expect(claude?.models.length).toBe(serverConfig.providers.find((p) => p.instanceId === "claudeAgent")!.models.length);

    // unrelated stream events do not notify
    fake.emit("subscribeServerConfig", { version: 1, type: "settingsUpdated", payload: { settings: {} } });
    expect(seen).toHaveLength(2);

    const manager = (win.__t3p as { manager: { disable(id: string): Promise<unknown> } }).manager;
    await manager.disable("p");
    fake.emit("subscribeServerConfig", { version: 1, type: "providerStatuses", payload: { providers: [] } });
    expect(seen).toHaveLength(2);
  });

  it("refresh re-probes through server.refreshProviders and updates the cache", async () => {
    const fake = FakeRpc.withConfig();
    const refreshed = serverConfig.providers.map((p) => (p.instanceId === "codex" ? { ...p, installed: true, status: "ready" } : p));
    fake.handle("server.refreshProviders", () => ({ providers: refreshed }));
    const { t3 } = await startPlugins({ fake });

    const list = await t3.providers.refresh({ instanceId: "codex" });
    expect(fake.callsOf("server.refreshProviders")).toEqual([{ instanceId: "codex" }]);
    expect(list.find((p) => p.instanceId === "codex")).toMatchObject({ installed: true, status: "ready" });
    expect((await t3.providers.get("codex"))?.installed).toBe(true);

    await t3.providers.refresh();
    expect(fake.callsOf("server.refreshProviders")).toEqual([{ instanceId: "codex" }, {}]);
    expect(fake.callsOf("server.getConfig")).toHaveLength(1); // only the initial load
  });

  it("needs the rpc permission", async () => {
    const { t3, fake } = await startPlugins({ perms: {} });
    await expect(t3.providers.list()).rejects.toBeInstanceOf(T3PermissionError);
    await expect(t3.providers.get("codex")).rejects.toBeInstanceOf(T3PermissionError);
    await expect(t3.providers.limits("codex")).rejects.toBeInstanceOf(T3PermissionError);
    await expect(t3.providers.refresh()).rejects.toBeInstanceOf(T3PermissionError);
    expect(() => t3.providers.onChange(() => undefined)).toThrow(T3PermissionError);
    expect(fake.calls).toHaveLength(0);
    expect(fake.subs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// t3.threads: route reading
// ---------------------------------------------------------------------------------------------

describe("threads.current (route reading)", () => {
  it("reads the thread id from the hash route or from pathname", () => {
    expect(threadIdFromLocation({ hash: "#/env-1/thread-1", pathname: "/" })).toBe("thread-1");
    expect(threadIdFromLocation({ hash: "#/env-1/thread-1/", pathname: "/" })).toBe("thread-1");
    expect(threadIdFromLocation({ hash: "#/env-1/thread%201?tab=x", pathname: "/" })).toBe("thread 1");
    expect(threadIdFromLocation({ hash: "", pathname: "/env-1/thread-1" })).toBe("thread-1");
    expect(threadIdFromLocation({ hash: "#/settings/general" })).toBeNull();
    expect(threadIdFromLocation({ hash: "#/threads/env-1/thread-1" })).toBeNull();
    expect(threadIdFromLocation({ hash: "#/env-1" })).toBeNull();
    expect(threadIdFromLocation({})).toBeNull();
  });

  it("open() navigates to a thread in the current environment", async () => {
    const win = fakeWindow("#/env-1/thread-1");
    vi.stubGlobal("window", win);
    const { apis } = await startPlugins({ ids: ["a"] });
    apis.a!.threads.open("thread-7");
    expect(win.location.hash).toBe("#/env-1/thread-7");
    expect(() => apis.a!.threads.open("")).toThrow();
  });

  it("follows history changes and emits thread:focus once per change", async () => {
    const win = fakeWindow("#/env-1/thread-1");
    vi.stubGlobal("window", win);
    const { apis } = await startPlugins({ ids: ["a", "b"] });

    expect(apis.a!.threads.current()).toBe("thread-1");
    expect(apis.b!.threads.current()).toBe("thread-1");

    const focusA: Array<{ threadId: string | null }> = [];
    const focusB: Array<{ threadId: string | null }> = [];
    apis.a!.events.on("thread:focus", (payload) => focusA.push(payload));
    apis.b!.events.on("thread:focus", (payload) => focusB.push(payload));

    win.history.pushState(null, "", "#/env-1/thread-2");
    expect(apis.a!.threads.current()).toBe("thread-2");
    expect(focusA).toEqual([{ threadId: "thread-2" }]);
    expect(focusB).toEqual([{ threadId: "thread-2" }]); // one emission for the page, not one per plugin

    win.history.pushState(null, "", "#/settings/general");
    expect(apis.a!.threads.current()).toBeNull();
    expect(focusA.at(-1)).toEqual({ threadId: null });

    // same route again: no event
    win.history.pushState(null, "", "#/settings/general");
    expect(focusA).toHaveLength(2);

    // popstate (back/forward) is read too
    win.location.hash = "#/env-2/thread-9";
    win.firePopState();
    expect(apis.b!.threads.current()).toBe("thread-9");
    expect(focusA.at(-1)).toEqual({ threadId: "thread-9" });
  });
});

interface FakeWindow extends ThreadRouteWindow {
  location: { hash: string; pathname: string };
  history: { pushState(...args: unknown[]): void; replaceState(...args: unknown[]): void };
  firePopState(): void;
}

function fakeWindow(hash: string): FakeWindow {
  const win: FakeWindow = {
    location: { hash, pathname: "/" },
    history: {
      pushState(_state: unknown, _title: unknown, url: string) {
        win.location.hash = url;
      },
      replaceState(_state: unknown, _title: unknown, url: string) {
        win.location.hash = url;
      },
    },
    addEventListener(type: string, listener: () => void) {
      listeners.set(type, listener);
    },
    removeEventListener(type: string, _listener: () => void) {
      listeners.delete(type);
    },
    firePopState() {
      listeners.get("popstate")?.();
    },
  };
  const listeners = new Map<string, () => void>();
  return win;
}

// ---------------------------------------------------------------------------------------------
// t3.threads: list, subscribe, dispatch, model/provider changes
// ---------------------------------------------------------------------------------------------

const shellRow = (id: string, updatedAt: string, status = "idle") => ({
  id,
  title: `thread ${id}`,
  projectId: "prj-1",
  providerInstanceId: "claudeAgent",
  modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
  updatedAt,
  status,
  archivedAt: null,
});

describe("t3.threads", () => {
  it("derives settled from settledOverride === 'settled' and follows live updates", async () => {
    const { t3, fake } = await startPlugins();
    const pending = t3.threads.list();
    const sub = await waitForSub(fake, "orchestration.subscribeShell");
    sub.emit({
      kind: "snapshot",
      snapshot: {
        threads: [
          { ...shellRow("s1", "2026-01-01T10:00:00.000Z"), settledOverride: "settled", settledAt: "2026-01-01T09:00:00.000Z" },
          { ...shellRow("a1", "2026-01-01T09:00:00.000Z"), settledOverride: "active", settledAt: "2026-01-01T08:00:00.000Z" },
          { ...shellRow("n1", "2026-01-01T08:00:00.000Z"), settledOverride: null, settledAt: "2026-01-01T07:00:00.000Z" },
        ],
        archivedThreads: [],
      },
    });
    const by = (list: Awaited<typeof pending>) => Object.fromEntries(list.map((t) => [t.threadId, t.settled]));
    expect(by(await pending)).toEqual({ s1: true, a1: false, n1: false });
    sub.emit({ kind: "thread.updated", location: "active", sequence: 1, thread: { ...shellRow("s1", "2026-01-01T11:00:00.000Z"), settledOverride: "active" } });
    expect(by(await t3.threads.list()).s1).toBe(false);
  });

  it("maps the shell stream to ThreadSummary rows, most recently active first", async () => {
    const { t3, fake } = await startPlugins();
    const pending = t3.threads.list();
    const sub = await waitForSub(fake, "orchestration.subscribeShell");
    sub.emit({
      kind: "snapshot",
      snapshot: {
        threads: [shellRow("t-old", "2026-01-01T10:00:00.000Z"), shellRow("t-new", "2026-01-01T12:00:00.000Z", "running")],
        archivedThreads: [shellRow("t-archived", "2026-01-01T13:00:00.000Z")],
      },
    });
    const list = await pending;
    expect(list.map((t) => t.threadId)).toEqual(["t-new", "t-old"]);
    expect(list[0]).toMatchObject({ title: "thread t-new", projectId: "prj-1", providerInstanceId: "claudeAgent", model: "claude-opus-5-5", running: true, updatedAt: "2026-01-01T12:00:00.000Z" });
    expect(list[1]!.running).toBe(false);
    expect(list[0]!.raw).toMatchObject({ id: "t-new" });

    // live updates: upsert, remove, archive
    sub.emit({ kind: "thread.updated", location: "active", sequence: 1, thread: shellRow("t-live", "2026-01-01T14:00:00.000Z") });
    expect((await t3.threads.list()).map((t) => t.threadId)).toEqual(["t-live", "t-new", "t-old"]);

    sub.emit({ kind: "thread.removed", location: "active", sequence: 2, threadId: "t-old" });
    expect((await t3.threads.list()).map((t) => t.threadId)).toEqual(["t-live", "t-new"]);

    sub.emit({ kind: "thread.updated", location: "archive", sequence: 3, thread: shellRow("t-new", "2026-01-01T15:00:00.000Z") });
    expect((await t3.threads.list()).map((t) => t.threadId)).toEqual(["t-live"]);
  });

  it("adds projectName from the shell stream's projects", async () => {
    const { t3, fake } = await startPlugins();
    const pending = t3.threads.list();
    const sub = await waitForSub(fake, "orchestration.subscribeShell");
    sub.emit({ kind: "snapshot", snapshot: { threads: [shellRow("t1", "2026-01-01T10:00:00.000Z")], projects: [{ id: "prj-1", title: "demo-app" }], archivedThreads: [] } });
    expect((await pending)[0]!.projectName).toBe("demo-app");
    sub.emit({ kind: "project.updated", sequence: 1, project: { id: "prj-1", title: "renamed" } });
    expect((await t3.threads.list())[0]!.projectName).toBe("renamed");
    sub.emit({ kind: "project.removed", sequence: 2, projectId: "prj-1" });
    expect((await t3.threads.list())[0]!.projectName).toBeUndefined();
  });

  it("subscribe follows the thread with afterSequence and cancels on stop", async () => {
    const { t3, fake, win } = await startPlugins();
    const items: unknown[] = [];
    const stop = t3.threads.subscribe("th-1", (item) => items.push(item), { afterSequence: 5 });
    const sub = await waitForSub(fake, "orchestration.subscribeThread");
    expect(sub.payload).toEqual({ threadId: "th-1", afterSequence: 5 });

    const snapshot = { kind: "snapshot", snapshotSequence: 9, projection: { thread: { id: "th-1" } } };
    const event = { kind: "event", sequence: 10, event: { id: "e", threadId: "th-1", type: "thread.metadata-updated", payload: {} } };
    sub.emit(snapshot);
    sub.emit(event);
    expect(items).toEqual([snapshot, event]);

    const other = t3.threads.subscribe("th-2", () => undefined);
    await vi.waitFor(() => expect(fake.subs.filter((s) => s.method === "orchestration.subscribeThread")).toHaveLength(2));
    stop();
    expect(sub.cancelled).toBe(true);
    other();

    const third = t3.threads.subscribe("th-3", () => undefined);
    await vi.waitFor(() => expect(fake.subs.filter((s) => s.method === "orchestration.subscribeThread" && !s.cancelled)).toHaveLength(1));
    const manager = (win.__t3p as { manager: { disable(id: string): Promise<unknown> } }).manager;
    await manager.disable("p");
    expect(fake.subs.filter((s) => !s.cancelled).map((s) => s.method)).not.toContain("orchestration.subscribeThread");
    third();
  });

  it("projection and dispatch pass the payload through and return the wire result", async () => {
    const fake = FakeRpc.withConfig();
    const projection = { thread: { id: "th-1" }, providerTurns: [] };
    fake.handle("orchestration.getThreadProjection", () => projection).handle("orchestration.dispatchCommand", () => ({ sequence: 12 }));
    const { t3 } = await startPlugins({ fake });

    await expect(t3.threads.projection("th-1")).resolves.toEqual({ ...projection, settled: false });
    expect(fake.callsOf("orchestration.getThreadProjection")).toEqual([{ threadId: "th-1" }]);

    const command = { type: "thread.metadata.update", commandId: "c-1", threadId: "th-1", title: "renamed" };
    await expect(t3.threads.dispatch(command as never)).resolves.toEqual({ sequence: 12 });
    expect(fake.callsOf("orchestration.dispatchCommand")).toEqual([command]);
  });

  it("setModel dispatches thread.model-selection.set with the wire selection shape", async () => {
    const fake = FakeRpc.withConfig().handle("orchestration.dispatchCommand", () => ({ sequence: 4 }));
    const { t3 } = await startPlugins({ fake });

    const result = await t3.threads.setModel("th-1", { providerInstanceId: "claudeAgent", model: "claude-opus-5-5", options: { effort: "high" } });
    expect(result).toEqual({ status: "ok", result: { sequence: 4 } });
    const [command] = fake.callsOf("orchestration.dispatchCommand") as Array<Record<string, unknown>>;
    expect(command).toMatchObject({
      type: "thread.model-selection.set",
      threadId: "th-1",
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5", options: { effort: "high" } },
    });
    expect(typeof command!.commandId).toBe("string");
    expect((command!.commandId as string).length).toBeGreaterThan(0);
  });

  it("switchProvider succeeds for a ready, installed provider", async () => {
    const fake = readyProviderFake().handle("orchestration.dispatchCommand", () => ({ sequence: 21 }));
    const { t3 } = await startPlugins({ fake });

    const result = await t3.threads.switchProvider("th-1", { providerInstanceId: "claudeAgent", model: "claude-opus-5-5" });
    expect(result).toEqual({ status: "ok", result: { sequence: 21 } });
    expect(fake.callsOf("orchestration.dispatchCommand")).toEqual([
      expect.objectContaining({ type: "provider.switch", threadId: "th-1", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" } }),
    ]);
  });

  it("switchProvider refuses an uninstalled provider without sending anything", async () => {
    const { t3, fake } = await startPlugins();

    // fixture: codex is installed=false
    const result = await t3.threads.switchProvider("th-1", { providerInstanceId: "codex", model: "gpt-5-codex" });
    expect(result.status).toBe("unavailable");
    expect(result.status === "unavailable" && result.message).toMatch(/not installed/);
    expect(fake.callsOf("orchestration.dispatchCommand")).toHaveLength(0);
  });

  it("switchProvider refuses a provider that is not ready", async () => {
    const { t3, fake } = await startPlugins();

    // fixture: claudeAgent is installed but status "error" (unauthenticated)
    const notReady = await t3.threads.switchProvider("th-1", { providerInstanceId: "claudeAgent", model: "claude-opus-5-5" });
    expect(notReady.status).toBe("unavailable");
    expect(notReady.status === "unavailable" && notReady.message).toMatch(/not ready/);
    expect(fake.callsOf("orchestration.dispatchCommand")).toHaveLength(0);
  });

  it("switchProvider refuses a disabled provider and an unknown one", async () => {
    const disabled = new FakeRpc().handle("server.getConfig", () => ({
      ...serverConfig,
      providers: serverConfig.providers.map((p) => (p.instanceId === "claudeAgent" ? { ...p, installed: true, enabled: false, status: "ready" } : p)),
    }));
    const { t3, fake } = await startPlugins({ fake: disabled });

    const notEnabled = await t3.threads.switchProvider("th-1", { providerInstanceId: "claudeAgent", model: "m" });
    expect(notEnabled.status).toBe("unavailable");
    expect(notEnabled.status === "unavailable" && notEnabled.message).toMatch(/disabled/);

    const unknown = await t3.threads.switchProvider("th-1", { providerInstanceId: "nope", model: "x" });
    expect(unknown.status).toBe("unavailable");
    expect(unknown.status === "unavailable" && unknown.message).toMatch(/unknown/);

    expect(fake.callsOf("orchestration.dispatchCommand")).toHaveLength(0);
  });

  it("switchProvider reports busy when a run is active, and other errors as error", async () => {
    const busy = readyProviderFake().handle("orchestration.dispatchCommand", () => {
      throw busyError();
    });
    const { t3: t3Busy } = await startPlugins({ fake: busy });
    const busyResult = await t3Busy.threads.switchProvider("th-1", { providerInstanceId: "claudeAgent", model: "m" });
    expect(busyResult.status).toBe("busy");
    expect(busyResult.status === "busy" && busyResult.message).toMatch(/active turn/);

    const broken = readyProviderFake().handle("orchestration.dispatchCommand", () => {
      throw new Error("disk on fire");
    });
    const { t3: t3Broken } = await startPlugins({ fake: broken });
    const errorResult = await t3Broken.threads.switchProvider("th-1", { providerInstanceId: "claudeAgent", model: "m" });
    expect(errorResult.status).toBe("error");
    expect(errorResult).toMatchObject({ message: "Error: disk on fire" });
    expect((errorResult as { cause?: unknown }).cause).toBeInstanceOf(Error);

    // setModel maps the same way
    const setModelBusy = readyProviderFake().handle("orchestration.dispatchCommand", () => {
      throw busyError();
    });
    const { t3: t3Model } = await startPlugins({ fake: setModelBusy });
    await expect(t3Model.threads.setModel("th-1", { providerInstanceId: "claudeAgent", model: "m" })).resolves.toMatchObject({ status: "busy" });
  });

  it("needs the rpc permission", async () => {
    const { t3, fake } = await startPlugins({ perms: {} });
    await expect(t3.threads.list()).rejects.toBeInstanceOf(T3PermissionError);
    await expect(t3.threads.projection("th-1")).rejects.toBeInstanceOf(T3PermissionError);
    await expect(t3.threads.dispatch({} as never)).rejects.toBeInstanceOf(T3PermissionError);
    expect(() => t3.threads.current()).toThrow(T3PermissionError);
    expect(() => t3.threads.subscribe("th-1", () => undefined)).toThrow(T3PermissionError);
    await expect(t3.threads.setModel("th-1", { providerInstanceId: "a", model: "m" })).rejects.toBeInstanceOf(T3PermissionError);
    await expect(t3.threads.switchProvider("th-1", { providerInstanceId: "a", model: "m" })).rejects.toBeInstanceOf(T3PermissionError);
    expect(fake.calls).toHaveLength(0);
  });
});

/** Recorded config with claudeAgent made usable (installed, enabled, ready). */
function readyProviderFake(): FakeRpc {
  const providers = serverConfig.providers.map((p) => (p.instanceId === "claudeAgent" ? { ...p, installed: true, enabled: true, status: "ready" } : p));
  return new FakeRpc().handle("server.getConfig", () => ({ ...serverConfig, providers }));
}

/** The recorded busy failure: OrchestrationV2DispatchCommandError wrapping the busy cause name. */
function busyError(): RpcError {
  return new RpcError("failure", "OrchestrationV2DispatchCommandError (orchestration.dispatchCommand): Thread has an active turn. Wait for it to finish, then retry.", {
    tag: "OrchestrationV2DispatchCommandError",
    cause: [
      {
        _tag: "Fail",
        error: {
          _tag: "OrchestrationV2DispatchCommandError",
          commandId: "c-1",
          commandType: "provider.switch",
          message: "Thread has an active turn. Wait for it to finish, then retry the provider selection change.",
          cause: { name: "OrchestratorProviderSelectionBusyError", _tag: "OrchestratorProviderSelectionBusyError" },
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------------------------
// t3.usage
// ---------------------------------------------------------------------------------------------

const turn = (completedAt: string | null, usage?: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number }, providerThreadId = "pt-1") => ({
  providerThreadId,
  startedAt: completedAt === null ? null : new Date(Date.parse(completedAt) - 1000).toISOString(),
  completedAt,
  ...(usage === undefined ? {} : { tokenUsage: { ...usage, updatedAt: completedAt ?? "2026-01-01T00:00:00.000Z" } }),
});

const projectionFor = (provider: string, turns: unknown[]) => ({
  thread: { id: "th", providerInstanceId: provider },
  providerThreads: [{ id: "pt-1", providerInstanceId: provider }],
  providerTurns: turns,
});

describe("t3.usage", () => {
  it("thread totals sum inputTokens, cachedInputTokens and outputTokens of every provider turn", async () => {
    const fake = FakeRpc.withConfig().handle("orchestration.getThreadProjection", () =>
      projectionFor("claudeAgent", [
        turn("2026-01-01T00:00:10.000Z", { inputTokens: 100, cachedInputTokens: 20, outputTokens: 30 }),
        turn("2026-01-01T00:00:20.000Z"), // no tokenUsage: not counted
        turn("2026-01-01T00:00:30.000Z", { inputTokens: 5, outputTokens: 1 }),
      ]),
    );
    const { t3 } = await startPlugins({ fake });

    await expect(t3.usage.thread("th-1")).resolves.toEqual({
      inputTokens: 105,
      cachedInputTokens: 20,
      outputTokens: 31,
      totalTokens: 156,
    });
    expect(fake.callsOf("orchestration.getThreadProjection")).toEqual([{ threadId: "th-1" }]);
  });

  it("context returns the latest usedTokens and maxTokens, not a sum", async () => {
    const withGauge = (completedAt: string, gauge: Record<string, number>) => ({
      ...turn(completedAt, { inputTokens: 1 }),
      tokenUsage: { inputTokens: 1, updatedAt: completedAt, ...gauge },
    });
    const fake = FakeRpc.withConfig().handle("orchestration.getThreadProjection", () =>
      projectionFor("claudeAgent", [
        withGauge("2026-01-01T00:00:30.000Z", { usedTokens: 90_000, maxTokens: 200_000 }),
        withGauge("2026-01-01T00:00:10.000Z", { usedTokens: 10_000, maxTokens: 200_000 }),
        turn("2026-01-01T00:00:40.000Z", { inputTokens: 5 }), // newest but reports no gauge
      ]),
    );
    const { t3 } = await startPlugins({ fake });
    await expect(t3.usage.context("th-1")).resolves.toEqual({ usedTokens: 90_000, maxTokens: 200_000 });
    await expect(t3.usage.context("")).rejects.toBeInstanceOf(TypeError);
  });

  it("context is null when no turn reports a gauge", async () => {
    const fake = FakeRpc.withConfig().handle("orchestration.getThreadProjection", () => projectionFor("codex", [turn("2026-01-01T00:00:10.000Z", { inputTokens: 1 })]));
    const { t3 } = await startPlugins({ fake });
    await expect(t3.usage.context("th-1")).resolves.toEqual({ usedTokens: null, maxTokens: null });
  });

  it("summary filters turns by completion time and groups by thread and provider", async () => {
    const from = Date.parse("2026-01-01T00:00:00.000Z");
    const to = Date.parse("2026-01-02T00:00:00.000Z");
    const fake = FakeRpc.withConfig()
      .handle("orchestration.getThreadProjection", (payload) => {
        const { threadId } = payload as { threadId: string };
        if (threadId === "t-old") throw new Error("should have been skipped");
        return projectionFor("claudeAgent", [
          turn("2026-01-01T10:00:00.000Z", { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3 }),
          turn("2025-12-31T10:00:00.000Z", { inputTokens: 1000 }), // before the range
          turn("2026-01-02T10:00:00.000Z", { inputTokens: 2000 }), // after the range
        ]);
      });
    const { t3 } = await startPlugins({ fake });

    const pending = t3.usage.summary({ from, to });
    const sub = await waitForSub(fake, "orchestration.subscribeShell");
    sub.emit({
      kind: "snapshot",
      snapshot: {
        threads: [shellRow("t-live", "2026-01-01T12:00:00.000Z"), shellRow("t-old", "2025-12-01T00:00:00.000Z")],
        archivedThreads: [],
      },
    });
    const summary = await pending;

    expect(summary.range).toEqual({ from, to });
    expect(summary.totals).toEqual({ inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, totalTokens: 15 });
    expect(Object.keys(summary.byThread)).toEqual(["t-live"]);
    expect(summary.byThread["t-live"]).toEqual(summary.totals);
    expect(Object.keys(summary.byProvider)).toEqual(["claudeAgent"]);
    expect(summary.byProvider["claudeAgent"]).toEqual(summary.totals);
    // the thread whose last activity predates the range was never fetched
    expect(fake.callsOf("orchestration.getThreadProjection")).toEqual([{ threadId: "t-live" }]);
  });

  it("summary without a range counts every turn", async () => {
    const fake = FakeRpc.withConfig().handle("orchestration.getThreadProjection", () =>
      projectionFor("codex", [turn("2020-01-01T00:00:00.000Z", { inputTokens: 1, outputTokens: 2 }), turn("2030-01-01T00:00:00.000Z", { inputTokens: 3 })]),
    );
    const { t3 } = await startPlugins({ fake });

    const pending = t3.usage.summary();
    const sub = await waitForSub(fake, "orchestration.subscribeShell");
    sub.emit({ kind: "snapshot", snapshot: { threads: [shellRow("t-live", "2030-01-01T00:00:00.000Z")], archivedThreads: [] } });
    const summary = await pending;
    expect(summary.range).toEqual({});
    expect(summary.totals).toEqual({ inputTokens: 4, cachedInputTokens: 0, outputTokens: 2, totalTokens: 6 });
    expect(summary.byProvider["codex"]).toEqual(summary.totals);
  });

  it("needs the rpc permission", async () => {
    const { t3, fake } = await startPlugins({ perms: {} });
    await expect(t3.usage.summary()).rejects.toBeInstanceOf(T3PermissionError);
    await expect(t3.usage.thread("th-1")).rejects.toBeInstanceOf(T3PermissionError);
    await expect(t3.usage.context("th-1")).rejects.toBeInstanceOf(T3PermissionError);
    expect(fake.calls).toHaveLength(0);
  });
});
