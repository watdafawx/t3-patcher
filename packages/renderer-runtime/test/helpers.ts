import type { PermissionSet } from "@t3p/api";
import { vi } from "vitest";

import type { BootstrapEnv } from "../src/runtime.js";
import type { NativeBridgeLike, PluginListEntry } from "../src/types.js";

export interface FakeNative extends NativeBridgeLike {
  calls: Array<[string, unknown]>;
  /** Fires a pushed event (t3p:event, t3p:plugin-event). */
  push(channel: string, payload: unknown): void;
  entries: PluginListEntry[];
  storage: Map<string, { kv: Record<string, unknown>; settings: Record<string, unknown> }>;
  dev: boolean;
  limitBytes: number;
  failStorage: boolean;
}

export function entry(id: string, extra: Partial<PluginListEntry> = {}): PluginListEntry {
  return { id, status: "loaded", rendererUrl: `t3code://app/__t3p/plugins/${id}/r.js`, effective: {}, ...extra };
}

/** In-memory stand-in for window.__t3p_native with a working plugin list, storage and enable/disable. */
export function fakeNative(entries: PluginListEntry[], opts: { dev?: boolean; limitBytes?: number } = {}): FakeNative {
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const native: FakeNative = {
    version: "0.1.0",
    calls: [],
    entries,
    storage: new Map(),
    dev: opts.dev ?? false,
    limitBytes: opts.limitBytes ?? 1024 * 1024,
    failStorage: false,
    push(channel, payload) {
      for (const fn of [...(listeners.get(channel) ?? [])]) fn(payload);
    },
    on(channel, cb) {
      const set = listeners.get(channel) ?? new Set();
      set.add(cb);
      listeners.set(channel, set);
      return () => void set.delete(cb);
    },
    invoke: vi.fn(async (channel: string, payload?: unknown) => {
      native.calls.push([channel, payload]);
      const p = (payload ?? {}) as Record<string, unknown>;
      if (channel === "t3p:plugins:list") return { plugins: native.entries, dev: native.dev };
      if (channel === "t3p:plugins:set-enabled") {
        const e = native.entries.find((x) => x.id === p.id);
        if (!e) throw new Error("t3p: unknown or invalid plugin");
        if (p.enabled) {
          e.status = "loaded";
          e.rendererUrl = `t3code://app/__t3p/plugins/${e.id}/r.js`;
          if (p.grantRpc) e.effective = { ...e.effective, rpc: true } as PermissionSet;
        } else {
          e.status = "disabled";
          e.rendererUrl = null;
        }
        return { status: e.status, restartRequired: false };
      }
      if (channel === "t3p:plugins:set-load-order") return { order: p.order };
      if (channel === "t3p:storage:read" || channel === "t3p:storage:write") {
        if (native.failStorage) throw new Error("t3p: storage broke");
        const id = p.plugin as string;
        const data = native.storage.get(id) ?? { kv: {}, settings: {} };
        native.storage.set(id, data);
        if (channel === "t3p:storage:write") {
          const area = data[p.area as "kv" | "settings"];
          const next = { ...area };
          if (p.op === "clear") for (const k of Object.keys(next)) delete next[k];
          else if (p.op === "delete") delete next[p.key as string];
          else next[p.key as string] = p.value;
          if (p.op === "set" && JSON.stringify(next).length > native.limitBytes) throw new Error("t3p: storage quota exceeded (x > y bytes)");
          data[p.area as "kv" | "settings"] = next;
        }
        return { kv: { ...data.kv }, settings: { ...data.settings }, usedBytes: JSON.stringify(data).length, limitBytes: native.limitBytes };
      }
      return { ok: true };
    }),
  };
  return native;
}

export interface ModuleMap {
  [urlPrefix: string]: Record<string, unknown> | (() => Record<string, unknown> | Promise<Record<string, unknown>>);
}

/** `importModule` serving modules by plugin id (matches `/plugins/<id>/`); records every URL. */
export function fakeImporter(modules: ModuleMap) {
  const urls: string[] = [];
  const importModule = async (url: string): Promise<Record<string, unknown>> => {
    urls.push(url);
    const id = /\/plugins\/([^/]+)\//.exec(url)?.[1] ?? "";
    const m = modules[id];
    if (!m) throw new Error(`no module for ${url}`);
    return typeof m === "function" ? await m() : m;
  };
  return { importModule, urls };
}

export function envFor(
  native: NativeBridgeLike | null,
  importModule: BootstrapEnv["importModule"],
  extra: Partial<BootstrapEnv> = {},
): BootstrapEnv & { errors: unknown[][] } {
  const errors: unknown[][] = [];
  return {
    win: {},
    native,
    now: () => 1,
    importModule,
    consoleError: (...args: unknown[]) => void errors.push(args),
    errors,
    ...extra,
  };
}
