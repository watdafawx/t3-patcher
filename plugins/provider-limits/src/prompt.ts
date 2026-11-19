/**
 * The guard prompt flow (WP-11A): shows the question as a bottom toast or as a banner above the
 * composer, waits for the answer and turns it into a `TurnStartDecision`.
 *
 * - One pending prompt per thread: a second guarded send while one is open gets the same answer.
 * - A button resolves through `resolveChoice`. Closing the toast or the banner without a button is
 *   "Keep going" (never loses the user's message). The handler timeout is "allow" (not remembered)
 *   and removes the prompt.
 * - `composer` presentation falls back to the toast when no composer banner is mounted.
 */
import type { T3Disposable, ToastOptions, TurnStartContext, TurnStartDecision } from "@t3p/api";

import { type BannerContent, showBanner } from "./banner.js";
import { type ChoiceMemory, type GuardEvaluation, promptBody, promptButtons, promptTitle, resolveChoice } from "./guard.js";

export type GuardPresentation = "toast" | "composer";

export function parsePresentation(value: unknown): GuardPresentation {
  return value === "composer" ? "composer" : "toast";
}

/** The `composerBanner` slot hosts that are mounted right now. */
export class ComposerHosts {
  readonly #hosts = new Map<HTMLElement, { threadId: string | null; gone: Set<() => void> }>();

  /** Registers a mounted host. Returns the unmount function (also notifies `gone` listeners). */
  add(host: HTMLElement, threadId: string | null): () => void {
    this.#hosts.set(host, { threadId, gone: new Set() });
    return () => {
      const entry = this.#hosts.get(host);
      this.#hosts.delete(host);
      for (const fn of entry ? [...entry.gone] : []) fn();
    };
  }

  /** The host of this thread's composer; with one host of unknown thread, that one. */
  find(threadId: string): { host: HTMLElement; onGone(fn: () => void): void } | null {
    let found: HTMLElement | null = null;
    for (const [host, entry] of this.#hosts) {
      if (entry.threadId === threadId) {
        found = host;
        break;
      }
    }
    if (!found && this.#hosts.size === 1) found = [...this.#hosts.keys()][0]!;
    if (!found) return null;
    const entry = this.#hosts.get(found)!;
    return { host: found, onGone: (fn) => entry.gone.add(fn) };
  }

  get size(): number {
    return this.#hosts.size;
  }
}

export interface PrompterDeps {
  toast(options: ToastOptions): T3Disposable;
  presentation(): GuardPresentation;
  hosts: ComposerHosts;
  memory: ChoiceMemory;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Answer deadline; after it the turn is allowed and the prompt removed. */
  timeoutMs: number;
  /** Injected for tests of the banner animation. */
  bannerClock?: Parameters<typeof showBanner>[3];
  bannerReducedMotion?: Parameters<typeof showBanner>[4];
}

export interface Prompter {
  ask(ctx: TurnStartContext, evaluation: Extract<GuardEvaluation, { kind: "ask" }>): Promise<TurnStartDecision>;
  /** Removes every open prompt and resolves them as allow. */
  dispose(): void;
}

export function createPrompter(deps: PrompterDeps): Prompter {
  const pending = new Map<string, { promise: Promise<TurnStartDecision>; cancel: () => void }>();

  function ask(ctx: TurnStartContext, evaluation: Extract<GuardEvaluation, { kind: "ask" }>): Promise<TurnStartDecision> {
    const key = ctx.threadId || ctx.requestId;
    const existing = pending.get(key);
    if (existing) return existing.promise;

    let finish: (decide: () => TurnStartDecision) => void = () => undefined;
    const promise = new Promise<TurnStartDecision>((resolve) => {
      let done = false;
      let ui: { close(): void } | null = null;
      let timer: unknown = null;
      finish = (decide) => {
        if (done) return;
        done = true;
        if (timer !== null) deps.clearTimer(timer);
        pending.delete(key);
        try {
          ui?.close();
        } catch {
          // the prompt is already gone
        }
        resolve(decide());
      };
      const answer = (index: number): void => finish(() => resolveChoice(ctx, evaluation, index, deps.memory, deps.now()));
      timer = deps.setTimer(() => finish(() => ({ action: "allow" })), deps.timeoutMs);

      const { labels, choices } = promptButtons(evaluation);
      const title = promptTitle(evaluation);
      const message = promptBody(ctx, evaluation, deps.now());
      const primary = choices[0] === "switch" ? 0 : -1;

      const composer = deps.presentation() === "composer" ? deps.hosts.find(ctx.threadId) : null;
      if (composer) {
        const content: BannerContent = { title, message, labels, primary };
        const banner = showBanner(composer.host, content, answer, deps.bannerClock, deps.bannerReducedMotion);
        // The composer went away (thread switch): same as closing it.
        composer.onGone(() => {
          banner.animator.destroy();
          answer(-1);
        });
        ui = { close: () => banner.close() };
      } else {
        const toast = deps.toast({
          title,
          message,
          kind: "warning",
          durationMs: 0,
          actions: labels.map((label, index) => ({ label, primary: index === primary, onClick: () => answer(index) })),
          onDismiss: () => answer(-1),
        });
        ui = { close: () => toast.dispose() };
      }
    });
    pending.set(key, { promise, cancel: () => finish(() => ({ action: "allow" })) });
    return promise;
  }

  return {
    ask,
    dispose() {
      for (const item of [...pending.values()]) item.cancel();
    },
  };
}
