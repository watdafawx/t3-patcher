import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isValidPluginId } from "@t3p/api";

import type { Logger } from "../log.js";

/** Per-plugin storage quota: serialized size of the whole plugin file (kv + settings). */
export const STORAGE_QUOTA_BYTES = 1024 * 1024;

export type StorageArea = "kv" | "settings";

/** What a plugin file holds. `kv` is `t3.storage`; `settings` is `t3.settings`. */
export interface StorageData {
  kv: Record<string, unknown>;
  settings: Record<string, unknown>;
}

export type StorageOp =
  | { area: StorageArea; op: "set"; key: string; value: unknown }
  | { area: StorageArea; op: "delete"; key: string }
  | { area: StorageArea; op: "clear" };

export interface StorageSnapshot extends StorageData {
  usedBytes: number;
  limitBytes: number;
}

const KEY_RE = /^[^\0]{1,256}$/;

function empty(): StorageData {
  return { kv: Object.create(null) as Record<string, unknown>, settings: Object.create(null) as Record<string, unknown> };
}

function sizeOf(data: StorageData): number {
  return Buffer.byteLength(JSON.stringify(data), "utf8");
}

function plain(source: unknown): Record<string, unknown> {
  const out = Object.create(null) as Record<string, unknown>;
  if (source && typeof source === "object" && !Array.isArray(source)) {
    for (const [k, v] of Object.entries(source as Record<string, unknown>)) if (k !== "__proto__") out[k] = v;
  }
  return out;
}

/**
 * <home>/.t3-patcher/storage/<plugin id>.json, one file per plugin, written atomically
 * (temp file + rename). The quota is checked before anything is written, so a plugin can never
 * push its file past 1 MiB. A plugin id is validated as a safe file name by `isValidPluginId`.
 * This is attribution, not isolation: any renderer code can name any plugin id (docs/security.md 4.5).
 */
export class StorageStore {
  private readonly cache = new Map<string, StorageData>();

  constructor(
    private readonly dir: string,
    private readonly log: Logger,
    readonly limitBytes: number = STORAGE_QUOTA_BYTES,
  ) {}

  private file(id: string): string {
    if (!isValidPluginId(id)) throw new Error("t3p: invalid plugin id");
    return join(this.dir, `${id}.json`);
  }

  private load(id: string): StorageData {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const file = this.file(id);
    let data = empty();
    try {
      const text = readFileSync(file, "utf8");
      if (text.length <= this.limitBytes * 2) {
        const raw = JSON.parse(text) as Record<string, unknown>;
        data = { kv: plain(raw.kv), settings: plain(raw.settings) };
      } else {
        this.log.warn(`storage ${id}: file is larger than twice the quota; ignoring it`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.log.warn(`storage ${id}: unreadable, starting empty: ${String(error)}`);
    }
    this.cache.set(id, data);
    return data;
  }

  read(id: string): StorageSnapshot {
    const data = this.load(id);
    return { kv: { ...data.kv }, settings: { ...data.settings }, usedBytes: sizeOf(data), limitBytes: this.limitBytes };
  }

  /** Applies one operation. Throws a `t3p:` error on a bad key, a non-JSON value or when the quota would be exceeded. */
  apply(id: string, op: StorageOp): StorageSnapshot {
    const data = this.load(id);
    const next: StorageData = { kv: { ...data.kv }, settings: { ...data.settings } };
    const bucket = next[op.area];
    if (op.op === "clear") {
      for (const k of Object.keys(bucket)) delete bucket[k];
    } else {
      if (!KEY_RE.test(op.key) || op.key === "__proto__") throw new Error("t3p: invalid storage key");
      if (op.op === "delete") delete bucket[op.key];
      else {
        if (op.value === undefined) throw new Error("t3p: storage value must not be undefined (use delete)");
        bucket[op.key] = op.value;
      }
    }
    const size = sizeOf(next);
    if (size > this.limitBytes && op.op !== "delete" && op.op !== "clear") {
      throw new Error(`t3p: storage quota exceeded (${size} > ${this.limitBytes} bytes)`);
    }
    this.persist(id, next);
    this.cache.set(id, next);
    return { kv: { ...next.kv }, settings: { ...next.settings }, usedBytes: size, limitBytes: this.limitBytes };
  }

  private persist(id: string, data: StorageData): void {
    mkdirSync(this.dir, { recursive: true });
    const file = this.file(id);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, file);
    } catch (error) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // best effort
      }
      throw error;
    }
  }
}
