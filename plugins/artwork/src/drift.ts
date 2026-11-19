import { BgLayer } from "./bg-base.js";
import { FIXED_PALETTE, rgbaString } from "./bg-model.js";
import { accentColor, clamp, shiftedColor } from "./model.js";

/**
 * "Gradient drift" background: four large soft blobs that slowly drift and breathe behind the app.
 *
 * Cost class: compositor only. No JS per frame and no canvas: the blobs are radial gradients (no
 * `filter: blur`) that animate `transform` alone, so each one is a cached GPU layer that is only
 * re-positioned. Paused (`animation-play-state`) while the window is hidden or blurred for 5 s, and
 * static under `prefers-reduced-motion` or speed 0. Pointer and density do not apply.
 */

export const DRIFT_CSS = `
#t3p-bg-drift i{position:absolute;display:block;width:var(--t3p-bgd-size);height:var(--t3p-bgd-size);margin:calc(var(--t3p-bgd-size)/-2) 0 0 calc(var(--t3p-bgd-size)/-2);border-radius:50%;background:radial-gradient(circle closest-side,var(--c) 0%,transparent 100%);opacity:var(--t3p-bgd-opacity);will-change:transform;animation:var(--k) var(--d) ease-in-out infinite alternate;animation-delay:var(--delay)}
#t3p-bg-drift i:nth-child(1){left:18%;top:22%;--c:var(--t3p-bgd-1);--k:t3p-bgd-a;--d:calc(var(--t3p-bgd-dur)*1);--delay:0s}
#t3p-bg-drift i:nth-child(2){left:82%;top:28%;--c:var(--t3p-bgd-2);--k:t3p-bgd-b;--d:calc(var(--t3p-bgd-dur)*1.25);--delay:calc(var(--t3p-bgd-dur)*-0.4)}
#t3p-bg-drift i:nth-child(3){left:30%;top:86%;--c:var(--t3p-bgd-3);--k:t3p-bgd-c;--d:calc(var(--t3p-bgd-dur)*1.5);--delay:calc(var(--t3p-bgd-dur)*-0.9)}
#t3p-bg-drift i:nth-child(4){left:76%;top:82%;--c:var(--t3p-bgd-4);--k:t3p-bgd-d;--d:calc(var(--t3p-bgd-dur)*1.8);--delay:calc(var(--t3p-bgd-dur)*-1.3)}
#t3p-bg-drift[data-paused] i{animation-play-state:paused}
#t3p-bg-drift[data-still] i{animation:none}
@keyframes t3p-bgd-a{from{transform:translate3d(-6vw,-4vh,0) scale(1)}to{transform:translate3d(9vw,8vh,0) scale(1.2)}}
@keyframes t3p-bgd-b{from{transform:translate3d(5vw,-6vh,0) scale(1.1)}to{transform:translate3d(-10vw,7vh,0) scale(.9)}}
@keyframes t3p-bgd-c{from{transform:translate3d(-8vw,4vh,0) scale(.95)}to{transform:translate3d(8vw,-8vh,0) scale(1.18)}}
@keyframes t3p-bgd-d{from{transform:translate3d(6vw,6vh,0) scale(1.15)}to{transform:translate3d(-7vw,-6vh,0) scale(.92)}}
@media (prefers-reduced-motion:reduce){#t3p-bg-drift i{animation:none}}
`;

export class GradientDrift extends BgLayer {
  protected css(): string {
    return DRIFT_CSS;
  }

  protected create(): HTMLElement {
    const root = document.createElement("div");
    for (let i = 0; i < 4; i++) root.appendChild(document.createElement("i"));
    return root;
  }

  protected override configure(): void {
    const root = this.root;
    if (!root) return;
    const { intensity, density, followAccent, hue } = this.cfg;
    const colors = followAccent
      ? [accentColor(hue), shiftedColor(hue, 35), shiftedColor(hue, -30), shiftedColor(hue, 70)]
      : [rgbaString(FIXED_PALETTE[0], 1), rgbaString(FIXED_PALETTE[1], 1), rgbaString(FIXED_PALETTE[2], 1), rgbaString(FIXED_PALETTE[1], 1)];
    colors.forEach((c, i) => root.style.setProperty(`--t3p-bgd-${i + 1}`, c));
    root.style.setProperty("--t3p-bgd-opacity", String(Math.round(clamp(intensity, 0, 100) * 0.9) / 100));
    root.style.setProperty("--t3p-bgd-size", `${Math.round(32 + clamp(density, 0, 100) * 0.26)}vmax`);
    // Seconds for one drift leg at the shortest blob: 50 s at the default speed.
    root.style.setProperty("--t3p-bgd-dur", `${Math.round((50 / Math.max(this.params.speed, 0.05)) * 10) / 10}s`);
  }

  protected run(): void {
    this.root?.removeAttribute("data-paused");
    this.root?.removeAttribute("data-still");
  }

  protected halt(): void {
    this.root?.setAttribute("data-paused", "");
  }

  protected still(): void {
    this.root?.setAttribute("data-still", "");
  }
}
