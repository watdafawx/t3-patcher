// Runs INSIDE the page main world (paste into cdp-eval). Proves a renderer plugin can authenticate and call RPC by itself.
(async () => {
  const b = window.desktopBridge;
  const env = (await b.getLocalEnvironmentBootstraps())[0];          // {httpBaseUrl, wsBaseUrl, bootstrapToken(secret), ...}
  const bearer = await b.getLocalEnvironmentBearerToken();           // cached access token of the desktop's own session
  const r = await fetch(new URL('/api/auth/websocket-ticket/rpc', env.httpBaseUrl), { method: 'POST', headers: { authorization: 'Bearer ' + bearer } });
  const { ticket } = await r.json();
  const ws = new WebSocket(`${env.wsBaseUrl}ws?wsTicket=${encodeURIComponent(ticket)}&orchestrationProtocol=2`);
  const res = await new Promise((resolve, reject) => {
    ws.onopen = () => ws.send(JSON.stringify({ _tag: 'Request', id: 0, tag: 'server.getConfig', payload: {}, headers: [] }));
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m._tag === 'Exit') resolve(m.exit); };
    ws.onerror = () => reject(new Error('ws error'));
    setTimeout(() => reject(new Error('timeout')), 8000);
  });
  ws.close();
  return { origin: location.origin, ticketStatus: r.status, cookiesVisible: document.cookie.length, exit: res._tag, providers: res.value?.providers?.map((p) => p.instanceId), bootstrapKeys: Object.keys(env) };
})()
