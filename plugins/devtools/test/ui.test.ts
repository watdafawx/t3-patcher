// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { OUTLINE_ATTR } from "../src/logic/outlines.js";
import type { ChunkLoader } from "../src/ui/live-chunks.js";
import { LogTailer } from "../src/ui/log-tailer.js";
import { mountLogsTab } from "../src/ui/logs-tab.js";
import { OutlineController } from "../src/ui/outline-controller.js";
import { mountPatchTab, type Tab } from "../src/ui/patch-tab.js";
import { mountRpcTab } from "../src/ui/rpc-tab.js";
import { mountSlotsTab } from "../src/ui/slots-tab.js";

interface AnyTab {
  dispose(): void;
}

const mounted: AnyTab[] = [];

afterEach(() => {
  for (const tab of mounted.splice(0)) tab.dispose();
  document.body.replaceChildren();
  for (const style of Array.from(document.head.querySelectorAll('style[data-t3p-devtools="slot-outlines"]'))) style.remove();
  document.documentElement.removeAttribute(OUTLINE_ATTR);
});

function host(): HTMLElement {
  const element = document.createElement("div");
  document.body.append(element);
  return element;
}

describe("slot outlines", () => {
  it("injects one style element and removes it on toggle off and teardown", () => {
    const api = { ui: { themeVars: () => ({ "--primary": "#ff0000" }) }, log: () => undefined };
    const outlines = new OutlineController(api);
    const element = host();
    const tab = mountSlotsTab(element, { api, outlines });
    mounted.push(tab);

    const checkbox = element.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(document.documentElement.hasAttribute(OUTLINE_ATTR)).toBe(false);

    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change"));
    expect(outlines.enabled).toBe(true);
    expect(document.documentElement.getAttribute(OUTLINE_ATTR)).toBe("1");
    const style = document.head.querySelector<HTMLStyleElement>('style[data-t3p-devtools="slot-outlines"]')!;
    expect(style.textContent).toContain("#ff0000");
    expect(style.textContent).toContain("[data-t3p-root]");

    // Re-applying (as a theme change does) replaces the element instead of stacking another one.
    outlines.set(true);
    expect(document.head.querySelectorAll('style[data-t3p-devtools="slot-outlines"]')).toHaveLength(1);

    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change"));
    expect(outlines.enabled).toBe(false);
    expect(document.head.querySelector('style[data-t3p-devtools="slot-outlines"]')).toBeNull();
    expect(document.documentElement.hasAttribute(OUTLINE_ATTR)).toBe(false);

    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change"));
    expect(outlines.enabled).toBe(true);
    tab.dispose();
    // A tab unmount leaves the outlines alone (a command may own them); plugin teardown removes them.
    expect(outlines.enabled).toBe(true);
    outlines.dispose();
    expect(outlines.enabled).toBe(false);
    expect(document.head.querySelector('style[data-t3p-devtools="slot-outlines"]')).toBeNull();
  });
});

describe("slot outlines: always reversible", () => {
  it("Escape turns outlines off, the checkbox follows, and a palette toggle flips it back", () => {
    const api = { ui: { themeVars: () => ({}) }, log: () => undefined };
    const outlines = new OutlineController(api);
    const element = host();
    const tab = mountSlotsTab(element, { api, outlines });
    mounted.push(tab);
    const checkbox = element.querySelector<HTMLInputElement>('input[type="checkbox"]')!;

    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change"));
    expect(outlines.enabled).toBe(true);

    // focus anywhere (even inside an app control) must not stop Escape
    const other = document.createElement("button");
    document.body.append(other);
    other.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(outlines.enabled).toBe(false);
    expect(checkbox.checked).toBe(false);
    expect(document.documentElement.hasAttribute(OUTLINE_ATTR)).toBe(false);
    expect(document.head.querySelector('style[data-t3p-devtools="slot-outlines"]')).toBeNull();
    other.remove();

    // the palette command path (toggle) both ways keeps the checkbox in sync
    expect(outlines.toggle()).toBe(true);
    expect(checkbox.checked).toBe(true);
    expect(outlines.toggle()).toBe(false);
    expect(checkbox.checked).toBe(false);

    // after dispose Escape does nothing and the key listener is gone
    outlines.set(true);
    outlines.dispose();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(outlines.enabled).toBe(false);
  });

  it("the outline sheet never touches layout, so the toggle host stays visible", () => {
    const api = { ui: { themeVars: () => ({}) }, log: () => undefined };
    const outlines = new OutlineController(api);
    const element = host();
    element.setAttribute("data-t3p-root", "");
    element.style.position = "fixed";
    const tab = mountSlotsTab(element, { api, outlines });
    mounted.push(tab);
    outlines.set(true);
    const css = outlines.element!.textContent ?? "";
    expect(css).not.toMatch(/position|display|visibility/);
    expect(element.style.position).toBe("fixed");
    expect(element.querySelector('input[type="checkbox"]')).not.toBeNull();
    outlines.dispose();
  });
});

describe("plugin log viewer", () => {
  it("renders plugin lines, filters them and stops polling on teardown", async () => {
    const calls: Array<{ path: string; cursor?: number }> = [];
    const first = "2026-11-19T10:00:00.000Z INFO  [renderer:alpha] hello\n2026-11-19T10:00:01.000Z ERROR [plugin:beta] bad\n";
    const api = {
      ui: { themeVars: () => ({}) },
      log: () => undefined,
      native: {
        logTail: async (request: { path: string; cursor?: number }) => {
          calls.push(request);
          const data = request.cursor === undefined ? first : "";
          return { path: request.path, data, cursor: first.length, size: first.length, reset: false, truncated: false };
        },
      },
    };
    const tailer = new LogTailer(api, { pollMs: 60_000 });
    await tailer.poll();
    expect(tailer.entries).toHaveLength(2);
    expect(calls[0]!.path).toBe("~/.t3-patcher/logs/main.log");

    const element = host();
    const tab = mountLogsTab(element, { api, tailer, pluginId: "devtools" });
    mounted.push(tab);
    expect(element.querySelectorAll(".dt-log-line")).toHaveLength(2);
    expect(tailer.started).toBe(true);

    const filter = element.querySelector<HTMLSelectElement>("select")!;
    expect(Array.from(filter.options).map((option) => option.value)).toEqual(["", "alpha", "beta"]);
    filter.value = "beta";
    filter.dispatchEvent(new Event("change"));
    expect(element.querySelectorAll(".dt-log-line")).toHaveLength(1);
    expect(element.textContent).toContain("bad");

    tab.dispose();
    expect(tailer.started).toBe(false);
    tailer.dispose();
  });

  it("shows the grant hint on a log.tail failure", async () => {
    const api = {
      ui: { themeVars: () => ({}) },
      log: () => undefined,
      native: {
        logTail: async () => {
          throw new Error("t3p: log.tail is not granted to devtools");
        },
      },
    };
    const tailer = new LogTailer(api, { pollMs: 60_000 });
    const element = host();
    const tab = mountLogsTab(element, { api, tailer, pluginId: "devtools" });
    mounted.push(tab);
    await vi.waitFor(() => expect(element.textContent).toContain("t3p grant devtools log.tail"));
    tab.dispose();
    tailer.dispose();
  });
});

describe("rpc console", () => {
  it("needs a second confirm for risky methods and calls safe ones directly", async () => {
    const calls: Array<{ method: string; payload: unknown }> = [];
    const api = {
      ui: { themeVars: () => ({}) },
      log: () => undefined,
      rpc: {
        call: async (method: string, payload: Record<string, unknown>) => {
          calls.push({ method, payload });
          return { ok: true };
        },
        subscribe: () => ({ cancel: () => undefined, done: new Promise<void>(() => undefined) }),
        state: "open",
        onState: (_cb: (state: string) => void) => () => undefined,
      },
    };
    const element = host();
    const tab = mountRpcTab(element, { api });
    mounted.push(tab);

    const method = element.querySelector<HTMLInputElement>('input[aria-label="RPC method"]')!;
    const run = Array.from(element.querySelectorAll("button")).find((button) => button.textContent === "Call")!;
    const confirm = element.querySelector<HTMLElement>('[data-role="confirm"]')!;

    method.value = "orchestration.dispatchCommand";
    run.click();
    expect(confirm.hidden).toBe(false);
    expect(calls).toHaveLength(0);

    const confirmButton = Array.from(confirm.querySelectorAll("button")).find((button) => button.textContent?.includes("Run anyway"))!;
    confirmButton.click();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.method).toBe("orchestration.dispatchCommand");

    method.value = "server.getConfig";
    method.dispatchEvent(new Event("input"));
    expect(confirm.hidden).toBe(true);
    run.click();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.method).toBe("server.getConfig");
  });
});

describe("patch tester", () => {
  it("runs against the provided chunks and reports the verdict, snippet and parse result", async () => {
    const loader: ChunkLoader = async () => ({
      chunks: [{ name: "assets/index-abc.js", source: "const a = 'MARK';" }],
      notes: ["one note"],
      error: null,
    });
    const api = { ui: { themeVars: () => ({}) }, log: () => undefined };
    const element = host();
    const tab: Tab = mountPatchTab(element, { api, loadChunks: loader });
    mounted.push(tab);

    element.querySelector<HTMLInputElement>('input[aria-label="find"]')!.value = "MARK";
    element.querySelector<HTMLInputElement>('input[aria-label="match"]')!.value = "MARK";
    element.querySelector<HTMLInputElement>('input[aria-label="replace"]')!.value = "DONE";
    const run = Array.from(element.querySelectorAll("button")).find((button) => button.textContent === "Run test")!;
    run.click();

    await vi.waitFor(() => expect(element.textContent).toContain("unique chunk"));
    expect(element.textContent).toContain("assets/index-abc.js");
    expect(element.textContent).toContain("The patched text parses as an ES module.");
    expect(element.textContent).toContain("1 loader note(s)");
    expect(element.querySelector("mark")?.textContent).toBe("DONE");
  });

  it("reports an invalid find without calling the loader", async () => {
    let loaded = 0;
    const loader: ChunkLoader = async () => {
      loaded += 1;
      return { chunks: [], notes: [], error: "no chunks" };
    };
    const api = { ui: { themeVars: () => ({}) }, log: () => undefined };
    const element = host();
    const tab = mountPatchTab(element, { api, loadChunks: loader });
    mounted.push(tab);
    element.querySelector<HTMLInputElement>('input[aria-label="find"]')!.value = "/[/";
    element.querySelector<HTMLInputElement>('input[aria-label="match"]')!.value = "a";
    element.querySelector<HTMLInputElement>('input[aria-label="replace"]')!.value = "b";
    Array.from(element.querySelectorAll("button")).find((button) => button.textContent === "Run test")!.click();
    await vi.waitFor(() => expect(element.textContent).toContain("Invalid regular expression"));
    expect(loaded).toBe(0);
  });
});
