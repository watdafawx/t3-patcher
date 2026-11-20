#!/usr/bin/env node
// Dumps the composited layers (size in CSS px, drawsContent, compositing reasons) of the slot's page, optionally after
// applying artwork settings. Shows which app layers a background forces into their own (big, transparent) layers.
//   node tools/rig/perf/layers.mjs --slot 3 [--set '{"oceanOn":true,"bgKind":"starfield"}'] [--min 0.2]
// --min: only list layers covering at least this share of the viewport (default 0.2).
import { attach, evaluate, sleep } from "./cdp.mjs";

const argv = process.argv.slice(2);
const get = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const slot = Number(get("--slot", 3));
const settings = JSON.parse(get("--set", "{}"));
const min = Number(get("--min", 0.2));
const s = await attach({ port: 9333 + slot - 1 });
try {
  await evaluate(s.page, `(async () => { await window.__t3p.ready; for (const [k, v] of Object.entries(${JSON.stringify(settings)})) await window.__t3p.manager.setSetting("artwork", k, v); })()`);
  await sleep(2500);
  const vp = await evaluate(s.page, "({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })");
  let layers = null;
  const off = s.page.on("LayerTree.layerTreeDidChange", (p) => {
    if (p.layers) layers = p.layers;
  });
  await s.page.send("LayerTree.enable", {}, 30000);
  const t0 = Date.now();
  while (!layers && Date.now() - t0 < 4000) await sleep(100);
  const big = (layers ?? []).filter((l) => l.width * l.height >= min * vp.w * vp.h);
  const rows = [];
  for (const l of big) {
    let reasons = [];
    try {
      reasons = (await s.page.send("LayerTree.compositingReasons", { layerId: l.layerId }, 10000)).compositingReasonIds ?? [];
    } catch {
      /* ignore */
    }
    let node = "";
    if (l.backendNodeId) {
      try {
        const d = await s.page.send("DOM.describeNode", { backendNodeId: l.backendNodeId }, 10000);
        const a = d.node.attributes ?? [];
        const attr = (n) => {
          const i = a.indexOf(n);
          return i >= 0 ? a[i + 1] : "";
        };
        node = `${d.node.nodeName.toLowerCase()}${attr("id") ? "#" + attr("id") : ""}${attr("data-slot") ? `[data-slot=${attr("data-slot")}]` : ""}`;
      } catch {
        /* ignore */
      }
    }
    rows.push({ id: l.layerId, node, w: Math.round(l.width), h: Math.round(l.height), draws: l.drawsContent, reasons: reasons.join(",") });
  }
  await s.page.send("LayerTree.disable", {}, 30000);
  off();
  const drawn = (layers ?? []).filter((l) => l.drawsContent);
  const mb = (drawn.reduce((a, l) => a + l.width * l.height, 0) * vp.dpr * vp.dpr * 4) / (1 << 20);
  console.log(JSON.stringify({ viewport: vp, layers: layers?.length ?? 0, drawn: drawn.length, mb: Math.round(mb), big: rows }, null, 1));
} finally {
  s.close();
}
