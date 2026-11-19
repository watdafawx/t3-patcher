// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { createEventBus } from "../src/events.js";
import { Scope } from "../src/scope.js";
import { Shell } from "../src/shell.js";

const tick = (ms = 80): Promise<void> => new Promise((r) => setTimeout(r, ms));
const makeShell = (): Shell => new Shell({ native: null, systemBus: createEventBus(() => undefined), log: () => undefined, consoleError: () => undefined });

/** A trimmed copy of the stock sidebar row: li[data-thread-item] > div[data-sidebar-row]. */
function row(key: string): HTMLElement {
  const li = document.createElement("li");
  li.setAttribute("data-thread-item", key);
  li.innerHTML = `<div role="button" data-sidebar-row="${key}"><span>title</span></div>`;
  return li;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("threadListDecorator slot", () => {
  it("mounts once per row with the row's own thread id, inside the row surface", async () => {
    const ul = document.createElement("ul");
    ul.append(row("env:t1"), row("env:t2"));
    document.body.append(ul);
    const shell = makeShell();
    const ns = shell.namespaces("demo", new Scope(), {});
    const seen: Array<string | null> = [];
    ns.ui.register({ slot: "threadListDecorator", id: "d", render(host, ctx) { seen.push(ctx.threadId); host.textContent = String(ctx.threadId); } });
    await tick();
    expect(seen.sort()).toEqual(["t1", "t2"]);
    const surface = ul.querySelector("[data-sidebar-row]")!;
    expect(surface.querySelector(":scope > .t3p-tld")).not.toBeNull();
    expect(ul.querySelectorAll(".t3p-tld")).toHaveLength(2);
    shell.slots.dispose();
  });

  it("re-mounts when React re-uses the element for another thread, and cleans up on removal and dispose", async () => {
    const ul = document.createElement("ul");
    const li = row("env:t1");
    ul.append(li);
    document.body.append(ul);
    const shell = makeShell();
    const ns = shell.namespaces("demo", new Scope(), {});
    const log: string[] = [];
    const reg = ns.ui.register({ slot: "threadListDecorator", id: "d", render(_host, ctx) { const id = ctx.threadId; log.push(`mount ${id}`); return () => log.push(`clean ${id}`); } });
    await tick();
    li.setAttribute("data-thread-item", "env:t9");
    document.body.append(document.createElement("i")); // any mutation wakes the observer
    await tick();
    expect(log).toEqual(["mount t1", "clean t1", "mount t9"]);
    // React detaches our container: it is put back, not duplicated.
    li.querySelector(".t3p-tld")!.remove();
    document.body.append(document.createElement("b"));
    await tick();
    expect(li.querySelectorAll(".t3p-tld")).toHaveLength(1);
    // Row removed (virtualized away): cleanup runs.
    li.remove();
    document.body.append(document.createElement("u"));
    await tick();
    expect(log.at(-1)).toMatch(/^clean /);
    reg.dispose();
    shell.slots.dispose();
  });

  it("dispose removes every mounted container", async () => {
    document.body.append(row("env:t1"));
    const shell = makeShell();
    const ns = shell.namespaces("demo", new Scope(), {});
    const reg = ns.ui.register({ slot: "threadListDecorator", id: "d", render(host) { host.textContent = "x"; } });
    await tick();
    expect(document.querySelectorAll(".t3p-tld")).toHaveLength(1);
    reg.dispose();
    await tick();
    expect(document.querySelectorAll(".t3p-tld")).toHaveLength(0);
    shell.slots.dispose();
  });
});
