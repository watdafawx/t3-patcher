import { RpcClient, type RpcClientOptions } from "../src/index.js";

type Handler<E> = ((e: E) => void) | null;

/** Event-driven in-process WebSocket. Opens on a microtask; the test plays the server via serverSend/serverClose. */
export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static autoOpen = true;
  static reset(): void {
    FakeWebSocket.instances = [];
    FakeWebSocket.autoOpen = true;
  }
  static get last(): FakeWebSocket {
    const w = FakeWebSocket.instances.at(-1);
    if (!w) throw new Error("no FakeWebSocket created");
    return w;
  }

  readyState = 0;
  readonly url: string;
  readonly sent: string[] = [];
  onopen: Handler<unknown> = null;
  onmessage: Handler<{ data: unknown }> = null;
  onclose: Handler<{ code: number }> = null;
  onerror: Handler<unknown> = null;
  closedByClient = false;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    if (FakeWebSocket.autoOpen) void Promise.resolve().then(() => this.serverOpen());
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("send on non-open FakeWebSocket");
    this.sent.push(data);
  }
  close(): void {
    this.closedByClient = true;
    this.readyState = 3;
  }

  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  serverSend(frame: unknown): void {
    this.onmessage?.({ data: typeof frame === "string" ? frame : JSON.stringify(frame) });
  }
  serverClose(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }

  /** Parsed frames the client sent. */
  get frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
  framesOf(tag: string): Array<Record<string, unknown>> {
    return this.frames.filter((f) => f._tag === tag);
  }
}

export interface FetchConfig {
  protocol?: number | undefined;
  /** status for POST /api/auth/websocket-ticket/rpc */
  rpcTicketStatus?: number;
  /** status for POST /api/auth/websocket-ticket */
  bareTicketStatus?: number;
  /** throw (network error) on the next N fetches of the ticket */
  failTicketNetwork?: number;
}

export interface FetchCall {
  method: string;
  url: string;
  headers: Headers;
}

export function createFetch(cfg: FetchConfig = {}) {
  const calls: FetchCall[] = [];
  let ticketN = 0;
  const state: FetchConfig = { ...cfg };
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ method: init?.method ?? "GET", url, headers });
    const path = new URL(url).pathname;
    if (path === "/.well-known/t3/environment") {
      return new Response(JSON.stringify({ environmentId: "e", orchestrationProtocolVersion: "protocol" in state ? state.protocol : 2 }), { status: 200 });
    }
    if (path.startsWith("/api/auth/websocket-ticket")) {
      if ((state.failTicketNetwork ?? 0) > 0) {
        state.failTicketNetwork = state.failTicketNetwork! - 1;
        throw new TypeError("network down");
      }
      const status = (path.endsWith("/rpc") ? state.rpcTicketStatus : state.bareTicketStatus) ?? 200;
      if (status !== 200) return new Response(JSON.stringify({ _tag: "EnvironmentAuthInvalidError", code: "auth_invalid" }), { status });
      return new Response(JSON.stringify({ ticket: `ticket-${++ticketN}`, expiresAt: "2099-01-01T00:00:00Z" }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, path }), { status: 200 });
  }) as typeof fetch;
  return { fetch: fetchFn, calls, state };
}

export function makeClient(over: Partial<RpcClientOptions> = {}, fetchCfg: FetchConfig = {}) {
  const f = createFetch(fetchCfg);
  let bearerCalls = 0;
  const client = new RpcClient({
    httpBaseUrl: "http://127.0.0.1:3873",
    getBearer: async () => `bearer-${++bearerCalls}`,
    fetch: f.fetch,
    WebSocket: FakeWebSocket as unknown as typeof WebSocket,
    ...over,
  });
  return { client, ...f, bearerCalls: () => bearerCalls };
}

export const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

export const chunk = (requestId: number, ...values: unknown[]) => ({ _tag: "Chunk", requestId, values });
export const exitOk = (requestId: number, value: unknown) => ({ _tag: "Exit", requestId, exit: { _tag: "Success", value } });
export const exitFail = (requestId: number, cause: unknown[]) => ({ _tag: "Exit", requestId, exit: { _tag: "Failure", cause } });
