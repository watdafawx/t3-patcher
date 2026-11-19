// @vitest-environment jsdom
import type { T3Api, UiSlotContext } from "@t3p/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildRow, type Rules, type Watch } from "../src/model.js";
import { mountDecorator, mountStatus, type Controller } from "../src/ui.js";

const rules: Rules = { leadMs: 8 * 60_000, maxPings: 20, minTtlMs: 0 };
const NOW = 1_800_000_000_000;

type Init = { watch?: Partial<Watch>; settled?: boolean; expiresIn?: number | null; title?: string };

function fake(initial: Record<string, Init>) {
  const data = new Map(Object.entries(initial));
  const calls: string[] = [];
  const redraws = new Set<() => void>();
  const ctrl: Controller = {
    redraws,
    rows: (now) =>
      [...data].map(([id, d]) =>
        buildRow(
          {
            threadId: id,
            watch: { pings: 0, until: null, lastPingAt: 0, ...d.watch },
            info: { title: d.title ?? `Thread ${id}`, projectName: "demo-app", providerInstanceId: "claudeAgent", model: "opus" },
            state: d.expiresIn === null ? null : { expiresAt: now + (d.expiresIn ?? 20 * 60_000), ttlMs: 3_600_000, source: "reported", lastRequestAt: null },
            settled: d.settled ?? false,
            note: "ping 2 sent",
          },
          now,
          rules,
        ),
      ),
    pause: (id) => {
      calls.push(`pause ${id}`);
      data.get(id)!.watch = { ...data.get(id)!.watch, paused: true };
    },
    resume: (id) => {
      calls.push(`resume ${id}`);
      data.get(id)!.watch = { ...data.get(id)!.watch, paused: false };
    },
    stop: (id) => {
      calls.push(`stop ${id}`);
      data.delete(id);
    },
    stopAll: () => {
      calls.push("stopAll");
      data.clear();
    },
  };
  const redraw = (): void => redraws.forEach((fn) => fn());
  const t3 = { threads: { open: (id: string) => calls.push(`open ${id}`) }, ui: { openSettings: () => calls.push("settings") } } as unknown as T3Api;
  return { ctrl, t3, calls, redraw, data };
}

const q = <T extends Element>(root: ParentNode, sel: string): T => root.querySelector(sel) as T;

describe("status chip and popover", () => {
  beforeEach(() => vi.useFakeTimers({ now: NOW }));
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("shows Warm N, a muted dash when none, and updates live", () => {
    const f = fake({ a: {}, b: { watch: { paused: true } }, c: { settled: true } });
    const host = document.body.appendChild(document.createElement("div"));
    const off = mountStatus(f.t3, host, f.ctrl);
    const chip = q<HTMLElement>(host, "[data-keep-warm=status]");
    expect(chip.textContent).toBe("Warm 1");
    f.data.delete("a");
    f.redraw();
    expect(chip.textContent).toBe("Warm —");
    off();
    expect(f.ctrl.redraws.size).toBe(0);
  });

  it("opens, lists sorted rows, and closes on Esc and outside click", () => {
    const f = fake({ late: { expiresIn: 40 * 60_000, title: "Late" }, soon: { expiresIn: 10 * 60_000, title: "Soon" }, done: { settled: true, title: "Done" } });
    const host = document.body.appendChild(document.createElement("div"));
    mountStatus(f.t3, host, f.ctrl);
    const chip = q<HTMLElement>(host, "[data-keep-warm=status]");
    const pop = q<HTMLElement>(host, "[role=dialog]");
    expect(pop.hidden).toBe(true);
    chip.click();
    expect(pop.hidden).toBe(false);
    const rows = [...pop.querySelectorAll<HTMLElement>(".kw-row")];
    expect(rows.map((r) => q(r, ".kw-title").textContent)).toEqual(["Soon", "Late", "Done"]);
    expect(rows[0]!.textContent).toContain("next ping in 2m");
    expect(rows[0]!.textContent).toContain("demo-app");
    expect(rows[0]!.textContent).toContain("claudeAgent / opus");
    expect(rows[0]!.textContent).toContain("0/20 pings");
    expect(rows[0]!.textContent).toContain("ping 2 sent");
    expect(rows[2]!.textContent).toContain("settled: paused");
    expect(rows[2]!.dataset.dim).toBe("true");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(pop.hidden).toBe(true);
    chip.click();
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(pop.hidden).toBe(true);
  });

  it("row actions: pause/resume, stop, open and settings link", () => {
    const f = fake({ a: { title: "Alpha" }, b: { title: "Beta", watch: { paused: true } } });
    const host = document.body.appendChild(document.createElement("div"));
    mountStatus(f.t3, host, f.ctrl);
    const chip = q<HTMLElement>(host, "[data-keep-warm=status]");
    chip.click();
    const rowOf = (id: string) => q<HTMLElement>(host, `[data-thread=${id}]`);
    q<HTMLElement>(rowOf("a"), "[data-action=pause]").click();
    f.redraw();
    expect(rowOf("a").textContent).toContain("paused");
    expect(q(rowOf("a"), "[data-action=resume]")).not.toBeNull();
    q<HTMLElement>(rowOf("b"), "[data-action=resume]").click();
    q<HTMLElement>(rowOf("b"), "[data-action=stop]").click();
    f.redraw();
    expect(host.querySelector("[data-thread=b]")).toBeNull();
    q<HTMLElement>(rowOf("a"), ".kw-title").click();
    expect(f.calls).toEqual(["pause a", "resume b", "stop b", "open a"]);
    expect(q<HTMLElement>(host, "[role=dialog]").hidden).toBe(true);
    chip.click();
    q<HTMLElement>(host, "[data-action=settings]").click();
    expect(f.calls.at(-1)).toBe("settings");
  });

  it("Stop all clears every watch and shows the empty state", () => {
    const f = fake({ a: {}, b: {} });
    const host = document.body.appendChild(document.createElement("div"));
    mountStatus(f.t3, host, f.ctrl);
    q<HTMLElement>(host, "[data-keep-warm=status]").click();
    q<HTMLElement>(host, "[data-action=stop-all]").click();
    expect(f.calls).toEqual(["stopAll"]);
    f.redraw();
    expect(q(host, "[data-empty]").textContent).toContain("Keep warm");
    expect(q<HTMLButtonElement>(host, "[data-action=stop-all]").disabled).toBe(true);
  });

  it("ticks countdowns every second only while open", () => {
    const f = fake({ a: { expiresIn: 10 * 60_000 } });
    const host = document.body.appendChild(document.createElement("div"));
    mountStatus(f.t3, host, f.ctrl);
    const chip = q<HTMLElement>(host, "[data-keep-warm=status]");
    expect(vi.getTimerCount()).toBe(0);
    chip.click();
    expect(vi.getTimerCount()).toBe(1);
    expect(q(host, "[data-next]").textContent).toBe("next ping in 2m");
    vi.advanceTimersByTime(90_000);
    expect(q(host, "[data-next]").textContent).toBe("next ping in 30s");
    chip.click();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("sidebar decorator", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });
  const ctxFor = (threadId: string): UiSlotContext => ({ slot: "threadListDecorator", threadId, record: null, onThemeChange: () => () => {} });

  it("hides without a watch, shows the tooltip, dims when paused", () => {
    const f = fake({ a: { watch: { pings: 3 } } });
    const hostA = document.body.appendChild(document.createElement("div"));
    const hostB = document.body.appendChild(document.createElement("div"));
    mountDecorator(hostA, ctxFor("a"), f.ctrl);
    mountDecorator(hostB, ctxFor("zzz"), f.ctrl);
    const iconA = q<HTMLElement>(hostA, "[data-keep-warm=flame]");
    expect(iconA.hidden).toBe(false);
    expect(iconA.title).toMatch(/^Kept warm: next ping in \d+m · 3\/20 pings$/);
    expect(iconA.hasAttribute("data-dim")).toBe(false);
    expect(q<HTMLElement>(hostB, "[data-keep-warm=flame]").hidden).toBe(true);
    f.ctrl.pause("a");
    f.redraw();
    expect(iconA.hasAttribute("data-dim")).toBe(true);
    expect(iconA.title).toBe("Keep-warm paused · 3/20 pings");
    f.ctrl.stop("a");
    f.redraw();
    expect(iconA.hidden).toBe(true);
  });

  it("cleanup unregisters the redraw", () => {
    const f = fake({ a: {} });
    const host = document.body.appendChild(document.createElement("div"));
    const off = mountDecorator(host, ctxFor("a"), f.ctrl);
    expect(f.ctrl.redraws.size).toBe(1);
    off();
    expect(f.ctrl.redraws.size).toBe(0);
  });
});
