import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { gunzipSync } from "node:zlib";

import type { Logger } from "../log.js";
import type { DialogGate } from "../plugins/dialog-gate.js";
import type { DialogLike } from "../plugins/grants.js";

export interface SelfUpdateFlowDeps<W> {
  dialog: DialogLike<W>;
  getWindow(): W | null;
  gate: DialogGate;
  runtimeDir: string;
  currentVersion: string;
  relaunch(): void;
  emit(payload: Record<string, unknown>): void;
  log: Logger;
}

export interface SelfUpdateResult {
  status: "updated" | "up-to-date" | "cancelled" | "busy" | "unavailable" | "error";
  version?: string;
  error?: string;
}

const NPM_LATEST_URL = "https://registry.npmjs.org/t3-patcher/latest";
const MAX_TARBALL_BYTES = 10 * 1024 * 1024;

/** Minimal POSIX ustar reader: extracts `package/runtime/<file>` entries (no subdirectories). */
export function extractRuntimeFromTar(tar: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const rawName = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const rawPrefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const fullName = rawPrefix ? `${rawPrefix}/${rawName}` : rawName;
    const sizeOctal = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeOctal, 8) || 0;
    const typeFlag = header[156];
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) break;
    if ((typeFlag === 0 || typeFlag === 48) && fullName.startsWith("package/runtime/")) {
      const rel = fullName.slice("package/runtime/".length);
      if (rel && !rel.includes("/") && !rel.includes("\\") && rel !== "." && rel !== "..") {
        files.set(basename(rel), Buffer.from(tar.subarray(dataStart, dataEnd)));
      }
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

export class SelfUpdateFlow<W> {
  constructor(private readonly deps: SelfUpdateFlowDeps<W>) {}

  async request(): Promise<SelfUpdateResult> {
    const log = this.deps.log;
    if (!this.deps.gate.tryEnter()) {
      return this.#finish({ status: "busy" });
    }
    let shown = false;
    try {
      const window = this.deps.getWindow();
      if (!window) return this.#finish({ status: "unavailable" });
      const metaRes = await fetch(NPM_LATEST_URL, {
        headers: { Accept: "application/json", "User-Agent": `t3-patcher/${this.deps.currentVersion}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!metaRes.ok) throw new Error(`npm registry returned HTTP ${metaRes.status}`);
      const meta = (await metaRes.json()) as { version?: string; dist?: { tarball?: string; shasum?: string } };
      const latest = typeof meta.version === "string" ? meta.version : null;
      const tarballUrl = meta.dist?.tarball;
      const shasum = meta.dist?.shasum;
      if (!latest || !tarballUrl || !shasum) throw new Error("npm metadata missing version, tarball, or shasum");

      shown = true;
      const { response } = await this.deps.dialog.showMessageBox(window, {
        type: "warning",
        title: "T3 Patcher: update runtime",
        message: `Update T3 Patcher from v${this.deps.currentVersion} to v${latest} and restart T3 Code?`,
        detail: [
          `Downloads t3-patcher@${latest} from npm, verifies SHA-1 (${shasum.slice(0, 12)}…), updates ~/.t3-patcher/runtime, and restarts T3 Code.`,
          "",
          "This dialog comes from T3 Patcher, not from a plugin.",
        ].join("\n"),
        buttons: ["Cancel", "Update and restart"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (response !== 1) return this.#finish({ status: "cancelled" });

      const tgzRes = await fetch(tarballUrl, { signal: AbortSignal.timeout(30_000) });
      if (!tgzRes.ok) throw new Error(`tarball download failed: HTTP ${tgzRes.status}`);
      const tgz = Buffer.from(await tgzRes.arrayBuffer());
      if (tgz.length > MAX_TARBALL_BYTES) throw new Error("tarball exceeds size cap");
      const actualSha = createHash("sha1").update(tgz).digest("hex");
      if (actualSha !== shasum) throw new Error(`tarball SHA-1 mismatch (expected ${shasum}, got ${actualSha})`);

      const tar = gunzipSync(tgz);
      const files = extractRuntimeFromTar(tar);
      if (!files.has("main.cjs") || !files.has("renderer.js") || !files.has("preload.cjs")) {
        throw new Error("tarball is missing core runtime files");
      }

      mkdirSync(this.deps.runtimeDir, { recursive: true });
      for (const [name, content] of files) {
        const dest = join(this.deps.runtimeDir, name);
        const tmp = `${dest}.${process.pid}.tmp`;
        writeFileSync(tmp, content);
        renameSync(tmp, dest);
      }
      log.info(`self-updated runtime to v${latest} (${files.size} files); relaunching`);
      const res = this.#finish({ status: "updated", version: latest });
      setTimeout(() => this.deps.relaunch(), 150);
      return res;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.warn(`self-update failed: ${msg}`);
      return this.#finish({ status: "error", error: msg });
    } finally {
      this.deps.gate.leave(shown);
    }
  }

  #finish(result: SelfUpdateResult): SelfUpdateResult {
    try {
      this.deps.emit({ type: "patcher-self-update-result", ...result });
    } catch {
      // ignore
    }
    return result;
  }
}
