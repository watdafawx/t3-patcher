// @vitest-environment jsdom
import type { SettingChange, SettingSchema, SettingValue, SettingsPanelOptions, T3Api, UiSlotRegistration } from "@t3p/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import plugin from "../src/index.js";

function fakeT3(initial: Record<string, SettingValue> = {}, stored: Record<string, unknown> = {}, limit = 1_048_576) {
  let schemas: SettingSchema[] = [];
  const values = new Map<string, SettingValue>(Object.entries(initial));
  const listeners = new Set<(c: SettingChange) => void>();
  const sets: Array<[string, SettingValue]> = [];
  const get = (key: string): SettingValue => values.get(key) ?? schemas.find((s) => s.key === key)!.default;
  const regs: UiSlotRegistration[] = [];
  const store = new Map<string, unknown>(Object.entries(stored));
  const toasts: string[] = [];
  const modal = vi.fn(async () => 0);
  const t3 = {
    settings: {
      define: (s: SettingSchema[]) => {
        schemas = s;
        return { dispose: () => undefined };
      },
      get,
      set: async (key: string, value: SettingValue) => {
        sets.push([key, value]);
        const previous = get(key);
        values.set(key, value);
        for (const l of listeners) l({ key, value, previous });
      },
      reset: async (key: string) => {
        const previous = get(key);
        values.delete(key);
        for (const l of listeners) l({ key, value: get(key), previous });
      },
      onChange: (cb: (c: SettingChange) => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      getSchemas: () => schemas,
    },
    storage: {
      get: async (k: string) => store.get(k),
      set: async (k: string, v: unknown) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
      usage: async () => ({ usedBytes: [...store.values()].reduce<number>((n, v) => n + JSON.stringify(v).length, 0), limitBytes: limit }),
    },
    ui: {
      register(reg: UiSlotRegistration) {
        regs.push(reg);
        return { dispose: () => void regs.splice(regs.indexOf(reg), 1) };
      },
      toast: (t: { message: string }) => {
        toasts.push(t.message);
        return { dispose: () => undefined };
      },
      modal,
      settingsPanel(_host: HTMLElement, _options: SettingsPanelOptions = {}) {
        return { dispose: () => undefined };
      },
      dock: { open: vi.fn(), close: vi.fn(), toggle: vi.fn(), isOpen: () => false },
    },
    commands: { register: () => ({ dispose: () => undefined }) },
  };
  return { t3: t3 as unknown as T3Api, sets, regs, store, toasts, modal, values };
}

let stop: void | (() => void);
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] }));
afterEach(() => {
  if (typeof stop === "function") stop();
  stop = undefined;
  vi.useRealTimers();
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  document.documentElement.removeAttribute("data-t3p-cbg");
  document.documentElement.removeAttribute("data-t3p-ocean");
});

async function start(fake: ReturnType<typeof fakeT3>, sidebar = true): Promise<HTMLElement> {
  if (sidebar) {
    document.body.innerHTML = '<div data-slot="sidebar-inner"><div id="col"></div></div><div data-slot="sidebar-inset"></div>';
  }
  stop = plugin.start(fake.t3) as () => void;
  const host = document.createElement("div");
  document.body.appendChild(host);
  fake.regs.find((r) => r.slot === "rightPanel")!.render(host, {} as never);
  await vi.advanceTimersByTimeAsync(0);
  return host;
}

const target = (id: string) => document.querySelector(`[data-t3p-custom-target="${id}"]`) as HTMLElement;
const q = <T extends HTMLElement>(id: string, sel: string): T => target(id).querySelector(sel) as T;
const type = async (el: HTMLTextAreaElement, value: string): Promise<void> => {
  el.value = value;
  el.dispatchEvent(new Event("input"));
  await vi.advanceTimersByTimeAsync(260);
};
const toggle = async (id: string, on: boolean): Promise<void> => {
  const sw = q<HTMLInputElement>(id, "[data-t3p-ct-enable]");
  sw.checked = on;
  sw.dispatchEvent(new Event("change"));
  await vi.advanceTimersByTimeAsync(0);
};
const root = (id: string) => document.querySelector(`[data-t3p-custom="${id}"]`) as HTMLElement | null;

describe("Custom section of the dock tab", () => {
  it("renders both targets with switch, html and css editors", async () => {
    await start(fakeT3());
    for (const id of ["header", "background"]) {
      expect(target(id)).not.toBeNull();
      expect(q(id, "[data-t3p-ct-enable]")).not.toBeNull();
      expect(q(id, "textarea[data-t3p-ct-html]")).not.toBeNull();
      expect(q(id, "textarea[data-t3p-ct-css]")).not.toBeNull();
    }
    expect(root("header")).toBeNull();
    expect(root("background")).toBeNull();
  });

  it("applies typed markup live after the 250 ms debounce, not before", async () => {
    await start(fakeT3());
    await toggle("header", true); // empty editors: filled from the preset
    const html = q<HTMLTextAreaElement>("header", "[data-t3p-ct-html]");
    const css = q<HTMLTextAreaElement>("header", "[data-t3p-ct-css]");
    expect(html.value).toContain("blobs");
    html.value = "<b>hi</b>";
    css.value = "b{color:var(--primary)}";
    html.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(200);
    expect(root("header")!.querySelector("b")).toBeNull();
    await vi.advanceTimersByTimeAsync(60);
    expect(root("header")!.querySelector("b")!.textContent).toBe("hi");
    expect(root("header")!.querySelector("style")!.textContent).toBe('[data-t3p-custom="header"] b{color:var(--primary)}');
  });

  it("shows validation errors inline and keeps the last good version", async () => {
    await start(fakeT3());
    await toggle("header", true);
    const css = q<HTMLTextAreaElement>("header", "[data-t3p-ct-css]");
    await type(css, "b{top:0}");
    const good = root("header")!.querySelector("style")!.textContent;
    await type(css, "@import 'https://evil.test/a.css'; b{top:0}");
    const errors = q("header", "[data-t3p-ct-errors]");
    expect(errors.textContent).toContain("@import");
    expect(css.getAttribute("aria-invalid")).toBe("true");
    expect(root("header")!.querySelector("style")!.textContent).toBe(good);
    await type(css, "b{top:0}");
    expect(errors.textContent).toBe("");
    expect(css.getAttribute("aria-invalid")).toBe("false");
  });

  it("warns about removed unsafe markup and still applies the rest", async () => {
    await start(fakeT3());
    await toggle("header", true);
    await type(q("header", "[data-t3p-ct-html]"), '<b onclick="x()">a</b><script>1</script>');
    expect(q("header", "[data-t3p-ct-warnings]").textContent).toContain("<script>");
    expect(root("header")!.querySelector("script")).toBeNull();
    expect(root("header")!.querySelector("b")!.hasAttribute("onclick")).toBe(false);
  });

  it("Start from current preset fills the editors with the active preset", async () => {
    await start(fakeT3({ preset: "gradient", angle: 90 }));
    q<HTMLButtonElement>("header", "[data-t3p-ct-from]").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(q<HTMLTextAreaElement>("header", "[data-t3p-ct-html]").value).toBe('<div class="fill"></div>');
    expect(q<HTMLTextAreaElement>("header", "[data-t3p-ct-css]").value).toContain("linear-gradient(90deg");
    // not enabled yet: nothing on screen
    expect(root("header")).toBeNull();
  });

  it("Reset to preset asks first, clears the editors and shows the preset again", async () => {
    const fake = fakeT3();
    await start(fake);
    await toggle("header", true);
    expect(root("header")).not.toBeNull();
    q<HTMLButtonElement>("header", "[data-t3p-ct-reset]").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.modal).toHaveBeenCalledTimes(1);
    expect(root("header")).toBeNull();
    expect(q<HTMLTextAreaElement>("header", "[data-t3p-ct-html]").value).toBe("");
    expect(q<HTMLInputElement>("header", "[data-t3p-ct-enable]").checked).toBe(false);
  });

  it("Reset to preset does nothing when the user cancels", async () => {
    const fake = fakeT3();
    fake.modal.mockResolvedValueOnce(1);
    await start(fake);
    await toggle("header", true);
    q<HTMLButtonElement>("header", "[data-t3p-ct-reset]").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(root("header")).not.toBeNull();
  });
});

describe("takeover and restore", () => {
  const layer = () => document.querySelector(".t3p-art-layer:not([data-main])") as HTMLElement;

  it("custom header hides the sidebar preset while on and restores it when off", async () => {
    await start(fakeT3({ preset: "aurora" }));
    expect(layer().getAttribute("data-preset")).toBe("aurora");
    await toggle("header", true);
    expect(layer().getAttribute("data-preset")).toBe("none");
    expect(document.querySelector("#col")!.querySelector('[data-t3p-custom="header"]')).not.toBeNull();
    await toggle("header", false);
    expect(layer().getAttribute("data-preset")).toBe("aurora");
    expect(root("header")).toBeNull();
  });

  it("a broken custom header never takes over", async () => {
    await start(fakeT3({ preset: "aurora" }));
    await toggle("header", true);
    await type(q("header", "[data-t3p-ct-css]"), "}");
    // last good (the generated template) still shown
    expect(layer().getAttribute("data-preset")).toBe("none");
    expect(root("header")).not.toBeNull();
  });

  it("custom background pauses Ocean and Ocean comes back when custom is off", async () => {
    await start(fakeT3({ oceanOn: true }));
    expect(document.getElementById("t3p-ocean")).not.toBeNull();
    await toggle("background", true);
    expect(document.getElementById("t3p-ocean")).toBeNull();
    expect(root("background")!.parentElement).toBe(document.body);
    expect(document.documentElement.hasAttribute("data-t3p-ocean")).toBe(false);
    await toggle("background", false);
    expect(root("background")).toBeNull();
    expect(document.getElementById("t3p-ocean")).not.toBeNull();
  });

  it("custom background removes the dim overlay and gives it back when custom is off", async () => {
    await start(fakeT3({ oceanOn: true, bgKind: "drift", bgDim: 30, bgBlur: 8 }));
    expect(document.getElementById("t3p-bg-dim")).not.toBeNull();
    await toggle("background", true);
    expect(document.getElementById("t3p-bg-dim")).toBeNull();
    expect(document.getElementById("t3p-bg-drift")).toBeNull();
    await toggle("background", false);
    expect(document.getElementById("t3p-bg-dim")!.style.opacity).toBe("0.3");
    expect(document.getElementById("t3p-bg-dim")!.previousElementSibling).toBe(document.getElementById("t3p-bg-drift"));
  });

  it("custom background also takes over the Gradient drift and Starfield presets", async () => {
    for (const kind of ["drift", "starfield"]) {
      await start(fakeT3({ oceanOn: true, bgKind: kind }));
      expect(document.getElementById(`t3p-bg-${kind}`)).not.toBeNull();
      await toggle("background", true);
      expect(document.getElementById(`t3p-bg-${kind}`)).toBeNull();
      expect(document.documentElement.hasAttribute(`data-t3p-bg-${kind}`)).toBe(false);
      await toggle("background", false);
      expect(document.getElementById(`t3p-bg-${kind}`)).not.toBeNull();
      (stop as () => void)();
      stop = undefined;
    }
  });

  it("leaves aurora presets and Ocean untouched when custom is never enabled", async () => {
    await start(fakeT3({ oceanOn: true, preset: "mesh" }));
    expect(layer().getAttribute("data-preset")).toBe("mesh");
    expect(document.getElementById("t3p-ocean")).not.toBeNull();
    expect(document.querySelector("[data-t3p-custom]")).toBeNull();
    expect(document.getElementById("t3p-art-custom-style")).toBeNull();
  });

  it("stopping the plugin removes every custom node, style and attribute", async () => {
    await start(fakeT3());
    await toggle("header", true);
    await toggle("background", true);
    expect(document.querySelector("[data-t3p-custom]")).not.toBeNull();
    (stop as () => void)();
    stop = undefined;
    expect(document.querySelector("[data-t3p-custom]")).toBeNull();
    expect(document.getElementById("t3p-art-custom-style")).toBeNull();
    expect(document.documentElement.hasAttribute("data-t3p-cbg")).toBe(false);
    expect(document.querySelector(".t3p-art-layer")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("persistence, size, import and export", () => {
  it("saves the bundle to storage after a debounce and loads it on start", async () => {
    const fake = fakeT3();
    await start(fake);
    await toggle("header", true);
    await type(q("header", "[data-t3p-ct-html]"), "<b>kept</b>");
    expect(fake.store.has("custom")).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    const saved = fake.store.get("custom") as { v: number; header: { enabled: boolean; html: string } };
    expect(saved.v).toBe(1);
    expect(saved.header).toMatchObject({ enabled: true, html: "<b>kept</b>" });

    (stop as () => void)();
    stop = undefined;
    document.body.innerHTML = "";
    await start(fakeT3({}, { custom: saved }));
    expect(root("header")!.querySelector("b")!.textContent).toBe("kept");
    expect(q<HTMLInputElement>("header", "[data-t3p-ct-enable]").checked).toBe(true);
  });

  it("ignores a corrupt stored value", async () => {
    await start(fakeT3({}, { custom: { v: 9, junk: true } }));
    expect(root("header")).toBeNull();
  });

  it("does not save past the storage quota and says so", async () => {
    const fake = fakeT3({}, {}, 20_000);
    await start(fake);
    await toggle("header", true);
    await type(q("header", "[data-t3p-ct-html]"), "<b>" + "x".repeat(19_000) + "</b>");
    await vi.advanceTimersByTimeAsync(700);
    expect(fake.store.has("custom")).toBe(false);
    expect(q("header", "[data-t3p-ct-errors]")).not.toBeNull();
    expect(document.querySelector("[data-t3p-ct-status]")!.textContent).toContain("Not saved");
    expect(root("header")).not.toBeNull(); // still applied
  });

  it("shows the size line", async () => {
    await start(fakeT3());
    await vi.advanceTimersByTimeAsync(5);
    expect(document.querySelector("[data-t3p-ct-size]")!.textContent).toMatch(/Custom code: .* KB saved\. Plugin storage: .* of 1024 KB used\./);
  });

  it("Copy bundle writes the JSON to the clipboard", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await start(fakeT3());
    await toggle("header", true);
    (document.querySelector("[data-t3p-ct-export]") as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(0);
    const text = (writeText.mock.calls as unknown as string[][])[0]![0]!;
    expect(JSON.parse(text)).toMatchObject({ v: 1, header: { enabled: true }, background: { enabled: false } });
  });

  it("falls back to a text box when the clipboard is blocked", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => Promise.reject(new Error("no")) }, configurable: true });
    await start(fakeT3());
    (document.querySelector("[data-t3p-ct-export]") as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(0);
    const box = document.querySelector("[data-t3p-ct-import]") as HTMLElement;
    expect(box.hidden).toBe(false);
    expect(JSON.parse((box.querySelector("textarea") as HTMLTextAreaElement).value).v).toBe(1);
  });

  it("imports a pasted bundle and shows it", async () => {
    await start(fakeT3());
    (document.querySelector("[data-t3p-ct-import-open]") as HTMLButtonElement).click();
    const text = document.querySelector("[data-t3p-ct-import-text]") as HTMLTextAreaElement;
    text.value = JSON.stringify({ v: 1, background: { enabled: true, html: "<i>bg</i>", css: "i{top:0}" } });
    (document.querySelector("[data-t3p-ct-do-import]") as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(root("background")!.querySelector("i")!.textContent).toBe("bg");
    expect(q<HTMLTextAreaElement>("background", "[data-t3p-ct-css]").value).toBe("i{top:0}");
    expect((document.querySelector("[data-t3p-ct-import]") as HTMLElement).hidden).toBe(true);
  });

  it("rejects a bad import without touching anything", async () => {
    await start(fakeT3());
    await toggle("header", true);
    const before = root("header")!.innerHTML;
    (document.querySelector("[data-t3p-ct-import-open]") as HTMLButtonElement).click();
    const text = document.querySelector("[data-t3p-ct-import-text]") as HTMLTextAreaElement;
    text.value = "not json";
    (document.querySelector("[data-t3p-ct-do-import]") as HTMLButtonElement).click();
    expect(document.querySelector("[data-t3p-ct-import-error]")!.textContent).toContain("not valid JSON");
    expect(root("header")!.innerHTML).toBe(before);
  });

  it("an imported bundle with script and remote urls is sanitized, not trusted", async () => {
    await start(fakeT3());
    (document.querySelector("[data-t3p-ct-import-open]") as HTMLButtonElement).click();
    const text = document.querySelector("[data-t3p-ct-import-text]") as HTMLTextAreaElement;
    text.value = JSON.stringify({ v: 1, header: { enabled: true, html: '<script>window.pwn=1</script><img src="https://e.test/a.png" onerror="window.pwn=2">', css: ".x{background:url(https://e.test/a.png)}" } });
    (document.querySelector("[data-t3p-ct-do-import]") as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(root("header")).toBeNull(); // remote css url blocked: nothing applied
    expect(q("header", "[data-t3p-ct-errors]").textContent).toContain("remote url");
    expect((window as unknown as { pwn?: number }).pwn).toBeUndefined();
  });

  it("Allow remote assets lets a remote url through and re-checks at once", async () => {
    const fake = fakeT3();
    await start(fake);
    await toggle("header", true);
    await type(q("header", "[data-t3p-ct-css]"), ".x{background:url(https://e.test/a.png)}");
    expect(q("header", "[data-t3p-ct-errors]").textContent).toContain("remote url");
    const sw = document.querySelector("[data-t3p-ct-remote]") as HTMLInputElement;
    sw.checked = true;
    sw.dispatchEvent(new Event("change"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.sets).toContainEqual(["allowRemoteAssets", true]);
    expect(q("header", "[data-t3p-ct-errors]").textContent).toBe("");
    expect(root("header")!.querySelector("style")!.textContent).toContain("https://e.test/a.png");
  });
});
