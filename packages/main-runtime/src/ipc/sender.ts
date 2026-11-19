/**
 * Sender check for every `t3p:` IPC call. Mirrors the upstream guard in
 * DesktopIpc (sender is the main window's webContents AND senderFrame is its
 * main frame) and adds an origin check (the frame shows t3code://app).
 */

export interface FrameLike {
  url: string;
}
export interface WebContentsLike {
  id: number;
  mainFrame: FrameLike;
  isDestroyed(): boolean;
  send?(channel: string, ...args: unknown[]): void;
}
export interface WindowLike {
  webContents: WebContentsLike;
  isDestroyed(): boolean;
}
export interface IpcEventLike {
  sender: { id: number };
  senderFrame: FrameLike | null | undefined;
}

export type SenderVerdict = { ok: true } | { ok: false; reason: string };

export const APP_ORIGIN = "t3code://app";

export function createSenderCheck(getMainWindow: () => WindowLike | null): (event: IpcEventLike) => SenderVerdict {
  return (event) => {
    const main = getMainWindow();
    if (!main || main.isDestroyed() || main.webContents.isDestroyed()) return { ok: false, reason: "no main window" };
    if (!event || !event.sender || event.sender.id !== main.webContents.id) return { ok: false, reason: "sender is not the main window" };
    const frame = event.senderFrame;
    if (!frame || frame !== main.webContents.mainFrame) return { ok: false, reason: "sender frame is not the main frame" };
    let origin: string;
    try {
      const u = new URL(frame.url);
      origin = `${u.protocol}//${u.host}`;
    } catch {
      return { ok: false, reason: "sender frame has no valid URL" };
    }
    if (origin !== APP_ORIGIN) return { ok: false, reason: `sender origin ${origin} is not ${APP_ORIGIN}` };
    return { ok: true };
  };
}

/** Web preferences as Electron reports them (getLastWebPreferences). */
export interface WebPrefsLike {
  preload?: string;
  webviewTag?: boolean;
}

/**
 * Decides whether a window is T3 Code's main window from its web preferences:
 * - the preload path, when Electron reports it (it must be the app's own
 *   preload.cjs inside _app.asar);
 * - otherwise `webviewTag: true`. Electron 44 leaves `preload` out of
 *   getLastWebPreferences() (measured on rig), and in T3 Code 0.1.10 only the
 *   main window enables <webview>; the picture-in-picture, splash, snapshot
 *   and overlay windows do not.
 * Returns null while the preferences are not known yet. If upstream changes
 * these options the check fails closed: no window is the main window, t3p IPC
 * is rejected, the app itself keeps working.
 */
export function classifyMainWindow(prefs: WebPrefsLike | null | undefined, isMainPreload: (preload: string) => boolean): boolean | null {
  if (!prefs) return null;
  if (typeof prefs.preload === "string" && prefs.preload.length > 0) return isMainPreload(prefs.preload);
  return prefs.webviewTag === true;
}

/**
 * Tracks the T3 Code main window. Windows are registered at
 * browser-window-created and classified lazily: Electron fills in the web
 * preferences after that event, so the classifier runs at the first IPC call
 * (and on later get() calls until it gives an answer). The newest live main
 * window wins, so a recreated main window is picked up.
 */
export class MainWindowTracker<W extends WindowLike> {
  private readonly windows: Array<{ window: W; classify: () => boolean | null; main: boolean | null }> = [];

  watch(window: W, classify: () => boolean | null): void {
    this.windows.push({ window, classify, main: null });
  }

  get(): W | null {
    for (let i = this.windows.length - 1; i >= 0; i--) {
      const entry = this.windows[i]!;
      if (entry.window.isDestroyed()) {
        this.windows.splice(i, 1);
        continue;
      }
      if (entry.main === null) {
        try {
          entry.main = entry.classify();
        } catch {
          entry.main = null;
        }
      }
      if (entry.main === true) return entry.window;
    }
    return null;
  }
}

/** Builds the preload matcher from the expected preload path(s), case-insensitive with either slash. */
export function preloadMatcher(expected: readonly string[]): (preload: string) => boolean {
  const norm = (p: string): string => p.replace(/\//g, "\\").toLowerCase();
  const wanted = new Set(expected.map(norm));
  return (preload) => wanted.has(norm(preload));
}
