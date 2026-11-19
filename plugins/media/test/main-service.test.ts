import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

interface Result {
  state: string;
  retryInMs?: number;
  media?: { thumb: string | null; status: string; id?: unknown };
}
const require = createRequire(import.meta.url);
const { createSmtcService, IDLE_MS, BACKOFF_START_MS } = require("../main-service.cjs") as {
  createSmtcService(deps: Record<string, unknown>): { poll(): Promise<Result>; command(n: string): Promise<Result>; stop(): void; _state(): { running: boolean; backoffMs: number; pending: number } };
  IDLE_MS: number;
  BACKOFF_START_MS: number;
};

/** A manual clock with timers and a fake helper that answers lines the test feeds back. */
function harness(opts: { failSpawn?: boolean } = {}) {
  let t = 1_000_000;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextTimer = 1;
  const spawns: Array<{ onLine(l: string): void; onExit(i: { code: number | null; signal: null; stderr: string }): void; written: string[]; killed: boolean }> = [];
  const service = createSmtcService({
    exe: "powershell.exe",
    script: "smtc.ps1",
    now: () => t,
    setTimer: (fn: () => void, ms: number) => {
      const id = nextTimer++;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimer: (id: number) => timers.delete(id),
    spawnSession: (req: { onLine(l: string): void; onExit(i: never): void }) => {
      if (opts.failSpawn) throw new Error("denied");
      const rec = { onLine: req.onLine, onExit: req.onExit as never, written: [] as string[], killed: false };
      spawns.push(rec);
      return {
        write: (s: string) => (rec.written.push(s), true),
        kill: () => {
          rec.killed = true;
        },
      };
    },
  });
  const advance = (ms: number): void => {
    t += ms;
    for (const [id, tm] of [...timers]) {
      if (tm.at <= t) {
        timers.delete(id);
        tm.fn();
      }
    }
  };
  const answer = (i: number, body: object): void => {
    const rec = spawns[spawns.length - 1]!;
    const id = Number(rec.written[i]!.split(" ")[0]);
    rec.onLine(JSON.stringify({ id, ok: true, ...body }));
  };
  return { service, spawns, advance, answer, now: () => t };
}

const track = { session: true, key: "k", title: "T", artist: "A", album: "", status: "Playing", posSec: 1, durSec: 10, updated: 5, canPrev: true, canNext: true, canToggle: true };

describe("smtc service", () => {
  it("starts nothing until asked, then polls through one shared process", async () => {
    const h = harness();
    expect(h.spawns).toHaveLength(0);
    const p = h.service.poll();
    expect(h.spawns).toHaveLength(1);
    h.answer(0, { ...track, thumb: "data:image/jpeg;base64,AAAA" });
    const r = await p;
    expect(r.state).toBe("ok");
    expect(r.media!.thumb).toBe("data:image/jpeg;base64,AAAA");
    expect(r.media!.id).toBeUndefined();
    // second poll after the gap reuses the process and keeps the thumbnail while the key is unchanged
    h.advance(1000);
    const p2 = h.service.poll();
    h.answer(1, track);
    expect((await p2).media!.thumb).toBe("data:image/jpeg;base64,AAAA");
    expect(h.spawns).toHaveLength(1);
  });

  it("coalesces concurrent polls and caches rapid ones", async () => {
    const h = harness();
    const a = h.service.poll();
    const b = h.service.poll();
    expect(h.spawns[0]!.written).toHaveLength(1);
    h.answer(0, track);
    await Promise.all([a, b]);
    await h.service.poll(); // within the gap: cached, nothing written
    expect(h.spawns[0]!.written).toHaveLength(1);
  });

  it("reports idle when there is no session", async () => {
    const h = harness();
    const p = h.service.poll();
    h.answer(0, { session: false });
    expect(await p).toEqual({ state: "idle" });
  });

  it("stops the process after the idle period and restarts on demand", async () => {
    const h = harness();
    const p = h.service.poll();
    h.answer(0, track);
    await p;
    h.advance(IDLE_MS + 10);
    expect(h.spawns[0]!.killed).toBe(true);
    expect(h.service._state().running).toBe(false);
    h.advance(2000);
    void h.service.poll();
    expect(h.spawns).toHaveLength(2);
  });

  it("backs off when the helper cannot start, doubling up to the cap", async () => {
    const h = harness({ failSpawn: true });
    const first = await h.service.poll();
    expect(first).toMatchObject({ state: "unavailable" });
    expect(h.service._state().backoffMs).toBe(BACKOFF_START_MS);
    // inside the backoff window nothing is attempted
    expect((await h.service.poll()).retryInMs!).toBeGreaterThan(0);
    h.advance(BACKOFF_START_MS + 1);
    await h.service.poll();
    expect(h.service._state().backoffMs).toBe(BACKOFF_START_MS * 2);
  });

  it("backs off when the helper says SMTC is unavailable or exits early", async () => {
    const h = harness();
    const p = h.service.poll();
    h.spawns[0]!.onLine(JSON.stringify({ id: 0, ok: false, unavailable: true, error: "x" }));
    h.spawns[0]!.onExit({ code: 2, signal: null, stderr: "" });
    expect((await p).state).toBe("unavailable");
    expect(h.service._state().backoffMs).toBeGreaterThan(0);
  });

  it("times out a silent helper, kills it and backs off", async () => {
    const h = harness();
    const p = h.service.poll();
    h.advance(9000);
    expect((await p).state).toBe("unavailable");
    expect(h.spawns[0]!.killed).toBe(true);
  });

  it("runs transport commands then returns fresh state; rejects unknown commands", async () => {
    const h = harness();
    const c = h.service.command("toggle");
    h.answer(0, { done: true });
    await Promise.resolve();
    await Promise.resolve();
    h.answer(1, { ...track, status: "Paused" });
    expect((await c).media!.status).toBe("Paused");
    expect(h.spawns[0]!.written[0]).toMatch(/^1 toggle\n$/);
    await expect(h.service.command("rm -rf")).rejects.toThrow();
  });

  it("stop() kills the helper and fails pending requests", async () => {
    const h = harness();
    const p = h.service.poll();
    h.service.stop();
    expect((await p).state).toBe("unavailable");
    expect(h.spawns[0]!.killed).toBe(true);
  });
});
