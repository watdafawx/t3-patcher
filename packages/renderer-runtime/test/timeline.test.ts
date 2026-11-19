import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { T3PermissionError, type TimelineRecord } from "@t3p/api";
import { describe, expect, it } from "vitest";

import type { SharedRpc } from "../src/rpc.js";
import { Scope } from "../src/scope.js";
import { createTimelineApi } from "../src/timeline.js";

const items = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../timeline/test/fixtures/tool-approval.json", import.meta.url)), "utf8"),
) as Array<Record<string, unknown>>;

function fakeShared(): { shared: SharedRpc; subscriptions: number; push(item: unknown): void } {
  const state = { subscriptions: 0, onItem: null as null | ((item: unknown) => void) };
  const client = {
    subscribe: (_method: string, _payload: unknown, onItem: (item: unknown) => void) => {
      state.subscriptions++;
      state.onItem = onItem;
      return { cancel: () => undefined };
    },
  };
  return {
    shared: { ready: async () => ({ client, base: "" }) } as unknown as SharedRpc,
    get subscriptions() {
      return state.subscriptions;
    },
    push: (item) => state.onItem?.(item),
  };
}

const api = (shared: SharedRpc, allowed = true) =>
  createTimelineApi({ id: "p", allowed, shared, scope: new Scope(), log: () => undefined });

describe("t3.timeline", () => {
  it("needs the rpc permission", async () => {
    expect(() => api(fakeShared().shared, false).subscribe("t1", () => undefined)).toThrow(T3PermissionError);
  });

  it("lists normalized records and shares one subscription per thread", async () => {
    const f = fakeShared();
    const t3 = api(f.shared);
    const first = t3.list("thread-a");
    await new Promise((r) => setTimeout(r, 5));
    f.push({ kind: "snapshot", snapshotSequence: 0, projection: {} });
    for (const item of items) f.push(item);
    const records = await first;
    expect(records.map((r) => r.kind)).toContain("approval.request");
    const again = await api(f.shared).list("thread-a");
    expect(again).toHaveLength(records.length);
    expect(f.subscriptions).toBe(1);
  });

  it("replays existing records to a subscriber", async () => {
    const f = fakeShared();
    const t3 = api(f.shared);
    const seen: TimelineRecord[] = [];
    const p = t3.list("thread-b");
    await new Promise((r) => setTimeout(r, 5));
    f.push({ kind: "snapshot", snapshotSequence: 0, projection: {} });
    for (const item of items) f.push(item);
    await p;
    t3.subscribe("thread-b", (r) => seen.push(r));
    await new Promise((r) => setTimeout(r, 5));
    expect(seen.length).toBeGreaterThan(0);
  });
});
