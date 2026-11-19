/**
 * DOM rendering for the status bar chip and the panel. All values arrive through
 * {@link PanelSource}; this module never touches `t3` or timers itself.
 *
 * Text is always written with `textContent` (provider labels and server messages are
 * untrusted), and colors come from {@link themeTokens} (app CSS variables plus the
 * threshold accent fallbacks).
 */

import type { ProviderSnapshot } from "@t3p/api";

import {
  buildProviderViews,
  formatChipText,
  pickWorst,
  type LimitThresholds,
  type ProviderLimitsView,
} from "./limits.js";
import { themeTokens, type ThemeTokens } from "./theme.js";

/** Everything the views read. Implemented by the plugin controller. */
export interface PanelSource {
  providers(): readonly ProviderSnapshot[];
  loading(): boolean;
  error(): string | null;
  thresholds(): LimitThresholds;
  /** Epoch ms used for every countdown. */
  now(): number;
  onChange(callback: () => void): () => void;
  /** Asks the controller to re-probe providers. */
  refresh(): void;
  themeVars(): Record<string, string>;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, style = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  if (text !== undefined) node.textContent = text;
  return node;
}

function line(style: string, text: string): HTMLDivElement {
  return element("div", style, text);
}

/**
 * Mounts the compact status bar chip. Clicking it calls `open` (the controller opens the
 * panel). Returns a cleanup that unsubscribes and removes the chip.
 */
export function mountChip(host: HTMLElement, source: PanelSource, visible: () => boolean, open: () => void): () => void {
  const button = element("button", "white-space:nowrap");
  button.className = "t3p-chip";
  button.setAttribute("data-compact", "");
  button.type = "button";
  button.dataset.t3pProviderLimits = "chip";
  button.title = "Provider limits — click to open the panel";
  const dot = element("span", "display:inline-block;width:6px;height:6px;border-radius:999px;flex:none");
  const label = element("span");
  button.append(dot, label);

  const paint = (): void => {
    button.style.display = visible() ? "inline-flex" : "none";
    const tokens = themeTokens(source.themeVars());
    const worst = pickWorst(source.providers(), source.thresholds());
    const accent = tokens.accent[worst?.level ?? "ok"];
    dot.style.background = accent;
    if (worst) {
      label.textContent = formatChipText(worst, source.now());
      button.title = `${worst.providerLabel} · ${worst.windowLabel} · ${formatChipText(worst, source.now())}\nClick to open provider limits`;
    } else if (source.loading()) {
      label.textContent = "Limits: loading…";
    } else if (source.error()) {
      label.textContent = "Limits: unavailable";
    } else {
      label.textContent = "Limits: no data";
    }
  };

  button.addEventListener("click", open);
  host.appendChild(button);
  const off = source.onChange(paint);
  paint();
  return () => {
    off();
    button.remove();
  };
}

/**
 * Mounts the full panel (provider rows, windows, countdowns). `header` adds the title and
 * the Refresh button; the modal passes `false` because it already has a title.
 * Returns a cleanup that unsubscribes and removes the panel.
 */
export function mountPanel(
  host: HTMLElement,
  source: PanelSource,
  options: { header?: boolean } = {},
): () => void {
  const root = element(
    "section",
    "display:flex;flex-direction:column;gap:10px;padding:12px;font-size:12px;line-height:1.4;box-sizing:border-box;min-width:0",
  );
  root.dataset.t3pProviderLimits = "panel";
  root.setAttribute("aria-label", "Provider limits");

  const tokens = (): ThemeTokens => themeTokens(source.themeVars());
  let refreshButton: HTMLButtonElement | null = null;

  if (options.header !== false) {
    const head = element("div", "display:flex;align-items:center;gap:8px");
    const title = element("strong", "", "Provider limits");
    const spacer = element("span", "flex:1");
    refreshButton = element("button", "");
    refreshButton.className = "t3p-btn";
    refreshButton.type = "button";
    refreshButton.textContent = "Refresh";
    refreshButton.addEventListener("click", () => {
      if (refreshButton) refreshButton.textContent = "Refreshing…";
      source.refresh();
    });
    head.append(title, spacer, refreshButton);
    root.append(head);
  }

  const body = element("div", "display:flex;flex-direction:column;gap:10px;min-width:0");
  root.append(body);
  host.appendChild(root);

  const paint = (): void => {
    const theme = tokens();
    root.style.color = theme.text;
    if (refreshButton) refreshButton.textContent = source.loading() ? "Refreshing…" : "Refresh";
    body.replaceChildren();

    const error = source.error();
    if (error) body.append(line(`color:${theme.accentText.critical};word-break:break-word`, `Could not read providers: ${error}`));
    if (source.loading() && source.providers().length === 0) {
      body.append(line(`color:${theme.mutedText}`, "Loading provider limits…"));
      return;
    }
    if (source.providers().length === 0) {
      if (!error) body.append(line(`color:${theme.mutedText}`, "No providers reported."));
      return;
    }

    const views = buildProviderViews(source.providers(), source.thresholds(), source.now());
    for (const view of views) body.append(renderProvider(view, theme));
  };

  const off = source.onChange(paint);
  paint();
  return () => {
    off();
    root.remove();
  };
}

function renderProvider(view: ProviderLimitsView, theme: ThemeTokens): HTMLElement {
  const card = element(
    "article",
    `display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid ${theme.border};border-radius:${theme.radius};background:${theme.surface};box-shadow:0 1px 2px 0 rgb(0 0 0/5%)`,
  );
  card.dataset.t3pProviderLimits = "provider";
  card.dataset.instanceId = view.instanceId;

  const head = element("div", "display:flex;align-items:baseline;gap:6px;flex-wrap:wrap");
  head.append(element("strong", "font-size:12px;font-weight:500", view.label));
  head.append(line(`color:${theme.mutedText};font-family:${theme.mono};font-size:11px`, view.instanceId));
  const spacer = element("span", "flex:1");
  head.append(spacer, element("span", `color:${theme.mutedText}`, view.status));
  card.append(head);

  card.append(line(`color:${theme.mutedText};font-size:11px`, `${view.flags} · auth: ${view.authText}`));

  if (view.note.kind !== "ok") {
    card.append(line(`color:${theme.accentText.warn};font-size:11px`, view.noteText));
  }

  for (const window of view.windows) {
    card.append(renderWindow(window, theme));
  }

  if (view.resetCreditsText) card.append(line(`color:${theme.mutedText};font-size:11px`, view.resetCreditsText));
  return card;
}

function renderWindow(window: ProviderLimitsView["windows"][number], theme: ThemeTokens): HTMLElement {
  const accent = theme.accent[window.level];
  const box = element("div", "display:flex;flex-direction:column;gap:3px");
  box.dataset.t3pProviderLimits = "window";
  box.dataset.windowId = window.id;
  box.dataset.level = window.level;

  const head = element("div", "display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;font-size:11px");
  head.append(element("span", `color:${theme.text}`, window.label));
  const meta = [window.kind, window.durationText].filter(Boolean).join(" · ");
  if (meta) head.append(element("span", `color:${theme.mutedText}`, meta));
  head.append(element("span", "flex:1"), element("span", `color:${theme.accentText[window.level]};font-weight:500;font-variant-numeric:tabular-nums`, window.percentText));
  box.append(head);

  const track = element(
    "div",
    `height:6px;border-radius:3px;background:${theme.track};overflow:hidden`,
  );
  const fill = element("div", `height:100%;border-radius:2px;background:${accent}`);
  fill.style.width = `${window.barPercent}%`;
  track.append(fill);
  box.append(track);

  box.append(line(`color:${theme.mutedText};font-size:11px;font-variant-numeric:tabular-nums`, `resets ${window.resetCountdown}`));
  return box;
}
