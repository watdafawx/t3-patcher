'use strict';
// WP-0C spike shim. Lives as the entry of a REPLACEMENT resources/app.asar (the original is renamed _app.asar).
// Fail-open: any error in the patch layer is logged and the stock app still starts.
const fs = require('fs');
const path = require('path');
const electron = require('electron');

const DIR = process.env.T3P_SPIKE_DIR || 'G:/rig-run/t3patcher/spike/wp0c';
const T0 = Date.now();
function log(msg) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(path.join(DIR, 'shim.log'), `${new Date().toISOString()} [${process.type}] ${msg}\n`);
  } catch (e) { try { process.stderr.write('T3P-LOGFAIL ' + e.message + '\n'); } catch {} }
}
// config is re-read on every request so a run can change marker/tag without repacking the asar
function cfg() {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8')); } catch { return {}; }
}

function install() {
  const { app, protocol, session } = electron;
  log(`shim start argv=${JSON.stringify(process.argv)} appPath=${app.getAppPath()} name=${app.name} version=${app.getVersion()} userData=${app.getPath('userData')} isPackaged=${app.isPackaged}`);

  // ---- observe the scheme privileges main registers (read only)
  const origPriv = protocol.registerSchemesAsPrivileged.bind(protocol);
  protocol.registerSchemesAsPrivileged = (schemes) => {
    log('registerSchemesAsPrivileged ' + JSON.stringify(schemes));
    return origPriv(schemes);
  };

  // ---- wrap protocol.handle for t3code
  const origHandle = protocol.handle.bind(protocol);
  protocol.handle = (scheme, handler) => {
    if (scheme !== 't3code') return origHandle(scheme, handler);
    log('protocol.handle(t3code) wrapped');
    return origHandle(scheme, async (request) => {
      // virtual route served entirely by the shim (CSP external-script test)
      try {
        const u = new URL(request.url);
        if (u.host === 'app' && u.pathname === '/__t3p/ext.js') {
          return new Response('(window.__t3p_order=window.__t3p_order||[]).push(["ext-virtual",performance.now()]);window.__t3p_ext_virtual=1;',
            { headers: { 'content-type': 'text/javascript; charset=utf-8' } });
        }
      } catch {}
      const response = await handler(request);
      if (cfg().logAll) log('req ' + new URL(request.url).pathname + ' ' + response.status + ' ' + (response.headers.get('content-type') || ''));
      try { return await patch(request, response); } catch (e) { log('patch error ' + (e && e.stack)); return response; }
    });
  };

  async function patch(request, response) {
    if (request.method !== 'GET' || response.status !== 200) return response;
    const u = new URL(request.url);
    const c = cfg();
    const ct = response.headers.get('content-type') || '';
    const isHtml = /text\/html/i.test(ct);
    const isChunk = !!c.chunk && u.pathname === '/assets/' + c.chunk;
    if (!isHtml && !isChunk) return response; // untouched: same Response object, still streaming
    const before = [...response.headers.entries()].map(([k, v]) => `${k}=${v.slice(0, 40)}`).join('|');
    let text = await response.text();
    const origLen = text.length;
    if (isHtml) {
      let inject = '<script>window.__t3p_test=1;(window.__t3p_order=window.__t3p_order||[]).push(["index.html",performance.now()]);</script>';
      for (const src of [].concat(c.ext || [])) inject += `<script src="${src}"></script>`;
      const i = text.indexOf('<script');
      text = i >= 0 ? text.slice(0, i) + inject + '\n    ' + text.slice(i) : text + inject;
    } else {
      text += `\n;(window.__t3p_order=window.__t3p_order||[]).push(["chunk",performance.now()]);window.__t3p_chunk_tag=${JSON.stringify(c.tag || '')};\n${c.marker || '/*T3P_MARKER*/'}`;
    }
    const headers = new Headers(response.headers);
    headers.delete('content-length'); // body size changed; let Response compute
    log(`patched ${u.pathname} ${origLen}->${text.length} origHeaders=[${before}]`);
    return new Response(text, { status: response.status, statusText: response.statusText, headers });
  }

  // ---- preload on the default session
  app.whenReady().then(() => {
    const c = cfg();
    const file = c.preload || path.join(DIR, 'preload.js');
    const ses = session.defaultSession;
    try {
      if (c.preloadApi === 'setPreloads') { ses.setPreloads([file]); log('setPreloads ok ' + file); }
      else { const id = ses.registerPreloadScript({ type: 'frame', filePath: file }); log('registerPreloadScript ok id=' + id + ' ' + file); }
    } catch (e) { log('preload registration failed ' + (e && e.stack)); }
  });
}

try { install(); } catch (e) { log('install failed (fail-open): ' + (e && e.stack)); }
require(path.join(process.resourcesPath, '_app.asar'));
log(`real app required after ${Date.now() - T0}ms; name=${electron.app.name} userData=${electron.app.getPath('userData')}`);
