/**
 * IPC channel names between the preload (`window.__t3p_native`) and the main runtime.
 * Every channel starts with `t3p:`. The preload only forwards channels that pass
 * {@link isAllowedInvokeChannel}; the main process checks the sender on every call.
 */

export const IPC_PREFIX = "t3p:";

/** Fixed invoke channels. */
export const INVOKE_CHANNELS = [
  "t3p:ping",
  "t3p:log",
  "t3p:plugins:list",
  "t3p:plugins:set-enabled",
  "t3p:plugins:set-load-order",
  "t3p:plugins:revoke",
  "t3p:plugin-health",
  "t3p:storage:read",
  "t3p:storage:write",
  "t3p:native:fs.read",
  "t3p:native:sqlite.query",
  "t3p:native:log.tail",
  "t3p:native:spawn",
  "t3p:internals:report",
  "t3p:patches:register",
  "t3p:patches:unregister",
  "t3p:guard:register",
  "t3p:guard:unregister",
  "t3p:guard:answer",
] as const;
export type InvokeChannel = (typeof INVOKE_CHANNELS)[number];

/** Main -> renderer push channels the preload lets the page subscribe to. */
export const EVENT_CHANNELS = ["t3p:event", "t3p:plugin-event"] as const;
export type EventChannel = (typeof EVENT_CHANNELS)[number];

/** `t3p:plugin:<plugin id>:<name>`, registered by a main-side plugin through ctx.ipc.handle. */
export const PLUGIN_CHANNEL_RE = /^t3p:plugin:[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const PLUGIN_CHANNEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function pluginChannel(pluginId: string, name: string): string {
  return `t3p:plugin:${pluginId}:${name}`;
}

/**
 * Privileged channels: registered by the main runtime but NOT in the page bridge's allowlist, so
 * `window.__t3p_native.invoke` refuses them and no page script (plugin or runtime) can send them.
 * Only the preload's isolated world calls them, from its own listener for trusted user clicks
 * (docs/security.md section 4.6).
 */
export const PRIVILEGED_PREFIX = "t3p:privileged:";
/** Ask the main process to show the native grant dialog: `{ id, permissions: string[] | "*" }`. */
export const GRANT_REQUEST_CHANNEL = "t3p:privileged:grant-request";
export const PRIVILEGED_CHANNELS = [GRANT_REQUEST_CHANNEL] as const;

/** DOM attributes the preload's trusted-click listener reads (on the Plugins page's Grant buttons). */
export const GRANT_ATTR = "data-t3p-grant-request";
export const GRANT_PERMS_ATTR = "data-t3p-grant-perms";

export function isPrivilegedChannel(channel: unknown): channel is string {
  return typeof channel === "string" && (PRIVILEGED_CHANNELS as readonly string[]).includes(channel);
}

export function isAllowedInvokeChannel(channel: unknown): channel is string {
  if (typeof channel !== "string" || channel.length > 160) return false;
  if (channel.startsWith(PRIVILEGED_PREFIX)) return false;
  return (INVOKE_CHANNELS as readonly string[]).includes(channel) || PLUGIN_CHANNEL_RE.test(channel);
}

export function isAllowedEventChannel(channel: unknown): channel is EventChannel {
  return typeof channel === "string" && (EVENT_CHANNELS as readonly string[]).includes(channel);
}
