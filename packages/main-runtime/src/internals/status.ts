import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { CAPTURE_NAMES, type CaptureName, type CaptureState, type CaptureStatus, type InternalsStatusFile, isCaptureName } from "@t3p/api";

import type { Logger } from "../log.js";
import type { CaptureDef } from "../patches/captures.js";
import type { PatchReport } from "../patches/service.js";

export interface InternalsStatusDeps {
  file: string;
  captures: readonly CaptureDef[];
  /** Names switched off with T3P_CAPTURES_OFF: their patches are not registered. */
  disabled: ReadonlySet<CaptureName>;
  appVersion: string | null;
  patchReport(): PatchReport;
  log: Logger;
  now?(): Date;
}

interface Reported {
  state: Exclude<CaptureState, "pending">;
  detail: string;
  at: string;
}

/**
 * Holds what the renderer reported for each tier 2 capture, merges in the patch engine's verdict for
 * the capture's patches and writes `internals-status.json` (read by `t3p doctor`).
 *
 * Merge rule: a patch that failed to apply turns `captured` into `failed`, and keeps `fallback` as
 * `fallback` (the substitute works, the capture does not). Nothing reported is `pending`.
 */
export class InternalsStatus {
  private readonly reported = new Map<CaptureName, Reported>();

  constructor(private readonly deps: InternalsStatusDeps) {}

  /** A renderer report. Unknown names or states are rejected. */
  report(name: unknown, state: unknown, detail: unknown): CaptureStatus {
    if (!isCaptureName(name)) throw new Error(`t3p: unknown capture ${String(name)}`);
    if (state !== "captured" && state !== "fallback" && state !== "failed") throw new Error("t3p: invalid capture state");
    const text = typeof detail === "string" ? detail.slice(0, 500) : "";
    this.reported.set(name, { state, detail: text, at: (this.deps.now?.() ?? new Date()).toISOString() });
    const snapshot = this.snapshot();
    this.write(snapshot);
    return snapshot.captures[name];
  }

  snapshot(): InternalsStatusFile {
    const report = this.deps.patchReport();
    const verdict = new Map<string, { status: "applied" | "failed"; reason?: string }>();
    for (const ok of report.applied) verdict.set(ok.find, { status: "applied" });
    for (const bad of report.failed) verdict.set(bad.find, { status: "failed", reason: `${bad.reason}: ${bad.detail}` });
    for (const bad of report.disabled) if (!verdict.has(bad.find) || verdict.get(bad.find)!.status !== "failed") verdict.set(bad.find, { status: "failed", reason: bad.reason });

    const captures = {} as Record<CaptureName, CaptureStatus>;
    for (const name of CAPTURE_NAMES) {
      const def = this.deps.captures.find((c) => c.name === name);
      const patches = (def?.patches ?? []).map((patch) => {
        const find = String(patch.find);
        const v = this.deps.disabled.has(name) ? undefined : verdict.get(find);
        return { find, status: v?.status ?? ("pending" as const), ...(v?.reason ? { reason: v.reason } : {}) };
      });
      const broken = patches.filter((p) => p.status === "failed");
      const reported = this.reported.get(name);
      let state: CaptureState = reported?.state ?? "pending";
      let detail = reported?.detail ?? (this.deps.disabled.has(name) ? "capture switched off (T3P_CAPTURES_OFF)" : "no report yet");
      if (broken.length > 0 && state === "captured") {
        state = "failed";
        detail = `patch failed: ${broken[0]!.reason ?? "unknown"}`;
      } else if (broken.length > 0 && state === "fallback") {
        detail = `${detail}; patch failed: ${broken[0]!.reason ?? "unknown"}`;
      }
      captures[name] = { state, detail, at: reported?.at ?? null, patches };
    }
    return { version: 1, updatedAt: (this.deps.now?.() ?? new Date()).toISOString(), appVersion: this.deps.appVersion, captures };
  }

  /** Writes the file once with everything `pending`, so doctor can tell "never ran" from "no file". */
  writeInitial(): void {
    this.write(this.snapshot());
  }

  private write(snapshot: InternalsStatusFile): void {
    try {
      mkdirSync(dirname(this.deps.file), { recursive: true });
      const tmp = `${this.deps.file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`);
      renameSync(tmp, this.deps.file);
    } catch (error) {
      this.deps.log.warn(`cannot write ${this.deps.file}: ${String(error)}`);
    }
  }
}
