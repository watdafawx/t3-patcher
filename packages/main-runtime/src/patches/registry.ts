import type { Patch } from "@t3p/patch-engine";

interface Entry {
  owner: string;
  patch: Patch;
}

export interface DisabledPatch {
  owner: string;
  find: string;
  reason: string;
}

/**
 * Every patch the runtime knows: built-ins (owner "t3p.core") plus the ones main
 * plugins register through ctx.patches. A patch that fails to apply is disabled
 * for the rest of the session and reported, never retried.
 */
export class PatchRegistry {
  private entries: Entry[] = [];
  private disabled = new Map<Patch, DisabledPatch>();
  /** Bumped on every change, so callers can cache derived data. */
  version = 0;

  /** Registers patches for an owner; the owner id is forced into patch.plugin. Returns an unregister function. */
  register(owner: string, patches: readonly Patch[]): () => void {
    const added: Entry[] = patches.map((patch) => ({ owner, patch: { ...patch, plugin: owner } }));
    this.entries.push(...added);
    this.version++;
    return () => {
      const before = this.entries.length;
      this.entries = this.entries.filter((entry) => !added.includes(entry));
      if (this.entries.length !== before) this.version++;
    };
  }

  /** Removes everything one owner registered (used when a plugin fails to activate). */
  unregisterOwner(owner: string): void {
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.owner !== owner);
    if (this.entries.length !== before) this.version++;
  }

  disable(patch: Patch, reason: string): void {
    const entry = this.entries.find((e) => e.patch === patch);
    if (!entry || this.disabled.has(entry.patch)) return;
    this.disabled.set(entry.patch, { owner: entry.owner, find: String(patch.find), reason });
    this.version++;
  }

  /** Enabled patches, in registration order. */
  active(): Patch[] {
    return this.entries.filter((entry) => !this.disabled.has(entry.patch)).map((entry) => entry.patch);
  }

  disabledList(): DisabledPatch[] {
    return [...this.disabled.values()];
  }

  get size(): number {
    return this.entries.length;
  }
}
