import type { T3Environment, T3EnvironmentInfo } from "@t3p/api";

import type { SharedRpc } from "./rpc.js";
import { environmentIdFromLocation, type ThreadRouteLocation } from "./threads.js";

export interface EnvironmentDeps {
  shared: Pick<SharedRpc, "localEnvironment">;
  /** The window location (a test seam). Default: the real `window.location`. */
  location?: () => ThreadRouteLocation | null;
}

/**
 * `t3.environment`. The id comes from the route (`#/<environmentId>/<threadId>`), else from the
 * local environment the desktop bridge reports. The label exists only for the local environment
 * (bridge `getLocalEnvironmentBootstraps()`, read once asynchronously when the plugin starts), so
 * it is `null` while that read is pending and when the route points at another environment.
 */
export function createEnvironmentApi(deps: EnvironmentDeps): T3Environment {
  let local: { id: string | null; label: string | null } | null = null;
  void deps.shared.localEnvironment().then((value) => {
    local = value;
  });
  const location = deps.location ?? ((): ThreadRouteLocation | null => (globalThis as unknown as { window?: { location: ThreadRouteLocation } }).window?.location ?? null);
  return Object.freeze({
    current(): T3EnvironmentInfo {
      const routeId = environmentIdFromLocation(location() ?? {});
      const id = routeId ?? local?.id ?? null;
      const label = local && id !== null && id === local.id ? local.label : null;
      return { id, label };
    },
  });
}
