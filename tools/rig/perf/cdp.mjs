// Minimal CDP client + ssh tunnel to a rig slot's debug port. No dependencies (Node >= 22 global WebSocket).
// Same transport as tools/rig/cdp-eval.mjs: the debug port is bound to 127.0.0.1 on rig, so we forward it over `ssh rig`.
import { spawn } from "node:child_process";
import net from "node:net";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () =>
  new Promise((res, rej) => {
    const s = net.createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });

export const getJson = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
};

/** Opens `ssh -N -L` to rig (or returns the direct endpoint). Returns { host, port, close }. */
export async function openEndpoint({ port, direct = false, host = "127.0.0.1", sshHost = "rig" }) {
  if (direct) return { host, port, close() {} };
  const local = await freePort();
  const child = spawn("ssh", ["-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=10", "-L", `127.0.0.1:${local}:127.0.0.1:${port}`, sshHost], {
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  let exited = false;
  child.once("exit", () => (exited = true));
  const close = () => {
    if (!child.killed) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
  };
  process.on("exit", close);
  const t0 = Date.now();
  while (Date.now() - t0 < 15000 && !exited) {
    try {
      await getJson(`http://127.0.0.1:${local}/json/version`);
      return { host: "127.0.0.1", port: local, close };
    } catch {
      await sleep(300);
    }
  }
  close();
  throw new Error(`CDP not reachable through ssh tunnel to ${sshHost}:${port} (is the slot running? tools/rig/launch.ps1)`);
}

/** One CDP websocket session. `send` resolves with `result`, rejects on `error`. `on(method, fn)` for events. */
export async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error(`websocket error ${wsUrl}`));
  });
  let id = 0;
  const pending = new Map();
  const handlers = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString());
    if (m.id !== undefined) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.rej(new Error(`${p.method}: ${m.error.message}`));
      else p.res(m.result);
    } else if (m.method) for (const fn of handlers.get(m.method) ?? []) fn(m.params);
  };
  ws.onclose = () => {
    for (const p of pending.values()) p.rej(new Error("websocket closed"));
    pending.clear();
  };
  return {
    send(method, params = {}, timeoutMs = 60000) {
      const n = ++id;
      return new Promise((res, rej) => {
        const timer = setTimeout(() => {
          pending.delete(n);
          rej(new Error(`${method}: timeout`));
        }, timeoutMs);
        pending.set(n, {
          method,
          res: (v) => {
            clearTimeout(timer);
            res(v);
          },
          rej: (e) => {
            clearTimeout(timer);
            rej(e);
          },
        });
        ws.send(JSON.stringify({ id: n, method, params }));
      });
    },
    on(method, fn) {
      if (!handlers.has(method)) handlers.set(method, new Set());
      handlers.get(method).add(fn);
      return () => handlers.get(method).delete(fn);
    },
    close() {
      ws.onclose = null;
      ws.close();
    },
  };
}

/** Evaluates `expr` (awaiting promises) and returns the value; throws on an exception. */
export async function evaluate(session, expr, timeoutMs = 60000) {
  const r = await session.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }, timeoutMs);
  if (r.exceptionDetails) throw new Error("page exception: " + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  return r.result.value;
}

/** Endpoint + browser session + the main `t3code://` page session. */
export async function attach({ port, direct, target = "t3code://" }) {
  const ep = await openEndpoint({ port, direct });
  const version = await getJson(`http://${ep.host}:${ep.port}/json/version`);
  const browserPath = new URL(version.webSocketDebuggerUrl).pathname;
  const browser = await connect(`ws://${ep.host}:${ep.port}${browserPath}`);
  const targets = await getJson(`http://${ep.host}:${ep.port}/json/list`);
  const t = targets.find((x) => x.type === "page" && x.url.startsWith(target));
  if (!t) throw new Error(`no page target starting with ${target}`);
  const page = await connect(`ws://${ep.host}:${ep.port}/devtools/page/${t.id}`);
  return {
    browser,
    page,
    version,
    targetId: t.id,
    close() {
      page.close();
      browser.close();
      ep.close();
    },
  };
}
