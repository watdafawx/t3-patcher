import type { SettingValue, T3Api } from "@t3p/api";

import { HUE_DEFAULT_FIXED, PRESETS, PRESET_LABELS, layerVars, type ArtworkConfig, type Preset, type SavedArtwork } from "./model.js";

/** Styles of the dock tab. Colors come only from app variables, so dark, light and custom themes follow. */
export const PANEL_CSS = `
.t3p-art-panel{display:flex;flex-direction:column;gap:14px;padding:10px 12px 16px;font-size:12px}
.t3p-art-sec{display:flex;flex-direction:column;gap:8px;min-width:0}
.t3p-art-sec>h3{margin:0;font-size:11px;font-weight:500;color:var(--muted-foreground,inherit);text-transform:none}
.t3p-art-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(76px,1fr));gap:6px}
.t3p-art-sw{position:relative;box-sizing:border-box;height:50px;padding:0;display:flex;align-items:flex-end;overflow:hidden;cursor:pointer;font:inherit;color:inherit;background:var(--sidebar,var(--background,canvas));border:1px solid var(--input,var(--border,currentColor));border-radius:var(--control-radius,.5rem);outline:none;transition:border-color .15s,box-shadow .15s}
.t3p-art-sw::before{content:"";position:absolute;inset:0;background-size:cover;background-position:center}
.t3p-art-sw[data-preset=aurora]::before{background:radial-gradient(55% 90% at 18% 0,var(--t3p-art-a),transparent),radial-gradient(55% 90% at 82% 0,var(--t3p-art-b),transparent),radial-gradient(60% 70% at 50% 8%,var(--t3p-art-c),transparent);opacity:.85}
.t3p-art-sw[data-preset=gradient]::before{background:linear-gradient(160deg,var(--t3p-art-a),var(--t3p-art-b) 55%,var(--t3p-art-c));opacity:.7}
.t3p-art-sw[data-preset=mesh]::before{background:radial-gradient(40% 70% at 12% 10%,var(--t3p-art-a),transparent),radial-gradient(45% 80% at 90% 0,var(--t3p-art-b),transparent),radial-gradient(40% 60% at 45% 85%,var(--t3p-art-c),transparent);opacity:.85}
.t3p-art-sw[data-preset=none]::before{background:repeating-linear-gradient(135deg,transparent 0 6px,color-mix(in srgb,var(--muted-foreground,currentColor) 22%,transparent) 6px 7px)}
.t3p-art-sw[data-preset=image]::before{background-image:var(--t3p-sw-img,none);background-color:color-mix(in srgb,var(--muted-foreground,currentColor) 14%,transparent)}
.t3p-art-sw span{position:relative;width:100%;box-sizing:border-box;padding:10px 6px 3px;font-size:11px;text-align:left;line-height:1.2;background:linear-gradient(to bottom,transparent,color-mix(in srgb,var(--card,var(--background,canvas)) 82%,transparent))}
.t3p-art-sw:hover{border-color:var(--muted-foreground,currentColor)}
.t3p-art-sw:focus-visible{box-shadow:0 0 0 2px var(--ring,currentColor)}
.t3p-art-sw[aria-pressed=true]{border-color:var(--ring,currentColor);box-shadow:0 0 0 1px var(--ring,currentColor)}
.t3p-art-hue{display:flex;flex-direction:column;gap:6px}
.t3p-art-hue[data-follow] .t3p-range-wrap{opacity:.45;pointer-events:none}
.t3p-art-hue-track{background:linear-gradient(90deg,oklch(.74 .15 0),oklch(.74 .15 60),oklch(.74 .15 120),oklch(.74 .15 180),oklch(.74 .15 240),oklch(.74 .15 300),oklch(.74 .15 360))}
.t3p-art-ln{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}
.t3p-art-ln>label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.t3p-art-imgs{display:flex;flex-direction:column;gap:4px}
.t3p-art-img{display:flex;align-items:center;gap:8px;min-width:0;padding:3px;border:1px solid transparent;border-radius:var(--control-radius,.5rem)}
.t3p-art-img[data-active]{border-color:var(--ring,currentColor)}
.t3p-art-img>span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.t3p-art-img .t3p-btn{height:24px}
.t3p-art-thumb2{flex:none;width:44px;height:28px;border-radius:4px;object-fit:cover;background:color-mix(in srgb,var(--muted-foreground,currentColor) 14%,transparent);border:1px solid var(--border,currentColor)}
.t3p-art-foot{display:flex;gap:6px;flex-wrap:wrap}
.t3p-art-foot .t3p-btn,.t3p-art-sec .t3p-btn{height:24px}
`;

export interface PanelContext {
  t3: T3Api;
  config(): ArtworkConfig;
  arts(): SavedArtwork[];
  activeName(): string;
  logoUrl(): string | null;
  /** Data URL of a saved image, cached. */
  thumb(art: SavedArtwork): Promise<string | null>;
  addArt(file: File): Promise<void>;
  useArt(art: SavedArtwork): Promise<void>;
  deleteArt(art: SavedArtwork): Promise<void>;
  setLogo(file: File): Promise<void>;
  clearLogo(): Promise<void>;
  /** Fires when images or the logo changed. */
  subscribe(fn: () => void): () => void;
  /** Applies a not yet saved value at once (live preview). `undefined` drops the preview. */
  preview(key: string, value: SettingValue | undefined): void;
}

/** Keys the generic helper renders in the "Look" and "Logo" sections. */
export const LOOK_KEYS = ["intensity", "speed", "fadeHeight", "blur", "angle", "scrim", "mainGlow"];
export const OCEAN_KEYS = ["oceanOn", "oceanIntensity", "oceanSpeed", "oceanRipples"];
export const LOGO_KEYS = ["logoMode", "logoText", "logoHeight"];
/** Every setting the panel can reset. */
export const ALL_KEYS = ["preset", "intensity", "speed", "hue", "fadeHeight", "blur", "angle", "scrim", "artworkName", "mainGlow", "oceanOn", "oceanIntensity", "oceanSpeed", "oceanRipples", "logoMode", "logoText", "logoHeight"];

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string> = {}, ...kids: Array<Node | string>): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) node.setAttribute(k, v);
  node.append(...kids);
  return node;
};

const button = (label: string, onClick: () => void, variant?: string): HTMLButtonElement => {
  const b = el("button", { type: "button", class: "t3p-btn", ...(variant ? { "data-variant": variant } : {}) }, label);
  b.addEventListener("click", onClick);
  return b;
};

const picker = (label: string, onFile: (file: File) => Promise<void>): HTMLElement => {
  const input = el("input", { type: "file", accept: "image/*", hidden: "" });
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    input.value = "";
    if (file) void onFile(file);
  });
  const wrap = el("span", { style: "flex:none" });
  wrap.append(input, button(label, () => input.click()));
  return wrap;
};

const section = (title: string): HTMLElement => el("section", { class: "t3p-art-sec" }, el("h3", {}, title));

/** Builds the Artwork dock tab into `host`. Returns the cleanup. */
export function renderPanel(host: HTMLElement, ctx: PanelContext): () => void {
  const { t3 } = ctx;
  const disposers: Array<() => void> = [];
  const root = el("div", { class: "t3p-art-panel", "data-t3p-artwork-panel": "" });
  host.appendChild(root);
  const preview = (key: string, value: SettingValue | undefined): void => {
    ctx.preview(key, value);
    syncSettings();
  };
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  disposers.push(() => timers.forEach((t) => clearTimeout(t)));

  // ---- presets -----------------------------------------------------------------------------------
  const presetSec = section("Preset");
  const grid = el("div", { class: "t3p-art-grid", role: "group", "aria-label": "Preset" });
  const swatches = new Map<Preset, HTMLButtonElement>();
  for (const preset of PRESETS) {
    const b = el("button", { type: "button", class: "t3p-art-sw", "data-preset": preset, "data-t3p-preset": preset, "aria-pressed": "false", title: PRESET_LABELS[preset] }, el("span", {}, PRESET_LABELS[preset]));
    b.addEventListener("click", () => {
      void t3.settings.set("preset", preset);
      preview("preset", preset);
    });
    swatches.set(preset, b);
    grid.appendChild(b);
  }
  presetSec.appendChild(grid);

  // ---- look (generic helper) ---------------------------------------------------------------------
  const hueSec = section("Color");
  const hue = el("div", { class: "t3p-art-hue", "data-t3p-hue": "" });
  const follow = el("input", { type: "checkbox", class: "t3p-switch", "aria-label": "Follow app accent", "data-t3p-follow": "" });
  const followRow = el("div", { class: "t3p-art-ln" }, el("label", {}, "Follow app accent"), follow);
  const hueIn = el("input", { type: "range", class: "t3p-range t3p-art-hue-track", min: "0", max: "360", step: "1", "aria-label": "Hue", "data-t3p-hue-input": "" });
  const hueOut = el("output", { class: "t3p-range-out" }, "165");
  const hueWrap = el("div", { class: "t3p-range-wrap" }, hueIn, hueOut);
  hue.append(followRow, hueWrap);
  hueSec.appendChild(hue);
  let lastHue = HUE_DEFAULT_FIXED;
  const writeHue = (value: number): void => {
    preview("hue", value);
    const old = timers.get("hue");
    if (old) clearTimeout(old);
    timers.set(
      "hue",
      setTimeout(() => {
        timers.delete("hue");
        void t3.settings.set("hue", value);
      }, 120),
    );
  };
  follow.addEventListener("change", () => {
    const value = follow.checked ? -1 : lastHue;
    hue.toggleAttribute("data-follow", follow.checked);
    void t3.settings.set("hue", value);
    preview("hue", value);
  });
  hueIn.addEventListener("input", () => {
    lastHue = Number(hueIn.value);
    hueOut.textContent = String(lastHue);
    writeHue(lastHue);
  });
  hueIn.addEventListener("change", () => {
    const old = timers.get("hue");
    if (old) clearTimeout(old);
    timers.delete("hue");
    void t3.settings.set("hue", Number(hueIn.value));
  });

  const lookSec = section("Look");
  disposers.push(t3.ui.settingsPanel(lookSec, { keys: LOOK_KEYS, onLive: (k, v) => preview(k, v) }).dispose);

  // ---- ocean ---------------------------------------------------------------------------------------
  const oceanSec = section("Ocean background");
  oceanSec.appendChild(el("div", { class: "t3p-meta" }, "Letters drift behind the whole app. Click for ripples. Separate from the sidebar preset; uses the Color above for the glow."));
  disposers.push(t3.ui.settingsPanel(oceanSec, { keys: OCEAN_KEYS, onLive: (k, v) => preview(k, v) }).dispose);

  // ---- logo --------------------------------------------------------------------------------------
  const logoSec = section("Logo");
  disposers.push(t3.ui.settingsPanel(logoSec, { keys: LOGO_KEYS, onLive: (k, v) => preview(k, v) }).dispose);
  const logoRow = el("div", { class: "t3p-art-img" });
  logoSec.appendChild(logoRow);

  // ---- images ------------------------------------------------------------------------------------
  const imgSec = section("Saved images");
  const list = el("div", { class: "t3p-art-imgs", "data-t3p-images": "" });
  imgSec.append(list, el("div", { class: "t3p-art-foot" }, picker("Add image...", ctx.addArt)));

  const foot = el("div", { class: "t3p-art-foot" });
  foot.appendChild(
    button("Reset to defaults", () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
      for (const key of ALL_KEYS) void t3.settings.reset(key).catch(() => undefined);
    }, "ghost"),
  );

  root.append(presetSec, hueSec, lookSec, oceanSec, logoSec, imgSec, foot);

  // ---- state sync --------------------------------------------------------------------------------
  const drawImages = (): void => {
    list.textContent = "";
    const active = ctx.activeName().toLowerCase();
    const arts = ctx.arts();
    if (arts.length === 0) list.appendChild(el("div", { class: "t3p-meta" }, "No saved images yet."));
    for (const art of arts) {
      const inUse = art.name.toLowerCase() === active;
      const thumb = el("img", { class: "t3p-art-thumb2", alt: "" });
      void ctx.thumb(art).then((url) => {
        if (url && thumb.isConnected) thumb.src = url;
      });
      const row = el("div", { class: "t3p-art-img", ...(inUse ? { "data-active": "" } : {}), "data-t3p-image": art.name }, thumb, el("span", { title: art.name }, `${art.name} (${Math.round(art.bytes / 1024)} KB)`));
      row.append(button(inUse ? "In use" : "Use", () => void ctx.useArt(art)), button("Delete", () => void ctx.deleteArt(art), "ghost"));
      list.appendChild(row);
    }
    const url = ctx.logoUrl();
    logoRow.textContent = "";
    if (url) logoRow.appendChild(el("img", { class: "t3p-art-thumb2", alt: "", src: url, style: "object-fit:contain" }));
    else logoRow.appendChild(el("span", { class: "t3p-meta" }, "No logo image"));
    logoRow.appendChild(picker(url ? "Replace logo..." : "Choose logo...", ctx.setLogo));
    if (url) logoRow.appendChild(button("Clear", () => void ctx.clearLogo(), "ghost"));
    // The image swatch shows the active image.
    const sw = swatches.get("image");
    const found = ctx.arts().find((a) => a.name.toLowerCase() === active);
    if (sw) {
      sw.style.setProperty("--t3p-sw-img", "none");
      const before = sw;
      if (found) {
        void ctx.thumb(found).then((u) => {
          if (u) before.style.setProperty("--t3p-sw-img", `url("${u}")`);
        });
      }
    }
  };

  const syncSettings = (): void => {
    const cfg = ctx.config();
    for (const [k, v] of Object.entries(layerVars(cfg))) grid.style.setProperty(k, v);
    for (const [preset, b] of swatches) b.setAttribute("aria-pressed", String(preset === cfg.preset));
    const following = cfg.hue < 0;
    hue.toggleAttribute("data-follow", following);
    follow.checked = following;
    if (!following) lastHue = Math.round(cfg.hue);
    if (document.activeElement !== hueIn) {
      hueIn.value = String(following ? lastHue : Math.round(cfg.hue));
      hueOut.textContent = hueIn.value;
    }
  };

  syncSettings();
  drawImages();
  disposers.push(t3.settings.onChange(() => syncSettings()));
  disposers.push(ctx.subscribe(drawImages));

  return () => {
    for (const d of disposers.reverse()) {
      try {
        d();
      } catch {
        /* best effort */
      }
    }
    root.remove();
  };
}
