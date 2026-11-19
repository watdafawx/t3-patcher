import { type JsonValue, type PermissionSet, T3PermissionError, type T3Native } from "@t3p/api";

import type { Scope } from "./scope.js";
import type { NativeBridgeLike } from "./types.js";

/**
 * `t3.native` for one plugin: a typed wrapper over `window.__t3p_native.invoke`.
 *
 * Every call is checked against the plugin's EFFECTIVE permissions (declared AND granted, as the
 * main process computed them) before it is sent, and the main process checks them again with the
 * plugin id attached. The id is always this plugin's own (a `plugin` key in a request is overwritten).
 * Attribution, not isolation: docs/security.md section 4.5.
 */
export function createNativeApi(id: string, effective: PermissionSet, native: NativeBridgeLike | null, scope: Scope): T3Native {
  const call = async <T>(channel: string, permission: string, granted: boolean, request: object): Promise<T> => {
    scope.assertAlive();
    if (!granted) throw new T3PermissionError(id, permission, `declare it in plugin.json and grant it (t3p grant ${id} ${permission})`);
    if (!native) throw new Error("t3.native: window.__t3p_native is not available (preload missing)");
    if (!request || typeof request !== "object") throw new TypeError("request must be an object");
    return (await native.invoke(channel, { ...request, plugin: id })) as T;
  };
  const api: T3Native = {
    fsRead: (request) => call("t3p:native:fs.read", "fs.read", effective["fs.read"] !== undefined, request),
    sqliteQuery: (request) => call("t3p:native:sqlite.query", "sqlite.read", effective["sqlite.read"] !== undefined, request),
    logTail: (request) => call("t3p:native:log.tail", "log.tail", effective["log.tail"] !== undefined, request),
    spawn: (request) => call("t3p:native:spawn", "spawn", effective.spawn !== undefined, request),
    async invoke<T = unknown>(name: string, payload?: JsonValue): Promise<T> {
      scope.assertAlive();
      if (!effective.main) throw new T3PermissionError(id, "main", "this plugin has no main-process entry");
      if (!native) throw new Error("t3.native: window.__t3p_native is not available (preload missing)");
      if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw new TypeError("invalid handler name");
      return (await native.invoke(`t3p:plugin:${id}:${name}`, payload)) as T;
    },
  };
  return Object.freeze(api);
}
