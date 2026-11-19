import {
  type JsonValue,
  type SettingChange,
  type SettingSchema,
  type SettingValue,
  T3QuotaError,
  type T3Settings,
  type T3Storage,
} from "@t3p/api";

import type { Scope } from "./scope.js";
import type { NativeBridgeLike, RemoteLog } from "./types.js";

interface Snapshot {
  kv: Record<string, unknown>;
  settings: Record<string, unknown>;
  usedBytes: number;
  limitBytes: number;
}

const DEFAULT_LIMIT = 1024 * 1024;

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/**
 * One plugin's persisted data (`t3.storage` and `t3.settings`). It outlives plugin reloads: the
 * cache stays, only the per-load registrations are disposed. Reads come from memory after the
 * first load; every write goes to the main process first (`t3p:storage:write`) and the cache
 * follows the answer. Writes of one plugin are serialized.
 *
 * Without the native bridge, or when the first read fails, data is memory-only (logged once).
 */
export class PluginData {
  #snapshot: Snapshot = { kv: {}, settings: {}, usedBytes: 2, limitBytes: DEFAULT_LIMIT };
  #loading: Promise<void> | null = null;
  #chain: Promise<unknown> = Promise.resolve();
  degraded = false;
  readonly schemas = new Map<string, SettingSchema>();
  readonly listeners = new Set<(change: SettingChange) => void>();

  constructor(
    readonly id: string,
    private readonly native: NativeBridgeLike | null,
    private readonly log: RemoteLog,
  ) {
    if (!native) this.degraded = true;
  }

  /** Loads the persisted data once. Never rejects. */
  load(): Promise<void> {
    if (this.#loading) return this.#loading;
    this.#loading = (async () => {
      if (!this.native) return;
      try {
        const snap = (await this.native.invoke("t3p:storage:read", { plugin: this.id })) as Snapshot;
        this.#snapshot = { kv: snap.kv ?? {}, settings: snap.settings ?? {}, usedBytes: snap.usedBytes, limitBytes: snap.limitBytes };
      } catch (error) {
        this.degraded = true;
        this.log("warn", `storage unavailable, using memory only: ${String(error)}`, this.id);
      }
    })();
    return this.#loading;
  }

  get kv(): Record<string, unknown> {
    return this.#snapshot.kv;
  }

  get settingsValues(): Record<string, unknown> {
    return this.#snapshot.settings;
  }

  get usage(): { usedBytes: number; limitBytes: number } {
    return { usedBytes: this.#snapshot.usedBytes, limitBytes: this.#snapshot.limitBytes };
  }

  /** Persists one operation, then updates the cache. */
  write(op: { area: "kv" | "settings"; op: "set" | "delete" | "clear"; key?: string; value?: unknown }): Promise<void> {
    const run = async (): Promise<void> => {
      await this.load();
      if (!this.native || this.degraded) {
        this.#applyLocal(op);
        return;
      }
      try {
        const snap = (await this.native.invoke("t3p:storage:write", { plugin: this.id, ...op })) as Snapshot;
        this.#snapshot = { kv: snap.kv ?? {}, settings: snap.settings ?? {}, usedBytes: snap.usedBytes, limitBytes: snap.limitBytes };
      } catch (error) {
        if (/quota/i.test(String(error))) throw new T3QuotaError(this.id, this.#snapshot.limitBytes);
        throw error;
      }
    };
    const result = this.#chain.then(run, run);
    this.#chain = result.catch(() => undefined);
    return result;
  }

  #applyLocal(op: { area: "kv" | "settings"; op: string; key?: string; value?: unknown }): void {
    const bucket = op.area === "kv" ? this.#snapshot.kv : this.#snapshot.settings;
    if (op.op === "clear") for (const k of Object.keys(bucket)) delete bucket[k];
    else if (op.op === "delete" && op.key !== undefined) delete bucket[op.key];
    else if (op.op === "set" && op.key !== undefined) bucket[op.key] = clone(op.value);
  }
}

/** `t3.storage` for one plugin. */
export function createStorageApi(data: PluginData, scope: Scope): T3Storage {
  return Object.freeze({
    async get<T extends JsonValue = JsonValue>(key: string): Promise<T | undefined> {
      await data.load();
      return Object.hasOwn(data.kv, key) ? clone(data.kv[key] as T) : undefined;
    },
    async set(key: string, value: JsonValue): Promise<void> {
      scope.assertAlive();
      if (typeof key !== "string" || key.length === 0) throw new TypeError("storage key must be a non-empty string");
      if (value === undefined) throw new TypeError("storage value must not be undefined (use delete)");
      await data.write({ area: "kv", op: "set", key, value });
    },
    async delete(key: string): Promise<void> {
      scope.assertAlive();
      await data.write({ area: "kv", op: "delete", key });
    },
    async keys(): Promise<string[]> {
      await data.load();
      return Object.keys(data.kv).sort();
    },
    async clear(): Promise<void> {
      scope.assertAlive();
      await data.write({ area: "kv", op: "clear" });
    },
    async usage(): Promise<{ usedBytes: number; limitBytes: number }> {
      await data.load();
      return data.usage;
    },
  });
}

// --- settings -------------------------------------------------------------------------------

/** Returns an error message for an invalid schema, or null. */
export function checkSchema(schema: unknown): string | null {
  if (!schema || typeof schema !== "object") return "schema must be an object";
  const s = schema as Record<string, unknown>;
  if (typeof s.key !== "string" || s.key.length === 0 || s.key.length > 128 || s.key === "__proto__") return "key must be a non-empty string (max 128)";
  if (typeof s.label !== "string" || s.label.length === 0) return `setting ${s.key}: label is required`;
  switch (s.type) {
    case "boolean":
      return typeof s.default === "boolean" ? null : `setting ${s.key}: default must be a boolean`;
    case "string":
      return typeof s.default === "string" ? null : `setting ${s.key}: default must be a string`;
    case "number": {
      if (typeof s.default !== "number" || !Number.isFinite(s.default)) return `setting ${s.key}: default must be a finite number`;
      if (s.min !== undefined && (typeof s.min !== "number" || s.default < s.min)) return `setting ${s.key}: default is below min`;
      if (s.max !== undefined && (typeof s.max !== "number" || s.default > s.max)) return `setting ${s.key}: default is above max`;
      return null;
    }
    case "range": {
      if (typeof s.min !== "number" || typeof s.max !== "number" || !Number.isFinite(s.min) || !Number.isFinite(s.max) || s.min >= s.max) return `setting ${s.key}: range needs a finite min below max`;
      if (s.step !== undefined && (typeof s.step !== "number" || !(s.step > 0))) return `setting ${s.key}: step must be above 0`;
      if (typeof s.default !== "number" || !Number.isFinite(s.default)) return `setting ${s.key}: default must be a finite number`;
      if (s.default < s.min) return `setting ${s.key}: default is below min`;
      if (s.default > s.max) return `setting ${s.key}: default is above max`;
      return null;
    }
    case "enum": {
      const options = s.options;
      if (!Array.isArray(options) || options.length === 0 || options.some((o) => !o || typeof (o as { value?: unknown }).value !== "string")) {
        return `setting ${s.key}: options must be a non-empty array of {value}`;
      }
      return options.some((o) => (o as { value: string }).value === s.default) ? null : `setting ${s.key}: default is not one of the options`;
    }
    default:
      return `setting ${s.key}: type must be boolean, string, number, range or enum`;
  }
}

/** True when `value` is acceptable for `schema`. */
export function valueFits(schema: SettingSchema, value: unknown): value is SettingValue {
  switch (schema.type) {
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string" && value.length <= 65_536;
    case "number":
    case "range":
      return typeof value === "number" && Number.isFinite(value) && (schema.min === undefined || value >= schema.min) && (schema.max === undefined || value <= schema.max);
    case "enum":
      return typeof value === "string" && schema.options.some((o) => o.value === value);
  }
}

/** Stored value if it still fits the schema, else the default. */
export function effectiveValue(schema: SettingSchema, stored: unknown): SettingValue {
  return valueFits(schema, stored) ? stored : schema.default;
}

/** Plugin-manager-side access to one plugin's settings (also used by `t3.settings`). */
export class SettingsAccess {
  constructor(private readonly data: PluginData) {}

  schemas(): SettingSchema[] {
    return [...this.data.schemas.values()].map((s) => clone(s));
  }

  get(key: string): SettingValue {
    const schema = this.data.schemas.get(key);
    if (!schema) throw new Error(`setting "${key}" is not defined`);
    return effectiveValue(schema, Object.hasOwn(this.data.settingsValues, key) ? this.data.settingsValues[key] : undefined);
  }

  async set(key: string, value: unknown): Promise<void> {
    const schema = this.data.schemas.get(key);
    if (!schema) throw new Error(`setting "${key}" is not defined`);
    if (!valueFits(schema, value)) throw new TypeError(`setting "${key}": ${JSON.stringify(value)} does not fit the ${schema.type} schema`);
    const previous = this.get(key);
    if (previous === value && Object.hasOwn(this.data.settingsValues, key)) return;
    await this.data.write({ area: "settings", op: "set", key, value });
    this.#emit({ key, value, previous });
  }

  async reset(key: string): Promise<void> {
    const schema = this.data.schemas.get(key);
    if (!schema) throw new Error(`setting "${key}" is not defined`);
    const previous = this.get(key);
    await this.data.write({ area: "settings", op: "delete", key });
    this.#emit({ key, value: schema.default, previous });
  }

  #emit(change: SettingChange): void {
    for (const fn of [...this.data.listeners]) {
      try {
        fn(change);
      } catch {
        // a listener must not break the others
      }
    }
  }
}

/** `t3.settings` for one plugin. */
export function createSettingsApi(data: PluginData, access: SettingsAccess, scope: Scope): T3Settings {
  return Object.freeze({
    define(schemas: SettingSchema[]): { dispose(): void } {
      scope.assertAlive();
      if (!Array.isArray(schemas)) throw new TypeError("schemas must be an array");
      const seen = new Set<string>();
      for (const schema of schemas) {
        const problem = checkSchema(schema);
        if (problem) throw new TypeError(problem);
        if (seen.has(schema.key)) throw new TypeError(`setting "${schema.key}" is defined twice`);
        seen.add(schema.key);
      }
      data.schemas.clear();
      for (const schema of schemas) data.schemas.set(schema.key, Object.freeze(clone(schema)));
      const keys = [...seen];
      const undo = scope.add(() => {
        for (const key of keys) data.schemas.delete(key);
      });
      return { dispose: undo };
    },
    get<T extends SettingValue = SettingValue>(key: string): T {
      return access.get(key) as T;
    },
    set: (key: string, value: SettingValue) => access.set(key, value),
    reset: (key: string) => access.reset(key),
    onChange(callback: (change: SettingChange) => void): () => void {
      if (typeof callback !== "function") throw new TypeError("callback must be a function");
      data.listeners.add(callback);
      return scope.add(() => void data.listeners.delete(callback));
    },
    getSchemas: () => access.schemas(),
  });
}
