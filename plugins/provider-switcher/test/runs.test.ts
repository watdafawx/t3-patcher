import { describe, expect, it } from "vitest";

import {
  ACTIVE_RUN_STATUSES,
  applyDomainEvent,
  applyProjection,
  createRunTracker,
  isActiveRunStatus,
  isIdle,
} from "../src/logic/runs.js";

const run = (id: string, status: string): { id: string; status: string } => ({ id, status });

describe("run tracking", () => {
  it("knows the active statuses and the terminal ones", () => {
    for (const status of ACTIVE_RUN_STATUSES) expect(isActiveRunStatus(status)).toBe(true);
    for (const status of ["completed", "failed", "cancelled", "interrupted", "rolled_back", "nonsense"]) {
      expect(isActiveRunStatus(status)).toBe(false);
    }
  });

  it("derives the active set from a projection and is idle when no run is active", () => {
    const active = applyProjection(createRunTracker(), {
      runs: [run("r1", "running"), run("r2", "completed"), run("r3", "waiting")],
      modelSelection: null,
    });
    expect(active.activeRunIds).toEqual(["r1", "r3"]);
    expect(isIdle(active)).toBe(false);
    expect(isIdle(applyProjection(active, { runs: [run("r1", "completed")], modelSelection: null }))).toBe(true);
    expect(isIdle(applyProjection(createRunTracker(), { runs: [], modelSelection: null }))).toBe(true);
  });

  it("goes idle when the last run ends, and busy again when a run starts", () => {
    let tracker = createRunTracker();
    tracker = applyDomainEvent(tracker, { type: "run.created", payload: { id: "r1", status: "queued" } });
    expect(tracker.activeRunIds).toEqual(["r1"]);
    tracker = applyDomainEvent(tracker, { type: "run.updated", payload: { id: "r1", status: "running" } });
    expect(isIdle(tracker)).toBe(false);
    tracker = applyDomainEvent(tracker, { type: "run.updated", payload: { id: "r1", status: "completed" } });
    expect(isIdle(tracker)).toBe(true);
    tracker = applyDomainEvent(tracker, { type: "run.created", payload: { id: "r2", status: "starting" } });
    expect(tracker.activeRunIds).toEqual(["r2"]);
    tracker = applyDomainEvent(tracker, { type: "run.updated", payload: { id: "r2", status: "failed" } });
    expect(isIdle(tracker)).toBe(true);
  });

  it("ignores events of other kinds and malformed payloads", () => {
    const tracker = createRunTracker();
    expect(applyDomainEvent(tracker, { type: "thread.model-selection.set", payload: { id: "r1", status: "running" } })).toBe(tracker);
    expect(applyDomainEvent(tracker, { type: "run.updated" })).toBe(tracker);
    expect(applyDomainEvent(tracker, { type: "run.updated", payload: { id: 7, status: "running" } })).toBe(tracker);
  });
});
