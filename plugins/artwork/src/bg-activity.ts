import { ActivityGate } from "./bg-perf.js";

/**
 * DOM side of the activity gate, shared by every background layer (ref-counted: the first `subscribe` adds the
 * listeners, the last unsubscribe removes them).
 *
 * - Input: `keydown`, `wheel` and `scroll` (capture, passive). Pointer events are not input here: the
 *   pointer-reactive presets follow the pointer and Ocean ripples on click.
 * - Streaming: one `MutationObserver` on <body> (child lists and text). Its callback only counts records; the gate
 *   decides from the rate, so a ticking clock never freezes the background.
 * - Long animation frames (where supported) are forwarded to the quality governor.
 *
 * Subscribers get `busy(true)` when the user becomes busy and `busy(false)` once the gate is quiet again.
 */

export type ActivityListener = { busy(on: boolean): void; blocking?(ms: number): void };

const now = (): number => performance.now();

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
      this.#observer = new MutationObserver((records) => this.#onMutations(records.length));
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
