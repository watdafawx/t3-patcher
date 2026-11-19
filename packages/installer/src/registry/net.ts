import { isRegistryUrl } from "@t3p/api";

import { T3pError } from "../errors.js";

/**
 * HTTP for the registry: https only (loopback http only with T3P_REGISTRY_ALLOW_INSECURE_LOCAL=1),
 * a byte cap enforced while reading, a timeout, and redirects followed by hand so every hop is
 * checked against an allowlist. `fetch` is injectable so tests never touch the network.
 */

export interface ResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | null;
}

export type FetchLike = (url: string, init: { method: "GET"; headers: Record<string, string>; redirect: "manual"; signal: AbortSignal }) => Promise<ResponseLike>;

export class RegistryNetError extends T3pError {
  constructor(
    message: string,
    readonly offline = false,
  ) {
    super(message);
    this.name = "RegistryNetError";
  }
}

/** Hosts a GitHub release download may redirect to (GitHub moved release assets to release-assets.githubusercontent.com in 2025). */
export const GITHUB_DOWNLOAD_HOSTS = Object.freeze(["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);

export function allowInsecureLocal(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.T3P_REGISTRY_ALLOW_INSECURE_LOCAL === "1";
}

export interface GetOptions {
  fetch?: FetchLike;
  maxBytes: number;
  timeoutMs: number;
  headers?: Record<string, string>;
  /** Hostnames a redirect may go to (the first URL's own host is always allowed). */
  redirectHosts: readonly string[];
  allowInsecureLocal?: boolean;
  maxRedirects?: number;
  /** For messages: "registry index", "plugin zip". */
  what: string;
}

export interface GetResult {
  status: number;
  url: string;
  headers: { get(name: string): string | null };
  body: Buffer;
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init) as unknown as Promise<ResponseLike>;

async function readCapped(body: ResponseLike["body"], maxBytes: number, what: string): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  const push = (chunk: Uint8Array): void => {
    total += chunk.byteLength;
    if (total > maxBytes) throw new RegistryNetError(`${what} is larger than ${maxBytes} bytes`);
    chunks.push(Buffer.from(chunk));
  };
  if (typeof (body as ReadableStream<Uint8Array>).getReader === "function") {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) push(value);
      }
    } catch (error) {
      void reader.cancel().catch(() => undefined);
      throw error;
    }
  } else {
    for await (const chunk of body as AsyncIterable<Uint8Array>) push(chunk);
  }
  return Buffer.concat(chunks, total);
}

/**
 * GET with the registry rules. 304 is returned as is (for ETag revalidation). Other non-2xx statuses
 * throw. Network failures throw {@link RegistryNetError} with `offline: true`.
 */
export async function getCapped(url: string, opts: GetOptions): Promise<GetResult> {
  const doFetch = opts.fetch ?? defaultFetch;
  const insecure = opts.allowInsecureLocal === true;
  if (!isRegistryUrl(url, { allowInsecureLocal: insecure })) throw new RegistryNetError(`${opts.what}: refusing non-https URL ${url}`);
  const firstHost = new URL(url).hostname;
  const allowed = new Set([firstHost, ...opts.redirectHosts]);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  (timer as { unref?: () => void }).unref?.();
  let current = url;
  try {
    for (let hop = 0; ; hop++) {
      let res: ResponseLike;
      try {
        res = await doFetch(current, { method: "GET", headers: { "user-agent": "t3-patcher", ...(opts.headers ?? {}) }, redirect: "manual", signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) throw new RegistryNetError(`${opts.what}: timed out after ${opts.timeoutMs} ms`, true);
        throw new RegistryNetError(`${opts.what}: cannot reach ${new URL(current).host} (${(error as Error)?.message ?? String(error)})`, true);
      }
      if (res.status >= 300 && res.status < 400 && res.status !== 304) {
        const location = res.headers.get("location");
        if (!location) throw new RegistryNetError(`${opts.what}: redirect without a location`);
        if (hop >= (opts.maxRedirects ?? 5)) throw new RegistryNetError(`${opts.what}: too many redirects`);
        const next = new URL(location, current).toString();
        if (!isRegistryUrl(next, { allowInsecureLocal: insecure })) throw new RegistryNetError(`${opts.what}: refusing redirect to a non-https URL (${next})`);
        const host = new URL(next).hostname;
        if (!allowed.has(host)) throw new RegistryNetError(`${opts.what}: refusing redirect to ${host} (allowed: ${[...allowed].join(", ")})`);
        // Drain nothing: the body of a redirect is ignored.
        current = next;
        continue;
      }
      if (res.status === 304) return { status: 304, url: current, headers: res.headers, body: Buffer.alloc(0) };
      if (res.status < 200 || res.status >= 300) throw new RegistryNetError(`${opts.what}: HTTP ${res.status} from ${current}`);
      const length = Number(res.headers.get("content-length") ?? "NaN");
      if (Number.isFinite(length) && length > opts.maxBytes) throw new RegistryNetError(`${opts.what} is larger than ${opts.maxBytes} bytes (${length})`);
      const body = await readCapped(res.body, opts.maxBytes, opts.what);
      return { status: res.status, url: current, headers: res.headers, body };
    }
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof RegistryNetError)) throw new RegistryNetError(`${opts.what}: timed out after ${opts.timeoutMs} ms`, true);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
