/** Pure helpers for the artwork plugin: preset to CSS variables, color math, image sizing, name handling. */

export const PRESETS = ["aurora", "gradient", "mesh", "image", "none"] as const;
export type Preset = (typeof PRESETS)[number];

export const PRESET_LABELS: Record<Preset, string> = {
  aurora: "Aurora",
  gradient: "Gradient",
  mesh: "Mesh glow",
  image: "Image",
  none: "None",
};

export const LOGO_MODES = ["keep", "text", "image", "hide"] as const;
export type LogoMode = (typeof LOGO_MODES)[number];

export interface ArtworkConfig {
  preset: Preset;
  /** 0 to 100 */
  intensity: number;
  /** 0 (still) to 100 */
  speed: number;
  /** Degrees 0 to 360, or a negative number for "derive from the app accent (--primary)". */
  hue: number;
  /** Layer height in px. */
  fadeHeight: number;
  /** Blur in px. */
  blur: number;
  /** Gradient angle in degrees. */
  angle: number;
}

/** Hue the "follow app accent" switch falls back to when turned off. */
export const HUE_DEFAULT_FIXED = 165;

export const MAX_IMAGE_EDGE = 1600;
export const MAX_IMAGE_BYTES = 2_000_000;
export const MAX_LOGO_EDGE = 160;
const STORAGE_HEADROOM = 16_000;

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

const FALLBACK_ACCENT = "oklch(0.72 0.15 165)";

/** Base accent: the app's `--primary` live, or a fixed hue. Never a copied computed value, so theme switches follow. */
export function accentColor(hue: number): string {
  if (hue < 0) return `var(--primary, ${FALLBACK_ACCENT})`;
  return `oklch(0.74 0.15 ${Math.round(hue % 360)})`;
}

/** Accent with its hue rotated by `shift` degrees (second and third aurora colors). */
export function shiftedColor(hue: number, shift: number): string {
  if (hue < 0) return `oklch(from var(--primary, ${FALLBACK_ACCENT}) max(l, 0.6) max(c, 0.1) calc(h + ${shift}))`;
  return `oklch(0.74 0.15 ${(((Math.round(hue) + shift) % 360) + 360) % 360})`;
}

/** Seconds for one drift cycle, or null when the speed is 0 (no animation). */
export function durationSeconds(speed: number): number | null {
  const s = clamp(speed, 0, 100);
  if (s <= 0) return null;
  return Math.round((80 - (s / 100) * 70) * 10) / 10;
}

/** Peak layer opacity for an intensity, 0 to 0.85. */
export function layerOpacity(intensity: number): number {
  return Math.round(clamp(intensity, 0, 100) * 0.85) / 100;
}

/** The glow behind the chat header is a lot weaker than the sidebar one. */
export function mainGlowOpacity(intensity: number): number {
  return Math.round(clamp(intensity, 0, 100) * 0.3) / 100;
}

/** CSS custom properties the layer stylesheet reads. */
export function layerVars(cfg: ArtworkConfig): Record<string, string> {
  const dur = durationSeconds(cfg.speed);
  return {
    "--t3p-art-a": accentColor(cfg.hue),
    "--t3p-art-b": shiftedColor(cfg.hue, 35),
    "--t3p-art-c": shiftedColor(cfg.hue, -30),
    "--t3p-art-opacity": String(layerOpacity(cfg.intensity)),
    "--t3p-art-height": `${Math.round(clamp(cfg.fadeHeight, 60, 600))}px`,
    "--t3p-art-blur": `${Math.round(clamp(cfg.blur, 0, 80))}px`,
    "--t3p-art-angle": `${Math.round(clamp(cfg.angle, 0, 360))}deg`,
    "--t3p-art-dur": `${dur ?? 60}s`,
  };
}

export function nextPreset(current: string, step = 1): Preset {
  const i = PRESETS.indexOf(current as Preset);
  const from = i < 0 ? 0 : i;
  return PRESETS[(from + step + PRESETS.length) % PRESETS.length]!;
}

/** Scales (w, h) down so the longest edge is at most `max`; never scales up. Integers. */
export function fitSize(width: number, height: number, max: number): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 1, height: 1 };
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Decoded byte size of a base64 data URL (0 for anything else). */
export function dataUrlBytes(url: string): number {
  const m = /^data:[^,]*;base64,(.*)$/s.exec(url);
  if (!m) return 0;
  const b64 = m[1]!;
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/**
 * Bytes one image may use: the 2 MB cap, further limited by what is left of the plugin's storage quota.
 * `replacing` is the size of the entry being overwritten, which frees up.
 */
export function imageBudget(limitBytes: number, usedBytes: number, replacing = 0): number {
  return Math.max(0, Math.min(MAX_IMAGE_BYTES, limitBytes - usedBytes + replacing - STORAGE_HEADROOM));
}

/** Encoding attempts from best to smallest: [quality, edge scale]. */
export function encodeSteps(): Array<{ quality: number; scale: number }> {
  return [
    { quality: 0.86, scale: 1 },
    { quality: 0.74, scale: 1 },
    { quality: 0.62, scale: 0.85 },
    { quality: 0.5, scale: 0.7 },
    { quality: 0.4, scale: 0.55 },
    { quality: 0.35, scale: 0.4 },
  ];
}

export function cleanName(raw: string): string {
  return raw.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/\s+/g, " ").trim().slice(0, 40) || "Artwork";
}

/** `name`, or `name 2`, `name 3` when taken (case-insensitive). */
export function uniqueName(name: string, existing: readonly string[]): string {
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i += 1) {
    const candidate = `${name} ${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export interface SavedArtwork {
  id: string;
  name: string;
  bytes: number;
}

export function findArtwork(list: readonly SavedArtwork[], name: string): SavedArtwork | undefined {
  const wanted = name.trim().toLowerCase();
  return list.find((a) => a.name.toLowerCase() === wanted);
}

export function isSavedArtwork(value: unknown): value is SavedArtwork {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.name === "string" && typeof v.bytes === "number";
}

/** True when `url` may be put into `background-image` (our own data URLs only). */
export function isSafeImageUrl(url: string): boolean {
  return /^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(url);
}

// ---- ocean background ---------------------------------------------------------------------------

export interface OceanConfig {
  on: boolean;
  /** 0 to 100: how bright the letters get. */
  intensity: number;
  /** 0 (still) to 100. */
  speed: number;
  ripples: boolean;
  /** Same hue setting as the sidebar artwork: negative follows the app accent. */
  hue: number;
}

export interface OceanParams {
  /** Multiplier for every ink and glow alpha. */
  alpha: number;
  /** Noise drift per second. */
  drift: number;
  /** Share of the grid that re-rolls its letter each frame. */
  shimmer: number;
  /** Ripple front speed, px per second. */
  rippleSpeed: number;
  animated: boolean;
}

export function oceanParams(cfg: Pick<OceanConfig, "intensity" | "speed">): OceanParams {
  const speed = clamp(cfg.speed, 0, 100) / 50; // 1 at the default 50
  return {
    alpha: Math.round((clamp(cfg.intensity, 0, 100) / 60) * 1000) / 1000, // 1 at the default 60
    drift: 0.035 * speed,
    shimmer: 0.015 * speed,
    rippleSpeed: 300 * Math.max(0.3, speed),
    animated: speed > 0,
  };
}

export type Rgb = readonly [number, number, number];

/** Base alphas of the five ink bands and the two ripple glow bands (at alpha multiplier 1). */
export const OCEAN_INK_ALPHAS = [0.035, 0.06, 0.09, 0.13, 0.18] as const;
export const OCEAN_GLOW_ALPHAS = [0.45, 0.75] as const;

const rgba = (c: Rgb, a: number): string => `rgba(${c[0]},${c[1]},${c[2]},${Math.round(clamp(a, 0, 1) * 1000) / 1000})`;

/** Ink band colors from the app foreground, glow band colors from the accent. */
export function oceanPalette(fg: Rgb, accent: Rgb, alpha: number): { ink: string[]; glow: string[] } {
  const light: Rgb = [Math.round((accent[0] + 255 * 2) / 3), Math.round((accent[1] + 255 * 2) / 3), Math.round((accent[2] + 255 * 2) / 3)];
  return {
    ink: OCEAN_INK_ALPHAS.map((a) => rgba(fg, a * alpha)),
    glow: [rgba(accent, OCEAN_GLOW_ALPHAS[0] * Math.min(1, alpha)), rgba(light, OCEAN_GLOW_ALPHAS[1] * Math.min(1, alpha))],
  };
}

/** `rgb(...)`, `rgba(...)`, `#rgb` or `#rrggbb` to a triple; null for anything else (the canvas resolves the rest). */
export function parseRgb(text: string): Rgb | null {
  const s = text.trim().toLowerCase();
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s);
  if (fn) return [Math.round(Number(fn[1])), Math.round(Number(fn[2])), Math.round(Number(fn[3]))];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (!hex) return null;
  const h = hex[1]!.length === 3 ? [...hex[1]!].map((c) => c + c).join("") : hex[1]!;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
