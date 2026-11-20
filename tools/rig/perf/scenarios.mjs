// Scenario sets for bg-perf.mjs. A scenario = artwork settings (applied through window.__t3p.manager.setSetting) plus
// optional page JS: `setup` runs right after the settings, `after` after the settle delay, `teardown` after measuring.
// RESET_JS runs before every scenario and undoes every experiment hook below.

export const RESET_JS = `
window.__t3pBgPerf = [];
document.getElementById("t3p-perf-exp")?.remove();
if (window.__t3pDprOrig) { Object.defineProperty(window, "devicePixelRatio", window.__t3pDprOrig); delete window.__t3pDprOrig; delete window.__t3pDpr; window.dispatchEvent(new Event("resize")); }
`;

/** Injects CSS for an experiment (removed by RESET_JS). */
const css = (text) => `{ const s = document.createElement("style"); s.id = "t3p-perf-exp"; s.textContent = ${JSON.stringify(text)}; document.head.appendChild(s); }`;
/** Fakes devicePixelRatio and fires resize, so the canvas presets re-size their backing store at that ratio. */
const dpr = (v) => `window.__t3pDprOrig ??= Object.getOwnPropertyDescriptor(window, "devicePixelRatio"); Object.defineProperty(window, "devicePixelRatio", { configurable: true, get: () => ${v} }); window.__t3pDpr = ${v}; window.dispatchEvent(new Event("resize"));`;

const DEFAULTS = { bgIntensity: 60, bgSpeed: 50, bgDensity: 50, bgPointer: true, bgFollowAccent: true, bgLowPower: false, oceanSpeed: 50, oceanIntensity: 60, bgDim: 0, bgBlur: 0, bgQuality: "auto", bgPauseWhileTyping: true };
const bg = (kind, extra = {}) => ({ ...DEFAULTS, oceanOn: true, bgKind: kind, ...extra });
/** Makes the surfaces markSurfaces cleared opaque again (the background is then only visible where nothing covers it). */
const opaque = (attr) => css(`html[${attr}] [${attr}-clear][${attr}-clear], html[${attr}] [data-slot="sidebar-inset"][data-slot]{background-color:var(--background)!important}`);

/** Re-mounts the running background with its 2D context on the CPU (`willReadFrequently`), or back on the GPU. */
const remount = `const m = window.__t3p.manager; await m.setSetting("artwork", "oceanOn", false); await m.setSetting("artwork", "oceanOn", true);`;
const cpuCanvas = `const P = HTMLCanvasElement.prototype; window.__t3pGetCtx = P.getContext; P.getContext = function (type, opts) { return window.__t3pGetCtx.call(this, type, type === "2d" ? { ...opts, willReadFrequently: true } : opts); }; ${remount}`;
const gpuCanvas = `HTMLCanvasElement.prototype.getContext = window.__t3pGetCtx; delete window.__t3pGetCtx; ${remount}`;

export const SETS = {
  baseline: [
    { name: "off", settings: { ...DEFAULTS, oceanOn: false } },
    { name: "ocean", settings: bg("ocean") },
    { name: "drift", settings: bg("drift") },
    { name: "starfield", settings: bg("starfield") },
  ],
  // A/B experiments on the shipped code, by poking it from outside.
  ab: [
    { name: "off", settings: { ...DEFAULTS, oceanOn: false } },
    { name: "ocean", settings: bg("ocean") },
    { name: "ocean-dpr1", settings: bg("ocean"), setup: dpr(1) },
    { name: "ocean-dpr0.5", settings: bg("ocean"), setup: dpr(0.5) },
    { name: "ocean-still", settings: bg("ocean", { oceanSpeed: 0 }) },
    { name: "ocean-opaque", settings: bg("ocean"), setup: opaque("data-t3p-ocean") },
    { name: "drift", settings: bg("drift") },
    { name: "drift-still", settings: bg("drift", { bgSpeed: 0 }) },
    { name: "starfield", settings: bg("starfield") },
  ],
  // After merging dim and blur (WP-13B): defaults, then blur 0/8/20 and dim on the heaviest presets, with and without the pause.
  merge: [
    { name: "off", settings: { ...DEFAULTS, oceanOn: false } },
    ...["ocean", "drift", "starfield"].map((k) => ({ name: `${k}-auto`, settings: bg(k) })),
    ...["ocean", "starfield"].flatMap((k) => [
      { name: `${k}-blur8`, settings: bg(k, { bgBlur: 8 }) },
      { name: `${k}-blur20`, settings: bg(k, { bgBlur: 20 }) },
      { name: `${k}-blur20-nopause`, settings: bg(k, { bgBlur: 20, bgPauseWhileTyping: false }) },
      { name: `${k}-dim40`, settings: bg(k, { bgDim: 40 }) },
    ]),
    { name: "drift-blur20", settings: bg("drift", { bgBlur: 20 }) },
  ],
  // After the fix: every preset with the defaults (Auto + pause while typing) and at each fixed tier without the pause.
  tiers: [
    { name: "off", settings: { ...DEFAULTS, oceanOn: false } },
    ...["ocean", "drift", "starfield"].flatMap((k) => [
      { name: `${k}-auto`, settings: bg(k, { bgQuality: "auto", bgPauseWhileTyping: true }) },
      ...["high", "balanced", "low", "static"].map((q) => ({ name: `${k}-${q}-nopause`, settings: bg(k, { bgQuality: q, bgPauseWhileTyping: false }) })),
    ]),
  ],
  // WP-17 before/after: the shipped defaults (Auto + pause while typing) and an always-animating High per preset.
  wp17: [
    { name: "off", settings: { ...DEFAULTS, oceanOn: false } },
    ...["ocean", "drift", "starfield"].flatMap((k) => [
      { name: `${k}-default`, settings: bg(k) },
      { name: `${k}-balanced-nopause`, settings: bg(k, { bgQuality: "balanced", bgPauseWhileTyping: false }) },
      { name: `${k}-high-nopause`, settings: bg(k, { bgQuality: "high", bgPauseWhileTyping: false }) },
    ]),
  ],
  // WP-17 A/B: GPU versus CPU raster for the canvas presets (pause off, Balanced). Antigravity, dropped in WP-17, was measured
  // here too (docs/artwork-perf.md).
  cpu17: [
    { name: "off", settings: { ...DEFAULTS, oceanOn: false } },
    { name: "sf", settings: bg("starfield", { bgQuality: "balanced", bgPauseWhileTyping: false }) },
    { name: "sf-hidden", note: "canvas display:none, JS still runs", settings: bg("starfield", { bgQuality: "balanced", bgPauseWhileTyping: false }), setup: css("#t3p-bg-starfield{display:none!important}") },
    { name: "sf-cpu", settings: bg("starfield", { bgQuality: "balanced", bgPauseWhileTyping: false }), setup: cpuCanvas, teardown: gpuCanvas },
    { name: "ocean", settings: bg("ocean", { bgQuality: "balanced", bgPauseWhileTyping: false }) },
    { name: "ocean-cpu", settings: bg("ocean", { bgQuality: "balanced", bgPauseWhileTyping: false }), setup: cpuCanvas, teardown: gpuCanvas },
  ],
  // Blur cost (WP-13D): blur 0/8/20 on every preset that blurs, with the pause (typing) and without (idle animation cost).
  blur: [
    { name: "off", settings: { ...DEFAULTS, oceanOn: false } },
    ...["ocean", "starfield"].flatMap((k) => [
      { name: `${k}-blur0`, settings: bg(k) },
      { name: `${k}-blur8`, settings: bg(k, { bgBlur: 8 }) },
      { name: `${k}-blur20`, settings: bg(k, { bgBlur: 20 }) },
      { name: `${k}-blur0-nopause`, settings: bg(k, { bgPauseWhileTyping: false }) },
      { name: `${k}-blur8-nopause`, settings: bg(k, { bgBlur: 8, bgPauseWhileTyping: false }) },
      { name: `${k}-blur20-nopause`, settings: bg(k, { bgBlur: 20, bgPauseWhileTyping: false }) },
    ]),
    { name: "drift-blur20", settings: bg("drift", { bgBlur: 20 }) },
  ],
};
