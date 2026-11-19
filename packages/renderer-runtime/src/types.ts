import type { PermissionJson, PermissionSet, T3LogLevel } from "@t3p/api";

/** The preload bridge (`window.__t3p_native`). */
export interface NativeBridgeLike {
  readonly version: string;
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  on(channel: string, callback: (payload: unknown) => void): () => void;
}

/** One row of `t3p:plugins:list`. Fields added after WP-2 are optional so older mains still work. */
export interface PluginListEntry {
  id: string;
  name?: string | null;
  version?: string | null;
  tier?: number | null;
  /** Host status: disabled, invalid, incompatible, active, failed, loaded. */
  status: string;
  /** declared AND granted, as the main process computed it. */
  effective?: PermissionSet;
  declared?: PermissionJson[];
  errors?: string[];
  rendererUrl: string | null;
  restartRequired?: boolean;
  /** `crash-loop` when the crash-loop guard disabled the plugin. */
  disabledReason?: string | null;
}

export interface PluginsListResponse {
  plugins?: PluginListEntry[];
  dev?: boolean;
}

/** The slice of upstream's `window.desktopBridge` the runtime uses. */
export interface DesktopBridgeLike {
  getLocalEnvironmentBearerToken(): Promise<string>;
  getLocalEnvironmentBootstraps(): Promise<unknown>;
}

export type RemoteLog = (level: T3LogLevel, message: string, plugin?: string) => void;

export type Listener = (payload: unknown) => void;

export interface EventBus {
  on(name: string, fn: Listener): () => void;
  emit(name: string, payload?: unknown): void;
}
