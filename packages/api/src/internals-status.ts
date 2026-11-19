/**
 * Tier 2 capture status, written by the main runtime to `<home>/.t3-patcher/internals-status.json`
 * and read by `t3p doctor`. The renderer reports each capture; main merges in what the patch engine
 * knows about the capture's patches.
 */

/** The tier 2 captures, in report order. Same keys as `InternalHandles` in t3.ts. */
export const CAPTURE_NAMES = ["atomRegistry", "router", "shortcutDispatcher", "settingsNav", "commandPalette"] as const;
export type CaptureName = (typeof CAPTURE_NAMES)[number];

/**
 * - `captured`: the patch ran and the runtime holds the app's real object.
 * - `fallback`: the patch did not run (or failed); the runtime uses a DOM or document-level substitute.
 * - `failed`: neither works. The feature that depends on it is off.
 * - `pending`: nothing reported yet (the app has not started, or the fallback timer has not fired).
 */
export type CaptureState = "captured" | "fallback" | "failed" | "pending";

export interface CapturePatchStatus {
  /** `String(find)` of the patch. */
  find: string;
  status: "applied" | "failed" | "pending";
  reason?: string;
}

export interface CaptureStatus {
  state: CaptureState;
  detail: string;
  /** ISO time of the last report, or null. */
  at: string | null;
  patches: CapturePatchStatus[];
}

export interface InternalsStatusFile {
  version: 1;
  updatedAt: string;
  appVersion: string | null;
  captures: Record<CaptureName, CaptureStatus>;
}

/** File name below `<home>/.t3-patcher/`. */
export const INTERNALS_STATUS_FILE = "internals-status.json";

export function isCaptureName(value: unknown): value is CaptureName {
  return typeof value === "string" && (CAPTURE_NAMES as readonly string[]).includes(value);
}
