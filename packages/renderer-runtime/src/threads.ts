import {
  type BeforeStartOptions,
  type DispatchResult,
  type ModelSelection,
  type OrchestrationCommand,
  type ProviderSnapshot,
  type SwitchResult,
  type T3Disposable,
  T3PermissionError,
  type T3Threads,
  type ThreadProjection,
  type ThreadStreamItem,
  type ThreadSummary,
  type TurnStartHandler,
  type Unsubscribe,
} from "@t3p/api";
import { type RpcClient, watchThread } from "@t3p/rpc-client";

import type { GuardClient } from "./guard.js";
import { providerStore } from "./providers.js";
import { type RpcClientLike, requireRpc, type SharedRpc } from "./rpc.js";
import type { Scope } from "./scope.js";
import type { EventBus, RemoteLog } from "./types.js";

// ---------------------------------------------------------------------------------------------
// Focused thread (URL route)
// ---------------------------------------------------------------------------------------------
//
// The desktop app uses TanStack Router with HASH history (`.upstream/apps/web/src/appInit.tsx`:
// `getRouter(isElectron ? createHashHistory() : createBrowserHistory())`), and the thread route is
// `_chat.$environmentId.$threadId` -> `/<environmentId>/<threadId>`. So in the app window the
// focused thread id is the third path segment of `location.hash`: `t3code://app/#/<env>/<thread>`
// (verified against the route files and WP-0D's `--hash "#/<environmentId>/<threadId>"` capture).
// In a browser-history build the same route sits in `location.pathname`. `/threads/<env>/<thread>`
// is only a copy-link route that redirects to the canonical one, so it is not read here.

/** The parts of `window.location` the route reader uses. */
export interface ThreadRouteLocation {
  hash?: string;
  pathname?: string;
}

/** The parts of `window` the focus tracker uses (a test seam; the app passes the real window). */
export interface ThreadRouteWindow {
  location: ThreadRouteLocation;
  history?: ThreadRouteHistory;
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}

export interface ThreadRouteHistory {
  pushState?: (...args: unknown[]) => unknown;
  replaceState?: (...args: unknown[]) => unknown;
  [name: string]: unknown;
}

/**
 * First segments of the app's other two-segment routes (`_chat.settings.*`, `_chat.draft.$draftId`
 * and the standalone routes). Without them `/settings/general` would read as `general`.
 * Source: `.upstream/apps/web/src/routes/`.
 */
const RESERVED_FIRST_SEGMENTS: ReadonlySet<string> = new Set([
  "settings",
  "draft",
  "welcome",
  "connect",
  "connect-agent",
  "pair",
  "approve-agent",
  "guest",
  "projects",
  "threads",
  "pull-requests",
  "usage",
]);

/**
 * Thread id of a URL, or `null` outside a thread. `#/...` wins when present (hash history);
 * otherwise `pathname`. Query strings and trailing slashes are ignored, segments are decoded.
 */
export function threadIdFromLocation(location: ThreadRouteLocation): string | null {
  const hash = typeof location.hash === "string" ? location.hash : "";
  const pathname = typeof location.pathname === "string" ? location.pathname : "";
  const route = hash.startsWith("#/") ? hash.slice(1) : pathname;
  const path = (route.split("?")[0] ?? "").replace(/\/+$/, "");
  const parts = path.split("/");
  if (parts.length !== 3 || parts[0] !== "" || !parts[1] || !parts[2]) return null;
  if (RESERVED_FIRST_SEGMENTS.has(parts[1])) return null;
  try {
    return decodeURIComponent(parts[2]);
  } catch {
    return null;
  }
}

/** Environment id of a thread route (`#/<environmentId>/<threadId>`), or `null` outside one. Same parsing as `threadIdFromLocation`. */
export function environmentIdFromLocation(location: ThreadRouteLocation): string | null {
  if (threadIdFromLocation(location) === null) return null;
  const hash = typeof location.hash === "string" ? location.hash : "";
  const pathname = typeof location.pathname === "string" ? location.pathname : "";
  const route = hash.startsWith("#/") ? hash.slice(1) : pathname;
  const segment = (route.split("?")[0] ?? "").split("/")[1];
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** Watches one window's URL and reports the focused thread id when it changes. */
class RouteFocusTracker {
  #id: string | null;
  readonly #win: ThreadRouteWindow;
  readonly #emit: (threadId: string | null) => void;
  readonly #patched: Array<{ name: "pushState" | "replaceState"; original: (...args: unknown[]) => unknown }> = [];
  readonly #onNavigate = (): void => this.#check();

  constructor(win: ThreadRouteWindow, emit: (threadId: string | null) => void) {
    this.#win = win;
    this.#emit = emit;
    this.#id = threadIdFromLocation(win.location ?? {});
    const history = win.history;
    for (const name of ["pushState", "replaceState"] as const) {
      const original = history?.[name];
      if (!history || typeof original !== "function") continue;
      const wrapper = (...args: unknown[]): unknown => {
        const out = original.apply(history, args);
        this.#check();
        return out;
      };
      history[name] = wrapper;
      this.#patched.push({ name, original });
    }
    win.addEventListener?.("popstate", this.#onNavigate);
    win.addEventListener?.("hashchange", this.#onNavigate);
  }

  get id(): string | null {
    return this.#id;
  }

  #check(): void {
    const next = threadIdFromLocation(this.#win.location ?? {});
    if (next === this.#id) return;
    this.#id = next;
    this.#emit(next);
  }

  dispose(): void {
    const history = this.#win.history;
    if (history) for (const { name, original } of this.#patched) history[name] = original;
    this.#patched.length = 0;
    this.#win.removeEventListener?.("popstate", this.#onNavigate);
    this.#win.removeEventListener?.("hashchange", this.#onNavigate);
  }
}

interface FocusEntry {
  tracker: RouteFocusTracker;
  refs: number;
}

const focusTrackers = new WeakMap<object, FocusEntry>();

/**
 * One tracker per window, shared by every plugin of the page so `thread:focus` is emitted ONCE
 * per navigation on the shared system bus. Released when the last plugin using it stops.
 */
function acquireFocusTracker(win: ThreadRouteWindow | null, bus: EventBus): { id(): string | null; release(): void } | null {
  if (!win) return null;
  let entry = focusTrackers.get(win);
  if (!entry) {
    entry = { tracker: new RouteFocusTracker(win, (threadId) => bus.emit("thread:focus", { threadId })), refs: 0 };
    focusTrackers.set(win, entry);
  }
  const found = entry;
  found.refs++;
  return {
    id: () => found.tracker.id,
    release(): void {
      found.refs--;
      if (found.refs > 0) return;
      found.tracker.dispose();
      focusTrackers.delete(win);
    },
  };
}

function defaultWindow(): ThreadRouteWindow | null {
  const win = (globalThis as unknown as { window?: ThreadRouteWindow }).window;
  return win ?? null;
}

// ---------------------------------------------------------------------------------------------
// Shell thread list
// ---------------------------------------------------------------------------------------------

/** `thread.updated` / snapshot shell rows (the fields `ThreadSummary` needs). */
interface ShellThreadWire {
  id: string;
  title?: unknown;
  projectId?: unknown;
  providerInstanceId?: unknown;
  modelSelection?: { model?: unknown } | null;
  updatedAt?: unknown;
  status?: unknown;
}

interface ShellStreamItemWire {
  kind?: unknown;
  location?: unknown;
  snapshot?: { threads?: ShellThreadWire[] };
  thread?: ShellThreadWire;
  threadId?: unknown;
}

const RUNNING_STATUSES: ReadonlySet<string> = new Set(["queued", "preparing", "starting", "running", "waiting"]);

function byMostRecent(a: ThreadSummary, b: ThreadSummary): number {
  const at = a.updatedAt ?? "";
  const bt = b.updatedAt ?? "";
  if (at !== bt) return at < bt ? 1 : -1;
  return a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0;
}

/**
 * The thread list, ONE per renderer, fed by `orchestration.subscribeShell` (started on first
 * `list()`). A snapshot replaces the map; `thread.updated` upserts (an `archive` update removes
 * the row) and `thread.removed` deletes. Archived snapshot rows are not listed.
 */
export class ThreadShellStore {
  readonly #threads = new Map<string, ThreadSummary>();
  #ready: Promise<void> | null = null;
  #stream: { cancel(): void; done: Promise<void> } | null = null;

  constructor(
    private readonly shared: SharedRpc,
    private readonly log: RemoteLog,
    private readonly firstItemTimeoutMs = 10_000,
  ) {}

  async list(): Promise<ThreadSummary[]> {
    await this.#ensure();
    return [...this.#threads.values()].sort(byMostRecent);
  }

  #ensure(): Promise<void> {
    if (!this.#ready) {
      const attempt = this.#start().catch((error: unknown) => {
        if (this.#ready === attempt) this.#ready = null;
        throw error;
      });
      this.#ready = attempt;
    }
    return this.#ready;
  }

  /** Subscribes (once) and resolves once the first snapshot item arrived, or after a timeout. */
  async #start(): Promise<void> {
    const { client } = await this.shared.ready();
    if (this.#stream) return;
    let first!: () => void;
    const arrived = new Promise<void>((resolve) => (first = resolve));
    const sub = client.subscribe(
      "orchestration.subscribeShell",
      {},
      (item) => {
        this.#onItem(item);
        first();
      },
      { onError: (error) => this.log("warn", `threads: shell stream ended: ${describe(error)}`) },
    );
    this.#stream = sub;
    const clear = (): void => {
      if (this.#stream !== sub) return;
      this.#stream = null;
      // The next list() resubscribes; its snapshot rebuilds the map (gap-free by design).
      this.#ready = null;
    };
    void sub.done.then(clear, clear);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.firstItemTimeoutMs);
      (timer as unknown as { unref?(): void }).unref?.();
    });
    try {
      await Promise.race([arrived, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #onItem(item: unknown): void {
    const event = item as ShellStreamItemWire | null;
    if (!event || typeof event.kind !== "string") return;
    switch (event.kind) {
      case "snapshot": {
        this.#threads.clear();
        for (const thread of event.snapshot?.threads ?? []) this.#put(thread);
        return;
      }
      case "thread.updated": {
        const thread = event.thread;
        if (!thread || typeof thread.id !== "string") return;
        if (event.location === "archive") this.#threads.delete(thread.id);
        else this.#put(thread);
        return;
      }
      case "thread.removed": {
        if (typeof event.threadId === "string") this.#threads.delete(event.threadId);
        return;
      }
      default:
        // project.updated, project.removed, synchronized, snapshot-required
        return;
    }
  }

  #put(thread: ShellThreadWire): void {
    if (typeof thread?.id !== "string" || thread.id.length === 0) return;
    this.#threads.set(thread.id, {
      threadId: thread.id,
      title: typeof thread.title === "string" ? thread.title : "",
      projectId: typeof thread.projectId === "string" ? thread.projectId : null,
      providerInstanceId: typeof thread.providerInstanceId === "string" ? thread.providerInstanceId : null,
      model: typeof thread.modelSelection?.model === "string" ? thread.modelSelection.model : null,
      updatedAt: typeof thread.updatedAt === "string" ? thread.updatedAt : null,
      running: typeof thread.status === "string" && RUNNING_STATUSES.has(thread.status),
      raw: thread,
    });
  }
}

const stores = new WeakMap<SharedRpc, ThreadShellStore>();

/** The shared shell thread store of one renderer (keyed by the one shared RPC client). */
export function threadStore(shared: SharedRpc, log: RemoteLog): ThreadShellStore {
  let store = stores.get(shared);
  if (!store) {
    store = new ThreadShellStore(shared, log);
    stores.set(shared, store);
  }
  return store;
}

// ---------------------------------------------------------------------------------------------
// t3.threads
// ---------------------------------------------------------------------------------------------

export interface ThreadsDeps {
  id: string;
  allowed: boolean;
  shared: SharedRpc;
  scope: Scope;
  log: RemoteLog;
  systemBus: EventBus;
  /** Test seam: the window whose URL is followed. Defaults to `globalThis.window`. */
  win?: ThreadRouteWindow | null;
  /** Turn guard (`beforeStart`). Null without a native bridge. */
  guard?: GuardClient | null;
  /** True when the plugin holds `guard` (declared and granted). */
  guardAllowed?: boolean;
}

/** `t3.threads` for one plugin. Needs the `rpc` permission. */
export function createThreadsApi(deps: ThreadsDeps): T3Threads {
  const { id, allowed, shared, scope, log, systemBus } = deps;
  const store = threadStore(shared, log);
  const win = deps.win === undefined ? defaultWindow() : deps.win;
  const focus = acquireFocusTracker(win, systemBus);
  if (focus) scope.add(focus.release);
  const need = (): void => {
    requireRpc(id, allowed);
    scope.assertAlive();
  };
  const client = async (): Promise<RpcClientLike> => (await shared.ready()).client;

  return Object.freeze({
    beforeStart(handler: TurnStartHandler, options?: BeforeStartOptions): T3Disposable {
      if (!deps.guardAllowed) throw new T3PermissionError(id, "guard", `declare "guard" in plugin.json and grant it (t3p grant ${id} guard)`);
      scope.assertAlive();
      if (typeof handler !== "function") throw new TypeError("beforeStart: handler must be a function");
      if (!deps.guard) throw new Error("t3.threads.beforeStart: the turn guard needs the T3 Patcher main runtime (no native bridge)");
      const dispose = scope.add(deps.guard.register(id, handler, options?.timeoutMs));
      return { dispose };
    },
    async list(): Promise<ThreadSummary[]> {
      need();
      return store.list();
    },
    current(): string | null {
      need();
      return focus ? focus.id() : null;
    },
    async projection(threadId: string): Promise<ThreadProjection> {
      need();
      assertId(threadId, "threadId");
      const rpc = await client();
      return (await rpc.call("orchestration.getThreadProjection", { threadId })) as ThreadProjection;
    },
    subscribe(
      threadId: string,
      callback: (item: ThreadStreamItem) => void,
      options: { afterSequence?: number } = {},
    ): Unsubscribe {
      need();
      assertId(threadId, "threadId");
      if (typeof callback !== "function") throw new TypeError("callback must be a function");
      let cancelled = false;
      let inner: { cancel(): void } | null = null;
      const stop = scope.add(() => {
        if (cancelled) return;
        cancelled = true;
        inner?.cancel();
      });
      void shared.ready().then(
        ({ client: rpc }) => {
          if (cancelled) return;
          // watchThread keeps `afterSequence` in sync across reconnects (resumeAfterSequence).
          inner = watchThread(
            rpc as unknown as RpcClient,
            threadId,
            (item) => callback(item),
            (item) => callback(item),
            {
              afterSequence: options.afterSequence ?? 0,
              onError: (error) => log("warn", `threads: stream for ${threadId} ended: ${error.message}`),
            },
          );
          if (cancelled) inner.cancel();
        },
        (error: unknown) => log("warn", `threads: could not subscribe to ${threadId}: ${describe(error)}`),
      );
      return stop;
    },
    async dispatch(command: OrchestrationCommand): Promise<DispatchResult> {
      need();
      if (command === null || typeof command !== "object") throw new TypeError("command must be an object");
      const rpc = await client();
      return (await rpc.call("orchestration.dispatchCommand", command)) as DispatchResult;
    },
    async setModel(threadId: string, selection: ModelSelection): Promise<SwitchResult> {
      need();
      assertId(threadId, "threadId");
      assertSelection(selection);
      return dispatchSwitch({ type: "thread.model-selection.set", commandId: newCommandId(), threadId, modelSelection: wireSelection(selection) });
    },
    async switchProvider(threadId: string, selection: ModelSelection): Promise<SwitchResult> {
      need();
      assertId(threadId, "threadId");
      assertSelection(selection);
      // The server accepts `provider.switch` to an uninstalled provider (WP-0D), so check the
      // target here: installed, enabled, and in a status that can run a turn ("ready"/"warning";
      // "error" covers unauthenticated providers, "disabled" covers ones off in settings).
      let provider: ProviderSnapshot | undefined;
      try {
        provider = await providerStore(shared, log).get(selection.providerInstanceId);
      } catch (error) {
        log("warn", `threads: could not read providers for switchProvider: ${describe(error)}`);
        return { status: "error", message: `the provider list could not be read: ${describe(error)}`, cause: error };
      }
      if (provider === undefined) return { status: "unavailable", message: `provider "${selection.providerInstanceId}" is unknown` };
      if (provider.installed !== true) {
        return { status: "unavailable", message: `provider "${selection.providerInstanceId}" is not installed` };
      }
      if (provider.enabled === false) {
        return { status: "unavailable", message: `provider "${selection.providerInstanceId}" is disabled in T3 Code settings` };
      }
      if (provider.status !== "ready" && provider.status !== "warning") {
        return { status: "unavailable", message: `provider "${selection.providerInstanceId}" is not ready (status "${provider.status}")` };
      }
      return dispatchSwitch({ type: "provider.switch", commandId: newCommandId(), threadId, modelSelection: wireSelection(selection) });
    },
  });

  /** The command and the error mapping both provider-selection commands share. */
  async function dispatchSwitch(command: {
    type: "thread.model-selection.set" | "provider.switch";
    commandId: string;
    threadId: string;
    modelSelection: { instanceId: string; model: string; options?: Record<string, unknown> };
  }): Promise<SwitchResult> {
    let rpc: RpcClientLike;
    try {
      rpc = await client();
    } catch (error) {
      return { status: "error", message: describe(error), cause: error };
    }
    try {
      const result = (await rpc.call("orchestration.dispatchCommand", command as unknown as OrchestrationCommand)) as DispatchResult;
      return { status: "ok", result };
    } catch (error) {
      return switchError(error);
    }
  }
}

/**
 * Maps a dispatch failure. A run in progress answers `OrchestrationV2DispatchCommandError` whose
 * nested `cause.name` is `OrchestratorProviderSelectionBusyError` (WP-0D); that is `busy`. Never
 * throws: a plugin gets a typed result for every expected outcome.
 */
function switchError(error: unknown): SwitchResult {
  const message = describe(error);
  if (providerSelectionBusyName(error) === "OrchestratorProviderSelectionBusyError") return { status: "busy", message };
  return { status: "error", message, cause: error };
}

function providerSelectionBusyName(error: unknown): string | undefined {
  const e = error as { causeName?: unknown; isProviderSelectionBusy?: unknown; cause?: unknown } | null;
  if (e?.isProviderSelectionBusy === true) return "OrchestratorProviderSelectionBusyError";
  if (typeof e?.causeName === "string") return e.causeName;
  // A plain error (another client implementation, a mock): walk the Effect cause array.
  if (Array.isArray(e?.cause)) {
    for (const entry of e.cause) {
      const name = (entry as { error?: { cause?: { name?: unknown } } } | null)?.error?.cause?.name;
      if (typeof name === "string") return name;
    }
  }
  return undefined;
}

/**
 * `@t3p/api` `ModelSelection` -> the wire `ModelSelection` (contracts `modelSelection.ts`): the
 * field is `instanceId` (not `providerInstanceId`). `options` is passed through unchanged: the
 * server schema accepts both the canonical `[{id, value}]` array and the legacy record form that
 * the API type uses.
 */
function wireSelection(selection: ModelSelection): { instanceId: string; model: string; options?: Record<string, unknown> } {
  const out: { instanceId: string; model: string; options?: Record<string, unknown> } = {
    instanceId: selection.providerInstanceId,
    model: selection.model,
  };
  if (selection.options !== undefined) out.options = selection.options as Record<string, unknown>;
  return out;
}

function assertId(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
}

function assertSelection(selection: ModelSelection): void {
  if (selection === null || typeof selection !== "object") throw new TypeError("selection must be an object");
  assertId(selection.providerInstanceId, "selection.providerInstanceId");
  assertId(selection.model, "selection.model");
}

/** A fresh command id: `crypto.randomUUID()` where available, otherwise a timestamp+random id. */
function newCommandId(): string {
  const crypto = (globalThis as unknown as { crypto?: { randomUUID?: () => string } }).crypto;
  if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
