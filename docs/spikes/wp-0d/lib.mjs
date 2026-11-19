// WP-0D shared helpers: ssh tunnel to rig slot, CDP bearer fetch, minimal Effect-RPC JSON client. Node >= 22.
import { spawn } from 'node:child_process';
import net from 'node:net';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const free = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

/** One ssh child forwarding rig:127.0.0.1:(3873+slot-1) and CDP (9333+slot-1) to free local ports. Call .close(). */
export async function openTunnel(slot = 2) {
  const srv = await free(), cdp = await free();
  const child = spawn('ssh', ['-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
    '-L', `127.0.0.1:${srv}:127.0.0.1:${3873 + slot - 1}`, '-L', `127.0.0.1:${cdp}:127.0.0.1:${9333 + slot - 1}`, 'rig'], { stdio: 'ignore', windowsHide: true });
  const close = () => { try { child.kill(); } catch {} };
  process.on('exit', close);
  for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${cdp}/json/version`); break; } catch { await sleep(250); } }
  return { serverPort: srv, cdpPort: cdp, httpBase: `http://127.0.0.1:${srv}`, wsBase: `ws://127.0.0.1:${srv}`, close };
}

/** Evaluate JS in the app's main window over CDP (slot's throwaway app only). */
export async function cdpEval(cdpPort, expression) {
  const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
  const t = targets.find((x) => x.type === 'page' && x.url.startsWith('t3code://'));
  const ws = new WebSocket(`ws://127.0.0.1:${cdpPort}/devtools/page/${t.id}`);
  await new Promise((r) => (ws.onopen = r));
  const res = await new Promise((resolve) => {
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) resolve(m); };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  ws.close();
  if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description);
  return res.result.result.value;
}

export const getDesktopBearer = (cdpPort) => cdpEval(cdpPort, 'window.desktopBridge.getLocalEnvironmentBearerToken()');

export async function issueTicket(httpBase, bearer, use = 'rpc') {
  const r = await fetch(`${httpBase}/api/auth/websocket-ticket/${use}`, { method: 'POST', headers: { authorization: `Bearer ${bearer}` } });
  const text = await r.text();
  return { status: r.status, body: text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

export const redactUrl = (u) => u.replace(/(wsTicket=)[^&]+/, '$1<redacted>');

/**
 * Minimal Effect-RPC JSON client (no effect dependency).
 * Wire: text frames, one JSON object per frame (RpcSerialization.json, no newline framing over WS).
 *  C->S {_tag:"Request",id,tag,payload,traceId,spanId,sampled,headers:[]}  | {_tag:"Ack",requestId} | {_tag:"Interrupt",requestId} | {_tag:"Ping"}
 *  S->C {_tag:"Chunk",requestId,values:[...]} | {_tag:"Exit",requestId,exit:{_tag:"Success"|"Failure",...}} | {_tag:"Pong"}
 * Frame parts (query frameParts=1): frames starting with U+001E are continuations, joined until a frame without the prefix.
 */
export class RpcSocket {
  constructor(url, { wsOptions, onFrame, frameParts = true } = {}) {
    this.url = url; this.wsOptions = wsOptions; this.onFrame = onFrame; this.frameParts = frameParts;
    this.nextId = 0; this.pending = new Map(); this.streams = new Map(); this.pending_part = '';
    this.log = [];
  }
  open() {
    return new Promise((resolve, reject) => {
      const ws = (this.ws = this.wsOptions ? new WebSocket(this.url, this.wsOptions) : new WebSocket(this.url));
      ws.onopen = () => { this.ping = setInterval(() => this.#send({ _tag: 'Ping' }), 5000); resolve(this); };
      ws.onerror = (e) => reject(Object.assign(new Error('ws error: ' + (e.message ?? 'connect failed')), { event: e }));
      ws.onclose = (e) => { clearInterval(this.ping); this.closed = { code: e.code, reason: e.reason }; for (const s of this.streams.values()) s.end?.({ closed: true }); for (const p of this.pending.values()) p.reject(new Error(`socket closed ${e.code}`)); this.onclose?.(e); };
      ws.onmessage = (e) => this.#onMessage(e.data);
    });
  }
  #send(obj) { const s = JSON.stringify(obj); this.onFrame?.('sent', s); this.ws.send(s); }
  #onMessage(data) {
    if (typeof data !== 'string') return;
    this.onFrame?.('recv', data);
    if (data.startsWith('\u001e')) { this.pending_part += data.slice(1); return; }
    if (this.pending_part) { data = this.pending_part + data; this.pending_part = ''; }
    const m = JSON.parse(data);
    if (m._tag === 'Pong') return;
    if (m._tag === 'Chunk') {
      const s = this.streams.get(m.requestId);
      for (const v of m.values) s?.onItem(v);
      this.#send({ _tag: 'Ack', requestId: m.requestId });   // required flow control: server waits for Ack before the next chunk
    } else if (m._tag === 'Exit') {
      const s = this.streams.get(m.requestId); if (s) { this.streams.delete(m.requestId); s.end?.({ exit: m.exit }); }
      const p = this.pending.get(m.requestId); if (p) { this.pending.delete(m.requestId); m.exit._tag === 'Success' ? p.resolve(m.exit.value) : p.reject(Object.assign(new Error('rpc failure'), { exit: m.exit })); }
    } else if (m._tag === 'ClientProtocolError' || m._tag === 'Defect') { this.onProtocolError?.(m); }
  }
  /** unary call; resolves with exit.value, rejects with {exit}. */
  call(tag, payload = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.#send({ _tag: 'Request', id, tag, payload, headers: [] }); });
  }
  /** stream call; onItem per value; returns {id, cancel(), done: Promise}. */
  subscribe(tag, payload, onItem) {
    const id = this.nextId++;
    let end; const done = new Promise((r) => (end = r));
    this.streams.set(id, { onItem, end });
    this.#send({ _tag: 'Request', id, tag, payload, headers: [] });
    return { id, done, cancel: () => this.#send({ _tag: 'Interrupt', requestId: id }) };
  }
  close() { try { this.ws.close(); } catch {} }
}
