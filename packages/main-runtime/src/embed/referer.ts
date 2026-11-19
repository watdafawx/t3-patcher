/**
 * `embed.youtube`: gives the YouTube embed document request a real https Referer.
 *
 * T3 Code loads from `t3code://app`, which is not an http(s) origin, so Chromium sends no Referer and
 * YouTube answers the nocookie embed with player error 153. This module sets a fixed Referer on exactly
 * one request kind: the sub-frame navigation to `https://www.youtube-nocookie.com/embed/<...>`.
 * Every other request, host and header is passed through untouched.
 *
 * Electron allows one `onBeforeSendHeaders` listener per session, so the listener is installed once
 * and asks `enabled()` for live state on every request (plugin enabled AND granted `embed.youtube`).
 */

export const EMBED_HOST = "www.youtube-nocookie.com";
export const EMBED_REFERER = `https://${EMBED_HOST}/`;

/** Request filter handed to Electron: other URLs never reach our code. */
export const EMBED_URL_FILTER = [`https://${EMBED_HOST}/embed/*`];

/** True only for `https://www.youtube-nocookie.com/embed/...` (exact host, no credentials, default port) loaded as a frame. */
export function isEmbedRequest(rawUrl: string, resourceType: string | undefined): boolean {
  if (resourceType !== undefined && resourceType !== "subFrame") return false;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.hostname === EMBED_HOST && url.port === "" && url.username === "" && url.password === "" && url.pathname.startsWith("/embed/");
}

export interface BeforeSendDetails {
  url: string;
  resourceType?: string;
  requestHeaders: Record<string, string>;
}

/** Pure rule: returns the headers to send (a copy), or null to leave the request alone. */
export function refererHeaders(details: BeforeSendDetails, enabled: () => boolean): Record<string, string> | null {
  if (!isEmbedRequest(details.url, details.resourceType)) return null;
  if (!enabled()) return null;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(details.requestHeaders)) if (name.toLowerCase() !== "referer") headers[name] = value;
  headers["Referer"] = EMBED_REFERER;
  return headers;
}

export type BeforeSendListener = (details: BeforeSendDetails, callback: (response: { requestHeaders?: Record<string, string>; cancel?: boolean }) => void) => void;

export interface WebRequestLike {
  onBeforeSendHeaders(filter: { urls: string[] }, listener: BeforeSendListener): void;
}

/** Installs the single listener. `enabled` is read per request, so revoking the grant or disabling the plugin stops it at once. */
export function installEmbedReferer(webRequest: WebRequestLike, enabled: () => boolean): void {
  webRequest.onBeforeSendHeaders({ urls: EMBED_URL_FILTER }, (details, callback) => {
    let headers: Record<string, string> | null = null;
    try {
      headers = refererHeaders(details, enabled);
    } catch {
      headers = null; // fail open: send the request unchanged
    }
    callback(headers ? { requestHeaders: headers } : {});
  });
}
