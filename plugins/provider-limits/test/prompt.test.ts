import type { ProviderSnapshot, T3Disposable, ToastOptions, TurnStartContext, TurnStartDecision } from "@t3p/api";
import { describe, expect, it } from "vitest";

import { ANIMATION_MS, BannerAnimator, showBanner } from "../src/banner.js";
import { ChoiceMemory, evaluateTurn, type GuardEvaluation } from "../src/guard.js";
import { ComposerHosts, createPrompter, type GuardPresentation, parsePresentation } from "../src/prompt.js";
import { asHost, FakeClock, FakeEl } from "./fakeDom.js";
import { makeProvider, NOW } from "./fixtures.js";

type Ask = Extract<GuardEvaluation, { kind: "ask" }>;

function ctx(overrides: Partial<TurnStartContext> = {}): TurnStartContext {
  return {
    requestId: "g1",
    commandType: "message.dispatch",
    kind: "message",
    threadId: "t1",
    parentThreadId: null,
    provider: "claudeAgent",
    model: "claude-opus-5-5",
    modelSource: "command",
    isSubagent: false,
    source: "web",
    createdBy: "user",
    continuation: null,
    textPreview: null,
    at: NOW,
    ...overrides,
  };
}

function prov(instanceId: string, used: number, slug: string): ProviderSnapshot {
  return makeProvider({
    instanceId,
    models: [{ slug, name: slug, isCustom: false, capabilities: null }],
    usageLimits: { checkedAt: "2026-11-18T21:25:04.493Z", windows: [{ id: "w", kind: "session", label: "Session", windowDurationMins: 300, usedPercent: used, resetsAt: "2026-11-18T23:30:00.000Z" }] },
  } as Partial<ProviderSnapshot> & { instanceId: string });
}

const providers = [prov("claudeAgent", 96, "claude-opus-5-5"), prov("codex", 38, "gpt-6.1-sol")];
const favorites = [{ provider: "codex", model: "gpt-6.1-sol" }];
const settings = { thresholdPercent: 5, fallback: "", useFavorites: true };

function setup(presentation: GuardPresentation = "toast") {
  const clock = new FakeClock();
  const memory = new ChoiceMemory();
  const hosts = new ComposerHosts();
  const toasts: Array<{ options: ToastOptions; disposed: boolean }> = [];
  const mode = { value: presentation };
  const prompter = createPrompter({
    toast: (options): T3Disposable => {
      const rec = { options, disposed: false };
      toasts.push(rec);
      return { dispose: () => void (rec.disposed = true) };
    },
    presentation: () => mode.value,
    hosts,
    memory,
    now: () => NOW + clock.now,
    setTimer: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimer: (h) => clock.clearTimeout(h),
    timeoutMs: 118_000,
    bannerClock: clock,
    bannerReducedMotion: () => false,
  });
  const ask = (c: TurnStartContext = ctx()): { evaluation: Ask; result: Promise<TurnStartDecision> } => {
    const evaluation = evaluateTurn(c, providers, settings, memory, NOW + clock.now, favorites) as Ask;
    expect(evaluation.kind).toBe("ask");
    return { evaluation, result: prompter.ask(c, evaluation) };
  };
  return { clock, memory, hosts, toasts, mode, prompter, ask };
}

describe("toast flow", () => {
  it("shows a persistent toast with title, message and three actions, Switch primary", async () => {
    const s = setup();
    const { result } = s.ask();
    expect(s.toasts).toHaveLength(1);
    const o = s.toasts[0]!.options;
    expect(o.durationMs).toBe(0);
    expect(o.title).toBe("claudeAgent is almost out (4% left)");
    expect(o.message).toContain("Resets in 2h.");
    expect(o.message).toContain("Switch to codex gpt-6.1-sol (next favorite with 62% left).");
    expect(o.actions?.map((a) => [a.label, a.primary])).toEqual([["Switch to codex gpt-6.1-sol", true], ["Keep going", false], ["Cancel", false]]);
    o.actions![0]!.onClick();
    expect(await result).toEqual({ action: "modify", provider: "codex", model: "gpt-6.1-sol" });
    expect(s.clock.pending).toBe(0);
  });

  it("Keep going allows and is remembered; Cancel blocks", async () => {
    const s = setup();
    const a = s.ask();
    s.toasts[0]!.options.actions![1]!.onClick();
    expect(await a.result).toEqual({ action: "allow" });
    expect(s.memory.get("t1", NOW)).toBe("keep");
    const s2 = setup();
    const b = s2.ask();
    s2.toasts[0]!.options.actions![2]!.onClick();
    expect(await b.result).toMatchObject({ action: "block" });
    expect(s2.memory.get("t1", NOW)).toBeNull();
  });

  it("closing the toast (onDismiss) means Keep going", async () => {
    const s = setup();
    const { result } = s.ask();
    s.toasts[0]!.options.onDismiss!();
    expect(await result).toEqual({ action: "allow" });
    expect(s.memory.get("t1", NOW)).toBe("keep");
  });

  it("the handler timeout allows, removes the toast and remembers nothing", async () => {
    const s = setup();
    const { result } = s.ask();
    s.clock.advance(117_999);
    expect(s.toasts[0]!.disposed).toBe(false);
    s.clock.advance(1);
    expect(await result).toEqual({ action: "allow" });
    expect(s.toasts[0]!.disposed).toBe(true);
    expect(s.memory.get("t1", NOW + 118_000)).toBeNull();
  });

  it("a second send while pending reuses the toast and the answer", async () => {
    const s = setup();
    const a = s.ask();
    const b = s.ask();
    expect(s.toasts).toHaveLength(1);
    expect(b.result).toBe(a.result);
    s.toasts[0]!.options.actions![1]!.onClick();
    expect(await b.result).toEqual({ action: "allow" });
    // another thread gets its own toast
    s.ask(ctx({ threadId: "t2", requestId: "g2" }));
    expect(s.toasts).toHaveLength(2);
  });

  it("a late answer after the timeout changes nothing", async () => {
    const s = setup();
    const { result } = s.ask();
    s.clock.advance(118_000);
    s.toasts[0]!.options.actions![2]!.onClick();
    expect(await result).toEqual({ action: "allow" });
  });

  it("dispose resolves open prompts as allow", async () => {
    const s = setup();
    const { result } = s.ask();
    s.prompter.dispose();
    expect(await result).toEqual({ action: "allow" });
    expect(s.toasts[0]!.disposed).toBe(true);
  });
});

describe("composer banner flow", () => {
  it("renders the banner in the thread's composer host and answers by button", async () => {
    const s = setup("composer");
    const host = new FakeEl();
    s.hosts.add(asHost(host), "t1");
    const { result } = s.ask();
    expect(s.toasts).toHaveLength(0);
    const banner = host.children[0]!;
    expect(banner.className).toContain("t3p-banner");
    expect(banner.phase).toBe("entering");
    const buttons = banner.buttons();
    expect(buttons.map((b) => b.textContent)).toEqual(["Switch to codex gpt-6.1-sol", "Keep going", "Cancel"]);
    expect(buttons[0]!.getAttribute("data-primary")).toBe("");
    buttons[0]!.click();
    expect(await result).toEqual({ action: "modify", provider: "codex", model: "gpt-6.1-sol" });
    expect(banner.phase).toBe("leaving");
    s.clock.advance(ANIMATION_MS);
    expect(banner.phase).toBe("removed");
    expect(host.children).toHaveLength(0);
  });

  it("falls back to the toast when no composer banner is mounted", () => {
    const s = setup("composer");
    s.ask();
    expect(s.toasts).toHaveLength(1);
  });

  it("uses the only mounted host when its thread is unknown, but not another thread's host", () => {
    const s = setup("composer");
    const host = new FakeEl();
    const off = s.hosts.add(asHost(host), "other");
    s.ask(); // single host: used
    expect(host.children).toHaveLength(1);
    off();
    s.hosts.add(asHost(new FakeEl()), "a");
    s.hosts.add(asHost(new FakeEl()), "b");
    s.ask(ctx({ threadId: "t9", requestId: "g9" }));
    expect(s.toasts).toHaveLength(1);
  });

  it("the composer unmounting counts as Keep going", async () => {
    const s = setup("composer");
    const host = new FakeEl();
    const off = s.hosts.add(asHost(host), "t1");
    const { result } = s.ask();
    off();
    expect(await result).toEqual({ action: "allow" });
    expect(host.children).toHaveLength(0);
  });

  it("the timeout removes the banner with the exit animation", async () => {
    const s = setup("composer");
    const host = new FakeEl();
    s.hosts.add(asHost(host), "t1");
    const { result } = s.ask();
    s.clock.advance(118_000);
    expect(await result).toEqual({ action: "allow" });
    expect(host.children[0]!.phase).toBe("leaving");
    s.clock.advance(ANIMATION_MS);
    expect(host.children).toHaveLength(0);
  });

  it("a second send while pending reuses the banner", () => {
    const s = setup("composer");
    const host = new FakeEl();
    s.hosts.add(asHost(host), "t1");
    s.ask();
    s.ask();
    expect(host.children).toHaveLength(1);
  });
});

describe("banner animation state machine", () => {
  const make = (reduced = false) => {
    const clock = new FakeClock();
    const host = new FakeEl();
    const handle = showBanner(asHost(host), { title: "t", message: "m", labels: ["a"], primary: 0 }, () => undefined, clock, () => reduced);
    return { clock, host, handle, el: host.children[0]!, a: handle.animator };
  };

  it("mounted -> entering -> visible -> leaving -> removed", () => {
    const { clock, host, handle, el, a } = make();
    expect(a.phase).toBe("entering");
    expect(el.phase).toBe("entering");
    clock.advance(ANIMATION_MS - 1);
    expect(a.phase).toBe("entering");
    clock.advance(1);
    expect(a.phase).toBe("visible");
    handle.close();
    expect(a.phase).toBe("leaving");
    expect(host.children).toHaveLength(1);
    clock.advance(ANIMATION_MS);
    expect(a.phase).toBe("removed");
    expect(el.phase).toBe("removed");
    expect(host.children).toHaveLength(0);
  });

  it("leaving while entering cancels the enter timer and still animates out", () => {
    const { clock, handle, a } = make();
    clock.advance(50);
    handle.close();
    expect(a.phase).toBe("leaving");
    clock.advance(ANIMATION_MS);
    expect(a.phase).toBe("removed");
    expect(clock.pending).toBe(0);
  });

  it("is idempotent and runs done callbacks once", () => {
    const { clock, handle, a } = make();
    let n = 0;
    a.leave(() => n++);
    a.leave(() => n++);
    handle.close();
    clock.advance(ANIMATION_MS);
    a.leave(() => n++);
    expect(n).toBe(3);
    expect(a.phase).toBe("removed");
  });

  it("honors reduced motion: visible at once, removed at once", () => {
    const { clock, host, handle, a } = make(true);
    expect(a.phase).toBe("visible");
    handle.close();
    expect(a.phase).toBe("removed");
    expect(host.children).toHaveLength(0);
    expect(clock.pending).toBe(0);
  });

  it("destroy skips the exit animation", () => {
    const { host, a } = make();
    a.destroy();
    expect(a.phase).toBe("removed");
    expect(host.children).toHaveLength(0);
  });

  it("animator on a bare element starts in mounted", () => {
    const el = new FakeEl();
    const a = new BannerAnimator(asHost(el), new FakeClock(), () => false);
    expect(a.phase).toBe("mounted");
    a.leave();
    expect(a.phase).toBe("removed");
  });
});

describe("parsePresentation", () => {
  it("defaults to toast", () => {
    expect(parsePresentation("composer")).toBe("composer");
    expect(parsePresentation("toast")).toBe("toast");
    expect(parsePresentation(undefined)).toBe("toast");
    expect(parsePresentation("both")).toBe("toast");
  });
});
