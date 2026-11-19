import type { JsonValue, T3EventBus, T3EventMap, T3Events } from "@t3p/api";

import type { Scope } from "./scope.js";
import type { EventBus, Listener } from "./types.js";

export function createEventBus(onError: (error: unknown) => void): EventBus {
  const map = new Map<string, Set<Listener>>();
  return Object.freeze({
    on(name: string, fn: Listener): () => void {
      if (typeof fn !== "function") throw new Error("listener must be a function");
      const set = map.get(name) ?? new Set<Listener>();
      set.add(fn);
      map.set(name, set);
      return () => void set.delete(fn);
    },
    emit(name: string, payload?: unknown): void {
      for (const fn of [...(map.get(name) ?? [])]) {
        try {
          fn(payload);
        } catch (error) {
          onError(error);
        }
      }
    },
  });
}

const BUS_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*$/;

/**
 * `t3.events` for one plugin.
 * - `systemBus` carries lifecycle events (`app:ready`, `plugin:started`, ...).
 * - `pluginBus` is keyed `<plugin id>:<name>` and also receives events main-side plugins emit
 *   (`ctx.events.emit`, arriving as `t3p:plugin-event`). A plugin can only emit as itself.
 */
export function createEventsApi(id: string, systemBus: EventBus, pluginBus: EventBus, scope: Scope): T3Events {
  const bus: T3EventBus = Object.freeze({
    emit(name: string, payload?: JsonValue): void {
      scope.assertAlive();
      if (typeof name !== "string" || !BUS_NAME_RE.test(name)) throw new Error(`invalid event name ${JSON.stringify(name)}`);
      pluginBus.emit(`${id}:${name}`, payload);
    },
    on(name: string, callback: (payload: unknown) => void): () => void {
      if (typeof name !== "string" || !BUS_NAME_RE.test(name)) throw new Error(`invalid event name ${JSON.stringify(name)}`);
      return scope.add(pluginBus.on(`${id}:${name}`, callback));
    },
    onFrom(pluginId: string, name: string, callback: (payload: unknown) => void): () => void {
      if (typeof pluginId !== "string" || !PLUGIN_ID_RE.test(pluginId)) throw new Error(`invalid plugin id ${JSON.stringify(pluginId)}`);
      if (typeof name !== "string" || !BUS_NAME_RE.test(name)) throw new Error(`invalid event name ${JSON.stringify(name)}`);
      return scope.add(pluginBus.on(`${pluginId}:${name}`, callback));
    },
  });
  return Object.freeze({
    on<K extends keyof T3EventMap>(name: K, callback: (payload: T3EventMap[K]) => void): () => void {
      return scope.add(systemBus.on(name, callback as Listener));
    },
    bus,
  });
}
