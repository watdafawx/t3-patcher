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

export function isAllowedInvokeChannel(channel: unknown): channel is string {
  if (typeof channel !== "string" || channel.length > 160) return false;
  return (INVOKE_CHANNELS as readonly string[]).includes(channel) || PLUGIN_CHANNEL_RE.test(channel);
}

export function isAllowedEventChannel(channel: unknown): channel is EventChannel {
  return typeof channel === "string" && (EVENT_CHANNELS as readonly string[]).includes(channel);
}
