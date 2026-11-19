#!/usr/bin/env node
// WP-0D: capture the app's own WebSocket frames over CDP (Network.webSocket* events).
//   node capture-cdp.mjs --slot 2 --out fixtures/app-load.jsonl [--seconds 8] [--reload] [--eval "<js>"]... [--hash "#/..."]
// Tunnels CDP through ssh (like tools/rig/cdp-eval.mjs). Redacts wsTicket/tokens before writing.
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';

const a = process.argv.slice(2);
const o = { slot: 2, out: null, seconds: 8, reload: false, evals: [], hash: null };
for (let i = 0; i < a.length; i++) {
  if (a[i] === '--slot') o.slot = +a[++i];
  else if (a[i] === '--out') o.out = a[++i];
  else if (a[i] === '--seconds') o.seconds = +a[++i];
  else if (a[i] === '--reload') o.reload = true;
  else if (a[i] === '--eval') o.evals.push(a[++i]);
  else if (a[i] === '--hash') o.hash = a[++i];
}
const cdpPort = 9333 + o.slot - 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const free = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const redact = (s) => s
  .replace(/(wsTicket=)[^&"\s]+/g, '$1<redacted>')
  .replace(/(dpop=)[^&"\s]+/g, '$1<redacted>')
  .replace(/("(?:ticket|token|bearerToken|bootstrapToken|accessToken|credential|sessionToken)"\s*:\s*)"[^"]*"/gi, '$1"<redacted>"')
  .replace(/Bearer [A-Za-z0-9._~+\/=-]+/g, 'Bearer <redacted>');

const local = await free();
const tunnel = spawn('ssh', ['-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${local}:127.0.0.1:${cdpPort}`, 'rig'], { stdio: 'ignore', windowsHide: true });
const done = (c) => { try { tunnel.kill(); } catch {} process.exit(c); };
process.on('SIGINT', () => done(2));
try {
  let targets;
  for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${local}/json/list`)).json(); break; } catch { await sleep(300); } }
  const t = targets.find((x) => x.type === 'page' && x.url.startsWith('t3code://'));
  const ws = new WebSocket(`ws://127.0.0.1:${local}/devtools/page/${t.id}`);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = new Map(); const sockets = new Map(); const lines = []; const t0 = Date.now();
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id) { pend.get(m.id)?.(m); pend.delete(m.id); return; }
    const p = m.params ?? {};
    if (m.method === 'Network.webSocketCreated') { sockets.set(p.requestId, redact(p.url)); lines.push({ t: Date.now() - t0, ev: 'created', sock: p.requestId, url: redact(p.url) }); }
    else if (m.method === 'Network.webSocketFrameSent') lines.push({ t: Date.now() - t0, ev: 'sent', sock: p.requestId, op: p.response.opcode, data: redact(p.response.payloadData) });
    else if (m.method === 'Network.webSocketFrameReceived') lines.push({ t: Date.now() - t0, ev: 'recv', sock: p.requestId, op: p.response.opcode, data: redact(p.response.payloadData) });
    else if (m.method === 'Network.webSocketClosed') lines.push({ t: Date.now() - t0, ev: 'closed', sock: p.requestId });
    else if (m.method === 'Network.webSocketFrameError') lines.push({ t: Date.now() - t0, ev: 'error', sock: p.requestId, msg: p.errorMessage });
  };
  await send('Network.enable');
  await send('Page.enable');
  if (o.hash) await send('Runtime.evaluate', { expression: `location.hash=${JSON.stringify(o.hash)}` });
  if (o.reload) await send('Page.reload', { ignoreCache: false });
  await sleep(1500);
  for (const e of o.evals) {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true, userGesture: true });
    lines.push({ t: Date.now() - t0, ev: 'eval', expr: e, result: redact(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails ?? null)) });
  }
  await sleep(o.seconds * 1000);
  const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  if (o.out) fs.writeFileSync(o.out, text); else process.stdout.write(text);
  console.error(`captured ${lines.length} lines, ${sockets.size} sockets`);
  ws.close(); done(0);
} catch (e) { console.error(e); done(1); }
