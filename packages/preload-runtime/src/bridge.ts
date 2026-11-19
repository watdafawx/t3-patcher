import { isAllowedEventChannel, isAllowedInvokeChannel } from "@t3p/api";

export const PRELOAD_VERSION = "0.1.0";

/** The slice of ipcRenderer the bridge uses. Never handed to the page. */
export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}

export interface NativeBridge {
  readonly version: string;
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  on(channel: string, callback: (payload: unknown) => void): () => void;
}

/**
 * Builds the frozen object exposed as `window.__t3p_native`. Only allowlisted
 * channels pass, exactly one payload argument is forwarded, and listeners get
 * the payload only (never the IpcRendererEvent, which would leak `sender`).
 * The main process checks the sender again on every call.
 */
export function createBridge(ipc: IpcRendererLike, version: string = PRELOAD_VERSION): NativeBridge {
  const invoke = (channel: string, payload?: unknown): Promise<unknown> => {
    if (!isAllowedInvokeChannel(channel)) return Promise.reject(new Error(`t3p: channel ${String(channel)} is not allowed`));
    return ipc.invoke(channel, payload);
  };
  const on = (channel: string, callback: (payload: unknown) => void): (() => void) => {
    if (!isAllowedEventChannel(channel)) throw new Error(`t3p: event channel ${String(channel)} is not allowed`);
    if (typeof callback !== "function") throw new Error("t3p: callback must be a function");
    const listener = (_event: unknown, payload: unknown): void => {
      try {
        callback(payload);
      } catch {
        // a page callback must not break other listeners
      }
    };
    ipc.on(channel, listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      ipc.removeListener(channel, listener);
    };
  };
  return Object.freeze({ version, invoke, on });
}

/** Expose only in the app's own top-level document. */
export function shouldExpose(loc: { protocol: string; host: string }, isMainFrame: boolean | undefined): boolean {
  return loc.protocol === "t3code:" && loc.host === "app" && isMainFrame !== false;
}
