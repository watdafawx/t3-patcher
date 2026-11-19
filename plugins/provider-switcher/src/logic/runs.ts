import type { ProjectionView } from "./types.js";

/**
 * Which runs are active, derived from a thread projection and the `run.*` domain events of the
 * thread stream. The queue waits for `isIdle` before it retries a switch.
 */

/** Run statuses that mean "the thread is busy" (upstream `OrchestrationV2Run.status`). */
export const ACTIVE_RUN_STATUSES = ["preparing", "queued", "starting", "running", "waiting"] as const;

const ACTIVE = new Set<string>(ACTIVE_RUN_STATUSES);

export function isActiveRunStatus(status: string): boolean {
  return ACTIVE.has(status);
}

/** Active run ids, sorted so equal states compare and the value is easy to assert. */
export interface RunTrackerState {
  activeRunIds: string[];
}

export function createRunTracker(): RunTrackerState {
  return { activeRunIds: [] };
}

/** A projection lists every run of the thread, so its active set is complete. */
export function applyProjection(_state: RunTrackerState, projection: ProjectionView): RunTrackerState {
  const active = projection.runs.filter((run) => isActiveRunStatus(run.status)).map((run) => run.id);
  return { activeRunIds: [...new Set(active)].sort() };
}

/** A `run.created` / `run.updated` event, structurally. */
export interface RunEventLike {
  type: string;
  payload?: { id?: unknown; status?: unknown };
}

/**
 * Applies one domain event. Only `run.created` and `run.updated` matter; the latest status of a run
 * decides whether it counts as active (a run that reaches `completed`, `failed`, `cancelled`,
 * `interrupted` or `rolled_back` leaves the set).
 */
export function applyDomainEvent(state: RunTrackerState, event: RunEventLike): RunTrackerState {
  if (event.type !== "run.created" && event.type !== "run.updated") return state;
  const id = event.payload?.id;
  const status = event.payload?.status;
  if (typeof id !== "string" || typeof status !== "string") return state;
  const active = new Set(state.activeRunIds);
  if (isActiveRunStatus(status)) active.add(id);
  else active.delete(id);
  return { activeRunIds: [...active].sort() };
}

/** True when no run is active. */
export function isIdle(state: RunTrackerState): boolean {
  return state.activeRunIds.length === 0;
}
