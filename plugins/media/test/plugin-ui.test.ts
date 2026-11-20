// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

import plugin from "../src/index.js";

/** The two SVG paths the now-playing button switches between. */
const PAUSE_PATH = "M6 5h4v14H6zm8 0h4v14h-4z";
const PLAY_PATH = "M8 5v14l11-7z";

function poll(status: "Playing" | "Paused"): object {
  return {
    state: "ok",
    media: { title: "Song", artist: "Artist", album: "", status, posSec: 1, durSec: 100, updated: 0, canPrev: true, canNext: true, canToggle: true, thumb: null, key: "Song|Artist|" },
  };
}

interface Registered {
  slot: string;
  render(host: HTMLElement): () => void;
}

/** Enough of T3Api for `start()`: one settings value, one poll answer, and the two slots we look at. */
function fakeT3(answer: () => object, chip: boolean) {
  const slots = new Map<string, Registered>();
  const t3 = {
    settings: {
      define: () => ({ dispose: () => undefined }),
      get: () => chip,
      onChange: () => () => undefined,
    },
    native: { invoke: async () => answer() },
    ui: {
      register: (opts: Registered) => {
        slots.set(opts.slot, opts);
        return { dispose: () => undefined };
      },
      modal: async () => 1,
      toast: () => undefined,
    },
    commands: { register: () => ({ dispose: () => undefined }) },
    storage: { get: async () => null, set: async () => undefined },
    log: () => undefined,
  };
  return { t3, slots };
}

let stop: (() => void) | null = null;
afterEach(() => {
  vi.useRealTimers();
  stop?.();
  stop = null;
  document.body.innerHTML = "";
});

it("redraws the now-playing button when the status changes: pause glyph while playing, play glyph while paused", async () => {
  vi.useFakeTimers();
  let status: "Playing" | "Paused" = "Playing";
  const { t3, slots } = fakeT3(() => poll(status), false);
  stop = (plugin as unknown as { start(t3: unknown): () => void }).start(t3);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const dispose = slots.get("threadDetails")!.render(host);

  const toggle = (): HTMLButtonElement => host.querySelector<HTMLButtonElement>(".md-ctl button:nth-child(2)")!;
  const path = (): string | null => toggle().querySelector("path")!.getAttribute("d");

  await vi.advanceTimersByTimeAsync(1100);
  expect(toggle().title).toBe("Pause");
  expect(path()).toBe(PAUSE_PATH);

  status = "Paused";
  await vi.advanceTimersByTimeAsync(1100);
  expect(toggle().title).toBe("Play");
  expect(path()).toBe(PLAY_PATH);

  status = "Playing";
  await vi.advanceTimersByTimeAsync(1100);
  expect(path()).toBe(PAUSE_PATH);

  dispose();
});

it("status bar chip shows the action the click takes, like the popover button", async () => {
  vi.useFakeTimers();
  let status: "Playing" | "Paused" = "Playing";
  const { t3, slots } = fakeT3(() => poll(status), true);
  stop = (plugin as unknown as { start(t3: unknown): () => void }).start(t3);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const dispose = slots.get("statusBar")!.render(host);

  const chip = (): HTMLElement => host.querySelector<HTMLElement>(".t3p-chip")!;
  await vi.advanceTimersByTimeAsync(5100);
  expect(chip().textContent).toBe("❚❚ Song");
  expect(chip().title).toContain("click to pause");

  status = "Paused";
  await vi.advanceTimersByTimeAsync(5100);
  expect(chip().textContent).toBe("▶ Song");
  expect(chip().title).toContain("click to play");

  dispose();
});
