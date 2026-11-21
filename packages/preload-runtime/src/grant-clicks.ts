import {
  GRANT_ATTR,
  GRANT_PERMS_ATTR,
  GRANT_REQUEST_CHANNEL,
  isPermissionName,
  isRegistryAction,
  isValidPluginId,
  REGISTRY_ACTION_ATTR,
  REGISTRY_ID_ATTR,
  REGISTRY_REQUEST_CHANNEL,
  TOGGLE_ENABLE_ATTR,
  TOGGLE_ID_ATTR,
  TOGGLE_REQUEST_CHANNEL,
  type RegistryAction,
} from "@t3p/api";

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
 *
 * The same listener is the only sender of the registry request channel (WP-14A): Install, Update
 * and Uninstall buttons on the Browse tab carry `data-t3p-registry-action` and
 * `data-t3p-registry-id`. The request names only an action and an id; the main process takes the
 * download URL and hash from the index it fetched itself, then asks in a native dialog.
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

export interface RegistryRequest {
  action: RegistryAction;
  id: string;
}

function trustedTarget(event: ClickLike, selector: string): ElementLike | null {
  if (!event || event.isTrusted !== true) return null;
  if (typeof event.button === "number" && event.button !== 0) return null;
  const target = event.target as ElementLike | null;
  if (!target || typeof target.closest !== "function") return null;
  try {
    return target.closest(selector);
  } catch {
    return null;
  }
}

/** Reads a registry request (install, update, uninstall) from a trusted click, or null. Pure. */
export function registryRequestFromClick(event: ClickLike): RegistryRequest | null {
  const el = trustedTarget(event, `[${REGISTRY_ACTION_ATTR}]`);
  if (!el) return null;
  const action = el.getAttribute(REGISTRY_ACTION_ATTR);
  const id = el.getAttribute(REGISTRY_ID_ATTR) ?? "";
  if (!isRegistryAction(action) || !isValidPluginId(id)) return null;
  return { action, id };
}

export interface TrustedToggleRequest {
  id: string;
  enabled: boolean;
}

/** Reads a trusted plugin enable/disable request from a trusted click, or null. Pure. */
export function toggleRequestFromClick(event: ClickLike): TrustedToggleRequest | null {
  const el = trustedTarget(event, `[${TOGGLE_ID_ATTR}]`);
  if (!el) return null;
  const id = el.getAttribute(TOGGLE_ID_ATTR) ?? "";
  const raw = el.getAttribute(TOGGLE_ENABLE_ATTR);
  if (!isValidPluginId(id) || (raw !== "true" && raw !== "false")) return null;
  return { id, enabled: raw === "true" };
}

/** Installs the capture-phase click listener on the preload's `window`. Returns a remover (tests). */
export function installGrantClicks(
  target: { addEventListener(type: string, fn: (event: ClickLike) => void, capture: boolean): void; removeEventListener(type: string, fn: (event: ClickLike) => void, capture: boolean): void },
  ipc: Pick<IpcRendererLike, "invoke">,
): () => void {
  const onClick = (event: ClickLike): void => {
    // Answers reach the page as `t3p:event` pushes (plugin-grant-result, plugin-registry-result, plugin-toggle-result) from the main process.
    const request = grantRequestFromClick(event);
    if (request) {
      ipc.invoke(GRANT_REQUEST_CHANNEL, request).catch(() => undefined);
      return;
    }
    const registry = registryRequestFromClick(event);
    if (registry) {
      ipc.invoke(REGISTRY_REQUEST_CHANNEL, registry).catch(() => undefined);
      return;
    }
    const toggle = toggleRequestFromClick(event);
    if (toggle) ipc.invoke(TOGGLE_REQUEST_CHANNEL, toggle).catch(() => undefined);
  };
  target.addEventListener("click", onClick, true);
  return () => target.removeEventListener("click", onClick, true);
}
