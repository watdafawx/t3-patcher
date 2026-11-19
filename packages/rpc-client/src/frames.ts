/**
 * Effect RPC JSON frame codec (docs/spikes/WP-0D.md). One JSON object per WebSocket text frame.
 * `\u001e`-prefixed frames are continuation parts (only sent when the client asks for `frameParts=1`).
 */
export const FRAME_PART_PREFIX = "\u001e";

export type ClientFrame =
  | { _tag: "Request"; id: number; tag: string; payload: unknown; headers: [] }
  | { _tag: "Ack"; requestId: number }
  | { _tag: "Interrupt"; requestId: number }
  | { _tag: "Ping" };

export type ExitFailure = { _tag: "Failure"; cause: unknown };
export type ExitSuccess = { _tag: "Success"; value: unknown };

export type ServerFrame =
  | { _tag: "Chunk"; requestId: number; values: unknown[] }
  | { _tag: "Exit"; requestId: number; exit: ExitSuccess | ExitFailure }
  | { _tag: "Pong" }
  | { _tag: "Defect"; defect: unknown }
  | { _tag: "ClientProtocolError"; error: unknown };

export const encodeFrame = (frame: ClientFrame): string => JSON.stringify(frame);

/** Parse a complete (joined) text frame; returns undefined for frames this client does not understand. */
export function decodeFrame(text: string): ServerFrame | undefined {
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof m !== "object" || m === null) return undefined;
  const f = m as Record<string, unknown>;
  switch (f._tag) {
    case "Chunk":
      return typeof f.requestId === "number" && Array.isArray(f.values) ? (f as unknown as ServerFrame) : undefined;
    case "Exit":
      return typeof f.requestId === "number" && typeof f.exit === "object" && f.exit !== null ? (f as unknown as ServerFrame) : undefined;
    case "Pong":
    case "Defect":
    case "ClientProtocolError":
      return f as unknown as ServerFrame;
    default:
      return undefined;
  }
}

/** Joins continuation parts: feed every received text frame, get a complete frame back or undefined. */
export class FrameJoiner {
  #buffer = "";
  push(data: string): string | undefined {
    if (data.startsWith(FRAME_PART_PREFIX)) {
      this.#buffer += data.slice(1);
      return undefined;
    }
    if (this.#buffer) {
      const joined = this.#buffer + data;
      this.#buffer = "";
      return joined;
    }
    return data;
  }
  reset(): void {
    this.#buffer = "";
  }
}
