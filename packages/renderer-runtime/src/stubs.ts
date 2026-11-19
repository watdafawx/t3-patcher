import {
  T3NotImplementedError,
  type T3Commands,
  type T3Internals,
  type T3Keybinds,
  type T3Patches,
  type T3Providers,
  type T3Threads,
  type T3Timeline,
  type T3Ui,
  type T3Usage,
} from "@t3p/api";

/**
 * Namespaces that other work packages implement. They carry the final signatures (see
 * `@t3p/api`) and throw `T3NotImplementedError` naming the owner until then. The throw is
 * synchronous, also for methods that return a promise.
 *
 * To implement one: replace its entry in `createT3` (`t3.ts`) with a real factory.
 */
function stub<T extends object>(namespace: string, owner: string, methods: readonly string[]): T {
  const out: Record<string, () => never> = {};
  for (const method of methods) {
    out[method] = () => {
      throw new T3NotImplementedError(`${namespace}.${method}`, owner);
    };
  }
  return Object.freeze(out) as unknown as T;
}

export const OWNERS = {
  providers: "WP-3B",
  threads: "WP-3B",
  usage: "WP-3B",
  timeline: "WP-3C",
  ui: "WP-3D",
  commands: "WP-3D",
  keybinds: "WP-3D",
  patches: "WP-3D",
  internals: "WP-3D",
} as const;

export const stubs = {
  providers: (): T3Providers => stub("providers", OWNERS.providers, ["list", "get", "limits", "onChange", "refresh"]),
  threads: (): T3Threads => stub("threads", OWNERS.threads, ["list", "current", "projection", "subscribe", "dispatch", "setModel", "switchProvider"]),
  timeline: (): T3Timeline => stub("timeline", OWNERS.timeline, ["list", "subscribe", "enrichFromProviderLog"]),
  usage: (): T3Usage => stub("usage", OWNERS.usage, ["summary", "thread", "context"]),
  ui: (): T3Ui => stub("ui", OWNERS.ui, ["register", "toast", "modal", "themeVars", "dock"]),
  commands: (): T3Commands => stub("commands", OWNERS.commands, ["register", "run", "list"]),
  keybinds: (): T3Keybinds => stub("keybinds", OWNERS.keybinds, ["register", "list"]),
  patches: (): T3Patches => stub("patches", OWNERS.patches, ["register"]),
  internals: (): T3Internals => stub("internals", OWNERS.internals, ["get", "status"]),
};
