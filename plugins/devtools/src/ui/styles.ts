/** Colour tokens: [our variable, app variable, fallback]. `t3.ui.themeVars()` fills them in. Fallbacks are neutral, never a hard-coded colour. */
export const THEME_MAP: ReadonlyArray<readonly [string, string, string]> = [
  ["--dt-fg", "--foreground", "inherit"],
  ["--dt-bg", "--background", "transparent"],
  ["--dt-muted", "--muted-foreground", "color-mix(in srgb, currentColor 60%, transparent)"],
  ["--dt-border", "--border", "color-mix(in srgb, currentColor 14%, transparent)"],
  ["--dt-input", "--input", "color-mix(in srgb, currentColor 18%, transparent)"],
  ["--dt-card", "--card", "transparent"],
  ["--dt-hover", "--accent", "color-mix(in srgb, currentColor 8%, transparent)"],
  ["--dt-accent", "--primary", "currentColor"],
  ["--dt-ring", "--ring", "currentColor"],
  ["--dt-danger", "--destructive", "currentColor"],
  ["--dt-warn", "--warning", "currentColor"],
  ["--dt-ok", "--success", "currentColor"],
];

export const CSS = `
.t3p-dt { display:flex; flex-direction:column; gap:8px; min-height:0; padding:12px; box-sizing:border-box; font-size:12px; line-height:1.4; color:var(--dt-fg); background:var(--dt-bg); }
.t3p-dt *, .t3p-dt *::before, .t3p-dt *::after { box-sizing:border-box; }
.t3p-dt button, .t3p-dt input, .t3p-dt select, .t3p-dt textarea { font:inherit; color:inherit; }
.t3p-dt h4 { margin:2px 0; font-size:12px; font-weight:500; }
.t3p-dt .dt-note { color:var(--dt-muted); margin:0; }
.t3p-dt .dt-warn { border:1px solid color-mix(in srgb, var(--dt-warn) 32%, transparent); background:color-mix(in srgb, var(--dt-warn) 8%, transparent); border-radius:var(--radius-md, .375rem); padding:6px 8px; }
.t3p-dt .dt-error { border:1px solid color-mix(in srgb, var(--dt-danger) 32%, transparent); background:color-mix(in srgb, var(--dt-danger) 8%, transparent); color:var(--destructive-foreground, var(--dt-danger)); border-radius:var(--radius-md, .375rem); padding:6px 8px; white-space:pre-wrap; word-break:break-word; }
.t3p-dt .dt-row { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
.t3p-dt .dt-row > .dt-grow { flex:1; min-width:90px; }
.t3p-dt .dt-stack { display:flex; flex-direction:column; gap:6px; }
.t3p-dt .dt-label { display:flex; flex-direction:column; gap:4px; color:var(--dt-muted); }
.t3p-dt input, .t3p-dt select, .t3p-dt textarea { height:24px; border:1px solid var(--dt-input); background:var(--dt-bg); border-radius:var(--control-radius, .5rem); padding:0 8px; min-width:0; outline:none; box-shadow:0 1px 2px 0 rgb(0 0 0/5%); transition:box-shadow .15s, border-color .15s; }
.t3p-dt input::placeholder, .t3p-dt textarea::placeholder { color:var(--placeholder, var(--dt-muted)); }
.t3p-dt input:focus-visible, .t3p-dt select:focus-visible, .t3p-dt textarea:focus-visible { border-color:var(--dt-ring); box-shadow:0 0 0 3px color-mix(in srgb, var(--dt-ring) 24%, transparent); }
.t3p-dt textarea { height:auto; padding:6px 8px; font-family:var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size:11px; resize:vertical; width:100%; }
.t3p-dt .dt-mono { font-family:var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size:11px; }
.t3p-dt .dt-btn { display:inline-flex; align-items:center; justify-content:center; gap:4px; flex:none; height:24px; padding:0 8px; border:1px solid var(--dt-input); background:var(--popover, transparent); border-radius:var(--control-radius, .5rem); font-weight:500; line-height:1; white-space:nowrap; cursor:pointer; outline:none; box-shadow:0 1px 2px 0 rgb(0 0 0/5%); transition:box-shadow .15s, scale .15s, background-color .15s; }
.t3p-dt .dt-btn:hover:not(:disabled) { background:color-mix(in srgb, var(--dt-hover) 50%, transparent); }
.t3p-dt .dt-btn:active:not(:disabled) { scale:.97; box-shadow:none; }
.t3p-dt .dt-btn:focus-visible { box-shadow:0 0 0 2px var(--dt-bg), 0 0 0 4px var(--dt-ring); }
.t3p-dt .dt-btn:disabled { opacity:.64; pointer-events:none; }
.t3p-dt .dt-btn-danger { color:var(--destructive-foreground, var(--dt-danger)); }
.t3p-dt .dt-btn-danger:hover:not(:disabled) { border-color:color-mix(in srgb, var(--dt-danger) 32%, transparent); background:color-mix(in srgb, var(--dt-danger) 4%, transparent); }
.t3p-dt .dt-btn[aria-pressed="true"] { background:var(--dt-hover); }
.t3p-dt .dt-badge { display:inline-flex; align-items:center; height:18px; padding:0 5px; border-radius:calc(var(--radius, .5rem) - 4px); font-size:11px; font-weight:500; line-height:1; white-space:nowrap; background:color-mix(in srgb, currentColor 8%, transparent); color:var(--dt-muted); }
.t3p-dt .dt-badge[data-tone="ok"] { background:color-mix(in srgb, var(--dt-ok) 10%, transparent); color:var(--success-foreground, var(--dt-ok)); }
.t3p-dt .dt-badge[data-tone="warn"] { background:color-mix(in srgb, var(--dt-warn) 10%, transparent); color:var(--warning-foreground, var(--dt-warn)); }
.t3p-dt .dt-badge[data-tone="bad"] { background:color-mix(in srgb, var(--dt-danger) 10%, transparent); color:var(--destructive-foreground, var(--dt-danger)); }
.t3p-dt .dt-pre { margin:0; padding:8px; max-height:220px; overflow:auto; border:1px solid var(--dt-border); border-radius:var(--radius-md, .375rem); background:var(--dt-card); font-family:var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size:11px; white-space:pre-wrap; word-break:break-all; }
.t3p-dt .dt-snippet { display:block; white-space:pre-wrap; word-break:break-all; }
.t3p-dt .dt-snippet mark { color:var(--dt-fg); background:color-mix(in srgb, var(--dt-accent) 30%, transparent); border-radius:2px; padding:0 1px; }
.t3p-dt .dt-list { display:flex; flex-direction:column; gap:2px; min-height:0; overflow:auto; }
.t3p-dt .dt-log { min-height:70px; max-height:38vh; overflow:auto; border:1px solid var(--dt-border); border-radius:var(--radius-md, .375rem); padding:6px 8px; background:var(--dt-card); font-family:var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size:11px; }
.t3p-dt .dt-log-line { white-space:pre-wrap; word-break:break-all; border-bottom:1px solid color-mix(in srgb, var(--dt-border) 60%, transparent); padding:2px 0; }
.t3p-dt .dt-log-line:last-child { border-bottom:0; }
.t3p-dt .dt-log-line[data-level="warn"] { color:var(--warning-foreground, var(--dt-warn)); }
.t3p-dt .dt-log-line[data-level="error"] { color:var(--destructive-foreground, var(--dt-danger)); }
.t3p-dt .dt-log-line .dt-log-at { color:var(--dt-muted); font-variant-numeric:tabular-nums; }
.t3p-dt .dt-count { color:var(--dt-muted); margin-left:auto; white-space:nowrap; font-variant-numeric:tabular-nums; }
.t3p-dt .dt-chunk { display:flex; gap:6px; align-items:baseline; }
.t3p-dt .dt-chunk code { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.t3p-dt .dt-chunk .dt-count { margin-left:0; }
.t3p-dt details > summary { cursor:pointer; color:var(--dt-muted); }
.t3p-dt .dt-anchor { display:flex; gap:6px; align-items:baseline; }
.t3p-dt .dt-anchor code { color:var(--dt-fg); font-weight:500; }
`;
