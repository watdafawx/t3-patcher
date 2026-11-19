#!/usr/bin/env node
// Measures what an Artwork full-app background costs the WHOLE app, not just its draw().
//
//   node tools/rig/perf/bg-perf.mjs --slot 3 [--set baseline] [--only name1,name2] [--seconds 5] [--no-trace] [--out file.json]
//
// Needs a patched rig slot with the artwork plugin enabled (tools/rig/patch-slot.ps1 + copy the plugin, see README.md here),
// running (tools/rig/launch.ps1). Talks CDP through an ssh tunnel (cdp.mjs). For every scenario of the chosen set
// (scenarios.mjs) it applies the artwork settings through window.__t3p.manager, runs any experiment setup JS, then
// records two windows of --seconds each:
//   idle: nothing happens in the app; shows the background's own cost (frames produced, GPU/compositor busy time)
//   work: synthetic chat streaming + CDP key presses into a textarea + CDP wheel scrolling (probe.js); shows what the user feels
// Per window: rAF frame deltas, long animation frames, Event Timing, key input delay, stream-append-to-frame lag,
// Performance.getMetrics deltas, per-process CPU (SystemInfo.getProcessInfo), a trace (frames, dropped frames, busy
// time per thread: renderer main / compositor / raster, GPU main, viz compositor), and once per scenario a LayerTree
// snapshot (layer count, drawn layer area in MB at device scale).
// Prints a summary table; --out writes the raw summary JSON.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { attach, evaluate, sleep } from "./cdp.mjs";
import { RESET_JS, SETS } from "./scenarios.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = { slot: 3, port: null, direct: false, set: "baseline", only: null, seconds: 5, trace: true, out: null, settle: 2500, repeat: 1 };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--slot") opt.slot = Number(argv[++i]);
  else if (a === "--port") opt.port = Number(argv[++i]);
  else if (a === "--direct") opt.direct = true;
  else if (a === "--set") opt.set = argv[++i];
  else if (a === "--only") opt.only = argv[++i].split(",");
  else if (a === "--seconds") opt.seconds = Number(argv[++i]);
  else if (a === "--settle") opt.settle = Number(argv[++i]);
  else if (a === "--repeat") opt.repeat = Number(argv[++i]);
  else if (a === "--no-trace") opt.trace = false;
  else if (a === "--out") opt.out = argv[++i];
  else {
    console.error(`unknown arg ${a}`);
    process.exit(2);
  }
}
if (opt.port == null) opt.port = 9333 + opt.slot - 1;
let scenarios = SETS[opt.set];
if (!scenarios) {
  console.error(`unknown set ${opt.set}; sets: ${Object.keys(SETS).join(", ")}`);
  process.exit(2);
}
if (opt.only) scenarios = scenarios.filter((s) => opt.only.includes(s.name));

const CATEGORIES = [
  "toplevel",
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "cc",
  "gpu",
  "viz",
  "benchmark",
  "__metadata",
];
const RUN_TASK = new Set(["ThreadControllerImpl::RunTask", "ThreadPool_RunTask", "TaskQueueManager::ProcessTaskFromWorkQueue", "RunTask"]);
const PHASES = ["Paint", "RasterTask", "PrePaint", "Layerize", "Layout", "UpdateLayoutTree", "Commit", "CompositeLayers", "FunctionCall", "FireAnimationFrame"];

// ---- stats ----------------------------------------------------------------------------------------
const sorted = (a) => [...a].sort((x, y) => x - y);
const pct = (a, p) => (a.length ? sorted(a)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : 0);
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;

function frameStats(deltas, vsync, seconds) {
  let dropped = 0;
  for (const d of deltas) dropped += Math.max(0, Math.round(d / vsync) - 1);
  return { n: deltas.length, avg: r2(avg(deltas)), p95: r2(pct(deltas, 95)), max: r2(Math.max(0, ...deltas)), droppedPerSec: r2(dropped / seconds) };
}

// ---- trace ----------------------------------------------------------------------------------------
async function readStream(page, handle) {
  let data = "";
  for (;;) {
    const r = await page.send("IO.read", { handle, size: 1 << 22 });
    data += r.base64Encoded ? Buffer.from(r.data, "base64").toString() : r.data;
    if (r.eof) break;
  }
  await page.send("IO.close", { handle });
  return data;
}

function analyzeTrace(events, seconds) {
  const procName = new Map();
  const threadName = new Map();
  for (const e of events) {
    if (e.ph !== "M") continue;
    if (e.name === "process_name") procName.set(e.pid, e.args?.name);
    if (e.name === "thread_name") threadName.set(`${e.pid}:${e.tid}`, e.args?.name);
  }
  const busy = new Map();
  const phases = Object.fromEntries(PHASES.map((p) => [p, { n: 0, ms: 0 }]));
  let draw = 0;
  let dropped = 0;
  let beginFrames = 0;
  for (const e of events) {
    if (e.ph === "X" && RUN_TASK.has(e.name) && (e.cat ?? "").includes("toplevel")) {
      const key = `${procName.get(e.pid) ?? e.pid} / ${(threadName.get(`${e.pid}:${e.tid}`) ?? String(e.tid)).replace(/\d+$/, "")}`;
      busy.set(key, (busy.get(key) ?? 0) + (e.dur ?? 0) / 1000);
    }
    if (PHASES.includes(e.name) && (e.ph === "X" || e.ph === "B")) {
      phases[e.name].n++;
      phases[e.name].ms += (e.dur ?? 0) / 1000;
    }
    if (e.name === "DrawFrame") draw++;
    if (e.name === "DroppedFrame") dropped++;
    if (e.name === "BeginFrame") beginFrames++;
  }
  const threads = Object.fromEntries([...busy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => [k, r1(v / seconds)]));
  const sum = (re) => r1([...busy.entries()].filter(([k]) => re.test(k)).reduce((s, [, v]) => s + v, 0) / seconds);
  return {
    drawFramesPerSec: r1(draw / seconds),
    droppedFramesTrace: dropped,
    beginFramesPerSec: r1(beginFrames / seconds),
    busyMsPerSec: {
      rendererMain: sum(/Renderer \/ CrRendererMain/),
      rendererCompositor: sum(/Renderer \/ Compositor$/),
      raster: sum(/Renderer \/ CompositorTileWorker/),
      gpuMain: sum(/GPU Process \/ CrGpuMain/),
      viz: sum(/GPU Process \/ VizCompositorThread/),
      gpuTotal: sum(/^GPU Process/),
      browserMain: sum(/Browser \/ CrBrowserMain/),
    },
    phasesMsPerSec: Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, { perSec: r1(v.n / seconds), ms: r1(v.ms / seconds) }])),
    threads,
  };
}

// ---- process cpu ----------------------------------------------------------------------------------
async function processCpu(browser) {
  try {
    const r = await browser.send("SystemInfo.getProcessInfo");
    const out = {};
    for (const p of r.processInfo) out[p.type] = (out[p.type] ?? 0) + p.cpuTime;
    return out;
  } catch {
    return null;
  }
}

// ---- metrics --------------------------------------------------------------------------------------
async function metrics(page) {
  const r = await page.send("Performance.getMetrics");
  return Object.fromEntries(r.metrics.map((m) => [m.name, m.value]));
}

async function layerSnapshot(page, dpr, vw, vh) {
  let last = null;
  const off = page.on("LayerTree.layerTreeDidChange", (p) => {
    if (p.layers) last = p.layers;
  });
  try {
    await page.send("LayerTree.enable", {}, 30000);
    const t0 = Date.now();
    while (!last && Date.now() - t0 < 3000) await sleep(100);
    await page.send("LayerTree.disable", {}, 30000);
  } catch (e) {
    console.error(`   layer snapshot: ${e.message}`);
  } finally {
    off();
  }
  if (!last) return null;
  const drawn = last.filter((l) => l.drawsContent);
  // LayerTree sizes are already in device pixels.
  const px = drawn.reduce((s, l) => s + l.width * l.height, 0);
  const big = drawn.filter((l) => l.width * l.height > 0.3 * vw * vh * dpr * dpr).length;
  return { layers: last.length, drawn: drawn.length, bigLayers: big, mb: r1((px * 4) / (1 << 20)) };
}

// ---- run --------------------------------------------------------------------------------------------
async function measureWindow(s, { workload, label, traced = false }) {
  const { page, browser } = s;
  const seconds = opt.seconds;
  const m0 = await metrics(page);
  const c0 = await processCpu(browser);
  let traceDone = null;
  if (traced) {
    traceDone = new Promise((res) => {
      const off = page.on("Tracing.tracingComplete", (p) => {
        off();
        res(p.stream);
      });
    });
    await page.send("Tracing.start", { transferMode: "ReturnAsStream", traceConfig: { includedCategories: CATEGORIES, recordMode: "recordAsMuchAsPossible" } });
  }
  const wall0 = Date.now();
  const info = await evaluate(page, `__t3pPerf.start(${JSON.stringify({ workload })})`);
  if (workload) {
    const c = await evaluate(page, "__t3pPerf.boxCenter()");
    const end = Date.now() + seconds * 1000;
    let k = 0;
    while (Date.now() < end) {
      // A key every ~100 ms, a wheel tick every ~300 ms.
      await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", text: "a", windowsVirtualKeyCode: 65 });
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
      if (k % 3 === 0) await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: c.x, y: c.y, deltaX: 0, deltaY: k % 6 === 0 ? -360 : 360 });
      k++;
      await sleep(100);
    }
  } else await sleep(seconds * 1000);
  const raw = await evaluate(page, "__t3pPerf.stop()");
  const wall = (Date.now() - wall0) / 1000;
  let trace = null;
  if (traced) {
    await page.send("Tracing.end");
    const handle = await traceDone;
    const text = await readStream(page, handle);
    const json = JSON.parse(text);
    trace = analyzeTrace(json.traceEvents ?? json, wall);
  }
  const m1 = await metrics(page);
  const c1 = await processCpu(browser);
  const cpu = c0 && c1 ? Object.fromEntries(Object.keys(c1).map((k) => [k, r1(((c1[k] - (c0[k] ?? 0)) / wall) * 100)])) : null;
  const dm = (k) => r1(((m1[k] ?? 0) - (m0[k] ?? 0)) * 1000 / wall);
  return { label, info, raw, wall, cpu, trace, metricsMsPerSec: { task: dm("TaskDuration"), script: dm("ScriptDuration"), layout: dm("LayoutDuration"), style: dm("RecalcStyleDuration") } };
}

function summarize(win, vsync) {
  const raw = win.raw;
  const out = {
    focus: raw.focus,
    bgDrawsPerSec: r1(raw.bgDraws / win.wall),
    frames: frameStats(raw.frames, vsync, win.wall),
    loaf: { n: raw.loaf.length, blockingMs: r1(raw.loaf.reduce((s, x) => s + x.b, 0)), maxMs: r1(Math.max(0, ...raw.loaf.map((x) => x.d))) },
    cpuPct: win.cpu,
    mainMsPerSec: win.metricsMsPerSec,
  };
  if (raw.keys.length) out.keys = { n: raw.keys.length, delayAvg: r2(avg(raw.keys.map((k) => k.delay))), delayP95: r2(pct(raw.keys.map((k) => k.delay), 95)), toFrameAvg: r2(avg(raw.keys.map((k) => k.toFrame))), toFrameP95: r2(pct(raw.keys.map((k) => k.toFrame), 95)) };
  if (raw.appends.length) out.stream = { n: raw.appends.length, lagAvg: r2(avg(raw.appends)), lagP95: r2(pct(raw.appends, 95)) };
  if (raw.events.length) out.eventTiming = { n: raw.events.length, p95: r1(pct(raw.events.map((e) => e.d), 95)), max: r1(Math.max(...raw.events.map((e) => e.d))) };
  if (win.trace) out.trace = win.trace;
  return out;
}

const s = await attach({ port: opt.port, direct: opt.direct });
const results = [];
try {
  await s.page.send("Performance.enable");
  await s.page.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await evaluate(s.page, readFileSync(join(here, "probe.js"), "utf8"));
  await evaluate(s.page, "window.__t3p.ready.then(() => true)");
  // vsync estimate: median rAF delta of an idle second with every background off.
  await evaluate(s.page, `(async () => { const m = window.__t3p.manager; await m.setSetting("artwork", "oceanOn", false); })()`);
  await sleep(800);
  const cal = await evaluate(s.page, `new Promise((res) => { const d = []; let l = 0; const f = (t) => { if (l) d.push(t - l); l = t; d.length < 90 ? requestAnimationFrame(f) : res(d); }; requestAnimationFrame(f); })`);
  const vsync = sorted(cal)[Math.floor(cal.length / 2)];
  const realDpr = await evaluate(s.page, "devicePixelRatio");
  const vp = await evaluate(s.page, "({ w: innerWidth, h: innerHeight })");
  console.error(`viewport ${vp.w}x${vp.h} CSS px at dpr ${realDpr}`);
  console.error(`vsync ~${r2(vsync)} ms (${r1(1000 / vsync)} Hz), ${s.version.Browser}`);
  for (let rep = 0; rep < opt.repeat; rep++) {
    for (const sc of scenarios) {
      console.error(`-- ${sc.name}`);
      await evaluate(s.page, `(async () => { const m = window.__t3p.manager; await m.setSetting("artwork", "oceanOn", false); ${RESET_JS} })()`);
      await sleep(600);
      const settings = { ...sc.settings };
      await evaluate(s.page, `(async () => { const m = window.__t3p.manager; for (const [k, v] of Object.entries(${JSON.stringify(settings)})) await m.setSetting("artwork", k, v); })()`);
      await evaluate(s.page, "window.dispatchEvent(new Event('focus'))");
      if (sc.setup) await evaluate(s.page, `(async () => { ${sc.setup} })()`);
      await sleep(opt.settle);
      if (sc.after) await evaluate(s.page, `(async () => { ${sc.after} })()`);
      const dpr = realDpr;
      const custom = await evaluate(s.page, "document.documentElement.hasAttribute('data-t3p-cbg')");
      if (custom) console.error("   WARNING: a Custom HTML/CSS background is active and replaces the preset; clear the slot's artwork storage");
      const layers = await layerSnapshot(s.page, dpr, vp.w, vp.h);
      const idle = summarize(await measureWindow(s, { workload: false, label: "idle" }), vsync);
      const work = summarize(await measureWindow(s, { workload: true, label: "work" }), vsync);
      // Traced windows run separately: tracing gpu/cc categories costs CPU itself and would skew the clean numbers above.
      if (opt.trace) {
        idle.trace = (await measureWindow(s, { workload: false, label: "idle-trace", traced: true })).trace;
        work.trace = (await measureWindow(s, { workload: true, label: "work-trace", traced: true })).trace;
      }
      const bgPerf = await evaluate(s.page, `(() => { const a = window.__t3pBgPerf; return Array.isArray(a) && a.length ? { n: a.length, avg: a.reduce((s, x) => s + x, 0) / a.length } : null; })()`);
      results.push({ name: sc.name, note: sc.note ?? "", layers, idle, work, drawCost: bgPerf });
      if (sc.teardown) await evaluate(s.page, `(async () => { ${sc.teardown} })()`);
      printRow(results.at(-1));
    }
  }
  await evaluate(s.page, `(async () => { const m = window.__t3p.manager; await m.setSetting("artwork", "oceanOn", false); ${RESET_JS} })()`);
} finally {
  s.close();
}
if (opt.out) writeFileSync(opt.out, JSON.stringify({ when: new Date().toISOString(), browser: s.version.Browser, seconds: opt.seconds, results }, null, 2));
console.log("\n" + table(results));

function printRow(r) {
  console.error(`   idle frames ${r.idle.frames.avg}/${r.idle.frames.p95} ms drop/s ${r.idle.frames.droppedPerSec} gpu% ${r.idle.cpuPct?.GPU ?? "?"} | work frames ${r.work.frames.avg}/${r.work.frames.p95} drop/s ${r.work.frames.droppedPerSec} key ${r.work.keys?.delayAvg}/${r.work.keys?.toFrameP95} stream p95 ${r.work.stream?.lagP95} gpu% ${r.work.cpuPct?.GPU ?? "?"} draws/s ${r.idle.bgDrawsPerSec}/${r.work.bgDrawsPerSec} focus ${r.idle.focus}/${r.work.focus} | trace idle draw/s ${r.idle.trace?.drawFramesPerSec ?? "-"} gpuBusy ${r.idle.trace?.busyMsPerSec.gpuTotal ?? "-"} work gpuBusy ${r.work.trace?.busyMsPerSec.gpuTotal ?? "-"} layers ${r.layers?.layers}/${r.layers?.mb}MB`);
}

function table(rows) {
  const head = "| scenario | idle frame avg/p95 ms | idle drop/s | idle GPU CPU % | idle renderer CPU % | idle GPU busy ms/s | work frame avg/p95 ms | work drop/s | key delay avg ms | key→frame p95 ms | stream→frame p95 ms | LoAF n / blocking ms | work GPU CPU % | work renderer CPU % | layers / MB |";
  const sep = "|" + "---|".repeat(15);
  const lines = rows.map((r) =>
    [
      r.name,
      `${r.idle.frames.avg} / ${r.idle.frames.p95}`,
      r.idle.frames.droppedPerSec,
      r.idle.cpuPct?.GPU ?? "?",
      r.idle.cpuPct?.renderer ?? "?",
      r.idle.trace?.busyMsPerSec.gpuTotal ?? "-",
      `${r.work.frames.avg} / ${r.work.frames.p95}`,
      r.work.frames.droppedPerSec,
      r.work.keys?.delayAvg ?? "-",
      r.work.keys?.toFrameP95 ?? "-",
      r.work.stream?.lagP95 ?? "-",
      `${r.work.loaf.n} / ${r.work.loaf.blockingMs}`,
      r.work.cpuPct?.GPU ?? "?",
      r.work.cpuPct?.renderer ?? "?",
      r.layers ? `${r.layers.layers} / ${r.layers.mb}` : "-",
    ].join(" | "),
  );
  return [head, sep, ...lines.map((l) => `| ${l} |`)].join("\n");
}
