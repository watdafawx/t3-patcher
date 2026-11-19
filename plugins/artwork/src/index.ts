import type { PluginModule, SettingSchema, SettingValue, T3Api } from "@t3p/api";

import { CUSTOM_KEY, CustomLayers, emptyBundle, parseBundle, serializeBundle, type CustomId } from "./custom.js";
import { backgroundTemplate, headerTemplate } from "./custom-templates.js";
import { Antigravity } from "./antigravity.js";
import { BG_KINDS, BG_LABELS, isBgKind, type BgConfig, type BgKind, type BgPresetKind } from "./bg-model.js";
import { GradientDrift } from "./drift.js";
import { Ocean } from "./ocean.js";
import { Starfield } from "./starfield.js";
import { PANEL_CSS, renderPanel } from "./panel.js";
import { mountResetAll } from "./reset.js";
import {
  LOGO_MODES,
  MAX_IMAGE_EDGE,
  MAX_LOGO_EDGE,
  PRESETS,
  PRESET_LABELS,
  cleanName,
  clamp,
  dataUrlBytes,
  encodeSteps,
  findArtwork,
  fitSize,
  imageBudget,
  isSafeImageUrl,
  isSavedArtwork,
  layerVars,
  mainGlowOpacity,
  nextPreset,
  uniqueName,
  type ArtworkConfig,
  type OceanConfig,
  type LogoMode,
  type Preset,
  type SavedArtwork,
} from "./model.js";

const STYLE_ID = "t3p-artwork-style";
const LOGO_SELECTOR = 'a[aria-label="T3 Code home"]';
const ARTS_KEY = "arts";
const LOGO_KEY = "logo";

/** All colors come from app variables (`--primary`, `--sidebar`, `--background`), so every theme works. */
const CSS = `
.t3p-art-layer{position:absolute;top:0;left:0;right:0;height:var(--t3p-art-height,190px);pointer-events:none;z-index:-1;overflow:hidden;
  -webkit-mask-image:linear-gradient(to bottom,#000 0,#000 30%,transparent 100%);mask-image:linear-gradient(to bottom,#000 0,#000 30%,transparent 100%)}
.t3p-art-layer[data-preset="none"]{display:none}
.t3p-art-layer[data-main]{z-index:1}
.t3p-art-layer[data-main] .t3p-art-scrim{display:none}
.t3p-art-art{position:absolute;inset:0;opacity:var(--t3p-art-opacity,.5)}
.t3p-art-blobs{position:absolute;inset:-25% -12%;filter:blur(var(--t3p-art-blur,24px))}
.t3p-art-blob{position:absolute;border-radius:50%;will-change:transform;background:radial-gradient(closest-side,var(--c1),transparent)}
.t3p-art-blob:nth-child(1){--c1:var(--t3p-art-a);left:-6%;top:-5%;width:70%;height:75%;animation:t3p-art-a calc(var(--t3p-art-dur,40s)) ease-in-out infinite alternate}
.t3p-art-blob:nth-child(2){--c1:var(--t3p-art-b);left:34%;top:-12%;width:72%;height:70%;animation:t3p-art-b calc(var(--t3p-art-dur,40s) * 1.3) ease-in-out infinite alternate}
.t3p-art-blob:nth-child(3){--c1:var(--t3p-art-c);left:8%;top:18%;width:84%;height:55%;animation:t3p-art-c calc(var(--t3p-art-dur,40s) * 0.8) ease-in-out infinite alternate}
.t3p-art-rays{position:absolute;inset:0 0 25% 0;opacity:.32;filter:blur(2px);display:none;
  background:repeating-linear-gradient(90deg,transparent 0 10px,color-mix(in srgb,var(--t3p-art-a) 55%,transparent) 14px,transparent 24px 36px);
  -webkit-mask-image:linear-gradient(to bottom,#000,transparent 90%);mask-image:linear-gradient(to bottom,#000,transparent 90%);
  animation:t3p-art-rays calc(var(--t3p-art-dur,40s) * 1.6) linear infinite}
.t3p-art-fill{position:absolute;inset:-12%;display:none;filter:blur(var(--t3p-art-blur,24px));background-size:cover;background-position:center}
.t3p-art-scrim{position:absolute;inset:0;
  background:linear-gradient(to bottom,color-mix(in srgb,var(--sidebar,var(--background,#000)) 62%,transparent) 0,color-mix(in srgb,var(--sidebar,var(--background,#000)) 30%,transparent) 44px,transparent 90px)}
.t3p-art-layer[data-scrim="0"] .t3p-art-scrim{display:none}
.t3p-art-layer[data-preset="aurora"] .t3p-art-rays{display:block}
.t3p-art-layer[data-preset="gradient"] .t3p-art-blobs,.t3p-art-layer[data-preset="image"] .t3p-art-blobs{display:none}
.t3p-art-layer[data-preset="gradient"] .t3p-art-fill,.t3p-art-layer[data-preset="image"] .t3p-art-fill{display:block}
.t3p-art-layer[data-preset="gradient"] .t3p-art-fill{background:linear-gradient(var(--t3p-art-angle,160deg),var(--t3p-art-a),var(--t3p-art-b) 55%,var(--t3p-art-c))}
.t3p-art-layer[data-preset="mesh"] .t3p-art-blob:nth-child(1){left:-15%;top:-30%;width:75%;height:110%}
.t3p-art-layer[data-preset="mesh"] .t3p-art-blob:nth-child(2){left:50%;top:-35%;width:70%;height:110%}
.t3p-art-layer[data-preset="mesh"] .t3p-art-blob:nth-child(3){left:25%;top:10%;width:55%;height:80%}
.t3p-art-layer[data-paused] *,.t3p-art-layer[data-still] *{animation-play-state:paused!important}
.t3p-art-layer[data-still] *{animation:none!important}
@media (prefers-reduced-motion:reduce){.t3p-art-layer *{animation:none!important}}
@keyframes t3p-art-a{0%{transform:translate3d(-8%,0,0) scale(1)}100%{transform:translate3d(16%,8%,0) scale(1.18)}}
@keyframes t3p-art-b{0%{transform:translate3d(10%,2%,0) scale(1.1)}100%{transform:translate3d(-14%,-5%,0) scale(.94)}}
@keyframes t3p-art-c{0%{transform:translate3d(0,-4%,0) scale(1)}100%{transform:translate3d(-10%,10%,0) scale(1.2)}}
@keyframes t3p-art-rays{0%{background-position:0 0}100%{background-position:72px 0}}
a[data-t3p-logo="text"]>span:not([data-t3p-logo-node]),a[data-t3p-logo="image"]>span:not([data-t3p-logo-node]){display:none}
a[data-t3p-logo="hide"]{display:none!important}
[data-t3p-logo-node]{display:inline-flex;align-items:center;min-width:0;font-size:.875rem;font-weight:500;letter-spacing:-.01em;line-height:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
[data-t3p-logo-node] img{display:block;width:auto;max-width:150px;object-fit:contain}
.t3p-art-page{display:flex;flex-direction:column;gap:10px;padding:12px 14px;margin-top:12px}
.t3p-art-row{display:flex;align-items:center;gap:8px;min-width:0}
.t3p-art-row>span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.t3p-art-thumb{width:40px;height:24px;border-radius:4px;object-fit:cover;border:1px solid var(--border,currentColor)}
`;

const settings: SettingSchema[] = [
  {
    key: "preset",
    type: "enum",
    default: "aurora",
    label: "Sidebar artwork",
    description: "What sits behind the sidebar header. Also in the command palette: Artwork: switch preset.",
    options: PRESETS.map((value) => ({ value, label: PRESET_LABELS[value] })),
  },
  { key: "intensity", type: "range", default: 60, min: 0, max: 100, label: "Intensity", description: "How strong the artwork is." },
  { key: "speed", type: "range", default: 40, min: 0, max: 100, label: "Speed", description: "Drift speed. 0 is still. Animation also stops while the window is hidden or the system asks for reduced motion." },
  { key: "hue", type: "number", default: -1, min: -1, max: 360, label: "Hue (-1 = app accent)", description: "-1 follows the theme accent color. 0 to 360 picks a fixed hue (150 to 190 is the northern lights look)." },
  { key: "fadeHeight", type: "range", default: 190, min: 60, max: 600, label: "Fade height (px)", description: "How far down the artwork reaches before it fades into the background." },
  { key: "blur", type: "range", default: 24, min: 0, max: 80, label: "Blur (px)", description: "Softness of the glow or image." },
  { key: "angle", type: "range", default: 160, min: 0, max: 360, label: "Gradient angle", description: "Angle of the Gradient preset." },
  { key: "scrim", type: "boolean", default: true, label: "Readability scrim", description: "A faint theme-colored veil under the title row so text stays readable on any artwork." },
  { key: "artworkName", type: "string", default: "", label: "Image name", description: "Which saved image the Image preset shows. Add and pick images in the Artwork images card below." },
  { key: "mainGlow", type: "boolean", default: false, label: "Main area glow", description: "A very subtle glow behind the top of the chat header, same style as the sidebar." },
  {
    key: "logoMode",
    type: "enum",
    default: "keep",
    label: "Logo",
    description: "Restyle the T3 Code wordmark. Window controls, collapse button and arrows are never touched.",
    options: LOGO_MODES.map((value) => ({ value, label: { keep: "Keep stock", text: "Custom text", image: "Custom image", hide: "Hide" }[value] })),
  },
  { key: "oceanOn", type: "boolean", default: false, label: "App background", description: "Turns the full-app background on. Which one is the Background kind below (Ocean, Antigravity, Gradient drift or Starfield). Independent of the sidebar artwork." },
  { key: "bgKind", type: "enum", default: "ocean", label: "Background kind", description: "Only one full-app background runs at a time.", options: BG_KINDS.map((value) => ({ value, label: BG_LABELS[value] })) },
  { key: "bgIntensity", type: "range", default: 60, min: 0, max: 100, label: "Background intensity", description: "How strong the Antigravity, Gradient drift and Starfield backgrounds are." },
  { key: "bgSpeed", type: "range", default: 50, min: 0, max: 100, label: "Background speed", description: "Motion speed of Antigravity, Gradient drift and Starfield. 0 is a still frame." },
  { key: "bgDensity", type: "range", default: 50, min: 0, max: 100, label: "Background density", description: "How many particles (Antigravity, Starfield) or how large the blobs (Gradient drift). The app lowers it by itself when frames get slow." },
  { key: "bgPointer", type: "boolean", default: true, label: "Pointer reactive", description: "Antigravity's ring follows the pointer and the Starfield shifts slightly with it. Gradient drift ignores the pointer." },
  { key: "bgFollowAccent", type: "boolean", default: true, label: "Follow accent color", description: "Colors come from the app accent (or the artwork Color). Off uses each background's own palette." },
  { key: "bgLowPower", type: "boolean", default: false, label: "Low power", description: "Caps Antigravity at 30 fps for laptops on battery. Starfield always runs at 30 fps; Gradient drift costs no JavaScript." },
  { key: "oceanIntensity", type: "range", default: 60, min: 0, max: 100, label: "Ocean intensity", description: "How bright the letters are. Their color follows the app text color." },
  { key: "oceanSpeed", type: "range", default: 50, min: 0, max: 100, label: "Ocean speed", description: "Drift, shimmer and ripple speed. 0 is a still frame. Also still under reduced motion and paused while the window is hidden." },
  { key: "oceanRipples", type: "boolean", default: true, label: "Ocean ripples", description: "Clicks send a ripple through the letters and the pointer lights them up. Clicks always still reach the app." },
  { key: "allowRemoteAssets", type: "boolean", default: false, label: "Allow remote assets", description: "Custom HTML/CSS may load http(s) images and urls. Off by default: remote files can track you and can change." },
  { key: "logoText", type: "string", default: "T3 Code", label: "Logo text", description: "Used when Logo is Custom text." },
  { key: "logoHeight", type: "range", default: 18, min: 10, max: 28, label: "Logo image height (px)", description: "Used when Logo is Custom image." },
];

const plugin: PluginModule = {
  start(t3: T3Api) {
    const disposers: Array<() => void> = [];
    const defs = t3.settings.define(settings);
    disposers.push(() => defs.dispose());

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS + PANEL_CSS;
    document.head.appendChild(style);
    disposers.push(() => style.remove());

    // ---- state -------------------------------------------------------------------------------
    let arts: SavedArtwork[] = [];
    let activeImage: { name: string; url: string } | null = null;
    let logoUrl: string | null = null;
    const listeners = new Set<() => void>();
    const notify = (): void => {
      for (const fn of listeners) fn();
    };

    /** Values being dragged in the dock tab, applied before their debounced write lands. */
    const live = new Map<string, SettingValue>();
    const get = <T extends boolean | string | number>(key: string): T => (live.has(key) ? (live.get(key) as T) : t3.settings.get<T>(key));
    const config = (): ArtworkConfig => ({
      preset: get<string>("preset") as Preset,
      intensity: get<number>("intensity"),
      speed: get<number>("speed"),
      hue: get<number>("hue"),
      fadeHeight: get<number>("fadeHeight"),
      blur: get<number>("blur"),
      angle: get<number>("angle"),
    });

    const custom = new CustomLayers({ allowRemote: () => get<boolean>("allowRemoteAssets") });
    disposers.push(() => custom.dispose());
    let saveError = "";
    let savedBytes = 0;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    disposers.push(() => saveTimer && clearTimeout(saveTimer));
    let customLoaded = false;

    const oceanConfig = (): OceanConfig => ({
      on: get<boolean>("oceanOn") && bgKind() === "ocean" && !custom.active("background"),
      intensity: get<number>("oceanIntensity"),
      speed: get<number>("oceanSpeed"),
      ripples: get<boolean>("oceanRipples"),
      hue: get<number>("hue"),
    });
    const ocean = new Ocean({ config: oceanConfig });
    disposers.push(() => ocean.stop());

    const bgKind = (): BgKind => {
      const k = get<string>("bgKind");
      return isBgKind(k) ? k : "ocean";
    };
    const bgConfig = (kind: BgPresetKind): BgConfig => ({
      on: get<boolean>("oceanOn") && bgKind() === kind && !custom.active("background"),
      intensity: get<number>("bgIntensity"),
      speed: get<number>("bgSpeed"),
      density: get<number>("bgDensity"),
      pointer: get<boolean>("bgPointer"),
      followAccent: get<boolean>("bgFollowAccent"),
      hue: get<number>("hue"),
      lowPower: get<boolean>("bgLowPower"),
    });
    const onAutoStop = (kind: BgPresetKind): void => {
      t3.ui.toast({
        title: "Artwork",
        message: `${BG_LABELS[kind]} background stopped: frames were still slow after lowering the density. Lower Background density, or turn on Low power, then switch it on again.`,
        kind: "warning",
        durationMs: 9000,
      });
    };
    const bgHost = (kind: BgPresetKind) => ({ config: () => bgConfig(kind), onAutoStop });
    const backgrounds = [new Antigravity("antigravity", bgHost("antigravity")), new GradientDrift("drift", bgHost("drift")), new Starfield("starfield", bgHost("starfield"))];
    disposers.push(() => backgrounds.forEach((b) => b.stop()));

    // ---- layers ------------------------------------------------------------------------------
    const makeLayer = (main: boolean): HTMLElement => {
      const layer = document.createElement("div");
      layer.className = "t3p-art-layer";
      layer.setAttribute("aria-hidden", "true");
      if (main) layer.setAttribute("data-main", "");
      layer.innerHTML =
        '<div class="t3p-art-art"><div class="t3p-art-blobs"><i class="t3p-art-blob"></i><i class="t3p-art-blob"></i><i class="t3p-art-blob"></i></div>' +
        '<div class="t3p-art-fill"></div><div class="t3p-art-rays"></div></div><div class="t3p-art-scrim"></div>';
      return layer;
    };
    const sideLayer = makeLayer(false);
    const mainLayer = makeLayer(true);
    let sideHost: HTMLElement | null = null;
    let mainHost: HTMLElement | null = null;

    const applyLayer = (layer: HTMLElement, preset: Preset, vars: Record<string, string>, opacity?: number): void => {
      for (const [k, v] of Object.entries(vars)) layer.style.setProperty(k, v);
      if (opacity !== undefined) layer.style.setProperty("--t3p-art-opacity", String(opacity));
      layer.setAttribute("data-preset", preset);
      layer.setAttribute("data-scrim", get<boolean>("scrim") ? "1" : "0");
      if (get<number>("speed") <= 0) layer.setAttribute("data-still", "");
      else layer.removeAttribute("data-still");
      if (document.hidden) layer.setAttribute("data-paused", "");
      else layer.removeAttribute("data-paused");
      const fill = layer.querySelector<HTMLElement>(".t3p-art-fill");
      if (fill) fill.style.backgroundImage = preset === "image" && activeImage && isSafeImageUrl(activeImage.url) ? `url("${activeImage.url}")` : "";
    };

    const applyLayers = (): void => {
      const cfg = config();
      const vars = layerVars(cfg);
      // Image preset with nothing picked yet shows nothing rather than a blank gradient.
      const preset: Preset = cfg.preset === "image" && !activeImage ? "none" : cfg.preset;
      // Custom header takes over the sidebar backdrop only while it is on and valid.
      applyLayer(sideLayer, custom.active("header") ? "none" : preset, vars);
      const mainPreset: Preset = preset === "image" || preset === "gradient" ? "mesh" : preset;
      const mainOn = get<boolean>("mainGlow") && preset !== "none";
      applyLayer(mainLayer, mainOn ? mainPreset : "none", { ...vars, "--t3p-art-height": "150px" }, mainGlowOpacity(cfg.intensity));
    };

    const mountLayers = (): void => {
      const inner = document.querySelector<HTMLElement>('[data-slot="sidebar-inner"]');
      const host = (inner?.firstElementChild as HTMLElement | null) ?? null;
      if (host && sideLayer.parentElement !== host) {
        host.insertBefore(sideLayer, host.firstChild);
        host.style.isolation = "isolate";
        sideLayer.style.borderTopLeftRadius = sideLayer.style.borderTopRightRadius = getComputedStyle(inner as HTMLElement).borderTopLeftRadius;
        sideHost = host;
      }
      custom.ensure(host);
      const inset = document.querySelector<HTMLElement>('[data-slot="sidebar-inset"]');
      if (inset && mainLayer.parentElement !== inset) {
        inset.insertBefore(mainLayer, inset.firstChild);
        mainHost = inset;
      }
    };

    // ---- logo --------------------------------------------------------------------------------
    const applyLogo = (): void => {
      const a = document.querySelector<HTMLElement>(LOGO_SELECTOR);
      if (!a) return;
      let mode = get<string>("logoMode") as LogoMode;
      if (mode === "image" && !(logoUrl && isSafeImageUrl(logoUrl))) mode = "keep";
      const existing = a.querySelector<HTMLElement>("[data-t3p-logo-node]");
      if (mode === "keep" || mode === "hide") {
        existing?.remove();
        if (mode === "hide") a.setAttribute("data-t3p-logo", "hide");
        else a.removeAttribute("data-t3p-logo");
        return;
      }
      let node = existing;
      if (!node) {
        node = document.createElement("span");
        node.setAttribute("data-t3p-logo-node", "");
        a.prepend(node);
      }
      a.setAttribute("data-t3p-logo", mode);
      if (mode === "text") {
        const text = get<string>("logoText").trim() || "T3 Code";
        if (node.textContent !== text || node.firstElementChild) node.textContent = text;
      } else {
        const height = `${Math.round(clamp(get<number>("logoHeight"), 10, 28))}px`;
        let img = node.querySelector("img");
        if (!img) {
          node.textContent = "";
          img = document.createElement("img");
          img.alt = "";
          node.appendChild(img);
        }
        if (img.getAttribute("src") !== logoUrl) img.src = logoUrl as string;
        img.style.height = height;
      }
    };

    const restoreLogo = (): void => {
      const a = document.querySelector<HTMLElement>(LOGO_SELECTOR);
      a?.removeAttribute("data-t3p-logo");
      a?.querySelector("[data-t3p-logo-node]")?.remove();
    };

    const ensure = (): void => {
      mountLayers();
      applyLogo();
    };
    let raf = 0;
    const schedule = (): void => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        ensure();
      });
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    disposers.push(() => {
      observer.disconnect();
      if (raf) cancelAnimationFrame(raf);
    });

    const applyAll = (): void => {
      ocean.update();
      for (const b of backgrounds) b.update();
      applyLayers();
      ensure();
    };

    const onVisibility = (): void => applyLayers();
    document.addEventListener("visibilitychange", onVisibility);
    disposers.push(() => document.removeEventListener("visibilitychange", onVisibility));

    // ---- storage -----------------------------------------------------------------------------
    const loadArts = async (): Promise<void> => {
      const raw = await t3.storage.get(ARTS_KEY).catch(() => undefined);
      arts = Array.isArray(raw) ? (raw as unknown[]).filter(isSavedArtwork) : [];
    };
    const loadActive = async (): Promise<void> => {
      const name = get<string>("artworkName");
      const found = name ? findArtwork(arts, name) : undefined;
      if (!found) {
        activeImage = null;
        return;
      }
      if (activeImage?.name === found.name) return;
      const url = await t3.storage.get<string>(`art:${found.id}`).catch(() => undefined);
      activeImage = typeof url === "string" && isSafeImageUrl(url) ? { name: found.name, url } : null;
    };
    const loadLogo = async (): Promise<void> => {
      const url = await t3.storage.get<string>(LOGO_KEY).catch(() => undefined);
      logoUrl = typeof url === "string" && isSafeImageUrl(url) ? url : null;
    };
    const refresh = async (): Promise<void> => {
      await loadActive();
      applyAll();
      notify();
    };

    // ---- custom bundle storage ---------------------------------------------------------------
    const STORAGE_HEADROOM = 16_000;
    const persist = (): void => {
      if (!customLoaded) return;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        saveTimer = undefined;
        const text = serializeBundle(custom.bundle());
        const bytes = new TextEncoder().encode(text).length;
        try {
          const u = await t3.storage.usage().catch(() => ({ usedBytes: 0, limitBytes: 1_048_576 }));
          if (bytes > u.limitBytes - u.usedBytes + savedBytes - STORAGE_HEADROOM) {
            saveError = `Not saved: ${Math.round(bytes / 1024)} KB of custom code does not fit in the plugin storage. It stays applied until you restart. Shorten it or delete saved images.`;
          } else {
            await t3.storage.set(CUSTOM_KEY, custom.bundle() as never);
            savedBytes = bytes;
            saveError = "";
          }
        } catch (error) {
          saveError = `Not saved: ${String(error)}`;
        }
        notify();
      }, 500);
    };
    const loadCustom = async (): Promise<void> => {
      const raw = await t3.storage.get(CUSTOM_KEY).catch(() => undefined);
      const parsed = raw === undefined ? { bundle: emptyBundle() } : parseBundle(raw);
      if (parsed.bundle) {
        savedBytes = raw === undefined ? 0 : new TextEncoder().encode(serializeBundle(parsed.bundle)).length;
        custom.load(parsed.bundle);
      }
      customLoaded = true;
    };
    disposers.push(
      custom.onChange(() => {
        applyAll();
        persist();
        notify();
      }),
    );

    // ---- image encode ------------------------------------------------------------------------
    const encodeImage = async (file: File, maxEdge: number, budget: number, alpha: boolean): Promise<string | null> => {
      const bitmap = await createImageBitmap(file);
      try {
        const base = fitSize(bitmap.width, bitmap.height, maxEdge);
        for (const step of encodeSteps()) {
          const w = Math.max(1, Math.round(base.width * step.scale));
          const h = Math.max(1, Math.round(base.height * step.scale));
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          if (!ctx) return null;
          ctx.drawImage(bitmap, 0, 0, w, h);
          const url = canvas.toDataURL(alpha ? "image/webp" : "image/jpeg", step.quality);
          if (dataUrlBytes(url) <= budget) return url;
        }
        return null;
      } finally {
        bitmap.close();
      }
    };

    const budgetFor = async (replacing = 0): Promise<number> => {
      const u = await t3.storage.usage().catch(() => ({ usedBytes: 0, limitBytes: 1_048_576 }));
      return imageBudget(u.limitBytes, u.usedBytes, replacing);
    };

    const reject = (message: string): void => {
      t3.ui.toast({ title: "Artwork", message, kind: "error" });
    };

    const addArtwork = async (file: File): Promise<void> => {
      if (!file.type.startsWith("image/")) return reject("That file is not an image.");
      try {
        const url = await encodeImage(file, MAX_IMAGE_EDGE, await budgetFor(), false);
        if (!url) return reject("Image is too large even after downscaling (cap 2 MB, and the plugin storage is limited). Try a smaller image.");
        const name = uniqueName(cleanName(file.name), arts.map((a) => a.name));
        const id = crypto.randomUUID();
        await t3.storage.set(`art:${id}`, url);
        arts = [...arts, { id, name, bytes: dataUrlBytes(url) }];
        await t3.storage.set(ARTS_KEY, arts as never);
        await t3.settings.set("artworkName", name);
        await t3.settings.set("preset", "image");
        t3.ui.toast({ title: "Artwork", message: `Saved "${name}" (${Math.round(dataUrlBytes(url) / 1024)} KB).`, kind: "success" });
        activeImage = null;
        await refresh();
      } catch (error) {
        reject(`Could not save the image: ${String(error)}`);
      }
    };

    const deleteArtwork = async (art: SavedArtwork): Promise<void> => {
      await t3.storage.delete(`art:${art.id}`);
      arts = arts.filter((a) => a.id !== art.id);
      await t3.storage.set(ARTS_KEY, arts as never);
      if (get<string>("artworkName").toLowerCase() === art.name.toLowerCase()) await t3.settings.set("artworkName", "");
      activeImage = null;
      await refresh();
    };

    const setLogo = async (file: File): Promise<void> => {
      if (!file.type.startsWith("image/")) return reject("That file is not an image.");
      try {
        const url = await encodeImage(file, MAX_LOGO_EDGE, await budgetFor(dataUrlBytes(logoUrl ?? "")), true);
        if (!url) return reject("Logo image is too large.");
        await t3.storage.set(LOGO_KEY, url);
        logoUrl = url;
        await t3.settings.set("logoMode", "image");
        applyAll();
        notify();
      } catch (error) {
        reject(`Could not save the logo: ${String(error)}`);
      }
    };

    const clearLogo = async (): Promise<void> => {
      await t3.storage.delete(LOGO_KEY);
      logoUrl = null;
      if (get<string>("logoMode") === "image") await t3.settings.set("logoMode", "keep");
      applyAll();
      notify();
    };

    // ---- dock tab ----------------------------------------------------------------------------
    const thumbs = new Map<string, string>();
    const useArtwork = async (art: SavedArtwork): Promise<void> => {
      await t3.settings.set("artworkName", art.name);
      await t3.settings.set("preset", "image");
      activeImage = null;
      await refresh();
    };
    const customApi = {
      view: (id: CustomId) => custom.view(id),
      update: (id: CustomId, patch: Partial<{ enabled: boolean; html: string; css: string }>) => custom.update(id, patch),
      fromPreset(id: CustomId) {
        const tpl = id === "header" ? headerTemplate(config()) : backgroundTemplate(config());
        custom.update(id, { html: tpl.html, css: tpl.css });
      },
      reset: (id: CustomId) => void custom.update(id, { enabled: false, html: "", css: "" }),
      exportText: () => JSON.stringify(custom.bundle(), null, 2),
      importText(text: string): string | null {
        const parsed = parseBundle(text.trim());
        if (!parsed.bundle) return parsed.error ?? "Could not read that bundle.";
        custom.load(parsed.bundle);
        return null;
      },
      allowRemote: () => get<boolean>("allowRemoteAssets"),
      setAllowRemote: (value: boolean) => void t3.settings.set("allowRemoteAssets", value),
      async stats() {
        const u = await t3.storage.usage().catch(() => ({ usedBytes: 0, limitBytes: 1_048_576 }));
        return { bundleBytes: new TextEncoder().encode(serializeBundle(custom.bundle())).length, usedBytes: u.usedBytes, limitBytes: u.limitBytes };
      },
      status: () => saveError,
      subscribe(fn: () => void) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
    const tab = t3.ui.register({
      slot: "rightPanel",
      id: "panel",
      title: "Artwork",
      render(host) {
        return renderPanel(host, {
          t3,
          config,
          arts: () => arts,
          activeName: () => get<string>("artworkName"),
          logoUrl: () => logoUrl,
          async thumb(art) {
            const cached = thumbs.get(art.id);
            if (cached) return cached;
            const url = await t3.storage.get<string>(`art:${art.id}`).catch(() => undefined);
            if (typeof url !== "string" || !isSafeImageUrl(url)) return null;
            thumbs.set(art.id, url);
            return url;
          },
          addArt: addArtwork,
          useArt: useArtwork,
          deleteArt: async (art) => {
            thumbs.delete(art.id);
            await deleteArtwork(art);
          },
          setLogo,
          clearLogo,
          custom: customApi,
          subscribe(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
          },
          preview(key, value) {
            if (value === undefined) live.delete(key);
            else live.set(key, value);
            applyAll();
          },
        });
      },
    });
    disposers.push(() => tab.dispose());

    // ---- settings page card ------------------------------------------------------------------
    const page = t3.ui.register({
      slot: "settingsPage",
      id: "images",
      title: "Artwork images",
      render(host) {
        const root = document.createElement("div");
        root.className = "t3p-card t3p-art-page";
        host.appendChild(root);
        const button = (label: string, onClick: () => void, variant?: string): HTMLButtonElement => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "t3p-btn";
          if (variant) b.setAttribute("data-variant", variant);
          b.textContent = label;
          b.addEventListener("click", onClick);
          return b;
        };
        const picker = (label: string, onFile: (file: File) => Promise<void>): HTMLElement => {
          const input = document.createElement("input");
          input.type = "file";
          input.accept = "image/*";
          input.hidden = true;
          input.addEventListener("change", () => {
            const file = input.files?.[0];
            input.value = "";
            if (file) void onFile(file);
          });
          const wrap = document.createElement("span");
          wrap.style.flex = "none";
          wrap.append(input, button(label, () => input.click()));
          return wrap;
        };
        const draw = (): void => {
          root.textContent = "";
          const title = document.createElement("div");
          title.textContent = "Artwork images";
          title.style.cssText = "font-size:13px;font-weight:600";
          const hint = document.createElement("div");
          hint.className = "t3p-meta";
          hint.textContent = "Images are downscaled to 1600 px and saved in this plugin's storage. Pick one by name here, or with Artwork: switch image in the command palette.";
          root.append(title, hint);
          const add = document.createElement("div");
          add.className = "t3p-art-row";
          add.appendChild(picker("Add image...", addArtwork));
          root.appendChild(add);
          const active = get<string>("artworkName").toLowerCase();
          for (const art of arts) {
            const row = document.createElement("div");
            row.className = "t3p-art-row";
            const name = document.createElement("span");
            name.textContent = `${art.name} (${Math.round(art.bytes / 1024)} KB)${art.name.toLowerCase() === active ? " - in use" : ""}`;
            row.append(
              name,
              button("Use", () => {
                void t3.settings.set("artworkName", art.name).then(() => t3.settings.set("preset", "image")).then(refresh);
              }),
              button("Delete", () => void deleteArtwork(art), "ghost"),
            );
            root.appendChild(row);
          }
          const logoTitle = document.createElement("div");
          logoTitle.className = "t3p-meta";
          logoTitle.textContent = "Logo image (small, scaled to fit the title row height)";
          logoTitle.style.marginTop = "6px";
          root.appendChild(logoTitle);
          const logoRow = document.createElement("div");
          logoRow.className = "t3p-art-row";
          if (logoUrl) {
            const img = document.createElement("img");
            img.className = "t3p-art-thumb";
            img.style.objectFit = "contain";
            img.src = logoUrl;
            logoRow.appendChild(img);
          }
          logoRow.appendChild(picker(logoUrl ? "Replace logo..." : "Choose logo...", setLogo));
          if (logoUrl) logoRow.appendChild(button("Clear", () => void clearLogo(), "ghost"));
          root.appendChild(logoRow);
          const resetHost = document.createElement("div");
          resetHost.style.marginTop = "8px";
          root.appendChild(resetHost);
          mountResetAll(resetHost, t3, customApi, () => void refresh());
        };
        listeners.add(draw);
        draw();
        return () => {
          listeners.delete(draw);
          root.remove();
        };
      },
    });
    disposers.push(() => page.dispose());

    // ---- commands ----------------------------------------------------------------------------
    const cmds = [
      t3.commands.register({
        id: "switch-preset",
        title: "Artwork: switch preset",
        description: "Choose the sidebar artwork preset",
        keywords: ["aurora", "gradient", "mesh", "image", "none", "background"],
        async run() {
          const index = await t3.ui.modal({ title: "Artwork preset", body: "Pick the artwork behind the sidebar header.", buttons: PRESETS.map((p) => PRESET_LABELS[p]) });
          const picked = PRESETS[index];
          if (picked) await t3.settings.set("preset", picked);
        },
      }),
      t3.commands.register({
        id: "open-panel",
        title: "Artwork: open panel",
        description: "Open the Artwork tab in the plugin dock",
        keywords: ["artwork", "dock", "settings", "tune"],
        run: () => t3.ui.dock.open("panel"),
      }),
      t3.commands.register({
        id: "next-preset",
        title: "Artwork: next preset",
        description: "Cycle to the next artwork preset",
        run: () => t3.settings.set("preset", nextPreset(get<string>("preset"))),
      }),
      t3.commands.register({
        id: "switch-image",
        title: "Artwork: switch image",
        description: "Choose one of the saved images",
        async run() {
          if (arts.length === 0) {
            t3.ui.toast({ title: "Artwork", message: "No saved images yet. Add one in Settings > Plugins > Artwork.", kind: "info" });
            return;
          }
          const shown = arts.slice(0, 8);
          const index = await t3.ui.modal({ title: "Artwork image", body: "Pick a saved image.", buttons: shown.map((a) => a.name) });
          const picked = shown[index];
          if (!picked) return;
          await t3.settings.set("artworkName", picked.name);
          await t3.settings.set("preset", "image");
        },
      }),
    ];
    disposers.push(() => cmds.forEach((c) => c.dispose()));

    // ---- go ----------------------------------------------------------------------------------
    const unsub = t3.settings.onChange((change) => {
      live.delete(change.key);
      if (change.key === "allowRemoteAssets") custom.revalidate();
      void refresh();
    });
    disposers.push(unsub);
    applyAll();
    void Promise.all([loadArts(), loadLogo(), loadCustom()]).then(refresh);

    return () => {
      for (const d of disposers.reverse()) {
        try {
          d();
        } catch {
          /* best effort */
        }
      }
      sideLayer.remove();
      mainLayer.remove();
      if (sideHost) sideHost.style.isolation = "";
      void mainHost;
      restoreLogo();
    };
  },
};

export default plugin;
