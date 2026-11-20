// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

import plugin from "../src/index.js";

/** The two SVG paths the now-playing button switches between. */
const PAUSE_PATH = "M6 5h4v14H6zm8 0h4v14h-4z";
const PLAY_PATH = "M8 5v14l11-7z";

function poll(status: "Playing" | "Paused", extra: Record<string, unknown> = {}): object {
  return {
    state: "ok",
    media: { title: "Song", artist: "Artist", album: "", status, posSec: 10, durSec: 100, updated: 0, canPrev: true, canNext: true, canToggle: true, canSeek: false, thumb: null, key: "Song|Artist|", ...extra },
  };
}

interface Registered {
  slot: string;
  render(host: HTMLElement): () => void;
}

/** Enough of T3Api for `start()`: one settings value, one poll answer, and the two slots we look at. */
function fakeT3(answer: (cmd: string, payload?: unknown) => object, chip: boolean) {
  const slots = new Map<string, Registered>();
  const calls: Array<[string, unknown]> = [];
  const t3 = {
    settings: {
      define: () => ({ dispose: () => undefined }),
      get: () => chip,
      onChange: () => () => undefined,
    },
    native: {
      invoke: async (cmd: string, payload?: unknown) => {
        calls.push([cmd, payload]);
        return answer(cmd, payload);
      },
    },
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
  return { t3, slots, calls };
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

it("status bar chip shows the action the click takes, like the popover button", async () => {  vi.useFakeTimers();
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

it("keeps a pasted YouTube link when the section is re-rendered, and keeps the caret", async () => {
  const { t3, slots } = fakeT3(() => poll("Playing"), false);
  stop = (plugin as unknown as { start(t3: unknown): () => void }).start(t3);
  const first = document.createElement("div");
  document.body.appendChild(first);
  const disposeFirst = slots.get("threadDetails")!.render(first);

  const paste = (input: HTMLInputElement, text: string): void => {
    input.focus();
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const url = "https://youtu.be/dQw4w9WgXcQ";
  paste(first.querySelector("input")!, url);

  // The slot engine drops and re-renders the section whenever the details card is re-created.
  disposeFirst();
  const second = document.createElement("div");
  document.body.appendChild(second);
  const disposeSecond = slots.get("threadDetails")!.render(second);
  await Promise.resolve();

  const again = second.querySelector("input")!;
  expect(again.value).toBe(url);
  expect(document.activeElement).toBe(again);
  expect(again.selectionStart).toBe(url.length);

  disposeSecond();
});

it("does not wipe the link field when the media session goes idle or unavailable", async () => {  vi.useFakeTimers();
  let answer: object = poll("Playing");
  const { t3, slots } = fakeT3(() => answer, false);
  stop = (plugin as unknown as { start(t3: unknown): () => void }).start(t3);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const dispose = slots.get("threadDetails")!.render(host);

  await vi.advanceTimersByTimeAsync(1100);
  const input = host.querySelector("input")!;
  input.focus();
  input.value = "https://youtu.be/dQw4w9WgXcQ";
  input.dispatchEvent(new Event("input", { bubbles: true }));

  answer = { state: "idle" };
  await vi.advanceTimersByTimeAsync(1100);
  answer = { state: "unavailable", retryInMs: 1000 };
  await vi.advanceTimersByTimeAsync(1100);

  expect(host.querySelector("input")!.value).toBe("https://youtu.be/dQw4w9WgXcQ");
  expect(document.activeElement).toBe(host.querySelector("input"));
  dispose();
});

it("seeks from the progress bar with the keyboard", async () => {
  vi.useFakeTimers();
  const { t3, slots, calls } = fakeT3(() => poll("Playing", { canSeek: true }), false);
  stop = (plugin as unknown as { start(t3: unknown): () => void }).start(t3);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const dispose = slots.get("threadDetails")!.render(host);

  await vi.advanceTimersByTimeAsync(1100);
  const bar = host.querySelector<HTMLElement>(".t3p-bar")!;
  expect(bar.getAttribute("role")).toBe("slider");
  bar.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  await Promise.resolve();
  await Promise.resolve();

  const seek = calls.find(([cmd]) => cmd === "seek");
  expect(seek).toBeTruthy();
  expect((seek![1] as { sec: number }).sec).toBeCloseTo(15, 5);
  dispose();
});

it("leaves the progress bar inert when the session cannot seek", async () => {
  vi.useFakeTimers();
  const { t3, slots } = fakeT3(() => poll("Playing", { canSeek: false }), false);
  stop = (plugin as unknown as { start(t3: unknown): () => void }).start(t3);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const dispose = slots.get("threadDetails")!.render(host);
  await vi.advanceTimersByTimeAsync(1100);
  const bar = host.querySelector<HTMLElement>(".t3p-bar")!;
  expect(bar.getAttribute("role")).toBeNull();
  dispose();
});

it("keeps the YouTube iframe alive when playback state messages arrive", async () => {
  vi.useFakeTimers();
  let state = poll("Paused");
  const { t3, slots } = fakeT3(() => state, false);
  stop = (plugin as unknown as { start(t3: unknown): () => void }).start(t3);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const dispose = slots.get("threadDetails")!.render(host);
  await vi.advanceTimersByTimeAsync(1100);

  const input = host.querySelector("input")!;
  input.value = "https://youtu.be/dQw4w9WgXcQ";
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  const frame = host.querySelector("iframe")!;
  expect(frame).not.toBeNull();

  for (const info of [1, 2, 1, 2]) {
    window.dispatchEvent(
      new MessageEvent("message", { origin: "https://www.youtube-nocookie.com", source: frame.contentWindow, data: JSON.stringify({ event: "onStateChange", info }) }),
    );
  }
  expect(host.querySelector("iframe")).toBe(frame);

  // A media-session update must not touch the embed either (that rebuilt the iframe and restarted
  // the video, which looked like "plays, then pauses right away").
  state = poll("Playing", { key: "Other|Artist|", title: "Other" });
  await vi.advanceTimersByTimeAsync(1100);
  expect(host.querySelector("iframe")).toBe(frame);
  expect(host.querySelectorAll(".t3p-td-title")[0]!.textContent).toBe("Other");
  dispose();
});

it("moves a playing inline video to the mini player when the card closes (thread switch)", async () => {
  const { t3, slots } = fakeT3(() => poll("Paused"), false);
  stop = (plugin as unknown as { start(t3: unknown): () => void }).start(t3);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const dispose = slots.get("threadDetails")!.render(host);

  const input = host.querySelector("input")!;
  input.value = "https://youtu.be/dQw4w9WgXcQ";
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(host.querySelector("iframe")).not.toBeNull();

  dispose();
  expect(document.querySelector(".md-mini iframe")).not.toBeNull();
});
