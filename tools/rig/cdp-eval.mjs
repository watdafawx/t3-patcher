#!/usr/bin/env node
// Evaluate a JS expression in the main T3 Code window (t3code:// page) over CDP. No dependencies (Node >= 22 global WebSocket).
//
//   node tools/rig/cdp-eval.mjs [--slot N] [--port P] [--host H] [--direct] [--target SUBSTR] [--list] "<js expression>"
//
// Default mode = SSH TUNNEL: rig's debug port is bound to 127.0.0.1 on rig only, so this script starts
//   ssh -N -L <free local port>:127.0.0.1:<port> rig
// on FOX, talks CDP through it, and always kills that ssh child before exiting (finally + exit/signal handlers).
// --direct  = connect straight to --host:--port (use when running ON rig, or if you made your own tunnel). Default host 127.0.0.1.
// --ssh-host NAME = ssh alias to tunnel through (default "rig").
// Output: JSON of the evaluated value on stdout. Exit 0 ok, 1 on JS exception / CDP error, 2 on usage/connect errors.
import { spawn } from 'node:child_process';
import net from 'node:net';

const argv = process.argv.slice(2);
const opt = { slot: 1, port: null, host: '127.0.0.1', direct: false, sshHost: 'rig', target: 't3code://', list: false, timeout: 20000 };
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--slot') opt.slot = Number(argv[++i]);
  else if (a === '--port') opt.port = Number(argv[++i]);
  else if (a === '--host') { opt.host = argv[++i]; }
  else if (a === '--ssh') { /* accepted for compatibility: tunnel is the default */ }
  else if (a === '--ssh-host') opt.sshHost = argv[++i];
  else if (a === '--direct') opt.direct = true;
  else if (a === '--target') opt.target = argv[++i];
  else if (a === '--list') opt.list = true;
  else if (a === '--timeout') opt.timeout = Number(argv[++i]);
  else rest.push(a);
}
if (opt.port == null) opt.port = 9333 + opt.slot - 1;
const expr = rest.join(' ');
if (!expr && !opt.list) { console.error('usage: cdp-eval.mjs [--slot N|--port P] [--direct --host H] [--list] "<js expression>"'); process.exit(2); }

let tunnel = null;
const cleanup = () => { if (tunnel && !tunnel.killed) { try { tunnel.kill(); } catch { /* ignore */ } } tunnel = null; };
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanup(); process.exit(2); });

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer(); s.once('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = async (url) => { const r = await fetch(url, { signal: AbortSignal.timeout(3000) }); if (!r.ok) throw new Error(`${url} -> ${r.status}`); return r.json(); };

async function main() {
  let host = opt.host, port = opt.port;
  if (!opt.direct) {
    const local = await freePort();
    tunnel = spawn('ssh', ['-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=10',
      '-L', `127.0.0.1:${local}:127.0.0.1:${opt.port}`, opt.sshHost], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
    let exited = false; tunnel.once('exit', () => { exited = true; });
    host = '127.0.0.1'; port = local;
    const t0 = Date.now(); let ok = false;
    while (Date.now() - t0 < 15000 && !exited) {
      try { await getJson(`http://${host}:${port}/json/version`); ok = true; break; } catch { await sleep(300); }
    }
    if (!ok) throw Object.assign(new Error(`CDP not reachable via ssh tunnel to rig:${opt.port} (is the app running? launch.ps1)`), { code: 2 });
  }
  const targets = await getJson(`http://${host}:${port}/json/list`);
  if (opt.list) { console.log(JSON.stringify(targets.map(({ id, type, title, url }) => ({ id, type, title, url })), null, 2)); return 0; }
  const t = targets.find((x) => x.type === 'page' && x.url.startsWith(opt.target)) ;
  if (!t) throw Object.assign(new Error(`no page target with url starting "${opt.target}". targets: ${targets.map((x) => x.type + ' ' + x.url).join(' | ')}`), { code: 2 });
  // The debugger URL carries the remote host; rewrite to the endpoint we can actually reach.
  const wsUrl = `ws://${host}:${port}/devtools/page/${t.id}`;
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(Object.assign(new Error('websocket error'), { code: 2 })); });
  const result = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(Object.assign(new Error('evaluate timeout'), { code: 1 })), opt.timeout);
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id === 1) { clearTimeout(timer); res(m); } };
    ws.onclose = () => rej(Object.assign(new Error('websocket closed'), { code: 2 }));
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true } }));
  });
  ws.onclose = null; ws.close();
  if (result.error) { console.error(JSON.stringify(result.error)); return 1; }
  const r = result.result;
  if (r.exceptionDetails) { console.error('exception: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)); return 1; }
  console.log(JSON.stringify(r.result.value === undefined ? { type: r.result.type, description: r.result.description ?? null } : r.result.value));
  return 0;
}

let code = 0;
try { code = await main(); } catch (e) { console.error(String(e.message ?? e)); code = e.code ?? 2; } finally { cleanup(); }
process.exit(code);
