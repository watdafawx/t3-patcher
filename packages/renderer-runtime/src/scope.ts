/**
 * Collects everything one plugin load registers (listeners, subscriptions, schemas, ...),
 * so stop, disable and hot reload can undo all of it. After `disposeAll` the scope is dead:
 * late registrations from stale async code are undone at once and refused.
 */
export class Scope {
  #fns = new Set<() => void>();
  #alive = true;

  get alive(): boolean {
    return this.#alive;
  }

  /** Registers a disposer. Returns a function that runs it now (once) and forgets it. */
  add(fn: () => void): () => void {
    if (!this.#alive) {
      try {
        fn();
      } catch {
        // the plugin is already gone
      }
      throw new Error("plugin is stopped");
    }
    let done = false;
    const once = (): void => {
      if (done) return;
      done = true;
      this.#fns.delete(once);
      fn();
    };
    this.#fns.add(once);
    return once;
  }

  /** Throws when the plugin was stopped. */
  assertAlive(): void {
    if (!this.#alive) throw new Error("plugin is stopped");
  }

  /** Runs every disposer (newest first), isolating errors. Idempotent. */
  disposeAll(onError: (error: unknown) => void): void {
    this.#alive = false;
    for (const fn of [...this.#fns].reverse()) {
      try {
        fn();
      } catch (error) {
        onError(error);
      }
    }
    this.#fns.clear();
  }
}
