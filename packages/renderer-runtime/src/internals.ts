import { CAPTURE_NAMES, type CaptureName, type InternalCaptureState, type InternalHandles } from "@t3p/api";

import type { NativeBridgeLike } from "./types.js";

type State = "captured" | "fallback" | "failed" | "pending";

/**
 * Holds the tier 2 captures. The first-party patches (main-runtime `patches/captures.ts`) call
 * `window.__t3p_plugins["t3p.core"].capture(name, value)` from inside the app's own chunks. Whatever
 * has not arrived once the app is up gets a fallback verdict, and every verdict is reported to main
 * (`t3p:internals:report`), which merges it with the patch engine's result into `internals-status.json`
 * (read by `t3p doctor`).
 */
export class InternalsHub {
  readonly #handles = new Map<CaptureName, unknown>();
  readonly #state = new Map<CaptureName, { state: State; detail: string }>();
  readonly #aux = new Map<CaptureName, Record<string, unknown>>();
  readonly #waiters = new Map<CaptureName, Set<(value: unknown) => void>>();
  /** What the runtime does when a capture is missing. A name maps to a detail text; absent means no substitute. */
  readonly #substitutes = new Map<CaptureName, string>();
  readonly #vetoed = new Set<CaptureName>();
  #finalized = false;

  constructor(
    private readonly native: NativeBridgeLike | null,
    private readonly log: (message: string) => void,
  ) {}

  /** Called by the patched app code. Returns `value` unchanged so the patch is transparent. */
  capture<T>(name: string, value: T, aux?: Record<string, unknown>): T {
    if (!(CAPTURE_NAMES as readonly string[]).includes(name)) return value;
    const key = name as CaptureName;
    if (this.#vetoed.has(key)) return value;
    this.#handles.set(key, value);
    if (aux) this.#aux.set(key, aux);
    this.set(key, "captured", "app object captured by patch");
    for (const fn of this.#waiters.get(key) ?? []) {
      try {
        fn(value);
      } catch (error) {
        this.log(`capture listener for ${key} failed: ${String(error)}`);
      }
    }
    return value;
  }

  aux<T = unknown>(name: CaptureName, key: string): T | null {
    return ((this.#aux.get(name) ?? {})[key] as T | undefined) ?? null;
  }

  get<K extends CaptureName>(name: K): InternalHandles[K] | null {
    return (this.#handles.has(name) ? this.#handles.get(name) : null) as InternalHandles[K] | null;
  }

  has(name: CaptureName): boolean {
    return this.#handles.has(name);
  }

  /** Runs `fn` now when the capture exists, otherwise when it arrives. */
  whenCaptured(name: CaptureName, fn: (value: unknown) => void): () => void {
    if (this.#handles.has(name)) {
      fn(this.#handles.get(name));
      return () => undefined;
    }
    const set = this.#waiters.get(name) ?? new Set();
    set.add(fn);
    this.#waiters.set(name, set);
    return () => void set.delete(fn);
  }

  /** The patch ran but the runtime cannot use what it got: switch to the substitute (or `failed`). */
  veto(name: CaptureName, reason: string): void {
    this.#vetoed.add(name);
    this.#handles.delete(name);
    const substitute = this.#substitutes.get(name);
    this.#finalized = true;
    if (substitute) this.set(name, "fallback", `${substitute}; capture unusable: ${reason}`);
    else this.set(name, "failed", `capture unusable: ${reason}`);
  }

  /** Declares what replaces a capture that does not run. Call before `finalize`. */
  substitute(name: CaptureName, detail: string): void {
    this.#substitutes.set(name, detail);
  }

  /** The public view (`t3.internals.status`): `failed` and `pending` read as `missing`. */
  status(): Record<CaptureName, InternalCaptureState> {
    const out = {} as Record<CaptureName, InternalCaptureState>;
    for (const name of CAPTURE_NAMES) {
      const s = this.#state.get(name)?.state;
      out[name] = s === "captured" ? "captured" : s === "fallback" ? "fallback" : "missing";
    }
    return out;
  }

  detail(): Record<CaptureName, { state: State; detail: string }> {
    const out = {} as Record<CaptureName, { state: State; detail: string }>;
    for (const name of CAPTURE_NAMES) out[name] = this.#state.get(name) ?? { state: "pending", detail: "no report yet" };
    return out;
  }

  /** Gives every capture that has not arrived its `fallback` or `failed` verdict. Late captures still win afterwards. */
  finalize(): void {
    this.#finalized = true;
    for (const name of CAPTURE_NAMES) {
      if (this.#handles.has(name) || this.#vetoed.has(name)) continue;
      const substitute = this.#substitutes.get(name);
      if (substitute) this.set(name, "fallback", substitute);
      else this.set(name, "failed", "capture did not run and there is no substitute");
    }
  }

  private set(name: CaptureName, state: State, detail: string): void {
    const previous = this.#state.get(name);
    if (previous?.state === state && previous.detail === detail) return;
    this.#state.set(name, { state, detail });
    if (state === "pending") return;
    if (!this.#finalized && state !== "captured") return;
    this.native?.invoke("t3p:internals:report", { name, state, detail }).catch(() => undefined);
  }
}
