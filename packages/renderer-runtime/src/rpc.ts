import { T3PermissionError, type T3Rpc, type T3RpcSubscribeOptions, type T3RpcSubscription } from "@t3p/api";
import { RpcClient, type RpcClientOptions, type RpcClientState, type RpcMethods, type RpcStreams } from "@t3p/rpc-client";

import type { Scope } from "./scope.js";
import type { DesktopBridgeLike, RemoteLog } from "./types.js";

/** The slice of RpcClient the runtime uses (a test seam). */
export interface RpcClientLike {
  readonly state: RpcClientState;
  onState(cb: (s: RpcClientState) => void): () => void;
  connect(): Promise<void>;
  call(method: string, payload: unknown): Promise<unknown>;
  subscribe(
    method: string,
    payload: unknown,
    onItem: (item: unknown) => void,
    opts?: { onError?: (e: Error) => void; resume?: (last: unknown, payload: unknown) => unknown },
  ): { cancel(): void; done: Promise<void> };
}

export interface SharedRpcDeps {
  bridge: DesktopBridgeLike | null;
  log: RemoteLog;
  createClient?: (opts: RpcClientOptions) => RpcClientLike;
  fetch?: typeof fetch;
  /** The T3 server may still be starting when plugins load: connect is retried. Default 20 x 500 ms. */
  connect?: { attempts: number; delayMs: number };
}

function pickBase(value: unknown): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  const url = (first as { httpBaseUrl?: unknown } | null | undefined)?.httpBaseUrl;
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url.replace(/\/+$/, "") : null;
}

/**
 * ONE RpcClient per renderer, shared by every plugin. It is created on first use from the
 * desktop bridge: base URL from `getLocalEnvironmentBootstraps()`, bearer from
 * `getLocalEnvironmentBearerToken()` (a fresh ws ticket per (re)connect, PLAN 4a).
 */
export class SharedRpc {
  #client: RpcClientLike | null = null;
  #starting: Promise<{ client: RpcClientLike; base: string }> | null = null;
  readonly #stateListeners = new Set<(s: RpcClientState) => void>();
  #base = "";

  constructor(private readonly deps: SharedRpcDeps) {}

  get state(): RpcClientState {
    return this.#client?.state ?? "idle";
  }

  /** `{id, label}` of the local environment from the desktop bridge (not the server), or `null`. Never throws. */
  async localEnvironment(): Promise<{ id: string | null; label: string | null } | null> {
    try {
      const value = await this.deps.bridge?.getLocalEnvironmentBootstraps();
      const first = (Array.isArray(value) ? value[0] : value) as { id?: unknown; label?: unknown } | null | undefined;
      if (!first || typeof first !== "object") return null;
      return { id: typeof first.id === "string" && first.id ? first.id : null, label: typeof first.label === "string" && first.label ? first.label : null };
    } catch {
      return null;
    }
  }

  get created(): boolean {
    return this.#client !== null;
  }

  onState(cb: (s: RpcClientState) => void): () => void {
    this.#stateListeners.add(cb);
    return () => void this.#stateListeners.delete(cb);
  }

  /** Creates the client once (shared), then connects it. A failed connect can be retried. */
  ready(): Promise<{ client: RpcClientLike; base: string }> {
    if (this.#starting) return this.#starting;
    const attempt = (async () => {
      const bridge = this.deps.bridge;
      if (!bridge) throw new Error("t3.rpc: window.desktopBridge is not available");
      if (!this.#client) {
        const base = pickBase(await bridge.getLocalEnvironmentBootstraps());
        if (!base) throw new Error("t3.rpc: could not find the local server URL (getLocalEnvironmentBootstraps)");
        this.#base = base;
        const options: RpcClientOptions = {
          httpBaseUrl: base,
          getBearer: () => bridge.getLocalEnvironmentBearerToken(),
          fetch: this.fetch,
        };
        const client = this.deps.createClient ? this.deps.createClient(options) : (new RpcClient(options) as unknown as RpcClientLike);
        client.onState((s) => {
          for (const cb of [...this.#stateListeners]) {
            try {
              cb(s);
            } catch {
              // listener errors never break the client
            }
          }
        });
        this.#client = client;
      }
      const { attempts, delayMs } = this.deps.connect ?? { attempts: 20, delayMs: 500 };
      for (let i = 1; ; i++) {
        try {
          await this.#client.connect();
          break;
        } catch (e) {
          if (i >= attempts) throw e;
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
      return { client: this.#client, base: this.#base };
    })();
    this.#starting = attempt;
    attempt.catch(() => {
      if (this.#starting === attempt) this.#starting = null;
    });
    // A closed client (server restart, failed first connect) is recreated on the next ready().
    void attempt.then(({ client }) => {
      client.onState((s) => {
        if (s === "closed" && this.#starting === attempt) this.#starting = null;
      });
    }, () => undefined);
    return attempt;
  }

  async bearer(): Promise<string> {
    const bridge = this.deps.bridge;
    if (!bridge) throw new Error("t3.rpc: window.desktopBridge is not available");
    return bridge.getLocalEnvironmentBearerToken();
  }

  get fetch(): typeof fetch {
    return this.deps.fetch ?? (((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)) as typeof fetch);
  }
}

/**
 * Throws {@link T3PermissionError} unless the plugin holds `rpc`. `t3.rpc` and the data services
 * built on it (`t3.providers`, `t3.threads`, `t3.usage`) share this gate.
 */
export function requireRpc(id: string, allowed: boolean): void {
  if (!allowed) {
    throw new T3PermissionError(id, "rpc", `declare "rpc" in plugin.json and grant it (t3p grant ${id} rpc)`);
  }
}

/** `t3.rpc` for one plugin. `allowed` is true when `rpc` is declared AND granted. */
export function createRpcApi(id: string, allowed: boolean, shared: SharedRpc, scope: Scope, log: RemoteLog): T3Rpc {
  const need = (): void => requireRpc(id, allowed);
  return Object.freeze({
    async call<M extends keyof RpcMethods & string>(method: M, payload: RpcMethods[M]["payload"]): Promise<RpcMethods[M]["result"]> {
      need();
      scope.assertAlive();
      if (typeof method !== "string" || method.length === 0) throw new TypeError("method must be a non-empty string");
      const { client } = await shared.ready();
      return (await client.call(method, payload)) as RpcMethods[M]["result"];
    },
    subscribe<M extends keyof RpcStreams & string>(
      method: M,
      payload: RpcStreams[M]["payload"],
      onItem: (item: RpcStreams[M]["item"]) => void,
      options: T3RpcSubscribeOptions<RpcStreams[M]["payload"], RpcStreams[M]["item"]> = {},
    ): T3RpcSubscription {
      need();
      scope.assertAlive();
      if (typeof onItem !== "function") throw new TypeError("onItem must be a function");
      let cancelled = false;
      let inner: { cancel(): void; done: Promise<void> } | null = null;
      let finish!: () => void;
      const done = new Promise<void>((r) => (finish = r));
      const cancel = (): void => {
        if (cancelled) return;
        cancelled = true;
        remove();
        inner?.cancel();
        finish();
      };
      const remove = scope.add(cancel);
      void shared.ready().then(
        ({ client }) => {
          if (cancelled) return;
          inner = client.subscribe(method, payload, onItem as (item: unknown) => void, {
            onError: (e) => options.onError?.(e),
            ...(options.resume ? { resume: (last, p) => options.resume!(last as never, p as never) } : {}),
          });
          void inner.done.then(finish);
        },
        (error: unknown) => {
          log("warn", `rpc subscribe ${method} failed: ${String(error)}`, id);
          if (!cancelled) options.onError?.(error instanceof Error ? error : new Error(String(error)));
          finish();
        },
      );
      return { cancel, done };
    },
    async http(path: string, init: RequestInit = {}): Promise<Response> {
      need();
      scope.assertAlive();
      if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
        throw new TypeError('t3.rpc.http: path must start with a single "/" (absolute URLs are refused)');
      }
      const { base } = await shared.ready();
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${await shared.bearer()}`);
      return shared.fetch(`${base}${path}`, { ...init, headers });
    },
    get state(): RpcClientState {
      requireRpc(id, allowed);
      return shared.state;
    },
    onState(callback: (state: RpcClientState) => void): () => void {
      need();
      return scope.add(shared.onState(callback));
    },
  });
}
