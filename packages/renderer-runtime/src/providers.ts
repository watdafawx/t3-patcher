import { type ProviderSnapshot, type ProviderUsageLimits, type T3Providers, type Unsubscribe } from "@t3p/api";

import { type RpcClientLike, requireRpc, type SharedRpc } from "./rpc.js";
import type { Scope } from "./scope.js";
import type { RemoteLog } from "./types.js";

/**
 * The provider cache. ONE per renderer: it is keyed by the shared RPC client, so every plugin
 * (`t3.providers`) of the page reads the same list from the same `subscribeServerConfig` stream.
 *
 * - `list()` calls `server.getConfig` once, then starts the config stream on first use.
 * - Stream items that carry providers (`snapshot`, `providerStatuses`, `providerStatusDeltas`)
 *   replace/merge the cache and notify listeners with the full list.
 * - `refresh()` calls `server.refreshProviders` and replaces the cache with its answer.
 */
export class ProviderStore {
  #providers: ProviderSnapshot[] = [];
  #loaded = false;
  #ready: Promise<RpcClientLike> | null = null;
  #stream: { cancel(): void; done: Promise<void> } | null = null;
  readonly #listeners = new Set<(providers: ProviderSnapshot[]) => void>();

  constructor(
    private readonly shared: SharedRpc,
    private readonly log: RemoteLog,
  ) {}

  /** Cached providers, loading them on first use. The array is a copy; the entries are wire objects. */
  async list(): Promise<ProviderSnapshot[]> {
    await this.#ensure();
    return [...this.#providers];
  }

  async get(instanceId: string): Promise<ProviderSnapshot | undefined> {
    const providers = await this.list();
    return providers.find((p) => p.instanceId === instanceId);
  }

  /**
   * `usageLimits` of one instance as the server reports it, or `undefined` when the provider
   * reports none (absent on the wire). A provider that cannot measure reports an object with
   * `windows: []` and `unavailable: { reason }`; that object is returned as-is.
   */
  async limits(instanceId: string): Promise<ProviderUsageLimits | undefined> {
    const provider = await this.get(instanceId);
    return provider?.usageLimits;
  }

  /** Fires with the full list after a stream update or `refresh()`. Not on the first load. */
  onChange(callback: (providers: ProviderSnapshot[]) => void): Unsubscribe {
    if (typeof callback !== "function") throw new TypeError("callback must be a function");
    this.#listeners.add(callback);
    void this.#ensure().catch((error: unknown) => {
      this.log("warn", `providers: initial load failed: ${describe(error)}`);
    });
    return () => void this.#listeners.delete(callback);
  }

  /**
   * Re-probes providers through the server (`server.refreshProviders`), updates the cache and
   * returns the new list. `instanceId` limits the probe to one instance; the answer still holds
   * every provider.
   */
  async refresh(options: { instanceId?: string } = {}): Promise<ProviderSnapshot[]> {
    const client = await this.#ensure();
    const payload = options.instanceId === undefined ? {} : { instanceId: options.instanceId };
    const answer = (await client.call("server.refreshProviders", payload)) as { providers?: ProviderSnapshot[] } | null;
    if (Array.isArray(answer?.providers)) {
      this.#replace(answer.providers);
      this.#notify();
    } else {
      const config = (await client.call("server.getConfig", {})) as { providers?: ProviderSnapshot[] } | null;
      if (Array.isArray(config?.providers)) this.#replace(config.providers);
    }
    return [...this.#providers];
  }

  // ---- internals ---------------------------------------------------------------------------

  /** Loads the cache once and keeps the stream live. A failure (or a dead stream) retries. */
  #ensure(): Promise<RpcClientLike> {
    if (!this.#ready) {
      const attempt = this.#start().catch((error: unknown) => {
        if (this.#ready === attempt) this.#ready = null;
        throw error;
      });
      this.#ready = attempt;
    }
    return this.#ready;
  }

  async #start(): Promise<RpcClientLike> {
    const { client } = await this.shared.ready();
    if (!this.#loaded) {
      const config = (await client.call("server.getConfig", {})) as { providers?: ProviderSnapshot[] } | null;
      this.#replace(config?.providers ?? []);
      this.#loaded = true;
    }
    this.#subscribe(client);
    return client;
  }

  #subscribe(client: RpcClientLike): void {
    if (this.#stream) return;
    // Flags the app itself sends for live limits (WP-0D "subscribeServerConfig"). The snapshot
    // carries the full config; later `providerStatuses` / `providerStatusDeltas` carry changes.
    const sub = client.subscribe(
      "subscribeServerConfig",
      { usageLimitSources: true, usageLimitsCommand: true },
      (item) => this.#onItem(item),
      { onError: (error) => this.log("warn", `providers: config stream ended: ${describe(error)}`) },
    );
    this.#stream = sub;
    const clear = (): void => {
      if (this.#stream !== sub) return;
      this.#stream = null;
      // The next list()/onChange()/refresh() resubscribes (e.g. after the client was recreated).
      this.#ready = null;
    };
    void sub.done.then(clear, clear);
  }

  #onItem(item: unknown): void {
    const event = item as { type?: unknown; config?: { providers?: ProviderSnapshot[] }; payload?: { providers?: unknown[] } } | null;
    if (!event || typeof event.type !== "string") return;
    switch (event.type) {
      case "snapshot": {
        const providers = event.config?.providers;
        if (Array.isArray(providers)) this.#apply(providers);
        return;
      }
      case "providerStatuses": {
        const providers = event.payload?.providers;
        if (Array.isArray(providers)) this.#apply(providers as ProviderSnapshot[]);
        return;
      }
      case "providerStatusDeltas": {
        const deltas = event.payload?.providers;
        if (Array.isArray(deltas)) this.#apply(this.#mergeDeltas(deltas as Array<Partial<ProviderSnapshot>>));
        return;
      }
      default:
        // keybindingsUpdated, settingsUpdated, environmentThemesUpdated, usageLimitSourcesUpdated
        return;
    }
  }

  #apply(providers: ProviderSnapshot[]): void {
    this.#replace(providers);
    this.#loaded = true;
    this.#notify();
  }

  /**
   * `providerStatusDeltas.providers` is every provider in order, with the lists (`models`,
   * `slashCommands`, `skills`) left out when the client already holds them. Merge by
   * `instanceId`; a provider this client never saw starts with empty lists.
   */
  #mergeDeltas(deltas: Array<Partial<ProviderSnapshot>>): ProviderSnapshot[] {
    const previous = new Map(this.#providers.map((p) => [p.instanceId, p]));
    return deltas.map((delta) => {
      const id = typeof delta.instanceId === "string" ? delta.instanceId : "";
      const base = previous.get(id);
      const merged = { ...(base ?? {}), ...delta } as ProviderSnapshot;
      return {
        ...merged,
        models: Array.isArray(delta.models) ? delta.models : (base?.models ?? []),
        slashCommands: Array.isArray(delta.slashCommands) ? delta.slashCommands : (base?.slashCommands ?? []),
        skills: Array.isArray(delta.skills) ? delta.skills : (base?.skills ?? []),
      };
    });
  }

  #replace(providers: ProviderSnapshot[]): void {
    this.#providers = [...providers];
  }

  #notify(): void {
    const list = [...this.#providers];
    for (const cb of [...this.#listeners]) {
      try {
        cb(list);
      } catch (error) {
        this.log("warn", `providers: onChange listener failed: ${describe(error)}`);
      }
    }
  }
}

const stores = new WeakMap<SharedRpc, ProviderStore>();

/** The shared provider store of one renderer (keyed by the one shared RPC client). */
export function providerStore(shared: SharedRpc, log: RemoteLog): ProviderStore {
  let store = stores.get(shared);
  if (!store) {
    store = new ProviderStore(shared, log);
    stores.set(shared, store);
  }
  return store;
}

/** `t3.providers` for one plugin. Needs the `rpc` permission (the same one `t3.rpc` needs). */
export function createProvidersApi(id: string, allowed: boolean, shared: SharedRpc, scope: Scope, log: RemoteLog): T3Providers {
  const store = providerStore(shared, log);
  const need = (): void => {
    requireRpc(id, allowed);
    scope.assertAlive();
  };
  return Object.freeze({
    async list(): Promise<ProviderSnapshot[]> {
      need();
      return store.list();
    },
    async get(instanceId: string): Promise<ProviderSnapshot | undefined> {
      need();
      if (typeof instanceId !== "string" || instanceId.length === 0) throw new TypeError("instanceId must be a non-empty string");
      return store.get(instanceId);
    },
    async limits(instanceId: string): Promise<ProviderUsageLimits | undefined> {
      need();
      if (typeof instanceId !== "string" || instanceId.length === 0) throw new TypeError("instanceId must be a non-empty string");
      return store.limits(instanceId);
    },
    onChange(callback: (providers: ProviderSnapshot[]) => void): Unsubscribe {
      need();
      return scope.add(store.onChange(callback));
    },
    async refresh(options?: { instanceId?: string }): Promise<ProviderSnapshot[]> {
      need();
      if (options !== undefined && (options === null || typeof options !== "object")) throw new TypeError("options must be an object");
      return store.refresh(options ?? {});
    },
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
