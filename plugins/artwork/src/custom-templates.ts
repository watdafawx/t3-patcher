import { clamp, layerOpacity, layerVars, type ArtworkConfig } from "./model.js";

/** Starting markup and CSS for the Custom editors, generated from the active preset. */
export interface Template {
  html: string;
  css: string;
}

const MASK = "linear-gradient(to bottom,black 0,black 30%,transparent 100%)";

function vars(cfg: ArtworkConfig): string {
  const v = layerVars(cfg);
  return `--a:${v["--t3p-art-a"]};--b:${v["--t3p-art-b"]};--c:${v["--t3p-art-c"]}`;
}

function drift(cfg: ArtworkConfig): { a: string; b: string; c: string; keyframes: string } {
  const still = cfg.speed <= 0;
  const dur = parseFloat(layerVars(cfg)["--t3p-art-dur"]!);
  const anim = (name: string, mult: number): string => (still ? "" : `;animation:${name} ${Math.round(dur * mult)}s ease-in-out infinite alternate`);
  return {
    a: anim("drift-a", 1),
    b: anim("drift-b", 1.3),
    c: anim("drift-c", 0.8),
    keyframes: still
      ? ""
      : "\n@keyframes drift-a{0%{transform:translate3d(-8%,0,0) scale(1)}100%{transform:translate3d(16%,8%,0) scale(1.18)}}" +
        "\n@keyframes drift-b{0%{transform:translate3d(10%,2%,0) scale(1.1)}100%{transform:translate3d(-14%,-5%,0) scale(.94)}}" +
        "\n@keyframes drift-c{0%{transform:translate3d(0,-4%,0) scale(1)}100%{transform:translate3d(-10%,10%,0) scale(1.2)}}",
  };
}

const BLOBS = '<div class="blobs"><i></i><i></i><i></i></div>';

/** Sidebar header: the active sidebar preset as editable markup. */
export function headerTemplate(cfg: ArtworkConfig): Template {
  const blur = Math.round(clamp(cfg.blur, 0, 80));
  const height = Math.round(clamp(cfg.fadeHeight, 60, 600));
  const root = `:root{${vars(cfg)};height:${height}px;opacity:${layerOpacity(cfg.intensity)};-webkit-mask-image:${MASK};mask-image:${MASK}}`;
  if (cfg.preset === "none") return { html: "", css: `/* Nothing yet. Edit the markup and CSS, the container is :root. */\n${root}` };
  if (cfg.preset === "gradient") {
    return {
      html: '<div class="fill"></div>',
      css: `${root}\n.fill{position:absolute;inset:-12%;filter:blur(${blur}px);background:linear-gradient(${Math.round(clamp(cfg.angle, 0, 360))}deg,var(--a),var(--b) 55%,var(--c))}`,
    };
  }
  const d = drift(cfg);
  const mesh = cfg.preset === "mesh" || cfg.preset === "image";
  const pos = mesh
    ? ["left:-15%;top:-30%;width:75%;height:110%", "left:50%;top:-35%;width:70%;height:110%", "left:25%;top:10%;width:55%;height:80%"]
    : ["left:-6%;top:-5%;width:70%;height:75%", "left:34%;top:-12%;width:72%;height:70%", "left:8%;top:18%;width:84%;height:55%"];
  const rays =
    cfg.preset === "aurora"
      ? `\n.rays{position:absolute;inset:0 0 25% 0;opacity:.32;filter:blur(2px);background:repeating-linear-gradient(90deg,transparent 0 10px,color-mix(in srgb,var(--a) 55%,transparent) 14px,transparent 24px 36px);-webkit-mask-image:linear-gradient(to bottom,black,transparent 90%);mask-image:linear-gradient(to bottom,black,transparent 90%)}`
      : "";
  return {
    html: BLOBS + (cfg.preset === "aurora" ? '<div class="rays"></div>' : ""),
    css:
      `${root}\n.blobs{position:absolute;inset:-25% -12%;filter:blur(${blur}px)}\n` +
      ".blobs i{position:absolute;border-radius:50%;background:radial-gradient(closest-side,var(--c1),transparent)}\n" +
      `.blobs i:nth-child(1){--c1:var(--a);${pos[0]}${d.a}}\n.blobs i:nth-child(2){--c1:var(--b);${pos[1]}${d.b}}\n.blobs i:nth-child(3){--c1:var(--c);${pos[2]}${d.c}}${rays}${d.keyframes}`,
  };
}

/** Whole-app background: the same glow, scaled to the full window. (The Ocean canvas cannot be exported as markup.) */
export function backgroundTemplate(cfg: ArtworkConfig): Template {
  const blur = Math.round(clamp(cfg.blur, 0, 80)) + 36;
  const opacity = Math.round(layerOpacity(cfg.intensity) * 0.6 * 100) / 100;
  const d = drift(cfg);
  return {
    html: BLOBS,
    css:
      `:root{${vars(cfg)};opacity:${opacity}}\n.blobs{position:absolute;inset:-10%;filter:blur(${blur}px)}\n` +
      ".blobs i{position:absolute;border-radius:50%;background:radial-gradient(closest-side,var(--c1),transparent)}\n" +
      `.blobs i:nth-child(1){--c1:var(--a);left:-5%;top:-10%;width:55%;height:60%${d.a}}\n` +
      `.blobs i:nth-child(2){--c1:var(--b);left:45%;top:5%;width:60%;height:65%${d.b}}\n` +
      `.blobs i:nth-child(3){--c1:var(--c);left:15%;top:45%;width:70%;height:60%${d.c}}${d.keyframes}`,
  };
}
