/** Colour tokens: [our variable, app variable, fallback]. The app's theme variables win; themeVars() refreshes them. Fallbacks are neutral, never a hard-coded colour. */
export const THEME_MAP: ReadonlyArray<readonly [string, string, string]> = [
  ["--si-bg", "--background", "transparent"],
  ["--si-fg", "--foreground", "inherit"],
  ["--si-muted", "--muted-foreground", "color-mix(in srgb, currentColor 60%, transparent)"],
  ["--si-border", "--border", "color-mix(in srgb, currentColor 14%, transparent)"],
  ["--si-input", "--input", "color-mix(in srgb, currentColor 18%, transparent)"],
  ["--si-card", "--card", "transparent"],
  ["--si-hover", "--accent", "color-mix(in srgb, currentColor 8%, transparent)"],
  ["--si-accent", "--primary", "currentColor"],
  ["--si-ring", "--ring", "currentColor"],
  ["--si-danger", "--destructive", "currentColor"],
  ["--si-warn", "--warning", "currentColor"],
  ["--si-ok", "--success", "currentColor"],
];

export const CSS = `
.t3p-si { display:flex; flex-direction:column; height:100%; min-height:0; box-sizing:border-box; font-size:12px; line-height:1.4; color:var(--si-fg); background:var(--si-bg); }
.t3p-si *, .t3p-si *::before, .t3p-si *::after { box-sizing:border-box; }
.t3p-si button, .t3p-si input { font:inherit; color:inherit; }
.t3p-si .si-tabs { display:flex; gap:2px; padding:6px 8px; border-bottom:1px solid var(--si-border); }
.t3p-si .si-tab { height:24px; padding:0 8px; border:0; border-radius:calc(var(--radius, .5rem) - 2px); background:transparent; cursor:pointer; color:var(--si-muted); font-weight:500; line-height:1; outline:none; transition:background-color .15s, color .15s; }
.t3p-si .si-tab:hover { background:var(--si-hover); color:var(--si-fg); }
.t3p-si .si-tab:focus-visible { box-shadow:0 0 0 2px var(--si-ring); }
.t3p-si .si-tab[aria-selected="true"] { color:var(--si-fg); background:var(--si-hover); }
.t3p-si .si-view { display:flex; flex-direction:column; flex:1; min-height:0; }
.t3p-si .si-view[hidden] { display:none; }
.t3p-si .si-now { padding:6px 12px; border-bottom:1px solid var(--si-border); display:flex; gap:8px; align-items:center; background:var(--si-card); }
.t3p-si .si-now .si-dot { width:8px; height:8px; border-radius:50%; background:var(--si-muted); flex:none; }
.t3p-si .si-now[data-state="running"] .si-dot, .t3p-si .si-now[data-state="streaming"] .si-dot, .t3p-si .si-now[data-state="run"] .si-dot { background:var(--si-ok); animation:si-pulse 1.2s ease-in-out infinite; }
.t3p-si .si-now[data-state="approval"] .si-dot, .t3p-si .si-now[data-state="input"] .si-dot { background:var(--si-warn); animation:si-pulse 1.2s ease-in-out infinite; }
.t3p-si .si-now .si-text { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.t3p-si .si-now .si-since { color:var(--si-muted); flex:none; font-variant-numeric:tabular-nums; }
@keyframes si-pulse { 50% { opacity:.35; } }
@media (prefers-reduced-motion: reduce) { .t3p-si .si-dot { animation:none !important; } }
.t3p-si .si-bar { display:flex; flex-wrap:wrap; gap:4px; padding:6px 8px; align-items:center; border-bottom:1px solid var(--si-border); }
.t3p-si .si-chip { height:20px; padding:0 6px; border:0; background:transparent; border-radius:calc(var(--radius, .5rem) - 4px); font-size:11px; font-weight:500; line-height:1; cursor:pointer; color:var(--si-muted); outline:none; transition:background-color .15s, color .15s; }
.t3p-si .si-chip:hover { background:var(--si-hover); color:var(--si-fg); }
.t3p-si .si-chip:focus-visible { box-shadow:0 0 0 2px var(--si-ring); }
.t3p-si .si-chip[aria-pressed="true"] { color:var(--si-fg); background:var(--si-hover); }
.t3p-si .si-text-filter { flex:1; min-width:90px; height:24px; border:1px solid var(--si-input); background:var(--si-bg); border-radius:var(--control-radius, .5rem); padding:0 8px; outline:none; box-shadow:0 1px 2px 0 rgb(0 0 0/5%); transition:box-shadow .15s, border-color .15s; }
.t3p-si .si-text-filter::placeholder { color:var(--placeholder, var(--si-muted)); }
.t3p-si .si-text-filter:focus-visible { border-color:var(--si-ring); box-shadow:0 0 0 3px color-mix(in srgb, var(--si-ring) 24%, transparent); }
.t3p-si .si-btn { display:inline-flex; align-items:center; justify-content:center; height:24px; padding:0 8px; border:1px solid var(--si-input); background:var(--popover, transparent); border-radius:var(--control-radius, .5rem); font-weight:500; line-height:1; white-space:nowrap; cursor:pointer; outline:none; box-shadow:0 1px 2px 0 rgb(0 0 0/5%); transition:box-shadow .15s, scale .15s, background-color .15s; }
.t3p-si .si-btn:hover { background:color-mix(in srgb, var(--si-hover) 50%, transparent); }
.t3p-si .si-btn:active { scale:.97; box-shadow:none; }
.t3p-si .si-btn:focus-visible { box-shadow:0 0 0 2px var(--si-bg), 0 0 0 4px var(--si-ring); }
.t3p-si .si-count { color:var(--si-muted); margin-left:auto; font-variant-numeric:tabular-nums; }
.t3p-si .si-list { position:relative; flex:1 1 55%; min-height:80px; overflow:auto; }
.t3p-si .si-spacer { position:relative; width:100%; }
.t3p-si .si-row { position:absolute; left:0; right:0; display:flex; align-items:center; gap:6px; padding:0 8px; cursor:pointer; white-space:nowrap; border-left:2px solid transparent; }
.t3p-si .si-row:hover { background:var(--si-hover); }
.t3p-si .si-row[aria-selected="true"] { background:var(--si-hover); border-left-color:var(--si-accent); }
.t3p-si .si-row[data-group="errors"] { border-left-color:var(--si-danger); }
.t3p-si .si-row[data-group="approvals"] { border-left-color:var(--si-warn); }
.t3p-si .si-c-time { flex:none; width:56px; color:var(--si-muted); font-variant-numeric:tabular-nums; }
.t3p-si .si-c-dur { flex:none; width:54px; text-align:right; color:var(--si-muted); font-variant-numeric:tabular-nums; }
.t3p-si .si-c-dur[data-open="1"] { color:var(--success-foreground, var(--si-ok)); }
.t3p-si .si-c-prov { flex:none; width:72px; overflow:hidden; text-overflow:ellipsis; color:var(--si-muted); }
.t3p-si .si-c-icon { flex:none; width:16px; text-align:center; font-weight:500; }
.t3p-si .si-c-sum { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; }
.t3p-si .si-c-why { flex:none; color:var(--si-muted); max-width:64px; overflow:hidden; text-overflow:ellipsis; }
.t3p-si .si-empty { padding:16px 12px; color:var(--si-muted); }
.t3p-si .si-detail { flex:1 1 45%; min-height:60px; overflow:auto; border-top:1px solid var(--si-border); padding:8px 12px; }
.t3p-si .si-detail h4 { margin:0 0 4px; font-size:12px; font-weight:500; }
.t3p-si .si-hop { display:flex; gap:6px; padding:2px 0; cursor:pointer; align-items:baseline; }
.t3p-si .si-hop:hover .si-hop-sum { text-decoration:underline; }
.t3p-si .si-hop-rel { color:var(--si-muted); flex:none; min-width:84px; }
.t3p-si .si-hop-time { color:var(--si-muted); flex:none; font-variant-numeric:tabular-nums; }
.t3p-si .si-hop-sum { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.t3p-si .si-note { color:var(--si-muted); margin:2px 0; }
.t3p-si details { margin-top:6px; }
.t3p-si details > summary { cursor:pointer; color:var(--si-muted); }
.t3p-si pre.si-raw { margin:4px 0 0; padding:8px; max-height:220px; overflow:auto; border:1px solid var(--si-border); border-radius:var(--radius-md, .375rem); background:var(--si-card); font-family:var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size:11px; white-space:pre-wrap; word-break:break-all; }
.t3p-si .si-ses-list { flex:1; min-height:0; overflow:auto; position:relative; }
.t3p-si .si-ses { position:absolute; left:0; right:0; padding:4px 12px; cursor:pointer; border-bottom:1px solid var(--si-border); overflow:hidden; border-left:2px solid transparent; }
.t3p-si .si-ses:hover { background:var(--si-hover); }
.t3p-si .si-ses[data-current="1"] { border-left-color:var(--si-accent); }
.t3p-si .si-ses-title { font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.t3p-si .si-ses-sub { display:flex; gap:8px; color:var(--si-muted); white-space:nowrap; font-size:11px; }
.t3p-si .si-ses-act { overflow:hidden; text-overflow:ellipsis; flex:1; min-width:0; }
.t3p-si .si-foot { padding:4px 12px; color:var(--si-muted); border-top:1px solid var(--si-border); font-size:11px; }
`;
