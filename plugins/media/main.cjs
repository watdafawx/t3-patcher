"use strict";
// Main-process entry of the Media plugin. Needs the `main` permission and a `spawn` grant for exactly
// powershell.exe and smtc.ps1 (see plugin.json). The renderer calls `poll` and `command` through t3.native.invoke.

const path = require("node:path");
const { createSmtcService } = require("./main-service.cjs");

const POWERSHELL = "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

/** @param {{ log: any, ipc: any, native?: any }} ctx */
function activate(ctx) {
  const spawnSession = ctx.native && ctx.native.spawnSession;
  if (!spawnSession) {
    ctx.log.warn("spawn is not granted: now-playing is disabled (run `t3p grant media spawn`)");
    ctx.ipc.handle("poll", () => ({ state: "unavailable", retryInMs: 0, reason: "spawn not granted" }));
    ctx.ipc.handle("command", () => ({ state: "unavailable", retryInMs: 0, reason: "spawn not granted" }));
    ctx.ipc.handle("seek", () => ({ state: "unavailable", retryInMs: 0, reason: "spawn not granted" }));
    return;
  }
  const service = createSmtcService({
    spawnSession,
    exe: POWERSHELL,
    script: path.join(__dirname, "smtc.ps1"),
    log: { info: (m) => ctx.log.info(m), warn: (m) => ctx.log.warn(m) },
  });
  ctx.ipc.handle("poll", () => service.poll());
  ctx.ipc.handle("command", (payload) => service.command(payload && typeof payload === "object" ? payload.name : ""));
  ctx.ipc.handle("seek", (payload) => service.command("seek", payload && typeof payload === "object" ? Number(payload.sec) : NaN));
  process.once("exit", () => service.stop());
}

module.exports = { activate };
