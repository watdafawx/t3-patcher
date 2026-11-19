// Which contexts can reach window.__t3p_native: main frame, a preview-partition <webview>, a same-origin iframe, a
// sandboxed iframe. Run on a patched slot: node tools/rig/cdp-eval.mjs --slot N --timeout 40000 "$(cat tools/rig/probes/frames.js)"
(async () => {
  const out = {};
  out.main = await window.__t3p_native.invoke("t3p:ping").then((r) => "ok v" + r.version, (e) => "rejected " + e.message);
  // 1) preview-browser webview (the only partition T3 Code lets attach): separate session, no t3p preload
  const wv = document.createElement("webview");
  wv.setAttribute("partition", "t3code-preview-ephemeral-t3ptest");
  wv.setAttribute("src", "data:text/html,<p>guest</p>");
  wv.style.cssText = "position:fixed;left:0;top:0;width:200px;height:150px;opacity:0.01";
  const ready = new Promise((r, j) => { wv.addEventListener("dom-ready", r, { once: true }); setTimeout(() => j(new Error("no dom-ready")), 15000); });
  document.body.appendChild(wv);
  try {
    await ready;
    out.webviewGuest = await wv.executeJavaScript("typeof window.__t3p_native + ' / ' + typeof window.__t3p");
    out.webviewGuestId = wv.getWebContentsId();
  } catch (e) {
    out.webviewGuest = "error " + e.message;
  } finally {
    wv.remove();
  }
  // 2) same-origin iframe: no own bridge; can reach the parent's (documented limitation)
  const f = document.createElement("iframe");
  f.style.cssText = "position:fixed;left:0;top:0;width:10px;height:10px;opacity:0.01";
  document.body.appendChild(f);
  out.iframeOwn = typeof f.contentWindow.__t3p_native;
  const viaParent = new Promise((r) => { window.__t3pProbeDone = r; setTimeout(() => r("no result"), 5000); });
  const s = f.contentDocument.createElement("script");
  s.textContent = "parent.__t3p_native.invoke('t3p:ping').then((r) => parent.__t3pProbeDone('accepted (main frame bridge) v' + r.version), (e) => parent.__t3pProbeDone('rejected ' + e.message));";
  f.contentDocument.body.appendChild(s);
  out.iframeViaParent = await viaParent;
  f.remove();
  // 3) cross-origin (sandboxed srcdoc) iframe cannot touch the parent
  const g = document.createElement("iframe");
  g.setAttribute("sandbox", "allow-scripts");
  g.srcdoc = "<script>let r; try { r = typeof parent.__t3p_native; } catch (e) { r = 'blocked: ' + e.name } parent.postMessage({ t3pProbe: r, own: typeof window.__t3p_native }, '*');</script>";
  const msg = new Promise((r) => { const h = (e) => { if (e.data && e.data.t3pProbe) { removeEventListener("message", h); r(e.data); } }; addEventListener("message", h); setTimeout(() => r({ t3pProbe: "no message" }), 5000); });
  document.body.appendChild(g);
  out.sandboxedIframe = await msg;
  g.remove();
  return JSON.stringify(out);
})()
