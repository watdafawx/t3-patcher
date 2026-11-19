/**
 * Integration test against the stock T3 Code on rig slot 2 (throwaway home). Runs only with T3P_RIG_E2E=1
 * (`pnpm --filter @t3p/rpc-client test:rig`). It launches slot 2, opens an ssh tunnel, takes the desktop
 * bearer over CDP (slot 2's own app, never FOX), and always tears everything down (client, tunnel, stop, reset).
 * T3P_RIG_SKIP_LAUNCH=1 reuses an already running slot 2 (it is still stopped and reset at the end).
 * No provider turn is started, so no provider login is needed.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RpcClient, watchThread, type ThreadEventItem, type ThreadSnapshotItem } from "../src/index.js";

const SLOT = 2;
const enabled = process.env.T3P_RIG_E2E === "1";
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const rigScript = (name: string, ...args: string[]) =>
  spawnSync("pwsh", ["-NoProfile", "-File", `tools/rig/${name}`, "-Slot", String(SLOT), ...args], { cwd: repoRoot, encoding: "utf8" });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms: number, what: string) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(50);
  }
};
const freePort = () =>
  new Promise<number>((res) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
  });

/** Run JS in slot 2's main window over CDP (same approach as docs/spikes/wp-0d/lib.mjs). */
async function cdpEval(cdpPort: number, expression: string): Promise<unknown> {
  const targets = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()) as Array<{ id: string; type: string; url: string }>;
  const t = targets.find((x) => x.type === "page" && x.url.startsWith("t3code://"));
  if (!t) throw new Error("no t3code:// page target");
  const ws = new WebSocket(`ws://127.0.0.1:${cdpPort}/devtools/page/${t.id}`);
  await new Promise((r) => (ws.onopen = r));
  const res = await new Promise<{ result?: { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string } } } }>((resolve) => {
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { id?: number };
      if (m.id === 1) resolve(m as never);
    };
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  ws.close();
  if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description);
  return res.result?.result?.value;
}

/** WebSocket subclass that remembers its instances so the test can kill one abruptly. */
const sockets: WebSocket[] = [];
class TrackedWebSocket extends WebSocket {
  constructor(url: string | URL) {
    super(url);
    sockets.push(this);
  }
}

describe.skipIf(!enabled)("rig slot 2 integration", () => {
  let tunnel: ChildProcess | undefined;
  let httpBase = "";
  let a: RpcClient;
  let b: RpcClient;
  let cdpPort = 0;

  const mk = () =>
    new RpcClient({
      httpBaseUrl: httpBase,
      getBearer: async () => String(await cdpEval(cdpPort, "window.desktopBridge.getLocalEnvironmentBearerToken()")),
      WebSocket: TrackedWebSocket as unknown as typeof WebSocket,
      reconnect: { initialMs: 500, maxMs: 2000 },
      clientInfo: { clientSurface: "t3p-test" },
    });

  beforeAll(async () => {
    if (process.env.T3P_RIG_SKIP_LAUNCH !== "1") {
      const r = rigScript("launch.ps1");
      process.stdout.write(`launch: ${r.stdout.trim().split("\n").at(-1) ?? ""}\n`);
      if (r.status !== 0) throw new Error(`launch failed: ${r.stderr || r.stdout}`);
    }
    const srv = await freePort();
    cdpPort = await freePort();
    tunnel = spawn(
      "ssh",
      ["-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-L", `127.0.0.1:${srv}:127.0.0.1:${3873 + SLOT - 1}`, "-L", `127.0.0.1:${cdpPort}:127.0.0.1:${9333 + SLOT - 1}`, "rig"],
      { stdio: "ignore", windowsHide: true },
    );
    httpBase = `http://127.0.0.1:${srv}`;
    for (let i = 0; i < 80; i++) {
      try {
        await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
        break;
      } catch {
        await sleep(250);
      }
    }
    a = mk();
    b = mk();
    await a.connect();
    await b.connect();
  }, 240_000);

  afterAll(async () => {
    a?.close();
    b?.close();
    try {
      tunnel?.kill();
    } catch {
      /* gone */
    }
    const s = rigScript("stop.ps1");
    const r = rigScript("reset.ps1");
    process.stdout.write(`teardown: stop=${s.status} reset=${r.status}\n`);
  }, 120_000);

  it("getConfig lists the providers; subscribeServerConfig streams a snapshot and refreshProviders produces an update", async () => {
    const cfg = await a.call("server.getConfig", {});
    const ids = cfg.providers.map((p) => p.instanceId);
    process.stdout.write(`providers: ${cfg.providers.map((p) => `${p.instanceId}[${p.status}/${p.auth.status}]`).join(" ")}\n`);
    expect(cfg.providers.length).toBeGreaterThan(0);
    expect(ids).toContain("claudeAgent");

    const types: string[] = [];
    const sub = a.subscribe("subscribeServerConfig", { environmentThemes: true, usageLimitSources: true, usageLimitsCommand: true }, (i) => types.push(i.type));
    await until(() => types.includes("snapshot"), 15_000, "config snapshot");
    await a.call("server.refreshProviders", { usageLimitsCommand: true });
    await until(() => types.includes("providerStatuses"), 30_000, "providerStatuses update");
    process.stdout.write(`serverConfig stream item types: ${types.join(",")}\n`);
    sub.cancel();
    await sub.done;
  }, 90_000);

  it("thread: snapshot, live rename, then an abrupt socket kill resubscribes with no gap and no duplicate", async () => {
    const project = await a.call("projects.ensureScratch", {});
    const threadId = randomUUID();
    const cmd = (c: Record<string, unknown>) => b.call("orchestration.dispatchCommand", { commandId: randomUUID(), threadId, ...c } as never);
    await a.call("orchestration.dispatchCommand", {
      type: "thread.create",
      commandId: randomUUID(),
      threadId,
      createdBy: "user",
      creationSource: "web",
      projectId: project.projectId,
      title: "wp1c rig test",
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    } as never);

    const snaps: ThreadSnapshotItem[] = [];
    const events: ThreadEventItem[] = [];
    const sub = watchThread(a, threadId, (s) => snaps.push(s), (e) => events.push(e), { onError: (e) => process.stdout.write(`watch error: ${e.message}\n`) });
    await until(() => snaps.length === 1, 15_000, "thread snapshot");
    process.stdout.write(`snapshot@${snaps[0]!.snapshotSequence} thread title=${JSON.stringify((snaps[0]!.projection as { thread: { title: string } }).thread.title)}\n`);

    // live rename seen as an event
    await cmd({ type: "thread.metadata.update", title: "renamed once" });
    await until(() => events.some((e) => e.event.type === "thread.metadata-updated"), 15_000, "rename event");
    const baseline = events.length;

    // 24 renames from client B every 60 ms; client A's socket is killed abruptly after ~6 of them arrived
    const N = 24;
    const titles = Array.from({ length: N }, (_, i) => `tick ${i}`);
    const writer = (async () => {
      for (const t of titles) {
        await cmd({ type: "thread.metadata.update", title: t });
        await sleep(60);
      }
    })();
    await until(() => events.length >= baseline + 6, 15_000, "first ticks");
    const stateLog: string[] = [];
    a.onState((s) => stateLog.push(s));
    const victim = sockets.filter((s) => s.readyState === WebSocket.OPEN).at(0); // a's socket was opened first
    expect(victim).toBeDefined();
    victim!.close(); // abrupt: no Interrupt frame from the client
    await writer;
    await until(() => events.filter((e) => e.event.type === "thread.metadata-updated").length >= N + 1, 30_000, "all ticks after resubscribe");
    sub.cancel();
    await sub.done;

    process.stdout.write(`client A state log after kill: ${stateLog.join(" -> ")}\n`);
    const seqs = events.map((e) => e.sequence);
    const uniq = new Set(seqs);
    process.stdout.write(`events: ${seqs.length} total, ${uniq.size} distinct, first ${seqs[0]} last ${seqs.at(-1)}, snapshots seen ${snaps.length}\n`);
    expect(stateLog).toContain("reconnecting");
    expect(stateLog.at(-1)).toBe("open");
    expect(snaps).toHaveLength(1); // resubscribe used afterSequence: no second snapshot
    expect(uniq.size).toBe(seqs.length); // no duplicates
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs); // in order
    // no gap: every tick title arrived exactly once, in order
    const seenTitles = events
      .filter((e) => e.event.type === "thread.metadata-updated")
      .map((e) => (e.event as unknown as { payload?: { title?: string } }).payload?.title)
      .filter((t): t is string => typeof t === "string" && t.startsWith("tick "));
    expect(seenTitles).toEqual(titles);
  }, 120_000);
});
