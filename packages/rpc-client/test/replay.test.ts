import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "../src/index.js";
import { FakeWebSocket, makeClient } from "./helpers.js";

/**
 * Replays the real frames the spike recorded on socket "primary" (docs/spikes/wp-0d/fixtures/standalone-frames.jsonl):
 * every client "sent" Request is issued through RpcClient, every server "recv" frame is played back to it, then we
 * check what the client emitted (Requests, one Ack per Chunk) and how it settled calls and the stream.
 */
interface Row {
  section: string;
  sock: string;
  dir: "sent" | "recv";
  data: string;
}

const rows = readFileSync(fileURLToPath(new URL("../../../docs/spikes/wp-0d/fixtures/standalone-frames.jsonl", import.meta.url)), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as Row)
  .filter((r) => r.sock === "primary");

const parse = (r: Row) => JSON.parse(r.data) as Record<string, unknown>;

beforeEach(() => {
  FakeWebSocket.reset();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("replay of recorded frames (sections 5 and 6: thread create, subscribe, rename, model set, provider switch)", () => {
  it("client emits the recorded Requests and one Ack per Chunk, and settles calls like the recording", async () => {
    // from section 5 up to just before the first request whose reply was truncated in the fixture
    const start = rows.findIndex((r) => r.section.startsWith("5."));
    const firstTruncated = rows.findIndex((r, i) => i > start && r.dir === "recv" && r.data.includes("...<truncated"));
    let end = firstTruncated;
    while (rows[end]!.dir !== "sent" || parse(rows[end]!)._tag !== "Request") end--;
    const slice = rows.slice(start, end);
    expect(slice.length).toBeGreaterThan(20);

    const { client } = makeClient();
    await client.connect();
    const ws = FakeWebSocket.last;

    const idMap = new Map<number, number>(); // fixture id -> client id
    const calls: Array<{ fixtureId: number; tag: string; promise: Promise<unknown> }> = [];
    const items: Array<Record<string, unknown>> = [];
    const expectedRequests: Array<Record<string, unknown>> = [];
    let chunks = 0;
    let sub: ReturnType<typeof client.subscribe> | undefined;
    let subClientId = -1;

    for (const r of slice) {
      const f = parse(r);
      if (r.dir === "sent" && f._tag === "Request") {
        const fixtureId = f.id as number;
        idMap.set(fixtureId, idMap.size);
        expectedRequests.push({ _tag: "Request", id: idMap.get(fixtureId), tag: f.tag, payload: f.payload, headers: [] });
        if (f.tag === "orchestration.subscribeThread") {
          subClientId = idMap.get(fixtureId)!;
          sub = client.subscribe("orchestration.subscribeThread", f.payload as never, (i) => items.push(i as Record<string, unknown>));
        } else {
          const promise = client.call(f.tag as string, f.payload as never);
          promise.catch(() => undefined);
          calls.push({ fixtureId, tag: f.tag as string, promise });
        }
      } else if (r.dir === "recv") {
        const id = idMap.get(f.requestId as number);
        expect(id, `reply for unknown request ${String(f.requestId)}`).toBeDefined();
        if (f._tag === "Chunk") chunks++;
        ws.serverSend({ ...f, requestId: id });
      }
    }

    expect(ws.framesOf("Request")).toEqual(expectedRequests);
    expect(chunks).toBeGreaterThan(3);
    expect(ws.framesOf("Ack")).toHaveLength(chunks);
    expect(items.length).toBe(chunks); // one value per recorded Chunk
    expect(items[0]).toMatchObject({ kind: "snapshot" });
    expect(items.slice(1).every((i) => i.kind === "event")).toBe(true);
    const seqs = items.slice(1).map((i) => i.sequence as number);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs); // strictly ordered like the server sent them

    const results = await Promise.all(calls.map((c) => c.promise.then((v) => ({ tag: c.tag, ok: v }), (e: unknown) => ({ tag: c.tag, err: e as RpcError }))));
    const ensured = results.find((r) => r.tag === "projects.ensureScratch");
    expect(ensured).toMatchObject({ ok: { projectId: expect.any(String) } });
    const failures = results.filter((r): r is { tag: string; err: RpcError } => "err" in r);
    expect(failures.length).toBeGreaterThanOrEqual(1);
    for (const f of failures) {
      expect(f.err.kind).toBe("failure");
      expect(f.err.tag).toBe("OrchestrationV2DispatchCommandError");
    }
    // dispatchCommand successes resolve with {sequence}
    const dispatches = results.filter((r) => r.tag === "orchestration.dispatchCommand" && "ok" in r) as Array<{ ok: { sequence: number } }>;
    expect(dispatches.length).toBeGreaterThan(3);
    for (const d of dispatches) expect(typeof d.ok.sequence).toBe("number");

    // cancel: Interrupt for the stream id, done resolves
    sub!.cancel();
    await sub!.done;
    expect(ws.framesOf("Interrupt")).toEqual([{ _tag: "Interrupt", requestId: subClientId }]);
  });
});
