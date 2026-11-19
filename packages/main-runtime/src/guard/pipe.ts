/**
 * Server process <-> main process transport for the turn guard: a local socket (a Windows named
 * pipe, a unix socket elsewhere) carrying one JSON object per line.
 *
 *   server -> main   {"id": 1, "token": "<hex>", "ctx": TurnStartContext}
 *   main -> server   {"id": 1, "decision": AttributedDecision}
 *
 * The token (random, per app start, passed only in the backend's env and removed there at once)
 * is checked on every request; a wrong token closes the connection.
 */
import { randomBytes } from "node:crypto";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { AttributedDecision, TurnStartContext } from "@t3p/api";

export const GUARD_PIPE_ENV = "T3P_GUARD_PIPE";
export const GUARD_TOKEN_ENV = "T3P_GUARD_TOKEN";
const MAX_LINE = 256 * 1024;

export function newGuardEndpoint(platform: NodeJS.Platform = process.platform, pid = process.pid): { path: string; token: string } {
  const rand = randomBytes(6).toString("hex");
  const path = platform === "win32" ? `\\\\.\\pipe\\t3p-guard-${pid}-${rand}` : join(tmpdir(), `t3p-guard-${pid}-${rand}.sock`);
  return { path, token: randomBytes(24).toString("hex") };
}

/** Splits a byte stream into lines; drops the connection on an over-long line. */
function lineReader(socket: Socket, onLine: (line: string) => void): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_LINE && !buffer.includes("\n")) {
      socket.destroy();
      return;
    }
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim()) onLine(line);
    }
  });
}

export interface GuardPipeServerDeps {
  path: string;
  token: string;
  decide(ctx: TurnStartContext): Promise<AttributedDecision>;
  log: { info(message: string): void; warn(message: string): void };
}

/** Main side. Resolves once listening. */
export function startGuardPipeServer(deps: GuardPipeServerDeps): Promise<Server> {
  const server = createServer((socket) => {
    socket.on("error", () => undefined);
    lineReader(socket, (line) => {
      let msg: { id?: unknown; token?: unknown; ctx?: unknown };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        socket.destroy();
        return;
      }
      if (msg.token !== deps.token || (typeof msg.id !== "number" && typeof msg.id !== "string")) {
        deps.log.warn("guard pipe: request with a bad token or id, closing");
        socket.destroy();
        return;
      }
      const id = msg.id;
      const reply = (decision: AttributedDecision): void => {
        if (!socket.destroyed) socket.write(`${JSON.stringify({ id, decision })}\n`);
      };
      if (msg.ctx === null || typeof msg.ctx !== "object") {
        reply({ action: "allow" });
        return;
      }
      deps.decide(msg.ctx as TurnStartContext).then(reply, (error: unknown) => {
        deps.log.warn(`guard pipe: decide failed (${error instanceof Error ? error.message : String(error)}), allowing`);
        reply({ action: "allow" });
      });
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(deps.path, () => {
      server.off("error", reject);
      server.on("error", (error) => deps.log.warn(`guard pipe error: ${String(error)}`));
      resolve(server);
    });
  });
}

export interface GuardPipeClient {
  request(ctx: TurnStartContext): Promise<AttributedDecision>;
  close(): void;
}

/**
 * Server side. Connects lazily, reconnects after an error, fails pending requests when the
 * connection drops (the guard then allows them).
 */
export function createGuardPipeClient(options: { path: string; token: string; connect?: (path: string) => Socket }): GuardPipeClient {
  const connect = options.connect ?? ((path: string) => createConnection(path));
  let socket: Socket | null = null;
  let nextId = 1;
  const pending = new Map<number, { resolve(d: AttributedDecision): void; reject(e: Error): void }>();

  const failAll = (error: Error): void => {
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  };
  /** The socket keeps the process alive only while a request waits. */
  const idle = (): void => {
    if (pending.size === 0) socket?.unref();
  };

  const ensure = (): Socket => {
    if (socket && !socket.destroyed) return socket;
    const s = connect(options.path);
    socket = s;
    s.on("error", (error) => {
      if (socket === s) socket = null;
      failAll(error);
    });
    s.on("close", () => {
      if (socket === s) socket = null;
      failAll(new Error("guard pipe closed"));
    });
    lineReader(s, (line) => {
      let msg: { id?: unknown; decision?: unknown };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        return;
      }
      if (typeof msg.id !== "number") return;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      idle();
      p.resolve((msg.decision ?? { action: "allow" }) as AttributedDecision);
    });
    return s;
  };

  return {
    request(ctx) {
      return new Promise<AttributedDecision>((resolve, reject) => {
        let s: Socket;
        try {
          s = ensure();
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        const id = nextId++;
        pending.set(id, { resolve, reject });
        s.ref();
        s.write(`${JSON.stringify({ id, token: options.token, ctx })}\n`);
      });
    },
    close() {
      socket?.destroy();
      socket = null;
      failAll(new Error("guard pipe client closed"));
    },
  };
}
