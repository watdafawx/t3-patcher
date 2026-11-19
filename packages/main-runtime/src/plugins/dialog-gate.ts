/**
 * One native confirmation dialog at a time, across every privileged flow (grants, registry install,
 * update, uninstall). While a flow holds the gate, and for `cooldownMs` after it let go, every other
 * request is refused as "busy". This stops a page script from stacking dialogs or timing a click
 * into a dialog the user did not expect (docs/security.md sections 4.6 and 4.7).
 */
export class DialogGate {
  #open = false;
  #lastAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly opts: { now?: () => number; cooldownMs?: number } = {}) {}

  get open(): boolean {
    return this.#open;
  }

  #now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** Takes the gate. False while another flow holds it or within the cooldown after the last one. */
  tryEnter(): boolean {
    if (this.#open || this.#now() - this.#lastAt < (this.opts.cooldownMs ?? 1500)) return false;
    this.#open = true;
    return true;
  }

  /** Releases the gate and starts the cooldown (only when `dialogShown`; a refused request does not). */
  leave(dialogShown = true): void {
    this.#open = false;
    if (dialogShown) this.#lastAt = this.#now();
  }
}
