import { RpcError, errorFromCause } from "./errors.js";
import { FrameJoiner, decodeFrame, encodeFrame, type ClientFrame, type ServerFrame } from "./frames.js";
import type { RpcMethods, RpcStreams } from "./methods.js";

export type RpcClientState = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export interface RpcClientOptions {
  /** e.g. http://127.0.0.1:3873 */
  httpBaseUrl: string;
  /** Derived from httpBaseUrl (http -> ws) when omitted. */
  wsBaseUrl?: string;
  /** renderer: () => window.desktopBridge.getLocalEnvironmentBearerToken(); node tests: any */
  getBearer: () => Promise<string>;
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
  /** default 5000 */
  pingIntervalMs?: number;
  /** Drop the socket and reconnect after this long without any frame. Default 15000. */
  silenceTimeoutMs?: number;
  /** default 500 / 10000, exponential with jitter */
  reconnect?: { initialMs: number; maxMs: number };
  /** Extra upgrade query params (clientSurface, ...). */
  clientInfo?: Record<string, string>;
}

export interface SubscribeOptions<P, I> {
  onError?: (e: RpcError) => void;
  /**
   * Called on every resubscribe after a reconnect. Returns the payload for the new request (it also
   * replaces the stored payload, so later resumes build on it). Default: resend the original payload.
   */
  resume?: (lastItem: I | undefined, payload: P) => P;
}

export interface Subscription {
  /** Sends `Interrupt` (when connected) and resolves `done`. Idempotent. */
  cancel(): void;
  /** Resolves (never rejects) when the stream ended: cancelled, server finished, failed (see onError) or client closed. */
  done: Promise<void>;
}

interface PendingCall {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: RpcError) => void;
}

interface Sub {
  method: string;
  payload: unknown;
  onItem: (item: unknown) => void;
  opts: SubscribeOptions<unknown, unknown>;
  lastItem: unknown;
  reqId: number | null;
  cancelled: boolean;
  finished: boolean;
  finish: () => void;
}

const DEFAULTS = { pingIntervalMs: 5000, silenceTimeoutMs: 15000, reconnect: { initialMs: 500, maxMs: 10000 } };
const TICKET_PATHS = ["/api/auth/websocket-ticket/rpc", "/api/auth/websocket-ticket"];
const WS_OPEN = 1;

export class RpcClient {
  readonly #opts: RpcClientOptions;
  readonly #fetch: typeof fetch;
  readonly #WS: typeof WebSocket;
  readonly #httpBase: string;
  readonly #wsBase: string;
  #state: RpcClientState = "idle";
  readonly #stateListeners = new Set<(s: RpcClientState) => void>();
  #ws: WebSocket | null = null;
  #nextId = 0;
  readonly #pending = new Map<number, PendingCall>();
  /** request id -> subscription (also kept for cancelled ones until their Exit, so Chunks are still acked). */
  readonly #streams = new Map<number, Sub>();
  readonly #subs = new Set<Sub>();
  #joiner = new FrameJoiner();
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  #silenceTimer: ReturnType<typeof setTimeout> | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #attempt = 0;
  #connecting: Promise<void> | null = null;

  constructor(opts: RpcClientOptions) {
    this.#opts = opts;
    const f = opts.fetch ?? (typeof fetch === "function" ? fetch.bind(globalThis) : undefined);
    const W = opts.WebSocket ?? (typeof WebSocket === "function" ? WebSocket : undefined);
    if (!f || !W) throw new Error("RpcClient needs a global (or injected) fetch and WebSocket");
    this.#fetch = f;
    this.#WS = W;
    this.#httpBase = opts.httpBaseUrl.replace(/\/+$/, "");
    this.#wsBase = (opts.wsBaseUrl ?? this.#httpBase.replace(/^http/i, "ws")).replace(/\/+$/, "");
  }

  get state(): RpcClientState {
    return this.#state;
  }

  onState(cb: (s: RpcClientState) => void): () => void {
    this.#stateListeners.add(cb);
    return () => void this.#stateListeners.delete(cb);
  }

  #setState(s: RpcClientState): void {
    if (this.#state === s) return;
    this.#state = s;
    for (const cb of [...this.#stateListeners]) {
      try {
        cb(s);
      } catch {
        /* listener errors never break the client */
      }
    }
  }

  /** Environment check, ticket, socket. Resolves when open. Rejects (and goes to "closed") when the first attempt fails. */
  connect(): Promise<void> {
    if (this.#state === "open") return Promise.resolve();
    if (this.#connecting) return this.#connecting;
    if (this.#state === "closed") this.#state = "idle"; // reuse after close()
    this.#setState("connecting");
    const p = this.#openSocket().then(
      () => {
        this.#connecting = null;
      },
      (e: unknown) => {
        this.#connecting = null;
        this.#setState("closed");
        this.#failAllSubs(e instanceof RpcError ? e : new RpcError("closed", String(e)));
        throw e;
      },
    );
    this.#connecting = p;
    return p;
  }

  close(): void {
    this.#clearTimers();
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    const ws = this.#ws;
    this.#ws = null;
    if (ws) this.#detach(ws);
    this.#rejectPending(new RpcError("closed", "client closed"));
    this.#setState("closed");
    for (const s of [...this.#subs]) this.#endSub(s);
    this.#streams.clear();
  }

  call<M extends keyof RpcMethods & string>(method: M, payload: RpcMethods[M]["payload"]): Promise<RpcMethods[M]["result"]> {
    const ws = this.#ws;
    if (this.#state !== "open" || !ws || ws.readyState !== WS_OPEN) {
      return Promise.reject(new RpcError("closed", `cannot call ${method}: client is ${this.#state}`));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject });
      this.#send({ _tag: "Request", id, tag: method, payload, headers: [] });
    });
  }

  subscribe<M extends keyof RpcStreams & string>(
    method: M,
    payload: RpcStreams[M]["payload"],
    onItem: (item: RpcStreams[M]["item"]) => void,
    opts: SubscribeOptions<RpcStreams[M]["payload"], RpcStreams[M]["item"]> = {},
  ): Subscription {
    let finish!: () => void;
    const done = new Promise<void>((r) => (finish = r));
    const sub: Sub = {
      method,
      payload,
      onItem: onItem as (item: unknown) => void,
      opts: opts as SubscribeOptions<unknown, unknown>,
      lastItem: undefined,
      reqId: null,
      cancelled: false,
      finished: false,
      finish,
    };
    if (this.#state === "closed") {
      this.#endSub(sub);
      queueMicrotask(() => opts.onError?.(new RpcError("closed", `cannot subscribe to ${method}: client is closed`)));
      return { cancel: () => undefined, done };
    }
    this.#subs.add(sub);
    if (this.#state === "open") this.#issue(sub);
    // else: issued as soon as the socket opens (connect() or reconnect)
    return {
      done,
      cancel: () => {
        if (sub.cancelled) return;
        sub.cancelled = true;
        if (sub.reqId !== null && this.#ws?.readyState === WS_OPEN) this.#send({ _tag: "Interrupt", requestId: sub.reqId });
        this.#endSub(sub);
      },
    };
  }

  /** Authenticated HTTP request to the server (adds `Authorization: Bearer`). */
  async http(path: string, init: RequestInit = {}): Promise<Response> {
    const bearer = await this.#opts.getBearer();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${bearer}`);
    return this.#fetch(this.#httpUrl(path), { ...init, headers });
  }

  // ---- connection ----------------------------------------------------------------------------

  #httpUrl(path: string): string {
    return `${this.#httpBase}${path.startsWith("/") ? path : `/${path}`}`;
  }

  async #checkEnvironment(): Promise<void> {
    let res: Response;
    try {
      res = await this.#fetch(this.#httpUrl("/.well-known/t3/environment"));
    } catch (e) {
      throw new RpcError("http", `environment probe failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) throw new RpcError("http", `environment probe returned ${res.status}`, { status: res.status });
    const body = (await res.json().catch(() => ({}))) as { orchestrationProtocolVersion?: unknown };
    if (body.orchestrationProtocolVersion !== 2) {
      throw new RpcError("http", `unsupported orchestrationProtocolVersion ${String(body.orchestrationProtocolVersion)} (this client speaks 2)`, {
        tag: "ProtocolVersionMismatch",
      });
    }
  }

  async #fetchTicket(): Promise<string> {
    const bearer = await this.#opts.getBearer();
    let last: RpcError | undefined;
    for (const p of TICKET_PATHS) {
      let res: Response;
      try {
        res = await this.#fetch(this.#httpUrl(p), { method: "POST", headers: { Authorization: `Bearer ${bearer}` } });
      } catch (e) {
        throw new RpcError("http", `ticket request failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (res.status === 404) {
        last = new RpcError("http", `ticket endpoint ${p} not found`, { status: 404 });
        continue; // older server: bare path
      }
      const text = await res.text();
      let json = null as { ticket?: unknown; _tag?: unknown } | null;
      try {
        json = JSON.parse(text) as typeof json;
      } catch {
        /* not json */
      }
      if (!res.ok || typeof json?.ticket !== "string") {
        const tag = typeof json?._tag === "string" ? json._tag : undefined;
        throw new RpcError("http", `ticket request failed: ${res.status} ${text.slice(0, 200)}`, { status: res.status, ...(tag ? { tag } : {}) });
      }
      return json.ticket;
    }
    throw last ?? new RpcError("http", "no ticket endpoint");
  }

  async #openSocket(): Promise<void> {
    await this.#checkEnvironment();
    const ticket = await this.#fetchTicket(); // fresh ticket on every (re)connect
    const params = new URLSearchParams({ wsTicket: ticket, orchestrationProtocol: "2", ...this.#opts.clientInfo });
    const ws = new this.#WS(`${this.#wsBase}/ws?${params.toString()}`);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      ws.onopen = () => {
        settled = true;
        resolve();
      };
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new RpcError("closed", "websocket error before open"));
        }
      };
      ws.onclose = (e) => {
        if (!settled) {
          settled = true;
          reject(new RpcError("closed", `websocket closed before open (${e?.code ?? "?"})`));
        } else {
          this.#onSocketLost(ws);
        }
      };
    });
    if (this.#state === "closed") {
      this.#detach(ws);
      throw new RpcError("closed", "client closed while connecting");
    }
    ws.onmessage = (e) => this.#onMessage(ws, e.data);
    ws.onerror = () => undefined; // the close event follows
    this.#ws = ws;
    this.#joiner = new FrameJoiner();
    this.#attempt = 0;
    this.#startTimers(ws);
    this.#setState("open");
    for (const sub of [...this.#subs]) {
      if (sub.reqId === null && !sub.cancelled) this.#issue(sub, true);
    }
  }

  #detach(ws: WebSocket): void {
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }

  #startTimers(ws: WebSocket): void {
    this.#clearTimers();
    const ping = this.#opts.pingIntervalMs ?? DEFAULTS.pingIntervalMs;
    this.#pingTimer = setInterval(() => {
      if (this.#ws === ws && ws.readyState === WS_OPEN) this.#send({ _tag: "Ping" });
    }, ping);
    this.#armSilence(ws);
  }

  #armSilence(ws: WebSocket): void {
    if (this.#silenceTimer) clearTimeout(this.#silenceTimer);
    this.#silenceTimer = setTimeout(() => this.#onSocketLost(ws), this.#opts.silenceTimeoutMs ?? DEFAULTS.silenceTimeoutMs);
  }

  #clearTimers(): void {
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    if (this.#silenceTimer) clearTimeout(this.#silenceTimer);
    this.#pingTimer = this.#silenceTimer = null;
  }

  #onSocketLost(ws: WebSocket): void {
    if (this.#ws !== ws) return; // already handled
    this.#ws = null;
    this.#detach(ws);
    this.#clearTimers();
    this.#rejectPending(new RpcError("closed", "connection lost"));
    for (const sub of this.#subs) sub.reqId = null;
    this.#streams.clear();
    if (this.#state === "closed") return;
    this.#setState("reconnecting");
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    const { initialMs, maxMs } = this.#opts.reconnect ?? DEFAULTS.reconnect;
    const base = Math.min(maxMs, initialMs * 2 ** this.#attempt);
    const delay = Math.round(base * (0.5 + Math.random() * 0.5));
    this.#attempt++;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (this.#state !== "reconnecting") return;
      this.#openSocket().catch((e: unknown) => {
        if (this.#state !== "reconnecting") return;
        if (e instanceof RpcError && e.tag === "ProtocolVersionMismatch") {
          this.#setState("closed");
          this.#failAllSubs(e);
          return;
        }
        this.#scheduleReconnect();
      });
    }, delay);
  }

  // ---- frames --------------------------------------------------------------------------------

  #send(frame: ClientFrame): void {
    this.#ws?.send(encodeFrame(frame));
  }

  #onMessage(ws: WebSocket, data: unknown): void {
    if (this.#ws !== ws || typeof data !== "string") return;
    this.#armSilence(ws);
    const text = this.#joiner.push(data);
    if (text === undefined) return;
    const frame = decodeFrame(text);
    if (frame) this.#handle(frame);
  }

  #handle(frame: ServerFrame): void {
    switch (frame._tag) {
      case "Pong":
        return;
      case "Chunk": {
        const sub = this.#streams.get(frame.requestId);
        if (sub && !sub.cancelled) {
          for (const v of frame.values) {
            sub.lastItem = v;
            try {
              sub.onItem(v);
            } catch (e) {
              sub.opts.onError?.(new RpcError("defect", `onItem threw: ${e instanceof Error ? e.message : String(e)}`, { tag: "OnItemThrew", cause: e }));
            }
          }
        }
        this.#send({ _tag: "Ack", requestId: frame.requestId }); // always: the server pauses without it
        return;
      }
      case "Exit": {
        const call = this.#pending.get(frame.requestId);
        if (call) {
          this.#pending.delete(frame.requestId);
          if (frame.exit._tag === "Success") call.resolve(frame.exit.value);
          else call.reject(errorFromCause(frame.exit.cause, call.method));
          return;
        }
        const sub = this.#streams.get(frame.requestId);
        if (sub) {
          this.#streams.delete(frame.requestId);
          if (!sub.cancelled && frame.exit._tag === "Failure") sub.opts.onError?.(errorFromCause(frame.exit.cause, sub.method));
          this.#endSub(sub);
        }
        return;
      }
      case "Defect":
      case "ClientProtocolError":
        this.#rejectPending(new RpcError("defect", `protocol error: ${JSON.stringify("defect" in frame ? frame.defect : frame.error)}`, { tag: frame._tag }));
        return;
    }
  }

  #issue(sub: Sub, resume = false): void {
    if (resume && sub.opts.resume) sub.payload = sub.opts.resume(sub.lastItem, sub.payload);
    const id = this.#nextId++;
    sub.reqId = id;
    this.#streams.set(id, sub);
    this.#send({ _tag: "Request", id, tag: sub.method, payload: sub.payload, headers: [] });
  }

  #endSub(sub: Sub): void {
    if (sub.finished) return;
    sub.finished = true;
    this.#subs.delete(sub);
    if (sub.reqId !== null && !sub.cancelled) this.#streams.delete(sub.reqId);
    sub.finish();
  }

  #rejectPending(err: RpcError): void {
    for (const [, p] of this.#pending) p.reject(err);
    this.#pending.clear();
  }

  #failAllSubs(err: RpcError): void {
    for (const sub of [...this.#subs]) {
      if (!sub.cancelled) sub.opts.onError?.(err);
      this.#endSub(sub);
    }
  }
}
