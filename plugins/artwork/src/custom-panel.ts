import type { T3Api } from "@t3p/api";

import { CUSTOM_IDS, CUSTOM_LABELS, type CustomId, type CustomTarget, type TargetView } from "./custom.js";

/** The Custom section of the dock tab. Colors come only from app variables. */
export const CUSTOM_PANEL_CSS = `
.t3p-art-ct{display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--border,currentColor);border-radius:var(--radius-lg,var(--radius,.5rem));min-width:0}
.t3p-art-ct[data-on]{border-color:var(--ring,currentColor)}
.t3p-art-ct textarea{box-sizing:border-box;width:100%;min-height:70px;height:96px;padding:6px 8px;resize:vertical;font:11px/1.45 ui-monospace,"IBM Plex Mono",Consolas,monospace;tab-size:2;white-space:pre;overflow:auto;color:inherit;background:var(--background,transparent);border:1px solid var(--input,var(--border,currentColor));border-radius:var(--control-radius,.5rem);outline:none}
.t3p-art-ct textarea:focus-visible{border-color:var(--ring,currentColor);box-shadow:0 0 0 3px color-mix(in srgb,var(--ring,currentColor) 24%,transparent)}
.t3p-art-ct textarea[aria-invalid=true]{border-color:var(--destructive,currentColor)}
.t3p-art-ct-msg{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none;font-size:11px;white-space:pre-wrap;word-break:break-word}
.t3p-art-ct-msg[data-kind=error]{color:var(--destructive-foreground,var(--destructive,inherit))}
.t3p-art-ct-msg[data-kind=warn]{color:var(--warning-foreground,var(--muted-foreground,inherit))}
.t3p-art-ct-import{display:flex;flex-direction:column;gap:6px}
`;

export interface CustomApi {
  view(id: CustomId): TargetView;
  update(id: CustomId, patch: Partial<CustomTarget>): TargetView;
  /** Fills the editors with the active preset's markup and CSS. */
  fromPreset(id: CustomId): void;
  /** Clears the editors and turns the target off, so the stock preset shows again. */
  reset(id: CustomId): void;
  exportText(): string;
  /** Returns an error message, or null when the bundle was imported. */
  importText(text: string): string | null;
  allowRemote(): boolean;
  setAllowRemote(value: boolean): void;
  stats(): Promise<{ bundleBytes: number; usedBytes: number; limitBytes: number }>;
  /** A save problem to show (for example over quota), or "". */
  status(): string;
  subscribe(fn: () => void): () => void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string> = {}, ...kids: Array<Node | string>): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) node.setAttribute(k, v);
  node.append(...kids);
  return node;
};
const button = (label: string, onClick: () => void, attrs: Record<string, string> = {}): HTMLButtonElement => {
  const b = el("button", { type: "button", class: "t3p-btn", ...attrs }, label);
  b.addEventListener("click", onClick);
  return b;
};

export const DEBOUNCE_MS = 250;

const kb = (n: number): string => `${(n / 1024).toFixed(n < 10_240 ? 1 : 0)} KB`;

/** Builds the Custom section into `section`. Returns the cleanup. */
export function renderCustomSection(section: HTMLElement, ctx: CustomApi, t3: T3Api): () => void {
  const disposers: Array<() => void> = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  disposers.push(() => timers.forEach((t) => clearTimeout(t)));

  section.appendChild(
    el("div", { class: "t3p-meta" }, "Write your own markup and CSS for the sidebar header or the whole app background. Turn a target on and it replaces the matching preset (or Ocean); turn it off to get the preset back. Your CSS only affects its own box."),
  );

  const redraws: Array<() => void> = [];
  for (const id of CUSTOM_IDS) {
    const box = el("div", { class: "t3p-art-ct", "data-t3p-custom-target": id });
    const enable = el("input", { type: "checkbox", class: "t3p-switch", "aria-label": `Custom ${CUSTOM_LABELS[id]}`, "data-t3p-ct-enable": "" });
    const head = el("div", { class: "t3p-art-ln" }, el("label", {}, CUSTOM_LABELS[id]), enable);
    const html = el("textarea", { "aria-label": `${CUSTOM_LABELS[id]} HTML`, "data-t3p-ct-html": "", spellcheck: "false", placeholder: "<div class=\"glow\"></div>", rows: "5" });
    const css = el("textarea", { "aria-label": `${CUSTOM_LABELS[id]} CSS`, "data-t3p-ct-css": "", spellcheck: "false", placeholder: ":root { opacity: .5 }\n.glow { position: absolute; inset: 0; background: var(--primary) }", rows: "5" });
    const errors = el("ul", { class: "t3p-art-ct-msg", "data-kind": "error", "data-t3p-ct-errors": "", role: "alert" });
    const warns = el("ul", { class: "t3p-art-ct-msg", "data-kind": "warn", "data-t3p-ct-warnings": "" });
    const info = el("div", { class: "t3p-meta" }, ":root is the box itself (already positioned, clipped, click-through). Use app variables only: var(--primary), var(--foreground)...");
    const read = (): Partial<CustomTarget> => ({ html: html.value, css: css.value });

    const showView = (view: TargetView): void => {
      errors.replaceChildren(...view.errors.map((m) => el("li", {}, m)));
      warns.replaceChildren(...view.warnings.map((m) => el("li", {}, m)));
      html.setAttribute("aria-invalid", String(view.errors.some((m) => m.startsWith("HTML is"))));
      css.setAttribute("aria-invalid", String(view.errors.some((m) => !m.startsWith("HTML is"))));
      box.toggleAttribute("data-on", view.enabled);
      enable.checked = view.enabled;
    };
    const redraw = (): void => {
      const view = ctx.view(id);
      // Never overwrite what the user is typing.
      if (document.activeElement !== html && html.value !== view.html) html.value = view.html;
      if (document.activeElement !== css && css.value !== view.css) css.value = view.css;
      showView(view);
    };
    redraws.push(redraw);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const typed = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timers.delete(timer!);
        showView(ctx.update(id, read()));
      }, DEBOUNCE_MS);
      timers.add(timer);
    };
    html.addEventListener("input", typed);
    css.addEventListener("input", typed);
    enable.addEventListener("change", () => {
      if (timer) clearTimeout(timer);
      const on = enable.checked; // fromPreset redraws the switch, so read it first
      if (on && html.value.trim() === "" && css.value.trim() === "") ctx.fromPreset(id);
      showView(ctx.update(id, { ...read(), enabled: on }));
    });
    const actions = el(
      "div",
      { class: "t3p-art-foot" },
      button("Start from current preset", () => ctx.fromPreset(id), { "data-t3p-ct-from": "" }),
      button(
        "Reset to preset",
        () => {
          const has = html.value.trim() !== "" || css.value.trim() !== "";
          const run = (): void => ctx.reset(id);
          if (!has) return run();
          void t3.ui.modal({ title: "Reset custom code?", body: `This clears the ${CUSTOM_LABELS[id]} markup and CSS and switches back to the preset. Export first to keep a copy.`, buttons: ["Reset", "Cancel"] }).then((i) => {
            if (i === 0) run();
          });
        },
        { "data-variant": "ghost", "data-t3p-ct-reset": "" },
      ),
    );
    box.append(head, el("div", { class: "t3p-meta" }, "HTML"), html, el("div", { class: "t3p-meta" }, "CSS"), css, errors, warns, info, actions);
    section.appendChild(box);
    redraw();
  }

  // ---- shared footer: remote assets, size, import/export -------------------------------------------
  const remote = el("input", { type: "checkbox", class: "t3p-switch", "aria-label": "Allow remote assets", "data-t3p-ct-remote": "" });
  remote.addEventListener("change", () => ctx.setAllowRemote(remote.checked));
  const remoteRow = el("div", { class: "t3p-art-ln", title: "Lets custom CSS and images load http(s) urls. Off by default: remote files can track you and may change." }, el("label", {}, "Allow remote assets (http/https urls)"), remote);
  const size = el("div", { class: "t3p-meta", "data-t3p-ct-size": "" });
  const status = el("div", { class: "t3p-art-ct-msg", "data-kind": "error", "data-t3p-ct-status": "" });
  const importBox = el("div", { class: "t3p-art-ct-import", "data-t3p-ct-import": "", hidden: "" });
  const importText = el("textarea", { "aria-label": "Bundle JSON", "data-t3p-ct-import-text": "", spellcheck: "false", placeholder: "Paste a bundle here", rows: "4" });
  const importErr = el("div", { class: "t3p-art-ct-msg", "data-kind": "error", "data-t3p-ct-import-error": "", role: "alert" });
  importBox.append(
    importText,
    importErr,
    el(
      "div",
      { class: "t3p-art-foot" },
      button("Import", () => {
        const error = ctx.importText(importText.value);
        importErr.textContent = error ?? "";
        if (!error) {
          importText.value = "";
          importBox.hidden = true;
        }
      }, { "data-t3p-ct-do-import": "" }),
      button("Cancel", () => void (importBox.hidden = true), { "data-variant": "ghost" }),
    ),
  );
  const exportBtn = button("Copy bundle", () => {
    const text = ctx.exportText();
    const done = (): void => void t3.ui.toast({ title: "Artwork", message: "Custom bundle copied.", kind: "success" });
    const fail = (): void => {
      importBox.hidden = false;
      importText.value = text;
      importText.select();
      t3.ui.toast({ title: "Artwork", message: "Clipboard is blocked here. The bundle is in the box below, copy it by hand.", kind: "info" });
    };
    try {
      void navigator.clipboard.writeText(text).then(done, fail);
    } catch {
      fail();
    }
  }, { "data-t3p-ct-export": "" });
  const importBtn = button("Paste bundle...", () => void (importBox.hidden = !importBox.hidden), { "data-variant": "ghost", "data-t3p-ct-import-open": "" });
  section.append(remoteRow, size, status, el("div", { class: "t3p-art-foot" }, exportBtn, importBtn), importBox);

  let sizeToken = 0;
  const refreshFooter = (): void => {
    remote.checked = ctx.allowRemote();
    status.textContent = ctx.status();
    const token = ++sizeToken;
    void ctx.stats().then((s) => {
      if (token === sizeToken) size.textContent = `Custom code: ${kb(s.bundleBytes)} saved. Plugin storage: ${kb(s.usedBytes)} of ${kb(s.limitBytes)} used.`;
    }, () => undefined);
  };
  refreshFooter();
  disposers.push(
    ctx.subscribe(() => {
      redraws.forEach((r) => r());
      refreshFooter();
    }),
  );

  return () => {
    for (const d of disposers.reverse()) {
      try {
        d();
      } catch {
        /* best effort */
      }
    }
  };
}
