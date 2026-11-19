import type { RpcClient, Subscription } from "./client.js";
import type { RpcError } from "./errors.js";
import type { ThreadEventItem, ThreadSnapshotItem, ThreadStreamItem } from "./methods.js";

type ThreadPayload = { threadId: string; afterSequence?: number };

const sequenceOf = (item: ThreadStreamItem | undefined): number | undefined =>
  item?.kind === "event" ? item.sequence : item?.kind === "snapshot" ? item.snapshotSequence : undefined;

/**
 * `resume` callback for `orchestration.subscribeThread`: after a reconnect, ask only for events newer
 * than the highest `sequence` seen (event `sequence`, or the snapshot's `snapshotSequence`). Sequences
 * are global per environment and increase along the stream, so the last item delivered is the highest.
 *
 * What the caller sees after a reconnect:
 * - at least one item was delivered before the drop: events with `sequence > last` only, no snapshot, no
 *   gap, no duplicate (verified in WP-0D);
 * - nothing was delivered yet (`afterSequence` is still 0 or absent): the subscription starts over and a
 *   fresh snapshot arrives, exactly like the first subscribe.
 */
export function resumeAfterSequence<P extends ThreadPayload>(): (lastItem: ThreadStreamItem | undefined, payload: P) => P {
  return (lastItem, payload) => {
    const seq = sequenceOf(lastItem);
    if (seq === undefined || seq <= (payload.afterSequence ?? 0)) return payload;
    return { ...payload, afterSequence: seq };
  };
}

export interface WatchThreadOptions {
  /** Start after this sequence (default 0: snapshot first). */
  afterSequence?: number;
  onError?: (e: RpcError) => void;
  /** Called for the `synchronized` marker (only sent when `requestCompletionMarker` is used). */
  onSynchronized?: () => void;
}

/**
 * Watch one thread: `onSnapshot` once at the start (and again only if a resubscribe begins from
 * sequence 0), then `onEvent` for every domain event. Reconnects resume with `resumeAfterSequence`.
 */
export function watchThread(
  client: RpcClient,
  threadId: string,
  onSnapshot: (snapshot: ThreadSnapshotItem) => void,
  onEvent: (event: ThreadEventItem) => void,
  opts: WatchThreadOptions = {},
): Subscription {
  const payload: ThreadPayload = { threadId, afterSequence: opts.afterSequence ?? 0 };
  return client.subscribe(
    "orchestration.subscribeThread",
    payload as never,
    (item: ThreadStreamItem) => {
      if (item.kind === "snapshot") onSnapshot(item);
      else if (item.kind === "event") onEvent(item);
      else if (item.kind === "synchronized") opts.onSynchronized?.();
    },
    {
      ...(opts.onError ? { onError: opts.onError } : {}),
      resume: resumeAfterSequence() as never,
    },
  );
}
