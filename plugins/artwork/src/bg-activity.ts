import { ActivityGate } from "./bg-perf.js";

/**
 * DOM side of the activity gate, shared by every background layer (ref-counted: the first `subscribe` adds the
 * listeners, the last unsubscribe removes them).
 *
 * - Input: `keydown`, `wheel` and `scroll` (capture, passive). Pointer events are not input here: the
 *   pointer-reactive presets follow the pointer and Ocean ripples on click.
 * - Streaming: one `MutationObserver` on <body> (child lists and text). Its callback only counts records; the gate
 *   decides from the rate, so a ticking clock never freezes the background. Records inside plugin UI (anything
 *   under an element with a `t3p-` class or id, `[data-t3p-root]`) do not count: the plugin dock re-renders its
 *   panels every second even while closed (~11-14 records/s with Provider limits installed), which on rig kept the
 *   gate busy forever and froze every background on its first frame (WP-17).
 * - Long animation frames (where supported) are forwarded to the quality governor.
 *
 * Subscribers get `busy(true)` when the user becomes busy and `busy(false)` once the gate is quiet again.
 */

export type ActivityListener = { busy(on: boolean): void; blocking?(ms: number): void };

const now = (): number => performance.now();

/** Plugin UI (dock, status bar chips, slots, our own probes): its mutations are not the chat streaming. */
const PLUGIN_UI = '[class*="t3p-"],[id^="t3p-"],[data-t3p-root]';

/**
 * True for a node inside plugin UI. The walk stops below <body>: plugins put state classes on <body> and <html>
 * (`t3p-dock-open`), and matching those would hide the whole chat from the gate.
 */
export function isPluginUi(node: Node): boolean {
  for (let el = node.nodeType === 1 ? (node as Element) : node.parentElement; el && el !== document.body && el !== document.documentElement; el = el.parentElement)
    if (el.matches?.(PLUGIN_UI)) return true;
  return false;
}

/** A record that only touches plugin UI: inside it, or adding/removing nothing but plugin nodes (the color probe). */
export function isPluginRecord(r: Pick<MutationRecord, "target" | "type" | "addedNodes" | "removedNodes">): boolean {
  if (isPluginUi(r.target)) return true;
  if (r.type !== "childList") return false;
  const nodes = [...Array.from(r.addedNodes), ...Array.from(r.removedNodes)];
  return nodes.length > 0 && nodes.every((n) => n.nodeType === 1 && (n as Element).matches?.(PLUGIN_UI));
}

export class ActivityMonitor {
  readonly gate = new ActivityGate();
  #subs = new Set<ActivityListener>();
  #observer: MutationObserver | null = null;
  #loaf: PerformanceObserver | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #busy = false;

  get busy(): boolean {
    return this.#busy;
  }

  subscribe(l: ActivityListener): () => void {
    this.#subs.add(l);
    if (this.#subs.size === 1) this.#attach();
    return () => {
      this.#subs.delete(l);
      if (this.#subs.size === 0) this.#detach();
    };
  }

  /** Test and measuring hook: same as a key press. */
  poke(): void {
    this.#onInput();
  }

  #attach(): void {
    const opts = { capture: true, passive: true } as const;
    window.addEventListener("keydown", this.#onInput, opts);
    window.addEventListener("wheel", this.#onInput, opts);
    window.addEventListener("scroll", this.#onInput, opts);
    if (typeof MutationObserver === "function" && document.body) {
      this.#observer = new MutationObserver((records) => {
        let n = 0;
        for (const r of records) if (!isPluginRecord(r)) n++;
        if (n > 0) this.#onMutations(n);
      });
      this.#observer.observe(document.body, { childList: true, characterData: true, subtree: true });
    }
    try {
      if (typeof PerformanceObserver === "function" && PerformanceObserver.supportedEntryTypes?.includes("long-animation-frame")) {
        this.#loaf = new PerformanceObserver((list) => {
          let ms = 0;
          for (const e of list.getEntries()) ms += (e as PerformanceEntry & { blockingDuration?: number }).blockingDuration ?? 0;
          if (ms > 0) for (const s of this.#subs) s.blocking?.(ms);
        });
        this.#loaf.observe({ type: "long-animation-frame", buffered: false });
      }
    } catch {
      this.#loaf = null;
    }
  }

  #detach(): void {
    const opts = { capture: true } as const;
    window.removeEventListener("keydown", this.#onInput, opts);
    window.removeEventListener("wheel", this.#onInput, opts);
    window.removeEventListener("scroll", this.#onInput, opts);
    this.#observer?.disconnect();
    this.#observer = null;
    this.#loaf?.disconnect();
    this.#loaf = null;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#busy = false;
    this.gate.reset();
  }

  readonly #onInput = (): void => {
    this.gate.input(now());
    this.#update();
  };

  #onMutations(count: number): void {
    this.gate.mutations(count, now());
    this.#update();
  }

  #update(): void {
    const t = now();
    const busy = this.gate.busy(t);
    if (busy && !this.#timer) this.#timer = setTimeout(this.#recheck, this.gate.remaining(t) + 16);
    if (busy === this.#busy) return;
    this.#busy = busy;
    for (const s of this.#subs) s.busy(busy);
  }

  readonly #recheck = (): void => {
    this.#timer = null;
    this.#update();
  };
}

/** One monitor per page. */
export const activity = new ActivityMonitor();
