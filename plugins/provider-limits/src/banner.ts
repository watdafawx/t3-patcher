/**
 * Composer banner presentation of the turn guard (WP-11A): a `t3p-banner` docked above the
 * composer through the `composerBanner` slot, with a small enter/leave state machine.
 *
 * Phases: mounted -> entering -> visible -> leaving -> removed. Entering and leaving last
 * `ANIMATION_MS` (the CSS animation in the shared styles); with reduced motion both are instant.
 * The clock and the reduced-motion check are injected so the machine is testable.
 */

export const ANIMATION_MS = 180;

export type BannerPhase = "mounted" | "entering" | "visible" | "leaving" | "removed";

export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Drives `data-t3p-phase` on an element. */
export class BannerAnimator {
  #phase: BannerPhase = "mounted";
  #timer: unknown = null;
  #onRemoved: Array<() => void> = [];

  constructor(
    private readonly el: HTMLElement,
    private readonly clock: Clock = realClock,
    private readonly reducedMotion: () => boolean = prefersReducedMotion,
  ) {
    el.setAttribute("data-t3p-phase", "mounted");
  }

  get phase(): BannerPhase {
    return this.#phase;
  }

  #set(phase: BannerPhase): void {
    this.#phase = phase;
    this.el.setAttribute("data-t3p-phase", phase);
  }

  #clear(): void {
    if (this.#timer !== null) this.clock.clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** mounted -> entering -> visible. No-op in any other phase. */
  enter(): void {
    if (this.#phase !== "mounted") return;
    if (this.reducedMotion()) {
      this.#set("visible");
      return;
    }
    this.#set("entering");
    this.#timer = this.clock.setTimeout(() => {
      this.#timer = null;
      if (this.#phase === "entering") this.#set("visible");
    }, ANIMATION_MS);
  }

  /** Any live phase -> leaving -> removed (element removed). `done` runs once when removed. Idempotent. */
  leave(done?: () => void): void {
    if (done) this.#onRemoved.push(done);
    if (this.#phase === "removed") {
      this.#flush();
      return;
    }
    if (this.#phase === "leaving") return;
    this.#clear();
    if (this.reducedMotion() || this.#phase === "mounted") {
      this.#finish();
      return;
    }
    this.#set("leaving");
    this.#timer = this.clock.setTimeout(() => {
      this.#timer = null;
      this.#finish();
    }, ANIMATION_MS);
  }

  /** Removes the element at once (teardown), without the exit animation. */
  destroy(): void {
    this.#clear();
    if (this.#phase !== "removed") this.#finish();
  }

  #finish(): void {
    this.#set("removed");
    this.el.remove();
    this.#flush();
  }

  #flush(): void {
    const fns = this.#onRemoved;
    this.#onRemoved = [];
    for (const fn of fns) {
      try {
        fn();
      } catch {
        // a done callback failed; the banner is gone anyway
      }
    }
  }
}

export interface BannerContent {
  title: string;
  message: string;
  labels: string[];
  /** Index of the primary (filled) button, or -1. */
  primary: number;
}

export interface BannerHandle {
  readonly animator: BannerAnimator;
  /** Plays the exit animation and removes the banner. */
  close(): void;
}

/** Renders a banner into a slot host and starts its enter animation. `onAnswer(index)` fires on a button press. */
export function showBanner(
  host: HTMLElement,
  content: BannerContent,
  onAnswer: (index: number) => void,
  clock: Clock = realClock,
  reducedMotion: () => boolean = prefersReducedMotion,
): BannerHandle {
  const doc = host.ownerDocument;
  const el = doc.createElement("div");
  el.className = "t3p-banner t3p-glass";
  el.setAttribute("role", "alert");
  el.setAttribute("data-kind", "warning");
  el.setAttribute("data-t3p-plugin", "provider-limits");
  const title = doc.createElement("b");
  title.textContent = content.title;
  const message = doc.createElement("span");
  message.textContent = content.message;
  const buttons = doc.createElement("div");
  buttons.className = "t3p-buttons";
  const animator = new BannerAnimator(el, clock, reducedMotion);
  content.labels.forEach((label, index) => {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "t3p-btn";
    if (index === content.primary) button.setAttribute("data-primary", "");
    button.textContent = label;
    button.addEventListener("click", () => onAnswer(index));
    buttons.appendChild(button);
  });
  el.append(title, message, buttons);
  host.appendChild(el);
  animator.enter();
  return { animator, close: () => animator.leave() };
}
