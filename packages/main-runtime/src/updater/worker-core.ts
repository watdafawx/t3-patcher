import type { Logger } from "../log.js";

export type LayoutState = "unpatched" | "patched" | "stale" | "broken" | "unknown" | "missing";

export interface WorkerDeps {
  log: Logger;
  pidAlive(pid: number): boolean;
  /** Current layout of the install dir, plus a fingerprint of app.asar (size+mtime) to detect a finished write. */
  layout(): Promise<{ state: LayoutState; fingerprint: string | null }>;
  /** Runs installer repair --if-stale. Resolves "busy" when files are locked (app running). */
  repair(): Promise<"repaired" | "noop" | "busy">;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface WorkerOptions {
  pid: number;
  /** Max wait for the old app to exit. */
  exitTimeoutMs?: number;
  /** Max wait for NSIS to finish writing the new install. */
  updateTimeoutMs?: number;
  /** Max time retrying while the (re-started) app holds the files. */
  busyTimeoutMs?: number;
  pollMs?: number;
  busyRetryMs?: number;
  /** "patched" must hold this long before we decide no update happened (NSIS may still be starting). */
  patchedSettleMs?: number;
  /** app.asar must be unchanged this long before we touch it. */
  settleMs?: number;
}

export type WorkerOutcome = "repaired" | "already-patched" | "unpatched" | "timeout" | "busy-timeout" | "broken" | "error";

/**
 * The repair worker's loop, free of I/O for tests:
 * 1. wait for the old app (pid) to exit;
 * 2. wait until NSIS has written the new install: layout "stale" (stock
 *    app.asar while the manifest still lists the install), with app.asar
 *    unchanged for settleMs;
 * 3. run repair; while the files are locked (NSIS --force-run restarted the
 *    app) retry until busyTimeoutMs.
 * A "patched" layout means NSIS never replaced anything (cancelled update): done.
 */
export async function runRepairLoop(deps: WorkerDeps, options: WorkerOptions): Promise<WorkerOutcome> {
  const log = deps.log;
  const poll = options.pollMs ?? 1000;
  const start = deps.now();
  const exitDeadline = start + (options.exitTimeoutMs ?? 10 * 60_000);
  while (deps.pidAlive(options.pid)) {
    if (deps.now() > exitDeadline) {
      log.warn(`app pid ${options.pid} still running; continuing anyway`);
      break;
    }
    await deps.sleep(poll);
  }
  log.info(`app pid ${options.pid} exited; waiting for the update to land`);

  const updateDeadline = deps.now() + (options.updateTimeoutMs ?? 30 * 60_000);
  const settle = options.settleMs ?? 10_000;
  let lastFingerprint: string | null = null;
  let stableSince = deps.now();
  for (;;) {
    if (deps.now() > updateDeadline) {
      log.warn("update did not finish in time; run t3p repair by hand");
      return "timeout";
    }
    let current: Awaited<ReturnType<WorkerDeps["layout"]>>;
    try {
      current = await deps.layout();
    } catch (error) {
      log.warn(`status failed (install still being written?): ${String(error)}`);
      current = { state: "missing", fingerprint: null };
    }
    if (current.fingerprint !== lastFingerprint) {
      lastFingerprint = current.fingerprint;
      stableSince = deps.now();
    }
    const settled = current.fingerprint !== null && deps.now() - stableSince >= settle;
    if (current.state === "patched" && current.fingerprint !== null && deps.now() - stableSince >= (options.patchedSettleMs ?? 120_000)) {
      log.info("layout is still patched (no update was installed); nothing to do");
      return "already-patched";
    }
    if (current.state === "stale" && settled) break;
    if (current.state === "unpatched" && settled) {
      log.info("layout is unpatched (no install manifest entry); not repairing");
      return "unpatched";
    }
    if (current.state === "broken" && settled) {
      log.error("layout is broken after the update; run t3p doctor");
      return "broken";
    }
    await deps.sleep(poll);
  }

  const busyDeadline = deps.now() + (options.busyTimeoutMs ?? 2 * 60 * 60_000);
  for (;;) {
    let result: "repaired" | "noop" | "busy";
    try {
      result = await deps.repair();
    } catch (error) {
      log.error("repair failed", error);
      return "error";
    }
    if (result === "repaired") {
      log.info("repair done: patched layout restored; it takes effect on the next app start");
      return "repaired";
    }
    if (result === "noop") {
      log.info("repair: nothing to do");
      return "already-patched";
    }
    if (deps.now() > busyDeadline) {
      log.warn("app kept the files locked; run t3p repair after closing T3 Code");
      return "busy-timeout";
    }
    log.info("files locked by the running app; retrying");
    await deps.sleep(options.busyRetryMs ?? 30_000);
  }
}
