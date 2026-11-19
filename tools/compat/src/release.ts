import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname } from "node:path";

export const REPO = "pingdotgg/t3code";
const BASE = `https://github.com/${REPO}`;

export interface Log {
  info(message: string): void;
  warn(message: string): void;
}

const silent: Log = { info: () => {}, warn: () => {} };

function noop(): void {
  /* progress sink for tests */
}

/** The tag a `--version` value refers to, and how it was worked out. */
export interface ResolvedTag {
  tag: string;
  how: "given" | "latest" | "nightly";
}

export function isTagSpec(value: string): boolean {
  return /^v?\d+\.\d+\.\d+/.test(value) || value === "latest" || value === "nightly";
}

export function normalizeTag(value: string): string {
  return value.startsWith("v") ? value : `v${value}`;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { "User-Agent": "t3p-compat" } });
  if (!response.ok) {
    throw new Error(`GET ${url} failed: HTTP ${response.status}`);
  }
  return response.text();
}

/** Resolves `latest` (stable channel) and `nightly` (highest `-nightly.` tag). */
export async function resolveTag(spec: string, log: Log = silent): Promise<ResolvedTag> {
  const value = spec.trim();
  if (value === "latest") {
    const response = await fetch(`${BASE}/releases/latest`, {
      redirect: "follow",
      headers: { "User-Agent": "t3p-compat" },
    });
    // GitHub answers 200 on the tag page it redirected to.
    const tag = /\/releases\/tag\/([^/?#]+)$/.exec(response.url)?.[1];
    if (!tag) throw new Error(`cannot resolve the latest release (final URL ${response.url})`);
    log.info(`latest release: ${decodeURIComponent(tag)}`);
    return { tag: decodeURIComponent(tag), how: "latest" };
  }
  if (value === "nightly") {
    const feed = await fetchText(`${BASE}/releases.atom`);
    const tags: string[] = [];
    for (const match of feed.matchAll(/\/releases\/tag\/([^"<]+)/g)) {
      const tag = decodeURIComponent(match[1]!);
      if (/^v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/.test(tag)) tags.push(tag);
    }
    const best = tags.sort(compareVersionTags).at(-1);
    if (!best) throw new Error("cannot find a nightly tag in the releases feed");
    log.info(`newest nightly: ${best} (${tags.length} in the feed)`);
    return { tag: best, how: "nightly" };
  }
  return { tag: normalizeTag(value), how: "given" };
}

/**
 * Orders release tags: `v0.1.10` < `v0.1.11-nightly.20261118.4903` <
 * `v0.1.11-nightly.20261119.4918` < `v0.1.11`. A `-nightly.` tag is a build
 * towards the release in its name, so it sits below that release.
 */
export function compareVersionTags(a: string, b: string): number {
  const key = (tag: string): number[] => {
    const match = /^v(\d+)\.(\d+)\.(\d+)(?:-(nightly|preview)\.(\d{8})\.(\d+))?/.exec(tag);
    if (!match) return [0, 0, 0, 2, 0, 0];
    const pre = match[4] ? 1 : 2;
    return [
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
      pre,
      Number(match[5] ?? 0),
      Number(match[6] ?? 0),
    ];
  };
  const left = key(a);
  const right = key(b);
  for (let i = 0; i < left.length; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Asset names attached to a release, read from the release's asset list page. */
export async function releaseAssets(tag: string, log: Log = silent): Promise<string[]> {
  const url = `${BASE}/releases/expanded_assets/${encodeURIComponent(tag)}`;
  const html = await fetchText(url);
  const names = new Set<string>();
  const pattern = /\/releases\/download\/[^/"]+\/([^"?]+)"/g;
  for (const match of html.matchAll(pattern)) {
    names.add(decodeURIComponent(match[1]!));
  }
  log.info(`${tag}: ${names.size} release assets`);
  return [...names].sort();
}

/**
 * The Windows installer asset for an x64 machine. The release also ships macOS
 * and Linux artifacts; the client they contain is the same, but the Windows
 * NSIS installer is the artifact our users run.
 */
export function pickInstallerAsset(names: readonly string[]): string | undefined {
  const exe = names.filter((name) => /\.exe$/i.test(name) && !/arm64|ia32/i.test(name));
  if (exe.length === 0) return undefined;
  const preferred = exe.find((name) => /^T3-Code-.*-x64\.exe$/i.test(name));
  return preferred ?? exe.sort((a, b) => a.length - b.length)[0];
}

export function installerUrl(tag: string, asset: string): string {
  return `${BASE}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`;
}

export interface DownloadResult {
  path: string;
  bytes: number;
  skipped: boolean;
}

/** Downloads to `dest`, skipping when a file of the expected size is already there. */
export async function download(
  url: string,
  dest: string,
  log: Log = silent,
  onProgress: (received: number, total: number) => void = noop,
): Promise<DownloadResult> {
  mkdirSync(dirname(dest), { recursive: true });
  if (existsSync(dest)) {
    try {
      const size = statSync(dest).size;
      if (size > 0) {
        log.info(`using cached download: ${dest} (${(size / 1048576).toFixed(1)} MB)`);
        return { path: dest, bytes: size, skipped: true };
      }
    } catch {
      // fall through to a fresh download
    }
  }

  const response = await fetch(url, { headers: { "User-Agent": "t3p-compat" } });
  if (!response.ok || !response.body) {
    throw new Error(`GET ${url} failed: HTTP ${response.status}`);
  }
  const total = Number(response.headers.get("content-length") ?? 0);
  const partial = `${dest}.part`;
  rmSync(partial, { force: true });

  let received = 0;
  let lastTick = 0;
  const source = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  source.on("data", (chunk: Buffer) => {
    received += chunk.length;
    const now = Date.now();
    if (now - lastTick > 2000) {
      lastTick = now;
      onProgress(received, total);
    }
  });
  await pipeline(source, createWriteStream(partial));
  rmSync(dest, { force: true });
  renameSync(partial, dest);
  log.info(`downloaded ${dest} (${(received / 1048576).toFixed(1)} MB)`);
  return { path: dest, bytes: received, skipped: false };
}
