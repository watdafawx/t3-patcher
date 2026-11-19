/** A tiny DOM stand-in (no jsdom in this package): just what banner.ts touches. */
import type { Clock } from "../src/banner.js";

export class FakeEl {
  attrs = new Map<string, string>();
  children: FakeEl[] = [];
  listeners = new Map<string, Array<() => void>>();
  parent: FakeEl | null = null;
  className = "";
  textContent = "";
  type = "";
  ownerDocument = { createElement: (_tag: string): FakeEl => new FakeEl() };

  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  appendChild(c: FakeEl): FakeEl {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  append(...cs: FakeEl[]): void {
    for (const c of cs) this.appendChild(c);
  }
  addEventListener(name: string, fn: () => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }
  click(): void {
    for (const fn of this.listeners.get("click") ?? []) fn();
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  get phase(): string | null {
    return this.getAttribute("data-t3p-phase");
  }
  /** All descendants that are buttons, in order. */
  buttons(): FakeEl[] {
    const out: FakeEl[] = [];
    const walk = (e: FakeEl): void => {
      for (const c of e.children) {
        if (c.className.includes("t3p-btn")) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

export const asHost = (el: FakeEl): HTMLElement => el as unknown as HTMLElement;

/** Manual clock: `advance(ms)` fires due timers in order. */
export class FakeClock implements Clock {
  now = 0;
  #next = 1;
  #timers = new Map<number, { at: number; fn: () => void }>();
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.#next++;
    this.#timers.set(id, { at: this.now + ms, fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.#timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.#timers.delete(due[0]);
      this.now = due[1].at;
      due[1].fn();
    }
    this.now = target;
  }
  get pending(): number {
    return this.#timers.size;
  }
}
