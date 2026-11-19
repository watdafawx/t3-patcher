/**
 * Public types of @t3p/timeline. No runtime dependencies: inputs are described structurally, so
 * the package accepts the `orchestration.subscribeThread` items from @t3p/rpc-client (and anything
 * shaped like them) without importing the 11 MB vendored contracts.
 */

import type {
  CauseRelation,
  ProviderFrame,
  TimelineCause,
  TimelineEnrichment,
  TimelineKind,
  TimelineRecord,
} from "@t3p/api";

export type { CauseRelation, ProviderFrame, TimelineCause, TimelineEnrichment, TimelineKind, TimelineRecord };

export interface TimelineChange {
  added: TimelineRecord[];
  updated: TimelineRecord[];
  /** True when `reset()` cleared everything (added/updated are empty). */
  reset: boolean;
}

// ---- inputs (structural; compatible with ThreadSnapshotItem / ThreadEventItem of @t3p/rpc-client) ----

export interface SnapshotItemLike {
  kind: "snapshot";
  snapshotSequence: number;
  projection: unknown;
  [k: string]: unknown;
}

export interface EventItemLike {
  kind: "event";
  sequence: number;
  event: unknown;
  [k: string]: unknown;
}

export interface Timeline {
  /** Apply the `snapshot` stream item. Duplicate `snapshotSequence` is ignored. Never throws. */
  applySnapshot(item: SnapshotItemLike | unknown): void;
  /** Apply one `event` stream item. A `sequence` seen before (or <= the snapshot's) is ignored. Never throws. */
  applyEvent(item: EventItemLike | unknown): void;
  /** Dispatch any stream item: snapshot, event, synchronized (ignored) or unknown kind (recorded as `unknown`). */
  apply(item: unknown): void;
  /** All records, ordered by (`at`, creation order). A fresh array each call. */
  records(): TimelineRecord[];
  get(id: string): TimelineRecord | undefined;
  /** Called after every apply that added or changed a record, and after reset(). Returns unsubscribe. */
  subscribe(cb: (change: TimelineChange) => void): () => void;
  reset(): void;
}
