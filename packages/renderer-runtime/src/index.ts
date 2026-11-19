/** IIFE entry (dist/renderer.js): runs as a classic script before the app's module scripts. */
import { bootstrap, type NativeBridgeLike } from "./runtime.js";
import type { DesktopBridgeLike } from "./types.js";

declare const window: Record<string, unknown> & {
  __t3p_native?: NativeBridgeLike;
  desktopBridge?: DesktopBridgeLike;
  location: { reload(): void };
  addEventListener(type: string, listener: (event: never) => void): void;
  removeEventListener(type: string, listener: (event: never) => void): void;
};
declare const performance: { now(): number };
declare const console: { error(...args: unknown[]): void };

try {
  void bootstrap({
    win: window,
    native: window.__t3p_native ?? null,
    now: () => performance.now(),
    // Native dynamic import of a same-origin t3code:// module (CSP script-src 'self').
    importModule: (url) => import(/* @vite-ignore */ url) as Promise<Record<string, unknown>>,
    consoleError: (...args) => console.error(...args),
    // The app's preload defines desktopBridge before this script runs; read it lazily anyway.
    desktopBridge: {
      getLocalEnvironmentBearerToken: () => {
        const bridge = window.desktopBridge;
        if (!bridge) return Promise.reject(new Error("window.desktopBridge is not available"));
        return bridge.getLocalEnvironmentBearerToken();
      },
      getLocalEnvironmentBootstraps: () => {
        const bridge = window.desktopBridge;
        if (!bridge) return Promise.reject(new Error("window.desktopBridge is not available"));
        return bridge.getLocalEnvironmentBootstraps();
      },
    },
    // Crash-loop guard: uncaught errors and unhandled rejections, with their stacks.
    watchErrors: (cb) => {
      const onError = (e: { message?: unknown; error?: { stack?: unknown } | null }): void => cb(String(e.message ?? ""), String(e.error?.stack ?? ""));
      const onRejection = (e: { reason?: { message?: unknown; stack?: unknown } | null }): void => cb(String(e.reason?.message ?? e.reason ?? ""), String(e.reason?.stack ?? ""));
      window.addEventListener("error", onError);
      window.addEventListener("unhandledrejection", onRejection);
      return () => {
        window.removeEventListener("error", onError);
        window.removeEventListener("unhandledrejection", onRejection);
      };
    },
    onUnload: (callback) => window.addEventListener("pagehide", callback),
    reloadPage: () => window.location.reload(),
  });
} catch (error) {
  console.error("[t3p] renderer bootstrap failed", error);
}
