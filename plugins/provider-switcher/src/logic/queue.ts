import type { Selection, SwitchKind } from "./types.js";

/**
 * Queue-until-idle state machine: the pure half of "switch when the run ends".
 *
 * Flow: a switch comes back `busy`, the caller queues it (`request`), the controller watches the
 * thread and feeds `idle` when no run is active. The reducer then asks for exactly one retry. A retry
 * that comes back `busy` again gives up instead of looping; `cancel`, a focus change to another
 * thread or a second request all end the waiting without a retry.
 *
 * `attempt` numbers the queued request. A retry result only applies while its attempt is still the
 * pending one, so a result that arrives after the user replaced or cancelled the request is ignored
 * (the runtime cannot cancel the promise it already sent).
 */

/** One queued switch. */
export interface PendingSwitch {
  threadId: string;
  selection: Selection;
  kind: SwitchKind;
  /** Retries already attempted (starts at 0). */
  attempts: number;
  /** A retry is in flight; further idle signals are ignored. */
  inFlight: boolean;
  /** Identifies this request among replaced ones. */
  attempt: number;
}

export interface QueueState {
  pending: PendingSwitch | null;
  /** Monotonic request counter. */
  seq: number;
}

export type QueueEvent =
  | { type: "request"; threadId: string; selection: Selection; kind: SwitchKind }
  | { type: "cancel" }
  /** The focused thread changed; a pending switch for another thread is dropped. */
  | { type: "thread-changed"; threadId: string | null }
  /** No run is active in `threadId`. */
  | { type: "idle"; threadId: string }
  | { type: "retry-result"; attempt: number; outcome: "ok" | "busy" | "unavailable" | "error"; message?: string };

export type QueueEffect =
  /** Perform the queued switch. */
  | { type: "retry"; pending: PendingSwitch }
  /** The pending switch ended. `ok` is a success, the others are silent. */
  | { type: "cleared"; reason: "ok" | "cancelled" | "thread-changed"; pending: PendingSwitch }
  /** The retry failed and nothing more will be tried: tell the user. */
  | { type: "given-up"; pending: PendingSwitch; message: string };

/** Retries per queued switch. The brief asks for exactly one. */
export const MAX_RETRIES = 1;

const initialState: QueueState = { pending: null, seq: 0 };

export function createQueueState(): QueueState {
  return initialState;
}

/** Human label of a selection, for messages. */
export function describeSelection(selection: Selection): string {
  return `${selection.providerInstanceId} / ${selection.model}`;
}

export interface QueueReduction {
  state: QueueState;
  effects: QueueEffect[];
}

/**
 * One event in, one state plus the effects to run out. Returns the same state object when nothing
 * changed, so a caller can skip repainting.
 */
export function queueReduce(state: QueueState, event: QueueEvent): QueueReduction {
  switch (event.type) {
    case "request": {
      const seq = state.seq + 1;
      return {
        state: {
          seq,
          pending: {
            threadId: event.threadId,
            selection: event.selection,
            kind: event.kind,
            attempts: 0,
            inFlight: false,
            attempt: seq,
          },
        },
        effects: [],
      };
    }

    case "cancel": {
      if (!state.pending) return { state, effects: [] };
      return { state: { ...state, pending: null }, effects: [{ type: "cleared", reason: "cancelled", pending: state.pending }] };
    }

    case "thread-changed": {
      const pending = state.pending;
      if (!pending || pending.threadId === event.threadId) return { state, effects: [] };
      return { state: { ...state, pending: null }, effects: [{ type: "cleared", reason: "thread-changed", pending }] };
    }

    case "idle": {
      const pending = state.pending;
      if (!pending || pending.threadId !== event.threadId || pending.inFlight) return { state, effects: [] };
      if (pending.attempts >= MAX_RETRIES) {
        return {
          state: { ...state, pending: null },
          effects: [
            {
              type: "given-up",
              pending,
              message: `${describeSelection(pending.selection)} was not applied: the thread kept running (retried once).`,
            },
          ],
        };
      }
      const next: PendingSwitch = { ...pending, attempts: pending.attempts + 1, inFlight: true };
      return { state: { ...state, pending: next }, effects: [{ type: "retry", pending: next }] };
    }

    case "retry-result": {
      const pending = state.pending;
      if (!pending || pending.attempt !== event.attempt) return { state, effects: [] };
      if (event.outcome === "ok") {
        return { state: { ...state, pending: null }, effects: [{ type: "cleared", reason: "ok", pending }] };
      }
      if (event.outcome === "busy" && pending.attempts < MAX_RETRIES) {
        // Another idle signal can try again (only reachable with MAX_RETRIES > 1).
        return { state: { ...state, pending: { ...pending, inFlight: false } }, effects: [] };
      }
      const reason =
        event.outcome === "busy"
          ? "the thread kept running"
          : event.message?.trim() || (event.outcome === "unavailable" ? "the provider is unavailable" : "the server refused the switch");
      return {
        state: { ...state, pending: null },
        effects: [
          {
            type: "given-up",
            pending,
            message: `${describeSelection(pending.selection)} was not applied: ${reason}.`,
          },
        ],
      };
    }

  }
  return { state, effects: [] };
}
