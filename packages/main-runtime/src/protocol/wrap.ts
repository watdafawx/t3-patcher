import type { Logger } from "../log.js";
import { injectRendererScript } from "./html.js";

export type Handler = (request: Request) => Response | Promise<Response>;

export interface RewriteDeps {
  log: Logger;
  /** Inject the renderer bootstrap into index.html (false in safe mode). */
  injectHtml: boolean;
  /** Awaited before the first chunk decision, so main plugins can register patches first. */
  ready?: Promise<unknown>;
  hasPatchesFor(chunkName: string): boolean;
  /** Patched source, or null to serve the original. Must not throw (it is guarded anyway). */
  transform(chunkName: string, source: string): string | null;
  /** Answers `/__t3p/*` requests. */
  virtual(url: URL, request: Request): Response | Promise<Response>;
}

const JS_PATH = /\.(m?js)$/i;

function rebuild(response: Response, body: string): Response {
  const headers = new Headers(response.headers);
  // The body changed: drop length and any encoding so Electron computes them.
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Wraps the app's `t3code` protocol handler. Responses that are not rewritten
 * are returned as the same object (still streaming); only index.html and
 * chunks with assigned patches are buffered. Every failure falls back to the
 * original bytes.
 */
export function wrapProtocolHandler(handler: Handler, deps: RewriteDeps): Handler {
  return async (request: Request): Promise<Response> => {
    let url: URL | null = null;
    try {
      url = new URL(request.url);
    } catch {
      url = null;
    }
    if (url && url.hostname === "app" && url.pathname.startsWith("/__t3p/")) {
      try {
        return await deps.virtual(url, request);
      } catch (error) {
        deps.log.error(`virtual route ${url.pathname} failed`, error);
        return new Response(null, { status: 500 });
      }
    }

    const response = await handler(request);
    if (!url || request.method !== "GET" || response.status !== 200 || !response.body) return response;

    let kind: "html" | "chunk" | null = null;
    let chunkName = "";
    try {
      const type = response.headers.get("content-type") ?? "";
      if (deps.injectHtml && /text\/html/i.test(type)) kind = "html";
      else if (JS_PATH.test(url.pathname) || /javascript/i.test(type)) {
        chunkName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
        if (deps.ready) await deps.ready;
        if (deps.hasPatchesFor(chunkName)) kind = "chunk";
      }
    } catch (error) {
      deps.log.error(`rewrite decision for ${url.pathname} failed; serving original`, error);
      kind = null;
    }
    if (!kind) return response;

    const original = await response.text();
    try {
      if (kind === "html") return rebuild(response, injectRendererScript(original));
      const patched = deps.transform(chunkName, original);
      return rebuild(response, patched ?? original);
    } catch (error) {
      deps.log.error(`rewrite of ${url.pathname} failed; serving original`, error);
      return rebuild(response, original);
    }
  };
}

export interface ProtocolLike {
  handle(scheme: string, handler: Handler): void;
}

/**
 * Replaces `protocol.handle` so the app's later registration of `scheme` goes
 * through {@link wrapProtocolHandler}. Other schemes pass through untouched.
 */
export function installProtocolWrap(protocol: ProtocolLike, scheme: string, deps: RewriteDeps): void {
  const original = protocol.handle.bind(protocol);
  protocol.handle = (s: string, handler: Handler): void => {
    if (s !== scheme) return original(s, handler);
    deps.log.info(`protocol.handle(${scheme}) wrapped`);
    return original(s, wrapProtocolHandler(handler, deps));
  };
}
