// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { createEventBus } from "../src/events.js";
import { Scope } from "../src/scope.js";
import { Shell } from "../src/shell.js";

function makeShell(): Shell {
  return new Shell({ native: null, systemBus: createEventBus(() => undefined), log: () => undefined, consoleError: () => undefined });
}

const tick = (ms = 80): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A trimmed copy of the stock card: workspace + version control + limits sections and the "Choose what to show" row. */
function cardHtml(): string {
  return `
<div data-thread-details-card>
  <div><div class="group/details-items">
    <section aria-label="Workspace" class="px-2 pt-2 pb-2.5">
      <div class="hidden"><h3>Workspace</h3></div>
      <div class="flex flex-col">
        <div data-row="env"><span>Local</span></div>
        <button data-row="vscode"><svg></svg><span>Open in VS Code</span></button>
        <button data-row="script"><span>Run project script</span></button>
      </div>
    </section>
    <section aria-label="Version Control" class="px-2 pt-2 pb-2.5 border-t">
      <div class="hidden"><h3>Version Control</h3></div>
      <div class="flex flex-col">
        <div data-row="branch"><span>main</span></div>
        <button data-row="commit"><span>Commit &amp; push</span></button>
      </div>
    </section>
    <section aria-label="Limits" class="px-2 pt-2 pb-2.5 border-t">
      <div class="flex flex-col">
        <div data-row="session"><span>Session limit</span></div>
        <div data-row="weekly"><span>Weekly</span></div>
      </div>
    </section>
    <div class="p-2" data-choose><span>Choose what to show</span></div>
  </div></div>
</div>`;
}

function openCard(): HTMLElement {
  const portal = document.createElement("div");
  portal.id = "portal";
  portal.innerHTML = cardHtml();
  document.body.appendChild(portal);
  return portal;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("threadDetails slot", () => {
  it("mounts after the last stock section, before the choose row, and cleans up on close", async () => {
    const shell = makeShell();
    const cleaned: string[] = [];
    const ns = shell.namespaces("demo", new Scope(), {});
    ns.ui.register({
      slot: "threadDetails",
      id: "a",
      render(host) {
        host.textContent = "hello";
        return () => cleaned.push("a");
      },
    });
    await tick();
    expect(document.querySelector("[data-t3p-container=threadDetails]")).toBeNull(); // no card yet

    const portal = openCard();
    await tick(); // the observer mounts synchronously before paint, the debounce is a backstop
    const section = document.querySelector("[data-t3p-container=threadDetails]") as HTMLElement;
    expect(section).not.toBeNull();
    expect(section.tagName).toBe("SECTION");
    expect(section.classList.contains("t3p-td-section")).toBe(true);
    expect(section.previousElementSibling?.getAttribute("aria-label")).toBe("Limits");
    expect(section.nextElementSibling?.hasAttribute("data-choose")).toBe(true);
    expect(section.textContent).toBe("hello");

    portal.remove();
    await tick();
    expect(cleaned).toEqual(["a"]);
    expect(document.querySelector("[data-t3p-container=threadDetails]")).toBeNull();

    // reopening mounts again
    openCard();
    await tick();
    expect(document.querySelector("[data-t3p-container=threadDetails]")?.textContent).toBe("hello");
    shell.slots.dispose();
  });

  it("mounts synchronously in the observer callback (no flash)", async () => {
    const shell = makeShell();
    shell.namespaces("demo", new Scope(), {}).ui.register({ slot: "threadDetails", id: "a", render: (host) => void (host.textContent = "x") });
    await tick();
    openCard();
    await Promise.resolve(); // one microtask: the MutationObserver callback has run
    await Promise.resolve();
    expect(document.querySelector("[data-t3p-container=threadDetails]")).not.toBeNull();
    shell.slots.dispose();
  });

  it("orders registrations by `order`, then registration order", async () => {
    const shell = makeShell();
    const ns = shell.namespaces("demo", new Scope(), {});
    for (const [id, order] of [["late", 5], ["early", -1], ["mid", 0]] as const) {
      ns.ui.register({ slot: "threadDetails", id, order, render: (host) => void (host.textContent = id) });
    }
    openCard();
    await tick();
    const roots = [...document.querySelectorAll("[data-t3p-container=threadDetails] > [data-t3p-root]")] as HTMLElement[];
    const sorted = [...roots].sort((a, b) => Number(a.style.order) - Number(b.style.order)).map((r) => r.textContent);
    expect(sorted).toEqual(["early", "mid", "late"]);
    shell.slots.dispose();
  });

  it("re-places the section when the stock card re-renders another section after it", async () => {
    const shell = makeShell();
    shell.namespaces("demo", new Scope(), {}).ui.register({ slot: "threadDetails", id: "a", render: (host) => void (host.textContent = "x") });
    openCard();
    await tick();
    const items = document.querySelector('[class~="group/details-items"]') as HTMLElement;
    const extra = document.createElement("section");
    extra.setAttribute("aria-label", "Context");
    extra.innerHTML = "<div><div>Context</div></div>";
    items.querySelector("[data-choose]")!.before(extra);
    await tick();
    const section = document.querySelector("[data-t3p-container=threadDetails]") as HTMLElement;
    expect(section.previousElementSibling).toBe(extra);
    shell.slots.dispose();
  });
});

describe("t3.ui.threadDetails.hide", () => {
  it("hides stock rows by label, collapses emptied sections, reapplies on reopen and restores on dispose", async () => {
    const shell = makeShell();
    const ns = shell.namespaces("demo", new Scope(), {});
    const handle = ns.ui.threadDetails.hide(["open in vs code", "  Weekly ", "Session limit"]);
    const portal = openCard();
    await tick();
    const hidden = (): string[] => [...document.querySelectorAll("[data-t3p-hidden]")].map((e) => e.getAttribute("data-row") ?? e.getAttribute("aria-label") ?? "?");
    expect(hidden().sort()).toEqual(["Limits", "session", "vscode", "weekly"].sort());
    // other rows stay
    expect(document.querySelector('[data-row="env"]')?.hasAttribute("data-t3p-hidden")).toBe(false);

    portal.remove();
    openCard();
    await tick();
    expect(hidden()).toContain("vscode");

    handle.dispose();
    expect(hidden()).toEqual([]);
    shell.slots.dispose();
  });

  it("rejects non-string labels", () => {
    const ns = makeShell().namespaces("demo", new Scope(), {});
    expect(() => ns.ui.threadDetails.hide([1 as unknown as string])).toThrow();
  });
});
