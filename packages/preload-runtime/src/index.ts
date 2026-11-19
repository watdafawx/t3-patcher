/**
 * T3 Patcher preload (dist/preload.cjs), registered on the default session as
 * a "frame" preload. Runs in the isolated preload world before the page's
 * first script and exposes `window.__t3p_native`. It does not touch
 * `window.desktopBridge` (the app's own preload).
 */
import { contextBridge, ipcRenderer } from "electron";

import { createBridge, shouldExpose } from "./bridge.js";

try {
  if (shouldExpose(location, process.isMainFrame)) {
    contextBridge.exposeInMainWorld("__t3p_native", createBridge(ipcRenderer));
  }
} catch (error) {
  try {
    console.error("[t3p] preload failed", error);
  } catch {
    // nothing else to do
  }
}
