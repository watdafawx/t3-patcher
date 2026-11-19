import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError, resumeAfterSequence, watchThread, type RpcClientState } from "../src/index.js";
import { FakeWebSocket, chunk, exitFail, exitOk, flush, makeClient } from "./helpers.js";

beforeEach(() => {
  FakeWebSocket.reset();
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(1); // jitter factor 1.0 -> delay = exact backoff base
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function open(over: Parameters<typeof makeClient>[0] = {}, cfg: Parameters<typeof makeClient>[1] = {}) {
  const h = makeClient(over, cfg);
  await h.client.connect();
  return { ...h, ws: FakeWebSocket.last };
}

describe("connect and auth", () => {
  it("checks the environment, trades the bearer for a ticket and opens /ws with orchestrationProtocol=2", async () => {
    const { client, calls, ws } = await open({ clientInfo: { clientSurface: "t3p" } });
    expect(client.state).toBe("open");
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(["GET /.well-known/t3/environment", "POST /api/auth/websocket-ticket/rpc"]);
    expect(calls[1]!.headers.get("authorization")).toBe("Bearer bearer-1");
    const u = new URL(ws.url);
    expect(u.protocol).toBe("ws:");
    expect(u.pathname).toBe("/ws");
    expect(u.searchParams.get("wsTicket")).toBe("ticket-1");
    expect(u.searchParams.get("orchestrationProtocol")).toBe("2");
    expect(u.searchParams.get("clientSurface")).toBe("t3p");
    expect(u.searchParams.has("frameParts")).toBe(false);
  });

  it("emits state changes idle -> connecting -> open and supports unsubscribe", async () => {
    const { client } = makeClient();
    const seen: RpcClientState[] = [];
    const off = client.onState((s) => seen.push(s));
    expect(client.state).toBe("idle");
    await client.connect();
    off();
    client.close();
    expect(seen).toEqual(["connecting", "open"]);
  });

  it("derives wss from https and honours an explicit wsBaseUrl", async () => {
    const a = await open({ httpBaseUrl: "https://example.test:9/" });
    expect(FakeWebSocket.last.url.startsWith("wss://example.test:9/ws?")).toBe(true);
    a.client.close();
    const b = await open({ wsBaseUrl: "ws://other:1" });
    expect(FakeWebSocket.last.url.startsWith("ws://other:1/ws?")).toBe(true);
    b.client.close();
  });

  it("falls back to the bare ticket path on a 404 from /rpc", async () => {
    const { calls, ws } = await open({}, { rpcTicketStatus: 404 });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/.well-known/t3/environment",
      "/api/auth/websocket-ticket/rpc",
      "/api/auth/websocket-ticket",
    ]);
    expect(new URL(ws.url).searchParams.get("wsTicket")).toBe("ticket-1");
  });

  it("refuses when orchestrationProtocolVersion is not 2 (no ticket, no socket)", async () => {
    const { client, calls } = makeClient({}, { protocol: 3 });
    const err = await client.connect().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).kind).toBe("http");
    expect((err as RpcError).tag).toBe("ProtocolVersionMismatch");
    expect(calls).toHaveLength(1);
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(client.state).toBe("closed");
  });

  it("rejects with RpcError http on a ticket 401, carrying status and tag", async () => {
    const { client } = makeClient({}, { rpcTicketStatus: 401 });
    const err = (await client.connect().catch((e: unknown) => e)) as RpcError;
    expect(err.kind).toBe("http");
    expect(err.status).toBe(401);
    expect(err.tag).toBe("EnvironmentAuthInvalidError");
  });

  it("http() adds the bearer and keeps caller headers", async () => {
    const { client, calls } = makeClient();
    const res = await client.http("api/auth/session", { headers: { "x-t": "1" } });
    expect(res.status).toBe(200);
    const c = calls.at(-1)!;
    expect(c.url).toBe("http://127.0.0.1:3873/api/auth/session");
    expect(c.headers.get("authorization")).toBe("Bearer bearer-1");
    expect(c.headers.get("x-t")).toBe("1");
  });
});

describe("unary calls", () => {
  it("sends numeric ids and resolves with exit.value", async () => {
    const { client, ws } = await open();
    const a = client.call("server.getConfig", {});
    const b = client.call("projects.ensureScratch", {});
    expect(ws.framesOf("Request")).toEqual([
      { _tag: "Request", id: 0, tag: "server.getConfig", payload: {}, headers: [] },
      { _tag: "Request", id: 1, tag: "projects.ensureScratch", payload: {}, headers: [] },
    ]);
    ws.serverSend(exitOk(1, { projectId: "p" }));
    ws.serverSend(exitOk(0, { providers: [] }));
    await expect(a).resolves.toEqual({ providers: [] });
    await expect(b).resolves.toEqual({ projectId: "p" });
  });

  it("maps Fail, Die and Interrupt causes to RpcError kinds and keeps the raw cause", async () => {
    const { client, ws } = await open();
    const fail = client.call("orchestration.dispatchCommand", {} as never);
    const die = client.call("no.such.method", {});
    const intr = client.call("server.getConfig", {});
    const failCause = [{ _tag: "Fail", error: { _tag: "OrchestrationV2DispatchCommandError", message: "No adapter for nope.", cause: { name: "X" } } }];
    ws.serverSend(exitFail(0, failCause));
    ws.serverSend(exitFail(1, [{ _tag: "Die", defect: "Unknown request tag: no.such.method" }]));
    ws.serverSend(exitFail(2, [{ _tag: "Interrupt", fiberId: 7 }]));
    const e1 = (await fail.catch((e: unknown) => e)) as RpcError;
    expect(e1).toMatchObject({ kind: "failure", tag: "OrchestrationV2DispatchCommandError" });
    expect(e1.message).toContain("No adapter for nope.");
    expect(e1.cause).toEqual(failCause);
    expect(e1.isProviderSelectionBusy).toBe(false);
    const e2 = (await die.catch((e: unknown) => e)) as RpcError;
    expect(e2.kind).toBe("defect");
    expect(e2.message).toContain("Unknown request tag");
    expect(((await intr.catch((e: unknown) => e)) as RpcError).kind).toBe("interrupted");
  });

  it("detects the busy provider switch through cause.name, not the outer tag", async () => {
    const { client, ws } = await open();
    const p = client.call("orchestration.dispatchCommand", {} as never);
    ws.serverSend(
      exitFail(0, [
        {
          _tag: "Fail",
          error: {
            _tag: "OrchestrationV2DispatchCommandError",
            commandType: "provider.switch",
            message: "Thread has an active turn.",
            cause: { name: "OrchestratorProviderSelectionBusyError" },
          },
        },
      ]),
    );
    const e = (await p.catch((x: unknown) => x)) as RpcError;
    expect(e.causeName).toBe("OrchestratorProviderSelectionBusyError");
    expect(e.isProviderSelectionBusy).toBe(true);
  });

  it("clips very long defect messages but keeps the full cause", async () => {
    const { client, ws } = await open();
    const p = client.call("x", {});
    const defect = "e".repeat(5000);
    ws.serverSend(exitFail(0, [{ _tag: "Die", defect }]));
    const e = (await p.catch((x: unknown) => x)) as RpcError;
    expect(e.message.length).toBeLessThan(1100);
    expect((e.cause as Array<{ defect: string }>)[0]!.defect).toHaveLength(5000);
  });

  it("rejects with kind closed when not connected", async () => {
    const { client } = makeClient();
    await expect(client.call("server.getConfig", {})).rejects.toMatchObject({ kind: "closed" });
  });

  it("types: known methods are precise, unknown ones fall back to unknown", async () => {
    const { client, ws } = await open();
    const known = client.call("server.getConfig", {});
    const unknownMethod = client.call("some.future.method", { anything: 1 });
    // @ts-expect-error payload of a typed method is checked
    void client.call("orchestration.getThreadProjection", { nope: 1 }).catch(() => undefined);
    ws.serverSend(exitOk(0, { providers: [] }));
    ws.serverSend(exitOk(1, 5));
    const cfg = await known;
    expect(Array.isArray(cfg.providers)).toBe(true);
    const u: unknown = await unknownMethod;
    expect(u).toBe(5);
  });
});

describe("streams", () => {
  it("delivers every value, Acks each Chunk once and sends Interrupt on cancel, then resolves done", async () => {
    const { client, ws } = await open();
    const items: unknown[] = [];
    const sub = client.subscribe("subscribeServerConfig", {}, (i) => items.push(i));
    expect(ws.framesOf("Request")[0]).toMatchObject({ id: 0, tag: "subscribeServerConfig" });
    ws.serverSend(chunk(0, { n: 1 }, { n: 2 }));
    ws.serverSend(chunk(0, { n: 3 }));
    expect(items).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(ws.framesOf("Ack")).toEqual([
      { _tag: "Ack", requestId: 0 },
      { _tag: "Ack", requestId: 0 },
    ]);
    let done = false;
    void sub.done.then(() => (done = true));
    sub.cancel();
    sub.cancel(); // idempotent
    expect(ws.framesOf("Interrupt")).toEqual([{ _tag: "Interrupt", requestId: 0 }]);
    await flush();
    expect(done).toBe(true);
    // a chunk that was already in flight: acked, not delivered
    ws.serverSend(chunk(0, { n: 4 }));
    expect(items).toHaveLength(3);
    expect(ws.framesOf("Ack")).toHaveLength(3);
    ws.serverSend(exitFail(0, [{ _tag: "Interrupt", fiberId: 1 }]));
  });

  it("joins frame parts before decoding", async () => {
    const { client, ws } = await open();
    const items: unknown[] = [];
    client.subscribe("subscribeServerConfig", {}, (i) => items.push(i));
    const whole = JSON.stringify(chunk(0, { big: "x".repeat(100) }));
    ws.serverSend("\u001e" + whole.slice(0, 30));
    ws.serverSend("\u001e" + whole.slice(30, 60));
    expect(items).toHaveLength(0);
    ws.serverSend(whole.slice(60));
    expect(items).toEqual([{ big: "x".repeat(100) }]);
    expect(ws.framesOf("Ack")).toHaveLength(1);
  });

  it("reports a failed stream through onError and resolves done", async () => {
    const { client, ws } = await open();
    const errors: RpcError[] = [];
    const sub = client.subscribe("orchestration.subscribeThread", { threadId: "t" } as never, () => undefined, { onError: (e) => errors.push(e) });
    ws.serverSend(exitFail(0, [{ _tag: "Die", defect: "Missing key" }]));
    await sub.done;
    expect(errors).toHaveLength(1);
    expect(errors[0]!.kind).toBe("defect");
  });

  it("a server-side Success exit just ends the stream", async () => {
    const { client, ws } = await open();
    const onError = vi.fn();
    const sub = client.subscribe("subscribeServerConfig", {}, () => undefined, { onError });
    ws.serverSend(exitOk(0, undefined));
    await sub.done;
    expect(onError).not.toHaveBeenCalled();
  });

  it("an onItem that throws goes to onError and does not stop the stream or the Ack", async () => {
    const { client, ws } = await open();
    const errors: RpcError[] = [];
    const seen: unknown[] = [];
    client.subscribe(
      "subscribeServerConfig",
      {},
      (i) => {
        seen.push(i);
        if ((i as unknown) === 1) throw new Error("boom");
      },
      { onError: (e) => errors.push(e) },
    );
    ws.serverSend(chunk(0, 1, 2));
    expect(seen).toEqual([1, 2]);
    expect(errors).toHaveLength(1);
    expect(ws.framesOf("Ack")).toHaveLength(1);
  });

  it("a subscribe issued before connect() is sent when the socket opens", async () => {
    const { client } = makeClient();
    const items: unknown[] = [];
    client.subscribe("subscribeServerConfig", { environmentThemes: true }, (i) => items.push(i));
    await client.connect();
    const ws = FakeWebSocket.last;
    expect(ws.framesOf("Request")).toEqual([{ _tag: "Request", id: 0, tag: "subscribeServerConfig", payload: { environmentThemes: true }, headers: [] }]);
  });
});

describe("ping and silence", () => {
  it("sends Ping every pingIntervalMs (default 5 s) and stays open while Pongs arrive", async () => {
    const { client, ws } = await open();
    for (let i = 1; i <= 6; i++) {
      await vi.advanceTimersByTimeAsync(5000);
      expect(ws.framesOf("Ping")).toHaveLength(i);
      ws.serverSend({ _tag: "Pong" });
    }
    expect(client.state).toBe("open");
  });

  it("honours a custom ping interval", async () => {
    const { ws } = await open({ pingIntervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(ws.framesOf("Ping")).toHaveLength(3);
  });

  it("drops the socket and reconnects after 15 s without any frame", async () => {
    const { client, ws } = await open();
    await vi.advanceTimersByTimeAsync(14_900);
    expect(client.state).toBe("open");
    await vi.advanceTimersByTimeAsync(200);
    expect(client.state).toBe("reconnecting");
    expect(ws.closedByClient).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(client.state).toBe("open");
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});

describe("reconnect", () => {
  it("rejects pending calls with kind closed, reconnects with a fresh ticket and bearer, re-issues streams", async () => {
    const h = await open();
    const { client, ws, calls } = h;
    const pending = client.call("server.getConfig", {});
    const items: unknown[] = [];
    client.subscribe("subscribeServerConfig", { environmentThemes: true }, (i) => items.push(i));
    ws.serverSend(chunk(1, "a"));
    const states: RpcClientState[] = [];
    client.onState((s) => states.push(s));

    ws.serverClose();
    await expect(pending).rejects.toMatchObject({ kind: "closed" });
    expect(client.state).toBe("reconnecting");
    await expect(client.call("server.getConfig", {})).rejects.toMatchObject({ kind: "closed" });

    await vi.advanceTimersByTimeAsync(499);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.state).toBe("open");
    expect(states).toEqual(["reconnecting", "open"]);

    const ws2 = FakeWebSocket.last;
    expect(ws2).not.toBe(ws);
    expect(new URL(ws2.url).searchParams.get("wsTicket")).toBe("ticket-2");
    expect(h.bearerCalls()).toBe(2);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
    // default resume: same payload, new request id (ids keep counting; the rejected call used 0, the stream 1)
    expect(ws2.framesOf("Request")).toEqual([{ _tag: "Request", id: 2, tag: "subscribeServerConfig", payload: { environmentThemes: true }, headers: [] }]);
    ws2.serverSend(chunk(2, "b"));
    expect(items).toEqual(["a", "b"]);
    expect(ws2.framesOf("Ack")).toEqual([{ _tag: "Ack", requestId: 2 }]);
  });

  it("retries failed attempts with exponential backoff (500, 1000, then capped at 1500)", async () => {
    const h = await open({ reconnect: { initialMs: 500, maxMs: 1500 } });
    h.state.failTicketNetwork = 2; // the next two ticket fetches throw
    FakeWebSocket.last.serverClose();
    const sockets = FakeWebSocket.instances.length;
    await vi.advanceTimersByTimeAsync(499);
    expect(h.state.failTicketNetwork).toBe(2);
    await vi.advanceTimersByTimeAsync(1); // attempt 1 at +500 fails
    expect(h.state.failTicketNetwork).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(h.state.failTicketNetwork).toBe(1);
    await vi.advanceTimersByTimeAsync(1); // attempt 2 at +1500 fails
    expect(h.state.failTicketNetwork).toBe(0);
    await vi.advanceTimersByTimeAsync(1499); // next delay min(1500, 2000)
    expect(h.client.state).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(1); // attempt 3 succeeds
    expect(h.client.state).toBe("open");
    expect(FakeWebSocket.instances.length).toBe(sockets + 1);
  });

  it("stops and reports when the server protocol changed during a reconnect", async () => {
    const { client, ws, state } = await open();
    const errors: RpcError[] = [];
    const sub = client.subscribe("subscribeServerConfig", {}, () => undefined, { onError: (e) => errors.push(e) });
    state.protocol = 3;
    ws.serverClose();
    await vi.advanceTimersByTimeAsync(500);
    expect(client.state).toBe("closed");
    expect(errors[0]).toMatchObject({ kind: "http", tag: "ProtocolVersionMismatch" });
    await sub.done;
  });

  it("close() ends reconnecting, rejects pending, resolves done and closes the socket", async () => {
    const { client, ws } = await open();
    const sub = client.subscribe("subscribeServerConfig", {}, () => undefined);
    const p = client.call("server.getConfig", {});
    client.close();
    expect(ws.closedByClient).toBe(true);
    await expect(p).rejects.toMatchObject({ kind: "closed" });
    await sub.done;
    expect(client.state).toBe("closed");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("a cancelled subscription is not re-issued after a reconnect", async () => {
    const { client, ws } = await open();
    const sub = client.subscribe("subscribeServerConfig", {}, () => undefined);
    sub.cancel();
    ws.serverClose();
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeWebSocket.last.framesOf("Request")).toHaveLength(0);
  });
});

describe("thread resume", () => {
  const snapshot = (seq: number) => ({ kind: "snapshot", snapshotSequence: seq, projection: { thread: { id: "t1" } } });
  const event = (seq: number, type = "thread.metadata-updated") => ({ kind: "event", sequence: seq, event: { type, threadId: "t1" } });

  it("resumeAfterSequence uses the highest sequence seen and never moves backwards", () => {
    const r = resumeAfterSequence<{ threadId: string; afterSequence?: number }>();
    expect(r(undefined, { threadId: "t" })).toEqual({ threadId: "t" });
    expect(r(snapshot(56) as never, { threadId: "t", afterSequence: 0 })).toEqual({ threadId: "t", afterSequence: 56 });
    expect(r(event(57) as never, { threadId: "t", afterSequence: 56 })).toEqual({ threadId: "t", afterSequence: 57 });
    expect(r({ kind: "synchronized" }, { threadId: "t", afterSequence: 57 })).toEqual({ threadId: "t", afterSequence: 57 });
    expect(r(event(3) as never, { threadId: "t", afterSequence: 57 })).toEqual({ threadId: "t", afterSequence: 57 });
  });

  it("watchThread: snapshot then events; after a drop resubscribes from the last sequence with no second snapshot", async () => {
    const { client, ws } = await open();
    const snaps: number[] = [];
    const events: number[] = [];
    watchThread(
      client,
      "t1",
      (s) => snaps.push(s.snapshotSequence),
      (e) => events.push(e.sequence),
    );
    expect(ws.framesOf("Request")[0]).toMatchObject({ tag: "orchestration.subscribeThread", payload: { threadId: "t1", afterSequence: 0 } });
    ws.serverSend(chunk(0, snapshot(56)));
    ws.serverSend(chunk(0, event(57)));
    ws.serverSend(chunk(0, event(88), event(90)));
    ws.serverClose();
    await vi.advanceTimersByTimeAsync(500);
    const ws2 = FakeWebSocket.last;
    expect(ws2.framesOf("Request")).toEqual([
      { _tag: "Request", id: 1, tag: "orchestration.subscribeThread", payload: { threadId: "t1", afterSequence: 90 }, headers: [] },
    ]);
    ws2.serverSend(chunk(1, event(91), event(92)));
    expect(snaps).toEqual([56]);
    expect(events).toEqual([57, 88, 90, 91, 92]);
    // second drop builds on the first resume
    ws2.serverClose();
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeWebSocket.last.framesOf("Request")[0]).toMatchObject({ payload: { threadId: "t1", afterSequence: 92 } });
  });

  it("watchThread: a drop before any item restarts from 0 and a new snapshot is delivered", async () => {
    const { client, ws } = await open();
    const snaps: number[] = [];
    watchThread(client, "t1", (s) => snaps.push(s.snapshotSequence), () => undefined);
    ws.serverClose();
    await vi.advanceTimersByTimeAsync(500);
    const ws2 = FakeWebSocket.last;
    expect(ws2.framesOf("Request")[0]).toMatchObject({ payload: { threadId: "t1", afterSequence: 0 } });
    ws2.serverSend(chunk(1, snapshot(70)));
    expect(snaps).toEqual([70]);
  });

  it("watchThread cancel interrupts the stream", async () => {
    const { client, ws } = await open();
    const w = watchThread(client, "t1", () => undefined, () => undefined);
    w.cancel();
    await w.done;
    expect(ws.framesOf("Interrupt")).toEqual([{ _tag: "Interrupt", requestId: 0 }]);
  });
});
