/** Tiny DOM helper. Plugin UI is plain DOM: no framework, no Shadow DOM (theme CSS variables must reach it). */
export type Child = Node | string | number | null | undefined | false;

export interface Props {
  class?: string;
  style?: string;
  dataset?: Record<string, string>;
  [key: string]: unknown;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "style") node.setAttribute("style", String(value));
    else if (key === "dataset") for (const [k, v] of Object.entries(value as Record<string, string>)) node.dataset[k] = v;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    else if (key in node && key !== "list" && key !== "type") (node as unknown as Record<string, unknown>)[key] = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  append(node, children);
  return node;
}

export function append(node: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === "object" ? child : document.createTextNode(String(child)));
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** True when the event target is somewhere the user types text. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLInputElement) return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image"].includes(target.type);
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if ((target as HTMLElement).isContentEditable) return true;
  return target.closest('[contenteditable=""],[contenteditable="true"],[role="textbox"],[role="combobox"],[role="searchbox"]') !== null;
}

let styleInjected = false;
/** One shared stylesheet for runtime-owned UI (toasts, modal, settings page, dock). Uses the app's CSS variables with fallbacks. */
export function ensureStyles(): void {
  if (styleInjected || typeof document === "undefined") return;
  styleInjected = true;
  const style = document.createElement("style");
  style.setAttribute("data-t3p-style", "");
  style.textContent = STYLE;
  (document.head ?? document.documentElement).appendChild(style);
}

const STYLE = `
[data-t3p-root]{font-family:inherit;color:var(--foreground,inherit)}
:root{--t3p-radius:var(--control-radius,.5rem);--t3p-line:var(--border,color-mix(in srgb,currentColor 14%,transparent));--t3p-hover:var(--accent,color-mix(in srgb,currentColor 8%,transparent));--t3p-ease:cubic-bezier(.22,1,.36,1)}
.t3p-glass{background:color-mix(in srgb,var(--popover,var(--background,canvas)) 18%,color-mix(in srgb,var(--popover,var(--background,canvas)) var(--glass-opacity,100%),transparent));-webkit-backdrop-filter:blur(var(--glass-blur,0px)) saturate(var(--glass-saturation,1));backdrop-filter:blur(var(--glass-blur,0px)) saturate(var(--glass-saturation,1));border:1px solid color-mix(in srgb,var(--contrast-foreground,var(--foreground,currentColor)) 10%,transparent);color:var(--popover-foreground,var(--foreground,inherit))}
.t3p-popover{position:fixed;z-index:2147483002;box-sizing:border-box;overflow:auto;padding:8px 10px;border-radius:var(--radius-lg,var(--radius,.5rem));font-size:12px;line-height:1.4;box-shadow:0 16px 40px -18px rgb(0 0 0/55%)}
.t3p-popover[hidden]{display:none}
.t3p-toasts{position:fixed;right:16px;bottom:34px;z-index:2147483000;display:flex;flex-direction:column;gap:8px;width:max-content;max-width:min(380px,calc(100vw - 32px));pointer-events:none}
.t3p-toast{pointer-events:auto;box-sizing:border-box;border-radius:var(--radius-lg,var(--radius,.5rem));padding:10px 12px;font-size:12px;line-height:1.4;box-shadow:0 10px 15px -3px rgb(0 0 0/25%),0 4px 6px -4px rgb(0 0 0/25%);cursor:pointer;position:relative;overflow:hidden;animation:t3p-in .35s var(--t3p-ease)}
.t3p-toast::before{content:"";position:absolute;left:0;top:0;bottom:0;width:2px;background:var(--t3p-tone,transparent)}
.t3p-toast[data-kind=info]{--t3p-tone:var(--info,currentColor)}
.t3p-toast[data-kind=success]{--t3p-tone:var(--success,currentColor)}
.t3p-toast[data-kind=warning]{--t3p-tone:var(--warning,currentColor)}
.t3p-toast[data-kind=error]{--t3p-tone:var(--destructive,currentColor)}
.t3p-toast b{display:block;margin-bottom:2px;font-weight:500}
.t3p-toast .t3p-buttons{margin-top:8px}
@keyframes t3p-in{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}
.t3p-overlay{position:fixed;inset:0;z-index:2147483001;background:color-mix(in srgb,var(--background,canvas) 62%,transparent);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center}
.t3p-modal{box-sizing:border-box;border-radius:var(--radius-xl,calc(var(--radius,.5rem) + 4px));min-width:320px;max-width:min(520px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;padding:16px;box-shadow:0 24px 64px -24px rgb(0 0 0/65%);font-size:13px}
.t3p-modal h2{margin:0 0 6px;font-size:14px;line-height:1.3;font-weight:600}
.t3p-modal-body{font-size:12px;line-height:1.5;color:var(--muted-foreground,inherit);margin-bottom:14px;white-space:pre-wrap}
.t3p-buttons{display:flex;gap:8px;justify-content:flex-end}
.t3p-btn,.t3p-chip{position:relative;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;flex:none;height:28px;padding:0 7px;border:1px solid var(--input,var(--t3p-line));border-radius:var(--t3p-radius);background:var(--popover,transparent);color:var(--foreground,inherit);font:inherit;font-size:12px;font-weight:500;line-height:1;white-space:nowrap;cursor:pointer;outline:none;transition:box-shadow .15s,scale .15s,background-color .15s,color .15s,border-color .15s;box-shadow:0 1px 2px 0 rgb(0 0 0/5%)}
.t3p-btn:hover,.t3p-chip:hover{background:color-mix(in srgb,var(--accent,currentColor) 50%,transparent)}
.t3p-btn:active,.t3p-chip:active{scale:.97;box-shadow:none}
.t3p-btn:focus-visible,.t3p-chip:focus-visible,.t3p-switch:focus-visible,.t3p-tab:focus-visible,.t3p-menu-item:focus-visible{box-shadow:0 0 0 2px var(--background,canvas),0 0 0 4px var(--ring,currentColor)}
.t3p-btn:disabled,.t3p-chip:disabled{opacity:.64;pointer-events:none}
.t3p-btn[data-primary]{background:var(--primary,currentColor);color:var(--primary-foreground,canvas);border-color:var(--primary,currentColor)}
.t3p-btn[data-primary]:hover{background:color-mix(in srgb,var(--primary,currentColor) 90%,transparent)}
.t3p-btn[data-variant=ghost],.t3p-chip{border-color:transparent;background:transparent;box-shadow:none;color:var(--muted-foreground,inherit)}
.t3p-btn[data-variant=ghost]:hover,.t3p-chip:hover{background:var(--t3p-hover);color:var(--foreground,inherit)}
.t3p-chip[data-tone=ok]{color:var(--success-foreground,var(--success,inherit))}
.t3p-chip[data-tone=warn]{color:var(--warning-foreground,var(--warning,inherit))}
.t3p-chip[data-tone=bad]{color:var(--destructive-foreground,var(--destructive,inherit))}
.t3p-chip[data-compact]{height:20px;padding:0 6px;font-size:11px;border-radius:calc(var(--radius,.5rem) - 4px)}
.t3p-statusbar{position:fixed;left:0;right:0;bottom:0;z-index:40;box-sizing:border-box;height:22px;display:flex;align-items:center;gap:8px;padding:0 8px;font-size:11px;line-height:1;background:var(--card,var(--background,canvas));color:var(--muted-foreground,inherit);border-top:1px solid var(--t3p-line);font-variant-numeric:tabular-nums}
.t3p-dock{position:absolute;top:var(--t3p-dock-top,46px);right:0;bottom:0;z-index:30;box-sizing:border-box;width:var(--t3p-dock-w,340px);display:flex;flex-direction:column;background:var(--card,var(--background,canvas));color:var(--foreground,inherit);border-left:1px solid var(--t3p-line);font-size:12px}
.t3p-dock[hidden]{display:none}
.t3p-dock-close{position:absolute;top:6px;right:8px;z-index:3;width:24px;height:24px;padding:0;font-size:16px;line-height:1}
.t3p-dock-tabs{padding-right:40px!important;display:flex;flex-wrap:wrap;gap:2px;padding:6px 8px;border-bottom:1px solid var(--t3p-line)}
.t3p-dock-tab,.t3p-tab{box-sizing:border-box;flex:none;height:24px;padding:0 8px;border:0;border-radius:calc(var(--radius,.5rem) - 2px);background:transparent;color:var(--muted-foreground,inherit);font:inherit;font-size:12px;font-weight:500;line-height:1;cursor:pointer;outline:none;transition:background-color .15s,color .15s}
.t3p-dock-tab:hover,.t3p-tab:hover{background:var(--t3p-hover);color:var(--foreground,inherit)}
.t3p-dock-tab[aria-selected=true],.t3p-tab[aria-selected=true]{background:var(--accent,color-mix(in srgb,currentColor 8%,transparent));color:var(--foreground,inherit)}
.t3p-dock-tab:focus-visible{box-shadow:0 0 0 2px var(--ring,currentColor)}
.t3p-dock-body{flex:1;min-height:0;overflow:auto;padding:0}
.t3p-dock-toggle{position:fixed;bottom:1px;right:8px;z-index:41;height:20px;padding:0 6px;font-size:11px;border-radius:calc(var(--radius,.5rem) - 4px)}
body:has(.t3p-statusbar) :is([class~="h-dvh!"],[class~="h-dvh"],[class~="h-svh"],[class~="md:h-dvh"]){height:calc(100dvh - 22px)!important}
body.t3p-dock-open [data-slot=sidebar-inset]{box-sizing:border-box;padding-right:var(--t3p-dock-w,340px)}
.t3p-dock-grip{position:absolute;left:-3px;top:0;bottom:0;width:6px;cursor:col-resize;z-index:2}
.t3p-dock-grip:hover,.t3p-dock-grip[data-drag]{background:var(--ring,currentColor);opacity:.35}
body:has(.t3p-statusbar) [data-slot=sidebar-container]{bottom:22px;height:auto}
[data-t3p-container=threadHeader]{display:inline-flex;flex-direction:row;align-items:center;flex:none;min-width:0;gap:6px;margin-left:12px}
.t3p-page{padding:20px 24px;max-width:860px;margin:0 auto;font-size:14px;color:var(--foreground,inherit)}
.t3p-page h1{font-size:18px;line-height:1.3;font-weight:600;margin:0 0 4px}
.t3p-page h2{font-size:12px;line-height:1.3;font-weight:500;margin:20px 0 8px;color:var(--muted-foreground,inherit)}
.t3p-muted{color:var(--muted-foreground,inherit)}
.t3p-meta{font-size:11px;line-height:1.4;color:var(--muted-foreground,inherit);font-variant-numeric:tabular-nums}
.t3p-card{border:1px solid var(--t3p-line);border-radius:var(--radius-lg,var(--radius,.5rem));padding:12px 14px;margin:0 0 10px;background:var(--card,transparent);box-shadow:0 1px 2px 0 rgb(0 0 0/5%)}
.t3p-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.t3p-card-title{font-weight:500;font-size:14px}
.t3p-pill,.t3p-badge{display:inline-flex;align-items:center;height:18px;box-sizing:border-box;padding:0 5px;border:1px solid transparent;border-radius:calc(var(--radius,.5rem) - 4px);font-size:11px;font-weight:500;line-height:1;white-space:nowrap;background:color-mix(in srgb,currentColor 8%,transparent);color:var(--muted-foreground,inherit)}
.t3p-pill[data-tone=ok],.t3p-badge[data-tone=ok]{background:color-mix(in srgb,var(--success,currentColor) 10%,transparent);color:var(--success-foreground,var(--success,inherit))}
.t3p-pill[data-tone=bad],.t3p-badge[data-tone=bad]{background:color-mix(in srgb,var(--destructive,currentColor) 10%,transparent);color:var(--destructive-foreground,var(--destructive,inherit))}
.t3p-pill[data-tone=warn],.t3p-badge[data-tone=warn]{background:color-mix(in srgb,var(--warning,currentColor) 10%,transparent);color:var(--warning-foreground,var(--warning,inherit))}
.t3p-spacer{flex:1}
.t3p-error{color:var(--destructive-foreground,var(--destructive,inherit));font-size:12px;margin-top:6px;white-space:pre-wrap;word-break:break-word}
.t3p-setting{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 12px;align-items:center;padding:8px 0;border-top:1px solid var(--t3p-line);font-size:13px}
.t3p-setting small{grid-column:1;font-size:12px;color:var(--muted-foreground,inherit)}
.t3p-input{box-sizing:border-box;height:28px;min-width:140px;padding:0 9px;border:1px solid var(--input,var(--t3p-line));border-radius:var(--t3p-radius);background:var(--background,transparent);color:inherit;font:inherit;font-size:12px;box-shadow:0 1px 2px 0 rgb(0 0 0/5%);outline:none;transition:box-shadow .15s,border-color .15s}
.t3p-input::placeholder{color:var(--placeholder,var(--muted-foreground,inherit))}
.t3p-input:focus-visible{border-color:var(--ring,currentColor);box-shadow:0 0 0 3px color-mix(in srgb,var(--ring,currentColor) 24%,transparent)}
.t3p-switch{appearance:none;flex:none;width:32px;height:18px;margin:0;border-radius:999px;background:var(--input,color-mix(in srgb,currentColor 20%,transparent));position:relative;cursor:pointer;border:0;outline:none;transition:background-color .2s,box-shadow .2s}
.t3p-switch::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--background,canvas);box-shadow:0 1px 2px rgb(0 0 0/12%);transition:translate .15s}
.t3p-switch:checked{background:var(--primary,currentColor)}
.t3p-switch:checked::after{translate:14px 0}
.t3p-switch:disabled{opacity:.64;cursor:not-allowed}
.t3p-nav-fallback{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:100%;height:28px;padding:0 10px;border:0;background:transparent;color:var(--muted-foreground,inherit);font:inherit;font-size:12px;cursor:pointer;border-radius:calc(var(--radius,.5rem) - 2px);text-align:left;outline:none}
.t3p-nav-fallback:hover,.t3p-nav-fallback:focus-visible{background:var(--t3p-hover);color:var(--foreground,inherit)}
.t3p-settings-route{flex:1 1 0;min-height:0;height:100%;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin}
.t3p-overlay-page{position:absolute;inset:0;z-index:50;overflow:auto;background:var(--background,canvas)}
.t3p-palette-group{padding:4px;border-top:1px solid var(--t3p-line)}
.t3p-palette-label{padding:4px 8px;font-size:11px;color:var(--muted-foreground,inherit)}
.t3p-palette-item,.t3p-menu-item{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:100%;min-height:32px;text-align:left;border:0;background:transparent;color:var(--foreground,inherit);padding:4px 8px;font:inherit;font-size:13px;cursor:pointer;border-radius:calc(var(--radius,.5rem) - 4px);outline:none}
.t3p-palette-item:hover,.t3p-palette-item:focus,.t3p-menu-item:hover,.t3p-menu-item:focus-visible{background:var(--accent,color-mix(in srgb,currentColor 8%,transparent))}
@media (prefers-reduced-motion:reduce){.t3p-toast{animation:none}.t3p-btn,.t3p-chip{transition:none}}
`;
