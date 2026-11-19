import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { AttributedDecision, GuardRequestEvent, TurnStartContext } from "@t3p/api";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createGuardBroker } from "../src/guard/broker.js";
import { applyTurnStartDecision, guardOrderKey, isGuardedCommand, turnStartContext } from "../src/guard/command.js";
import { createGuardPipeClient, GUARD_PIPE_ENV, GUARD_TOKEN_ENV, newGuardEndpoint, startGuardPipeServer } from "../src/guard/pipe.js";
import { isServerEntry, patchLoaded } from "../src/guard/server-hook.js";
import { createServerGuard, TurnBlockedError } from "../src/guard/server-guard.js";
import { applyServerGuardPatch, SERVER_GUARD_FILE_RE, SERVER_GUARD_GLOBAL } from "../src/guard/server-patch.js";
import { injectGuard, installSpawnWrap, isBackendSpawn } from "../src/guard/spawn-wrap.js";
import { CHUNK, CHUNK_BODY, EFFECT_MODULE, loadChunk } from "./guard-fixtures.js";

const quiet = { info: () => undefined, warn: () => undefined };

const message = (over: Record<string, unknown> = {}) => ({
  type: "message.dispatch",
  commandId: "c1",
  threadId: "t1",
  messageId: "m1",
  text: "hello there",
  createdBy: "user",
  creationSource: "web",
  ...over,
});

function ctxOf(command: unknown): TurnStartContext {
  return turnStartContext(command, "g1", 1000)!;
}

describe("command helpers", () => {
  it("guards turn-starting commands only", () => {
    expect(isGuardedCommand(message())).toBe(true);
    expect(isGuardedCommand({ type: "delegated_task.request", parentThreadId: "p" })).toBe(true);
    expect(isGuardedCommand({ type: "thread.create", threadId: "t", initialMessage: { text: "x" } })).toBe(true);
    expect(isGuardedCommand({ type: "thread.create", threadId: "t" })).toBe(false);
    expect(isGuardedCommand({ type: "thread.archive", threadId: "t" })).toBe(false);
    expect(isGuardedCommand(null)).toBe(false);
  });

  it("builds the message context", () => {
    const ctx = ctxOf(message({ modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" }, usageLimitContinuationOfRunId: "r1", text: "x".repeat(500) }));
    expect(ctx).toMatchObject({
      kind: "message",
      threadId: "t1",
      provider: "codex",
      model: "gpt-6.1-sol",
      modelSource: "command",
      isSubagent: false,
      source: "web",
      createdBy: "user",
      continuation: "usage-limit",
      at: 1000,
    });
    expect(ctx.textPreview).toHaveLength(200);
    expect(ctxOf(message({ createdBy: "agent", senderThreadId: "p" }))).toMatchObject({ isSubagent: true, parentThreadId: "p", modelSource: null, provider: null });
  });

  it("builds the delegate and thread-create contexts", () => {
    const d = { type: "delegated_task.request", commandId: "c", parentThreadId: "p1", task: "do it", createdBy: "agent", creationSource: "mcp" };
    expect(ctxOf(d)).toMatchObject({ kind: "delegate", threadId: "p1", parentThreadId: "p1", isSubagent: true, textPreview: "do it", source: "mcp" });
    expect(guardOrderKey(d)).toBe("p1");
    const c = { type: "thread.create", threadId: "t9", createdBy: "agent", initialMessage: { text: "go", senderThreadId: "p2" }, modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" } };
    expect(ctxOf(c)).toMatchObject({ kind: "thread-create", threadId: "t9", parentThreadId: "p2", isSubagent: true, provider: "claudeAgent" });
  });

  it("applies modify as a new modelSelection without touching the input", () => {
    const cmd = message({ modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5", options: { effort: "high" } } });
    const out = applyTurnStartDecision(cmd, { action: "modify", provider: "codex", model: "gpt-6.1-sol" });
    expect(out.applied).toBe(true);
    expect(out.command.modelSelection).toEqual({ instanceId: "codex", model: "gpt-6.1-sol" });
    expect(cmd.modelSelection).toEqual({ instanceId: "claudeAgent", model: "claude-opus-5-5", options: { effort: "high" } });
    // Model only: provider stays.
    expect(applyTurnStartDecision(cmd, { action: "modify", model: "claude-sonnet-5-5" }).command.modelSelection).toEqual({ instanceId: "claudeAgent", model: "claude-sonnet-5-5" });
    // No selection on the command and no provider in the decision: cannot apply.
    expect(applyTurnStartDecision(message(), { action: "modify", model: "x" }).applied).toBe(false);
  });
});

describe("server patch", () => {
  it("matches the server chunk file names", () => {
    expect(SERVER_GUARD_FILE_RE.test("C:\\T3\\resources\\server.asar\\apps\\server\\dist\\runtimeLayer-CMUqXtti.mjs")).toBe(true);
    expect(SERVER_GUARD_FILE_RE.test("/opt/t3/server.asar/apps/server/dist/runtimeLayer-3i4tIb8r.mjs")).toBe(true);
    expect(SERVER_GUARD_FILE_RE.test("/opt/t3/apps/server/dist/client/runtimeLayer-x.mjs")).toBe(false);
  });

  it("refuses chunks without the anchors, twice-patched or ambiguous ones", () => {
    expect(applyServerGuardPatch("const x = 1;")).toMatchObject({ ok: false, reason: "no-anchor" });
    expect(applyServerGuardPatch(CHUNK_BODY)).toMatchObject({ ok: false, reason: "no-try-promise" });
    expect(applyServerGuardPatch(CHUNK.replace("var OrchestratorDispatchError", "var Other"))).toMatchObject({ ok: false, reason: "no-dispatch-error" });
    expect(applyServerGuardPatch(CHUNK + CHUNK_BODY.replace("var OrchestratorDispatchError", "var X"))).toMatchObject({ ok: false, reason: "ambiguous-anchor" });
    const once = applyServerGuardPatch(CHUNK);
    expect(once.ok).toBe(true);
    expect(applyServerGuardPatch((once as { code: string }).code)).toMatchObject({ ok: false, reason: "already-patched" });
  });

  describe("patched dispatch", () => {
    afterEach(() => {
      delete (globalThis as Record<string, unknown>)[SERVER_GUARD_GLOBAL];
    });
    const patched = (): ReturnType<typeof loadChunk> => {
      const r = applyServerGuardPatch(CHUNK);
      if (!r.ok) throw new Error(r.detail);
      return loadChunk(r.code);
    };

    it("runs unchanged without the global", async () => {
      await expect(patched()(message())).resolves.toMatchObject({ command: { commandId: "c1" } });
    });

    it("dispatches what the guard resolves", async () => {
      (globalThis as Record<string, unknown>)[SERVER_GUARD_GLOBAL] = createServerGuard({
        request: async () => ({ action: "modify", provider: "codex", model: "gpt-6.1-sol" }),
        log: () => undefined,
      });
      const out = await patched()(message({ modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" } }));
      expect(out.command.modelSelection).toEqual({ instanceId: "codex", model: "gpt-6.1-sol" });
    });

    it("fails with OrchestratorDispatchError carrying the block reason", async () => {
      (globalThis as Record<string, unknown>)[SERVER_GUARD_GLOBAL] = createServerGuard({ request: async () => ({ action: "block", reason: "Out of quota" }), log: () => undefined });
      await expect(patched()(message())).rejects.toMatchObject({ _tag: "OrchestratorDispatchError", commandId: "c1", commandType: "message.dispatch", cause: "Out of quota" });
    });

    it("never asks for other commands", async () => {
      const request = vi.fn(async (): Promise<AttributedDecision> => ({ action: "block", reason: "no" }));
      (globalThis as Record<string, unknown>)[SERVER_GUARD_GLOBAL] = createServerGuard({ request, log: () => undefined });
      await expect(patched()({ type: "thread.archive", commandId: "c2", threadId: "t1" })).resolves.toBeTruthy();
      expect(request).not.toHaveBeenCalled();
    });
  });
});

describe("server guard", () => {
  it("fails open on errors, garbage and timeouts", async () => {
    const reject = createServerGuard({ request: () => Promise.reject(new Error("pipe down")), log: () => undefined });
    await expect(reject.check(message())).resolves.toEqual(message());
    const garbage = createServerGuard({ request: async () => ({ action: "explode" }) as unknown as AttributedDecision, log: () => undefined });
    await expect(garbage.check(message())).resolves.toEqual(message());
    const hang = createServerGuard({ request: () => new Promise(() => undefined), log: () => undefined, maxWaitMs: 20 });
    await expect(hang.check(message())).resolves.toEqual(message());
  });

  it("rejects with TurnBlockedError on block", async () => {
    const g = createServerGuard({ request: async () => ({ action: "block", reason: "nope", plugin: "x" }), log: () => undefined });
    await expect(g.check(message())).rejects.toBeInstanceOf(TurnBlockedError);
  });

  it("keeps the order of one thread's commands", async () => {
    const releases: Array<() => void> = [];
    const seen: string[] = [];
    const g = createServerGuard({
      request: (ctx) =>
        new Promise((resolve) => {
          seen.push(ctx.textPreview);
          releases.push(() => resolve({ action: "allow" }));
        }),
      log: () => undefined,
    });
    const done: string[] = [];
    const a = g.check(message({ text: "a" })).then(() => done.push("a"));
    const b = g.check(message({ text: "b" })).then(() => done.push("b"));
    const other = g.check(message({ text: "o", threadId: "t2" })).then(() => done.push("o"));
    await new Promise((r) => setTimeout(r, 5));
    // "b" waits for "a"; the other thread is asked at once.
    expect(seen).toEqual(["a", "o"]);
    releases[1]!();
    await other;
    releases[0]!();
    await a;
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual(["a", "o", "b"]);
    releases[2]!();
    await b;
    expect(done).toEqual(["o", "a", "b"]);
  });
});

describe("broker", () => {
  const ctx = ctxOf(message({ modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" } }));

  it("allows when nobody listens and no window takes the event", async () => {
    const emit = vi.fn(() => false);
    const b = createGuardBroker({ emit, log: quiet });
    await expect(b.decide(ctx)).resolves.toEqual({ action: "allow" });
    expect(emit).not.toHaveBeenCalled();
    b.registerRenderer("p");
    await expect(b.decide(ctx)).resolves.toEqual({ action: "allow" });
    expect(emit).toHaveBeenCalledOnce();
  });

  it("runs main handlers first; a block skips the renderer", async () => {
    const emit = vi.fn(() => true);
    const b = createGuardBroker({ emit, log: quiet });
    b.registerRenderer("r");
    b.addMainHandler("m", () => ({ action: "block", reason: "main says no" }));
    await expect(b.decide(ctx)).resolves.toEqual({ action: "block", reason: "main says no", plugin: "m" });
    expect(emit).not.toHaveBeenCalled();
  });

  it("round-trips to the renderer with the main-modified context", async () => {
    let event: GuardRequestEvent | null = null;
    const b = createGuardBroker({
      emit: (e) => {
        event = e;
        return true;
      },
      log: quiet,
    });
    b.addMainHandler("m", () => ({ action: "modify", model: "claude-sonnet-5-5" }));
    b.registerRenderer("r");
    const pending = b.decide(ctx);
    await new Promise((r) => setTimeout(r, 0));
    expect(event!.ctx.model).toBe("claude-sonnet-5-5");
    // Renderer allows: the main modify stands.
    expect(b.answer(event!.id, { action: "allow" })).toBe(true);
    await expect(pending).resolves.toEqual({ action: "modify", provider: "claudeAgent", model: "claude-sonnet-5-5", plugin: "m" });
    expect(b.answer(event!.id, { action: "allow" })).toBe(false);
  });

  it("times out to allow and allows pending requests when the renderer reloads", async () => {
    const b = createGuardBroker({ emit: () => true, log: quiet, slackMs: 0 });
    b.registerRenderer("r", 1000);
    vi.useFakeTimers();
    try {
      const timed = b.decide(ctx);
      await vi.advanceTimersByTimeAsync(1001);
      await expect(timed).resolves.toEqual({ action: "allow" });
    } finally {
      vi.useRealTimers();
    }
    const reloading = b.decide(ctx);
    await new Promise((r) => setTimeout(r, 0));
    b.unregisterRenderer();
    await expect(reloading).resolves.toEqual({ action: "allow" });
    expect(b.status()).toEqual({ main: [], renderer: [], pending: 0 });
  });
});

describe("spawn wrap", () => {
  const exe = "C:\\T3\\T3 Code.exe";
  const backendArgs = ["--require", "C:\\T3\\resources\\app.asar\\compileCache.cjs", "C:\\T3\\resources\\server.asar\\apps\\server\\dist\\bin.mjs", "--bootstrap-fd", "3"];
  const injection = { hookPath: join(tmpdir(), "server-hook.mjs"), pipe: "\\\\.\\pipe\\t3p-guard-1-x", token: "tok" };

  it("recognises only the local backend spawn", () => {
    expect(isBackendSpawn(exe, backendArgs, exe)).toBe(true);
    expect(isBackendSpawn("wsl.exe", ["--exec", "node", "/x/apps/server/dist/bin.mjs", "--bootstrap-fd", "0"], exe)).toBe(false);
    expect(isBackendSpawn(exe, ["--type=gpu-process"], exe)).toBe(false);
    expect(isBackendSpawn(exe, [backendArgs[2]!], exe)).toBe(false);
  });

  it("preloads the hook and sets the pipe env", () => {
    const out = injectGuard(backendArgs, { env: { ELECTRON_RUN_AS_NODE: "1" }, cwd: "C:\\x" }, injection);
    expect(out.args[0]).toBe(`--import=${pathToFileURL(injection.hookPath).href}`);
    expect(out.args.slice(1)).toEqual(backendArgs);
    expect(out.options).toMatchObject({ cwd: "C:\\x", env: { ELECTRON_RUN_AS_NODE: "1", [GUARD_PIPE_ENV]: injection.pipe, [GUARD_TOKEN_ENV]: "tok" } });
  });

  it("wraps spawn on the module object and passes everything else through", () => {
    const calls: unknown[][] = [];
    const cp = { spawn: ((...args: unknown[]) => calls.push(args)) as unknown as typeof import("node:child_process").spawn };
    const original = cp.spawn;
    let on = true;
    const uninstall = installSpawnWrap(cp, () => (on ? injection : null));
    (cp.spawn as unknown as (...a: unknown[]) => void)(process.execPath, ["x.js"], { env: {} });
    (cp.spawn as unknown as (...a: unknown[]) => void)(process.execPath, [...backendArgs.slice(2)], { env: {} });
    on = false;
    (cp.spawn as unknown as (...a: unknown[]) => void)(process.execPath, [...backendArgs.slice(2)], { env: {} });
    expect(calls[0]).toEqual([process.execPath, ["x.js"], { env: {} }]);
    expect((calls[1]![1] as string[])[0]).toMatch(/^--import=file:/);
    expect(calls[2]).toEqual([process.execPath, backendArgs.slice(2), { env: {} }]);
    uninstall();
    expect(cp.spawn).toBe(original);
  });
});

describe("pipe", () => {
  it("carries requests and drops a client with a bad token", async () => {
    const endpoint = newGuardEndpoint();
    const server = await startGuardPipeServer({
      ...endpoint,
      decide: async (ctx) => (ctx.textPreview === "block me" ? { action: "block", reason: "blocked" } : { action: "allow" }),
      log: quiet,
    });
    try {
      const client = createGuardPipeClient(endpoint);
      await expect(client.request(ctxOf(message()))).resolves.toEqual({ action: "allow" });
      await expect(client.request(ctxOf(message({ text: "block me" })))).resolves.toEqual({ action: "block", reason: "blocked" });
      client.close();
      const bad = createGuardPipeClient({ path: endpoint.path, token: "wrong" });
      await expect(bad.request(ctxOf(message()))).rejects.toThrow();
      bad.close();
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe("server hook", () => {
  it("only patches server chunks", () => {
    const seen: string[] = [];
    const chunk = pathToFileURL(join(tmpdir(), "apps", "server", "dist", "runtimeLayer-abc.mjs")).href;
    const other = pathToFileURL(join(tmpdir(), "apps", "server", "dist", "other.mjs")).href;
    expect(patchLoaded(other, { format: "module", source: CHUNK }, (f) => seen.push(f)).source).toBe(CHUNK);
    const out = patchLoaded(chunk, { format: "module", source: Buffer.from(CHUNK) }, (f, ok) => seen.push(`${ok}`));
    expect(String(out.source)).toContain("/*t3p:server-guard*/");
    expect(seen).toEqual(["true"]);
    expect(isServerEntry(["node", "C:\\x\\server.asar\\apps\\server\\dist\\bin.mjs", "--bootstrap-fd", "3"])).toBe(true);
    expect(isServerEntry(["node", "worker.mjs"])).toBe(false);
  });

  // End to end in a real Node process: --import the built hook, load a fake server tree, dispatch.
  const hook = join(__dirname, "..", "dist", "server-hook.mjs");
  it.skipIf(!existsSync(hook))("patches a real module load and asks main over the pipe", async () => {
    const root = mkdtempSync(join(tmpdir(), "t3p-guard-"));
    try {
      const dist = join(root, "apps", "server", "dist");
      mkdirSync(dist, { recursive: true });
      writeFileSync(join(dist, "effect.mjs"), EFFECT_MODULE);
      writeFileSync(join(dist, "runtimeLayer-Test1234.mjs"), CHUNK);
      writeFileSync(
        join(dist, "bin.mjs"),
        `import { dispatchWithReceipt } from "./runtimeLayer-Test1234.mjs";
const out = { envLeft: process.env.${GUARD_PIPE_ENV} ?? null, results: [] };
for (const text of ["switch me", "block me"]) {
  try {
    const r = await dispatchWithReceipt({ type: "message.dispatch", commandId: text, threadId: "t1", text, modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" } });
    out.results.push({ ok: r.command.modelSelection });
  } catch (e) { out.results.push({ error: e._tag, cause: e.cause }); }
}
process.stdout.write(JSON.stringify(out));
`,
      );
      const endpoint = newGuardEndpoint();
      const asked: TurnStartContext[] = [];
      const server = await startGuardPipeServer({
        ...endpoint,
        decide: async (ctx) => {
          asked.push(ctx);
          return ctx.textPreview === "block me" ? { action: "block", reason: "Quota low" } : { action: "modify", provider: "codex", model: "gpt-6.1-sol" };
        },
        log: quiet,
      });
      try {
        const child = spawn(process.execPath, [`--import=${pathToFileURL(hook).href}`, join(dist, "bin.mjs"), "--bootstrap-fd", "3"], {
          env: { ...process.env, [GUARD_PIPE_ENV]: endpoint.path, [GUARD_TOKEN_ENV]: endpoint.token },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += String(d)));
        child.stderr.on("data", (d) => (stderr += String(d)));
        const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
        expect(code, stderr).toBe(0);
        expect(stderr).toContain("turn guard patched");
        expect(JSON.parse(stdout)).toEqual({
          envLeft: null,
          results: [{ ok: { instanceId: "codex", model: "gpt-6.1-sol" } }, { error: "OrchestratorDispatchError", cause: "Quota low" }],
        });
        expect(asked.map((c) => c.textPreview)).toEqual(["switch me", "block me"]);
      } finally {
        await new Promise((r) => server.close(r));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});

// Against real server chunks: T3P_SERVER_DIST=<extracted server.asar>/apps/server/dist (one or more, `;`-separated; any folder holding the runtimeLayer-*.mjs chunks).
const serverDists = (process.env.T3P_SERVER_DIST ?? "").split(";").filter((d) => d && existsSync(d));
describe.skipIf(serverDists.length === 0)("server patch against the real server bundle", () => {
  for (const dist of serverDists) {
    it(`patches exactly one chunk in ${dist}`, () => {
      const hits = readdirSync(dist)
        .filter((f) => /^runtimeLayer-[\w-]+\.mjs$/.test(f))
        .map((f) => ({ f, r: applyServerGuardPatch(readFileSync(join(dist, f), "utf8")) }));
      const ok = hits.filter((h) => h.r.ok);
      expect(ok.map((h) => h.f)).toHaveLength(1);
      expect(ok[0]!.r.ok && ok[0]!.r.detail).toMatch(/^dispatchWithReceipt\(command\) via fnUntraced, tryPromise, OrchestratorDispatchError$/);
    });
  }
});
