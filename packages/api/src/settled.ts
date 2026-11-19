/**
 * Whether a thread is in T3 Code's "Settled" section. Same rule as the upstream client
 * (`apps/web` sidebar, command palette, `useThreadLifecycle`): `settledOverride === "settled"`.
 * `settledAt` / `unsettledAt` only order the lists; an `"active"` override or `null` is not settled.
 */
export function isThreadSettled(thread: { settledOverride?: unknown } | null | undefined): boolean {
  return thread?.settledOverride === "settled";
}
