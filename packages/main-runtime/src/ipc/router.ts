import { IPC_PREFIX, isAllowedEventChannel, isAllowedInvokeChannel } from "@t3p/api";

import type { Logger } from "../log.js";
import type { Validator } from "./schema.js";
import type { IpcEventLike, SenderVerdict, WindowLike } from "./sender.js";

export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}

export interface IpcRouterDeps {
  ipcMain: IpcMainLike;
  checkSender(event: IpcEventLike): SenderVerdict;
  getMainWindow(): WindowLike | null;
  log: Logger;
}

export type IpcHandlerFn<T> = (payload: T, event: IpcEventLike) => unknown;

/** Error the renderer sees. Only a short message crosses the boundary, never a stack. */
export class IpcError extends Error {}

export interface IpcRouter {
  /** Registers `channel` behind the sender check and `schema`. Returns an unregister function. */
  handle<T>(channel: string, schema: Validator<T>, fn: IpcHandlerFn<T>): () => void;
  /** Pushes an allowlisted event to the main window only. */
  emit(channel: string, payload: unknown): boolean;
  channels(): string[];
}

/**
 * The ONE place `t3p:` channels are registered with ipcMain. Every call runs:
 * sender check -> schema validation -> handler, and failures are logged and
 * returned as a short error message.
 */
/** Results cross IPC as plain JSON: no prototypes, functions or host objects, and a clear error instead of "could not be cloned". */
const MAX_RESULT_BYTES = 32 * 1024 * 1024;
export function toWire(value: unknown): unknown {
  if (value === undefined) return undefined;
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    throw new IpcError(`t3p: result is not JSON-serializable: ${(error as Error).message}`);
  }
  if (text === undefined) return undefined;
  if (text.length > MAX_RESULT_BYTES) throw new IpcError("t3p: result too large");
  return JSON.parse(text) as unknown;
}

export function createIpcRouter(deps: IpcRouterDeps): IpcRouter {
  const registered = new Set<string>();
  const log = deps.log;

  return {
    handle<T>(channel: string, schema: Validator<T>, fn: IpcHandlerFn<T>): () => void {
      if (!channel.startsWith(IPC_PREFIX) || !isAllowedInvokeChannel(channel)) throw new Error(`t3p: channel ${channel} is not allowed`);
      if (registered.has(channel)) throw new Error(`t3p: channel ${channel} is already registered`);
      registered.add(channel);
      deps.ipcMain.handle(channel, async (event, ...args) => {
        const verdict = deps.checkSender(event);
        if (!verdict.ok) {
          log.warn(`ipc ${channel} rejected: ${verdict.reason}`);
          throw new IpcError("t3p: rejected (sender)");
        }
        if (args.length > 1) {
          log.warn(`ipc ${channel} rejected: ${args.length} arguments`);
          throw new IpcError("t3p: rejected (one payload argument)");
        }
        const parsed = schema(args[0], "payload");
        if (!parsed.ok) {
          log.warn(`ipc ${channel} rejected: ${parsed.error}`);
          throw new IpcError(`t3p: invalid payload: ${parsed.error}`);
        }
        try {
          return toWire(await fn(parsed.value, event));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // A t3p: message is an expected refusal (denied path, missing grant): one line, no stack.
          if (message.startsWith("t3p:")) log.warn(`ipc ${channel}: ${message.slice(0, 500)}`);
          else if (!(error instanceof IpcError)) log.error(`ipc ${channel} handler failed`, error);
          throw new IpcError(message.startsWith("t3p:") ? message.slice(0, 500) : `t3p: ${channel} failed: ${message.slice(0, 500)}`);
        }
      });
      return () => {
        if (!registered.delete(channel)) return;
        try {
          deps.ipcMain.removeHandler(channel);
        } catch (error) {
          log.warn(`removeHandler ${channel} failed: ${String(error)}`);
        }
      };
    },
    emit(channel: string, payload: unknown): boolean {
      if (!isAllowedEventChannel(channel)) return false;
      const main = deps.getMainWindow();
      if (!main || main.isDestroyed() || main.webContents.isDestroyed() || !main.webContents.send) return false;
      try {
        main.webContents.send(channel, payload);
        return true;
      } catch (error) {
        log.warn(`emit ${channel} failed: ${String(error)}`);
        return false;
      }
    },
    channels: () => [...registered],
  };
}
