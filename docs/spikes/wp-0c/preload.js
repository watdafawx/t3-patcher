// WP-0C extra preload (registered on session.defaultSession). Runs in the sandboxed preload world.
const { contextBridge, webFrame } = require('electron');
if (location.protocol === 't3code:') {
  const t = performance.now();
  contextBridge.exposeInMainWorld('__t3p_probe', { ok: true, t, contextIsolated: process.contextIsolated, sandboxed: process.sandboxed, isMainFrame: process.isMainFrame });
  const code = `window.__t3p_early=1;(window.__t3p_order=window.__t3p_order||[]).push(["early-executeJavaScript",performance.now()]);`;
  try { webFrame.executeJavaScript(code); } catch (e) { contextBridge.exposeInMainWorld('__t3p_probe_err', String(e)); }
  // variant B: DOM-injected <script> as soon as documentElement exists
  const inject = () => {
    const s = document.createElement('script');
    s.textContent = `document.addEventListener('securitypolicyviolation',e=>{(window.__t3p_csp=window.__t3p_csp||[]).push([e.blockedURI,e.violatedDirective])});window.__t3p_early_dom=1;(window.__t3p_order=window.__t3p_order||[]).push(["early-dom-script",performance.now()]);`;
    (document.head || document.documentElement).prepend(s);
    s.remove();
  };
  if (document.documentElement) inject();
  else new MutationObserver((_, o) => { if (document.documentElement) { o.disconnect(); inject(); } }).observe(document, { childList: true });
}
