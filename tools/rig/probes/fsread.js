// fs.read path defences on a slot patched with `patch-slot.ps1 -Slot 1 -Plugins` (test-plugin holds fs.read on
// ~/fsread-root). Run: node tools/rig/cdp-eval.mjs --slot 1 "$(cat tools/rig/probes/fsread.js)"
(async () => {
  const n = window.__t3p_native;
  const strip = (e) => e.message.replace(/^Error invoking remote method '[^']+': Error: /, "");
  const r = async (plugin, p) => { try { const v = await n.invoke("t3p:native:fs.read", { plugin, path: p }); return "OK " + v.data; } catch (e) { return "ERR " + strip(e); } };
  const root = String.raw`G:\rig-run\t3patcher\p-s1`;
  return JSON.stringify({
    inside: await r("test-plugin", root + String.raw`\fsread-root\hello.txt`),
    tilde: await r("test-plugin", "~/fsread-root/hello.txt"),
    outside: await r("test-plugin", root + String.raw`\outside.txt`),
    traversal: await r("test-plugin", root + String.raw`\fsread-root\..\outside.txt`),
    devicePath: await r("test-plugin", String.raw`\?\G:\rig-run\t3patcher\p-s1\outside.txt`),
    ads: await r("test-plugin", root + String.raw`\fsread-root\hello.txt::$DATA`),
    otherPluginNoGrant: await r("after-renderer", root + String.raw`\fsread-root\hello.txt`),
    notAllowlisted: await n.invoke("desktop:get-bearer").then(() => "OK", (e) => "ERR " + e.message),
  }, null, 1);
})()
