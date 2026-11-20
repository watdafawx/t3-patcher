"use strict";
// Demand-driven SMTC client. One long-lived PowerShell process, started on the first request and stopped
// after IDLE_MS without requests, so nothing runs while no view or chip asks for data. Backs off (5 s doubling to
// 5 min) when the process cannot start, exits early or reports that SMTC is unavailable.

const IDLE_MS = 15_000;
const REQUEST_TIMEOUT_MS = 8_000;
const MIN_POLL_GAP_MS = 700;
const BACKOFF_START_MS = 5_000;
const BACKOFF_MAX_MS = 300_000;
const COMMANDS = new Set(["toggle", "next", "prev", "seek"]);

/**
 * @param {{
 *   spawnSession: (req: object) => { write(text: string): boolean, kill(): void },
 *   exe: string, script: string,
 *   now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (t: unknown) => void,
 *   log?: { info(m: string): void, warn(m: string): void },
 * }} deps
 */
function createSmtcService(deps) {
  const now = deps.now || Date.now;
  const setTimer = deps.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer || ((t) => clearTimeout(t));
  const log = deps.log || { info() {}, warn() {} };

  let session = null;
  let nextId = 1;
  /** @type {Map<number, { resolve(v: object): void, reject(e: Error): void, timer: unknown }>} */
  const pending = new Map();
  let idleTimer = null;
  let backoffMs = 0;
  let backoffUntil = 0;
  let lastPollAt = 0;
  let lastResult = null;
  let inflightPoll = null;
  let thumbKey = "";
  let thumb = null;

  function failAll(error) {
    for (const [id, p] of pending) {
      clearTimer(p.timer);
      pending.delete(id);
      p.reject(error);
    }
  }

  function trip(reason) {
    backoffMs = backoffMs ? Math.min(backoffMs * 2, BACKOFF_MAX_MS) : BACKOFF_START_MS;
    backoffUntil = now() + backoffMs;
    log.warn(`smtc unavailable (${reason}); retry in ${Math.round(backoffMs / 1000)} s`);
  }

  function stop() {
    if (idleTimer) clearTimer(idleTimer);
    idleTimer = null;
    const s = session;
    session = null;
    if (s) {
      try {
        s.kill();
      } catch {
        // already gone
      }
    }
    failAll(new Error("smtc session stopped"));
    inflightPoll = null;
  }

  function touch() {
    if (idleTimer) clearTimer(idleTimer);
    idleTimer = setTimer(() => {
      log.info("smtc idle: stopping helper");
      stop();
    }, IDLE_MS);
  }

  function onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (msg.unavailable) {
      trip(String(msg.error || "unavailable"));
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimer(p.timer);
    p.resolve(msg);
  }

  function ensure() {
    if (session) return true;
    if (now() < backoffUntil) return false;
    try {
      session = deps.spawnSession({
        exe: deps.exe,
        args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", deps.script],
        onLine,
        onExit: (info) => {
          const mine = session;
          session = null;
          if (idleTimer) clearTimer(idleTimer);
          idleTimer = null;
          if (mine || pending.size) {
            if (info.code !== 0) trip(`helper exited with ${String(info.code)}`);
            failAll(new Error("smtc helper exited"));
          }
          inflightPoll = null;
        },
      });
      return true;
    } catch (error) {
      trip(error && error.message ? error.message : String(error));
      return false;
    }
  }

  function request(cmd) {
    return new Promise((resolve, reject) => {
      if (!ensure() || !session) {
        reject(new Error("smtc unavailable"));
        return;
      }
      const id = nextId++;
      const timer = setTimer(() => {
        pending.delete(id);
        reject(new Error("smtc timeout"));
        trip("request timeout");
        stop();
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      if (!session.write(`${id} ${cmd}\n`)) {
        pending.delete(id);
        clearTimer(timer);
        reject(new Error("smtc helper not writable"));
        return;
      }
      touch();
    });
  }

  function unavailable() {
    return { state: "unavailable", retryInMs: Math.max(0, backoffUntil - now()) };
  }

  /** Latest media state. Concurrent and rapid calls share one helper round trip. */
  async function poll() {
    if (now() < backoffUntil && !session) return unavailable();
    if (inflightPoll) return inflightPoll;
    if (lastResult && now() - lastPollAt < MIN_POLL_GAP_MS) {
      touch();
      return lastResult;
    }
    inflightPoll = request("poll")
      .then((msg) => {
        backoffMs = 0;
        backoffUntil = 0;
        let result;
        if (!msg.ok) result = { state: "error", error: String(msg.error || "error") };
        else if (!msg.session) result = { state: "idle" };
        else {
          if (typeof msg.thumb === "string") {
            thumb = msg.thumb;
            thumbKey = String(msg.key || "");
          }
          const { id: _id, ok: _ok, session: _s, thumb: _t, ...rest } = msg;
          result = { state: "ok", media: { ...rest, thumb: thumbKey === rest.key ? thumb : null } };
        }
        lastResult = result;
        lastPollAt = now();
        return result;
      })
      .catch(() => unavailable())
      .finally(() => {
        inflightPoll = null;
      });
    return inflightPoll;
  }

  async function command(name, arg) {
    if (!COMMANDS.has(name)) throw new Error("unknown media command");
    let line = name;
    if (name === "seek") {
      if (typeof arg !== "number" || !Number.isFinite(arg) || arg < 0) throw new Error("seek needs a position in seconds");
      line = `${name} ${arg.toFixed(2)}`;
    }
    try {
      const msg = await request(line);
      if (name === "seek") log.info(`seek ${arg}s -> ${msg && msg.done ? "accepted by the player" : "refused by the player"}`);
    } catch {
      return unavailable();
    }
    lastResult = null; // the next poll must see the change
    return poll();
  }

  return { poll, command, stop, _state: () => ({ running: session !== null, backoffMs, pending: pending.size }) };
}

module.exports = { createSmtcService, IDLE_MS, BACKOFF_START_MS, BACKOFF_MAX_MS };
