#!/usr/bin/env node
// WP-0D spike: standalone Effect-RPC client against rig slot 2 (throwaway home). Run from FOX:
//   node docs/spikes/wp-0d/spike.mjs [--slot 2]
// Opens its own ssh tunnel (rig localhost-only ports), gets the bearer from the slot's own app over CDP,
// never touches FOX's T3 Code. Writes sanitized fixtures next to this file.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openTunnel, getDesktopBearer, issueTicket, RpcSocket, sleep } from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n) => path.join(here, 'fixtures', n);
const slot = Number(process.argv[process.argv.indexOf('--slot') + 1]) || 2;
const secrets = new Set();
const san = (s) => {
  let o = typeof s === 'string' ? s : JSON.stringify(s);
  for (const x of secrets) if (x) o = o.split(x).join('<redacted>');
  return o
    .replace(/C:\\\\Users\\\\[^\\"]+/g, 'C:\\\\Users\\\\<user>')
    .replace(/C:\\Users\\[^\\"]+/g, 'C:\\Users\\<user>')
    .replace(/(wsTicket=)[^&"\s]+/g, '$1<redacted>');
};
const trunc = (s, n = 3000) => (s.length > n ? s.slice(0, n) + `...<truncated ${s.length - n} chars>` : s);
const frames = [];
let section = '-';
const h = (t) => { section = t; console.log(`\n=== ${t} ===`); };
const mk = (name) => (d, f) => frames.push({ section, sock: name, dir: d, data: trunc(san(f)) });
const t = await openTunnel(slot);
const R = {}; // results -> fixtures/results.json
const open = (name, ticket, extra = '') =>
  new RpcSocket(`${t.wsBase}/ws?${ticket ? 'wsTicket=' + encodeURIComponent(ticket) + '&' : ''}orchestrationProtocol=2${extra}`, { onFrame: mk(name) }).open();
const fail = (e) => ({ error: e.exit ? e.exit : String(e.message ?? e) });
try {
  const bearer = await getDesktopBearer(t.cdpPort);
  secrets.add(bearer);
  const newTicket = async (use = 'rpc') => {
    const r = await issueTicket(t.httpBase, bearer, use);
    if (r.json?.ticket) secrets.add(r.json.ticket);
    return r.json.ticket;
  };

  h('0. HTTP auth surface');
  const env = await fetch(`${t.httpBase}/.well-known/t3/environment`);
  const envBody = await env.json();
  console.log('GET /.well-known/t3/environment (no auth)', env.status, trunc(san(envBody), 600));
  R.wellKnown = { status: env.status, body: JSON.parse(san(envBody)) };
  const noAuth = await fetch(`${t.httpBase}/api/auth/websocket-ticket`, { method: 'POST' });
  console.log('POST /api/auth/websocket-ticket, no credential ->', noAuth.status, (await noAuth.text()).slice(0, 300));
  R.ticketNoCred = noAuth.status;
  const r1 = await fetch(`${t.httpBase}/api/auth/websocket-ticket`, { method: 'POST', headers: { authorization: `Bearer ${bearer}` } });
  const b1 = await r1.json();
  if (b1.ticket) secrets.add(b1.ticket);
  console.log('POST /api/auth/websocket-ticket, Bearer ->', r1.status, 'keys', Object.keys(b1), 'expiresAt', b1.expiresAt);
  R.ticketBare = { status: r1.status, keys: Object.keys(b1) };
  const r2 = await fetch(`${t.httpBase}/api/auth/websocket-ticket/rpc`, { method: 'POST', headers: { authorization: `Bearer ${bearer}` } });
  const b2 = await r2.json();
  if (b2.ticket) secrets.add(b2.ticket);
  const ttl = ((Date.parse(b2.expiresAt) - Date.now()) / 1000) | 0;
  console.log('POST /api/auth/websocket-ticket/rpc, Bearer ->', r2.status, 'ttl seconds ~', ttl);
  R.ticketRpc = { status: r2.status, ttlSec: ttl };
  const sess = await fetch(`${t.httpBase}/api/auth/session`, { headers: { authorization: `Bearer ${bearer}` } });
  console.log('GET /api/auth/session, Bearer ->', sess.status, trunc(san(await sess.text()), 400));

  h('1. Socket auth matrix');
  const attempt = async (label, fn) => {
    try { const s = await fn(); R[label] = 'OPEN'; console.log(label, '-> OPEN'); return s; }
    catch (e) { R[label] = 'REJECTED: ' + e.message; console.log(label, '-> REJECTED', e.message); }
  };
  const un = await attempt('socket without credentials', () => open('unauth', null));
  if (un) { const r = await un.call('server.getConfig', {}).then(() => 'call ok', (e) => 'call failed ' + (e.message)); console.log('  unauth socket call:', r); R.unauthCall = r; un.close(); }
  await attempt('socket with bogus ticket', () => open('bogus', 'not-a-ticket'));
  const bearerSock = await attempt('socket with Authorization Bearer header (no ticket)', () =>
    new RpcSocket(`${t.wsBase}/ws?orchestrationProtocol=2`, { wsOptions: { headers: { authorization: `Bearer ${bearer}` } }, onFrame: mk('bearerHeader') }).open());
  if (bearerSock) {
    const c = await bearerSock.call('server.getConfig', {}).catch(fail);
    console.log('  bearer-header socket server.getConfig providers:', c.providers?.length ?? san(c));
    bearerSock.close();
  }
  const bad = await fetch(`${t.httpBase}/ws?wsTicket=x&orchestrationProtocol=1`);
  console.log('GET /ws?orchestrationProtocol=1 (plain http) ->', bad.status, (await bad.text()).slice(0, 300));
  R.protoMismatch = bad.status;
  const nop = await fetch(`${t.httpBase}/ws?wsTicket=x`);
  console.log('GET /ws (no orchestrationProtocol) ->', nop.status);
  R.noProto = nop.status;
  const tkA = await newTicket();
  const s1 = await open('primary', tkA);
  const reuse = await attempt('same ticket a second time', () => open('reuse', tkA));
  reuse?.close();
  const s2 = await attempt('second concurrent socket (fresh ticket from desktop bearer)', async () => open('second', await newTicket()));
  const parts = await attempt('socket with frameParts=1', async () => open('parts', await newTicket(), '&frameParts=1'));
  const c2 = await s2.call('server.getConfig', {}).catch(fail);
  console.log('  second socket getConfig providers:', c2.providers?.length ?? san(c2));
  const c3 = await parts.call('server.getConfig', {}).catch(fail);
  console.log('  frameParts socket getConfig (joined client side) providers:', c3.providers?.length ?? san(c3));
  R.framePartsFramesForGetConfig = frames.filter((f) => f.sock === 'parts' && f.dir === 'recv').length;

  h('2. server.getConfig and providers');
  const cfg = await s1.call('server.getConfig', {});
  fs.writeFileSync(fx('server-getConfig.json'), san(JSON.stringify(cfg, null, 1)));
  console.log('top-level keys:', Object.keys(cfg).join(', '));
  console.log('auth:', san(cfg.auth));
  for (const p of cfg.providers) {
    console.log(`  ${p.instanceId.padEnd(12)} driver=${p.driver.padEnd(12)} enabled=${p.enabled} installed=${p.installed} status=${p.status} auth=${p.auth.status} models=${p.models.length} usageLimits=${p.usageLimits ? trunc(JSON.stringify(p.usageLimits), 160) : 'absent'}`);
  }
  R.providers = cfg.providers.map((p) => ({ instanceId: p.instanceId, status: p.status, auth: p.auth.status, models: p.models.length, usageLimits: p.usageLimits ?? null }));
  const cfg2 = await s1.call('server.getConfig', { usageLimitSources: true, usageLimitsCommand: true }).catch(fail);
  console.log('getConfig with usageLimit flags ->', cfg2.providers ? 'ok; providers carrying usageLimits: ' + cfg2.providers.filter((p) => p.usageLimits).map((p) => p.instanceId).join(',') : trunc(san(cfg2), 400));

  h('3. subscribeServerConfig (stream)');
  const cfgItems = [];
  const subCfg = s1.subscribe('subscribeServerConfig', { environmentThemes: true, usageLimitSources: true, usageLimitsCommand: true, workspaceSnapshotsOnDemand: true }, (v) => {
    cfgItems.push(v);
    console.log('  item type=%s keys=%s', v.type, Object.keys(v).join(','));
  });
  await sleep(2500);
  const rp = await s1.call('server.refreshProviders', { usageLimitsCommand: true }).catch(fail);
  console.log('server.refreshProviders ->', trunc(san(rp), 300));
  await sleep(2500);
  subCfg.cancel();
  console.log('after Interrupt, stream end:', trunc(san((await Promise.race([subCfg.done, sleep(2000)])) ?? 'no exit within 2s'), 400));
  R.serverConfigItemTypes = cfgItems.map((v) => v.type);

  h('4. ping / pong');
  await sleep(6000);
  console.log('ping/pong frames:', frames.filter((f) => f.section.startsWith('4') && /Ping|Pong/.test(f.data)).map((f) => f.dir + ' ' + f.data).slice(0, 4));

  h('5. project + thread, subscribeThread snapshot and live events');
  const project = await s1.call('projects.ensureScratch', {});
  console.log('projects.ensureScratch ->', project);
  const threadId = randomUUID();
  const cmd = (type, extra) => s1.call('orchestration.dispatchCommand', { type, commandId: randomUUID(), threadId, ...extra });
  const created = await cmd('thread.create', { createdBy: 'user', creationSource: 'web', projectId: project.projectId, title: 'wp0d spike', modelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5' }, runtimeMode: 'approval-required', interactionMode: 'default', branch: null, worktreePath: null });
  console.log('dispatch thread.create ->', created);
  const items = [];
  const sub = s1.subscribe('orchestration.subscribeThread', { threadId, afterSequence: 0 }, (v) => {
    items.push(v);
    console.log('  ITEM kind=%s seq=%s type=%s', v.kind, v.sequence ?? v.snapshotSequence, v.event?.type ?? '');
  });
  await sleep(1200);
  console.log('rename (live) ->', await cmd('thread.metadata.update', { title: 'renamed once' }));
  await sleep(1000);

  h('6. dispatch: thread.model-selection.set / provider.switch');
  const tryCmd = async (label, type, extra) => {
    const r = await cmd(type, extra).catch(fail);
    console.log(label, '->', trunc(san(r), 900));
    R[label] = r;
    return r;
  };
  await tryCmd('model-selection.set (valid, same provider)', 'thread.model-selection.set', { modelSelection: { instanceId: 'claudeAgent', model: 'claude-sonnet-5-5' } });
  await tryCmd('model-selection.set (unknown instance)', 'thread.model-selection.set', { modelSelection: { instanceId: 'nope', model: 'x' } });
  await tryCmd('provider.switch (to codex, not installed on rig)', 'provider.switch', { modelSelection: { instanceId: 'codex', model: 'gpt-6.1-sol' } });
  await tryCmd('provider.switch (back to claudeAgent)', 'provider.switch', { modelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5' } });
  await tryCmd('invalid command type', 'thread.nonexistent', {});
  console.log('message.dispatch to create a run (claude is unauthenticated on this rig, expect a fast failure):');
  await tryCmd('message.dispatch', 'message.dispatch', { createdBy: 'user', creationSource: 'web', messageId: randomUUID(), text: 'hello', attachments: [], dispatchMode: { type: 'start_immediately' } });
  const raced = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 12000) {
    const r = await cmd('provider.switch', { modelSelection: { instanceId: raced.length % 2 ? 'claudeAgent' : 'codex', model: raced.length % 2 ? 'claude-opus-5-5' : 'gpt-6.1-sol' } }).catch(fail);
    raced.push({ ms: Date.now() - t0, r });
    if (r.error) { console.log('provider.switch error at +' + (Date.now() - t0) + 'ms:', trunc(san(r), 1200)); break; }
    await sleep(40);
  }
  console.log('provider.switch attempts after message.dispatch:', raced.length, 'busy error reproduced:', raced.some((x) => /ProviderSelectionBusy/.test(JSON.stringify(x.r))));
  R.raceResults = raced.slice(-3);
  await sleep(2500);
  console.log('events seen for the thread since subscribe:', items.length, [...new Set(items.map((v) => v.event?.type ?? v.kind))].join(', '));
  fs.writeFileSync(fx('subscribeThread-items.json'), san(JSON.stringify(items, null, 1)));
  R.allEventTypes = [...new Set(items.map((v) => v.event?.type ?? v.kind))];
  sub.cancel();
  const ex2 = await Promise.race([sub.done, sleep(2000)]);
  console.log('subscribeThread after Interrupt ->', trunc(san(ex2 ?? 'no exit within 2s'), 400));
  R.interruptExit = ex2 ?? null;

  h('7. error frames');
  console.log('unknown method ->', trunc(san(await s1.call('no.such.method', {}).catch(fail)), 600));
  console.log('bad payload ->', trunc(san(await s1.call('orchestration.subscribeThread', { nope: 1 }).catch(fail)), 600));

  h('8. reconnect / resubscribe from last sequence');
  const N = 40;
  const seen1 = [];
  const seen2 = [];
  const writer = (async () => {
    for (let i = 0; i < N; i++) {
      await s2.call('orchestration.dispatchCommand', { type: 'thread.metadata.update', commandId: randomUUID(), threadId, title: 'tick ' + i });
      await sleep(60);
    }
  })();
  const startSeq = (await s1.call('orchestration.getThreadProjection', { threadId }).catch(() => null)) ? 0 : 0;
  const rA = await open('readerA', await newTicket());
  let lastSeq = 0;
  rA.subscribe('orchestration.subscribeThread', { threadId, afterSequence: 0 }, (v) => {
    if (v.kind === 'event') { seen1.push(v.sequence); lastSeq = v.sequence; }
    else { seen1.push('snapshot@' + v.snapshotSequence); lastSeq = v.snapshotSequence; }
  });
  await sleep(900);
  rA.ws.close(); // abrupt: no Interrupt frame, no unsubscribe
  const lostAt = lastSeq;
  console.log('killed reader A after sequence', lostAt, '(items seen', seen1.length + ')');
  await sleep(600); // gap while the writer keeps going
  const rB = await open('readerB', await newTicket());
  rB.subscribe('orchestration.subscribeThread', { threadId, afterSequence: lostAt }, (v) => {
    seen2.push(v.kind === 'event' ? v.sequence : 'snapshot@' + v.snapshotSequence);
  });
  await writer;
  await sleep(1000);
  const nums = (a) => a.filter((x) => typeof x === 'number');
  const all = [...nums(seen1), ...nums(seen2)];
  const uniq = [...new Set(all)].sort((a, b) => a - b);
  const contiguous = uniq.every((x, i) => i === 0 || x === uniq[i - 1] + 1);
  console.log('A saw', seen1.join(','));
  console.log('B (afterSequence=%d) saw', lostAt, seen2.join(','));
  console.log('union: first', uniq[0], 'last', uniq.at(-1), 'distinct', uniq.length, 'received total', all.length, '=> duplicates', all.length - uniq.length, '| contiguous', contiguous);
  console.log('B first item is', typeof seen2[0] === 'string' ? seen2[0] : 'an event (no snapshot)');
  R.reconnect = { lostAt, aItems: seen1.length, bItems: seen2, duplicates: all.length - uniq.length, contiguous, bFirst: seen2[0] };
  void startSeq;
  rB.close();
  s1.close(); s2.close(); parts?.close();
} catch (e) {
  console.error('SPIKE ERROR', e);
  process.exitCode = 1;
} finally {
  fs.writeFileSync(fx('standalone-frames.jsonl'), frames.map((f) => JSON.stringify(f)).join('\n') + '\n');
  fs.writeFileSync(fx('results.json'), san(JSON.stringify(R, null, 1)));
  t.close();
}
