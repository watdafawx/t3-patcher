import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_REGISTRY_URL, isRegistryUrl, REGISTRY_MAX_INDEX_BYTES, type RegistryEntry, type RegistryIndex, validateRegistry } from "@t3p/api";

import { T3pError } from "../errors.js";
import { patcherBase } from "../plugin-admin.js";
import { allowInsecureLocal, type FetchLike, getCapped, GITHUB_DOWNLOAD_HOSTS, RegistryNetError } from "./net.js";

/**
 * Which registry, and fetching its index. Precedence: `T3P_REGISTRY_URL`, then `registryUrl` in
 * ~/.t3-patcher/config.json, then {@link DEFAULT_REGISTRY_URL}. The index is cached with its ETag in
 * ~/.t3-patcher/cache/registry/ so an unchanged index costs one 304, and an offline app still shows
 * the last list (marked stale).
 */

export const INDEX_TIMEOUT_MS = 10_000;

export interface RegistryConfig {
  url: string;
  /** Where the URL came from. */
  from: "env" | "config" | "default";
  allowInsecureLocal: boolean;
}

export function configPath(homeDir?: string): string {
  return join(patcherBase(homeDir), "config.json");
}

/** Resolves the registry URL. A configured URL that is not https (or allowed loopback http) is an error, never silently replaced. */
export function resolveRegistry(opts: { homeDir?: string; env?: NodeJS.ProcessEnv } = {}): RegistryConfig {
  const env = opts.env ?? process.env;
  const insecure = allowInsecureLocal(env);
  let url: string | undefined;
  let from: RegistryConfig["from"] = "default";
  if (env.T3P_REGISTRY_URL) {
    url = env.T3P_REGISTRY_URL;
    from = "env";
  } else {
    try {
      const raw = JSON.parse(readFileSync(configPath(opts.homeDir), "utf8")) as { registryUrl?: unknown };
      if (raw && typeof raw.registryUrl === "string" && raw.registryUrl) {
        url = raw.registryUrl;
        from = "config";
      }
    } catch {
      // no config file (or unreadable): the default
    }
  }
  url ??= DEFAULT_REGISTRY_URL;
  if (!isRegistryUrl(url, { allowInsecureLocal: insecure })) {
    throw new T3pError(`registry URL ${url} (from ${from === "env" ? "T3P_REGISTRY_URL" : configPath(opts.homeDir)}) must be https`);
  }
  return { url, from, allowInsecureLocal: insecure };
}

export interface IndexResult {
  url: string;
  index: RegistryIndex;
  /** network: fresh body; not-modified: 304 with the cached body; cache: network failed, last good copy. */
  source: "network" | "not-modified" | "cache";
  fetchedAt: string;
  /** Set when `source` is "cache": why the network fetch failed. */
  error?: string;
  warnings: string[];
}

interface CacheFile {
  url: string;
  etag: string | null;
  fetchedAt: string;
  body: string;
}

function cacheFile(homeDir: string | undefined, url: string): string {
  return join(patcherBase(homeDir), "cache", "registry", `${createHash("sha256").update(url).digest("hex").slice(0, 24)}.json`);
}

function readCache(file: string, url: string): CacheFile | null {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as CacheFile;
    if (raw && raw.url === url && typeof raw.body === "string" && typeof raw.fetchedAt === "string") return raw;
  } catch {
    // no or broken cache
  }
  return null;
}

function writeCache(file: string, data: CacheFile): void {
  try {
    mkdirSync(join(file, ".."), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, file);
  } catch {
    // a cache that cannot be written only costs a refetch
  }
}

function parseIndex(text: string, url: string, insecure: boolean): { index: RegistryIndex; warnings: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new T3pError(`registry index at ${url} is not valid JSON: ${(error as Error).message}`);
  }
  const res = validateRegistry(raw, { allowInsecureLocal: insecure });
  if (!res.ok) throw new T3pError(`registry index at ${url} is invalid: ${res.errors.slice(0, 5).join("; ")}`);
  return { index: res.index, warnings: res.warnings };
}

export interface FetchIndexOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  /** Override the resolved registry (tests). */
  registry?: RegistryConfig;
  /** Skip the cache entirely (no If-None-Match, no stale fallback). */
  noCache?: boolean;
  timeoutMs?: number;
  now?: () => Date;
}

/**
 * Fetches and validates the index. A network failure falls back to the cached copy (source "cache",
 * `error` set); with no cache it throws. An invalid index never replaces a good cached one.
 */
export async function fetchRegistryIndex(opts: FetchIndexOptions = {}): Promise<IndexResult> {
  const registry = opts.registry ?? resolveRegistry(opts);
  const url = registry.url;
  const file = cacheFile(opts.homeDir, url);
  const cached = opts.noCache ? null : readCache(file, url);
  const now = (opts.now ?? (() => new Date()))().toISOString();
  try {
    const res = await getCapped(url, {
      fetch: opts.fetch,
      maxBytes: REGISTRY_MAX_INDEX_BYTES,
      timeoutMs: opts.timeoutMs ?? INDEX_TIMEOUT_MS,
      headers: { accept: "application/json", ...(cached?.etag ? { "if-none-match": cached.etag } : {}) },
      redirectHosts: ["raw.githubusercontent.com", ...GITHUB_DOWNLOAD_HOSTS],
      allowInsecureLocal: registry.allowInsecureLocal,
      what: "registry index",
    });
    if (res.status === 304 && cached) {
      const parsed = parseIndex(cached.body, url, registry.allowInsecureLocal);
      writeCache(file, { ...cached, fetchedAt: now });
      return { url, index: parsed.index, source: "not-modified", fetchedAt: now, warnings: parsed.warnings };
    }
    if (res.status === 304) throw new RegistryNetError("registry index: 304 without a cached copy");
    const text = res.body.toString("utf8");
    const parsed = parseIndex(text, url, registry.allowInsecureLocal);
    if (!opts.noCache) writeCache(file, { url, etag: res.headers.get("etag"), fetchedAt: now, body: text });
    return { url, index: parsed.index, source: "network", fetchedAt: now, warnings: parsed.warnings };
  } catch (error) {
    if (cached) {
      try {
        const parsed = parseIndex(cached.body, url, registry.allowInsecureLocal);
        return { url, index: parsed.index, source: "cache", fetchedAt: cached.fetchedAt, error: (error as Error).message, warnings: parsed.warnings };
      } catch {
        // the cached copy is bad too: report the network error
      }
    }
    throw error;
  }
}

export function findEntry(index: RegistryIndex, id: string): RegistryEntry | null {
  return index.plugins.find((p) => p.id === id) ?? null;
}
