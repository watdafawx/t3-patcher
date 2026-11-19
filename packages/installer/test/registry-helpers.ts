import { createHash } from "node:crypto";

import type { RegistryEntry, RegistryIndex } from "@t3p/api";

import type { FetchLike, ResponseLike } from "../src/registry.js";
import { writeZip, type ZipWriteEntry } from "../src/registry/zip.js";

export const REGISTRY_URL = "https://registry.example/index.json";

export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface DemoPlugin {
  id?: string;
  version?: string;
  permissions?: unknown[];
  extra?: ZipWriteEntry[];
  manifest?: Record<string, unknown>;
  /** Drop plugin.json from the zip. */
  noManifest?: boolean;
}

export function pluginZip(p: DemoPlugin = {}): Buffer {
  const id = p.id ?? "demo";
  const manifest = { id, name: `Demo ${id}`, version: p.version ?? "1.0.0", tier: 1, t3Versions: ["*"], permissions: p.permissions ?? ["rpc"], renderer: "dist/renderer.js", ...(p.manifest ?? {}) };
  const files: ZipWriteEntry[] = [
    ...(p.noManifest ? [] : [{ name: "plugin.json", data: Buffer.from(JSON.stringify(manifest)) }]),
    { name: "dist/renderer.js", data: Buffer.from(`export default { start() { globalThis.__demo = "${manifest.version}"; } };`) },
    { name: "README.md", data: Buffer.from("# demo\n") },
    ...(p.extra ?? []),
  ];
  return writeZip(files);
}

export function entryFor(zip: Buffer, p: { id?: string; version?: string; permissions?: unknown[]; url?: string } = {}): RegistryEntry {
  const id = p.id ?? "demo";
  const version = p.version ?? "1.0.0";
  return {
    id,
    name: `Demo ${id}`,
    description: "A demo plugin.",
    author: "Tests",
    homepage: "https://example.com/demo",
    version,
    apiVersion: "1",
    permissions: (p.permissions ?? ["rpc"]) as RegistryEntry["permissions"],
    tags: ["demo"],
    download: { url: p.url ?? `https://github.com/example/demo/releases/download/v${version}/t3p-plugin-${id}-${version}.zip`, sha256: sha256(zip), size: zip.length },
  };
}

type Route = { status?: number; body?: Buffer | string; headers?: Record<string, string>; location?: string };

/** A fake fetch serving `routes` by exact URL. Records every request. */
export function fakeFetch(routes: Record<string, Route | ((headers: Record<string, string>) => Route)>): FetchLike & { calls: Array<{ url: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fn = (async (url: string, init: { headers: Record<string, string> }): Promise<ResponseLike> => {
    calls.push({ url, headers: init.headers });
    const r0 = routes[url];
    if (!r0) throw new Error(`ECONNREFUSED ${url}`);
    const r = typeof r0 === "function" ? r0(init.headers) : r0;
    const headers = new Map(Object.entries({ ...(r.headers ?? {}), ...(r.location ? { location: r.location } : {}) }).map(([k, v]) => [k.toLowerCase(), v]));
    const body = r.body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(r.body) ? r.body : Buffer.from(r.body);
    return {
      status: r.status ?? (r.location ? 302 : 200),
      headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null },
      body: (async function* () {
        // two chunks, so the byte cap is checked across chunks
        yield body.subarray(0, Math.floor(body.length / 2));
        yield body.subarray(Math.floor(body.length / 2));
      })(),
    };
  }) as FetchLike & { calls: Array<{ url: string; headers: Record<string, string> }> };
  fn.calls = calls;
  return fn;
}

export function indexOf(...entries: RegistryEntry[]): RegistryIndex {
  return { schemaVersion: 1, plugins: entries };
}
