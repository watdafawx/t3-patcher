import { GRANT_ATTR, GRANT_PERMS_ATTR, GRANT_REQUEST_CHANNEL, isPermissionName, isValidPluginId } from "@t3p/api";

import type { IpcRendererLike } from "./bridge.js";

/**
 * The only sender of the privileged grant-request channel.
 *
 * Plugins share the page's JavaScript world with the Plugins settings page, so nothing the page
 * does can prove that the user (and not a plugin) asked for a grant. This listener runs in the
 * preload's isolated world instead, where page scripts cannot reach `ipcRenderer`, cannot read or
 * remove this listener, and cannot patch the DOM prototypes it uses. It acts only on clicks the
 * browser marks `isTrusted` (real mouse or keyboard input; `el.click()` and `dispatchEvent` are
 * never trusted) on an element carrying `data-t3p-grant-request`. Even then the main process only
 * shows a native confirmation dialog; nothing is granted until the user confirms there.
 */

interface ElementLike {
  closest?(selector: string): ElementLike | null;
  getAttribute(name: string): string | null;
}

export interface ClickLike {
  isTrusted: boolean;
  button?: number;
  target: unknown;
}

export interface GrantRequest {
  id: string;
  permissions: string[] | "*";
}

const MAX_NAMES = 16;

/** Reads a grant request from a trusted click, or null. Pure (tested without a DOM). */
export function grantRequestFromClick(event: ClickLike): GrantRequest | null {
  if (!event || event.isTrusted !== true) return null;
  if (typeof event.button === "number" && event.button !== 0) return null;
  const target = event.target as ElementLike | null;
  if (!target || typeof target.closest !== "function") return null;
  let el: ElementLike | null;
  try {
    el = target.closest(`[${GRANT_ATTR}]`);
  } catch {
    return null;
  }
  if (!el) return null;
  const id = el.getAttribute(GRANT_ATTR) ?? "";
  if (!isValidPluginId(id)) return null;
  const raw = (el.getAttribute(GRANT_PERMS_ATTR) ?? "*").trim();
  if (raw === "*") return { id, permissions: "*" };
  const names = [...new Set(raw.split(",").map((n) => n.trim()).filter(Boolean))];
  if (names.length === 0 || names.length > MAX_NAMES || !names.every((n) => isPermissionName(n))) return null;
  return { id, permissions: names };
}

/** Installs the capture-phase click listener on the preload's `window`. Returns a remover (tests). */
export function installGrantClicks(
  target: { addEventListener(type: string, fn: (event: ClickLike) => void, capture: boolean): void; removeEventListener(type: string, fn: (event: ClickLike) => void, capture: boolean): void },
  ipc: Pick<IpcRendererLike, "invoke">,
): () => void {
  const onClick = (event: ClickLike): void => {
    const request = grantRequestFromClick(event);
    if (!request) return;
    // The answer reaches the page as a `t3p:event` (plugin-grant-result) from the main process.
    ipc.invoke(GRANT_REQUEST_CHANNEL, request).catch(() => undefined);
  };
  target.addEventListener("click", onClick, true);
  return () => target.removeEventListener("click", onClick, true);
}
