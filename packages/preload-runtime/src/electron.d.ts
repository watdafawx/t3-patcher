// Minimal ambient types for the sandboxed preload (electron is not a dependency).
declare module "electron" {
  import type { IpcRendererLike } from "./bridge.js";
  export const contextBridge: { exposeInMainWorld(key: string, api: unknown): void };
  export const ipcRenderer: IpcRendererLike;
}
declare const location: { protocol: string; host: string };
declare const process: { isMainFrame?: boolean };
declare const console: { error(...args: unknown[]): void };
declare const window: {
  addEventListener(type: string, fn: (event: import("./grant-clicks.js").ClickLike) => void, capture: boolean): void;
  removeEventListener(type: string, fn: (event: import("./grant-clicks.js").ClickLike) => void, capture: boolean): void;
};
