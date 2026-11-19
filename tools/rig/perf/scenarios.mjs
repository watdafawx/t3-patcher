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

export const SETS = {
  baseline: [
    { name: "off", settings: { ...DEFAULTS, oceanOn: false } },
    { name: "ocean", settings: bg("ocean") },
    { name: "antigravity", settings: bg("antigravity") },
    { name: "drift", settings: bg("drift") },
    { name: "starfield", settings: bg("starfield") },
  ],
  // A/B experiments on the shipped code, by poking it from outside.
  ab: [
    { name: "off", settings: { ...DEFAULTS, oceanOn: false } },
    { name: "ag", settings: bg("antigravity") },
    { name: "ag-hidden", note: "canvas display:none, JS still runs", settings: bg("antigravity"), setup: css("#t3p-bg-antigravity{display:none!important}") },
    { name: "ag-opaque", note: "app surfaces opaque again, canvas covered", settings: bg("antigravity"), setup: opaque("data-t3p-bg-antigravity") },
    { name: "ag-still", note: "speed 0, one still frame", settings: bg("antigravity", { bgSpeed: 0 }) },
    { name: "ag-30fps", note: "Low power", settings: bg("antigravity", { bgLowPower: true }) },
    { name: "ag-dpr1", settings: bg("antigravity"), setup: dpr(1) },
    { name: "ag-dpr0.5", settings: bg("antigravity"), setup: dpr(0.5) },
    { name: "ag-willchange", settings: bg("antigravity"), setup: css("#t3p-bg-antigravity{will-change:transform}") },
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
    ...["ocean", "antigravity", "drift", "starfield"].map((k) => ({ name: `${k}-auto`, settings: bg(k) })),
    ...["antigravity", "ocean"].flatMap((k) => [
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
    ...["ocean", "antigravity", "drift", "starfield"].flatMap((k) => [
      { name: `${k}-auto`, settings: bg(k, { bgQuality: "auto", bgPauseWhileTyping: true }) },
      ...["high", "balanced", "low", "static"].map((q) => ({ name: `${k}-${q}-nopause`, settings: bg(k, { bgQuality: q, bgPauseWhileTyping: false }) })),
    ]),
  ],
  // Blur cost (WP-13D): blur 0/8/20 on every preset that blurs, with the pause (typing) and without (idle animation cost).
  blur: [
    { name: "off", settings: { ...DEFAULTS, oceanOn: false } },
    ...["antigravity", "ocean", "starfield"].flatMap((k) => [
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
