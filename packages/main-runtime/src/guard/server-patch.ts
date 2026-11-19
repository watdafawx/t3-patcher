/**
 * The one server-side text patch (WP-6C): hooks the T3 server's orchestration `dispatch` so every
 * command that starts a turn passes `globalThis.__t3pServerGuard` first.
 *
 * Target, upstream `apps/server/src/orchestration-v2/Orchestrator.ts`:
 *
 *   const dispatchWithReceipt = Effect.fnUntraced(function* (command: OrchestrationV2ServerCommand) {
 *
 * which the server bundle (unminified ESM, `apps/server/dist/runtimeLayer-<hash>.mjs`) ships as
 *
 *   const dispatchWithReceipt = fnUntraced(function* (command) {
 *
 * The injected statement reassigns `command` (a parameter) to what the guard resolves, or fails the
 * Effect with the module's own `OrchestratorDispatchError` carrying the block reason, which the server
 * turns into the user-facing dispatch error (`userFacingDispatchErrorMessage`). Commands the guard
 * does not want are not delayed at all.
 *
 * Pure and electron-free: the server hook applies it, the tests and the compat checker run it too.
 */

/** The global the server hook installs. */
export const SERVER_GUARD_GLOBAL = "__t3pServerGuard";

/** Server chunks the hook looks at. */
export const SERVER_GUARD_FILE_RE = /(?:^|[\\/])apps[\\/]server[\\/]dist[\\/]runtimeLayer-[^\\/]*\.mjs$/;

/** `find`: plain text that must occur in exactly one server chunk. */
export const SERVER_GUARD_FIND = "const dispatchWithReceipt = ";

const ANCHOR_RE = /const dispatchWithReceipt = ([\w$]+)\(function\* \(([\w$]+)\) \{/g;
const TRY_PROMISE_RE = /\bas (tryPromise(?:\$\d+)?)\s*[,}]/g;
const DISPATCH_ERROR_RE = /\bvar (OrchestratorDispatchError(?:\$\d+)?) = class extends /g;
/** Marker so a chunk is never patched twice. */
const MARKER = "/*t3p:server-guard*/";

export type ServerPatchResult =
  | { ok: true; code: string; detail: string }
  | { ok: false; reason: "no-anchor" | "ambiguous-anchor" | "no-try-promise" | "ambiguous-try-promise" | "no-dispatch-error" | "ambiguous-dispatch-error" | "already-patched"; detail: string };

function all(re: RegExp, source: string): RegExpExecArray[] {
  re.lastIndex = 0;
  const out: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.push(m);
  return out;
}

/** Applies the guard patch to one server chunk. Never throws. */
export function applyServerGuardPatch(source: string): ServerPatchResult {
  if (source.includes(MARKER)) return { ok: false, reason: "already-patched", detail: "chunk already carries the guard" };
  const anchors = all(ANCHOR_RE, source);
  if (anchors.length === 0) return { ok: false, reason: "no-anchor", detail: "const dispatchWithReceipt = <fn>(function* (<param>) { not found" };
  if (anchors.length > 1) return { ok: false, reason: "ambiguous-anchor", detail: `dispatchWithReceipt anchor found ${anchors.length} times` };
  const tryPromises = [...new Set(all(TRY_PROMISE_RE, source).map((m) => m[1]!))];
  if (tryPromises.length === 0) return { ok: false, reason: "no-try-promise", detail: "no `as tryPromise` import binding" };
  if (tryPromises.length > 1) return { ok: false, reason: "ambiguous-try-promise", detail: `tryPromise bindings: ${tryPromises.join(", ")}` };
  const errors = all(DISPATCH_ERROR_RE, source);
  if (errors.length === 0) return { ok: false, reason: "no-dispatch-error", detail: "var OrchestratorDispatchError = class ... not found" };
  if (errors.length > 1) return { ok: false, reason: "ambiguous-dispatch-error", detail: `OrchestratorDispatchError defined ${errors.length} times` };

  const anchor = anchors[0]!;
  const cmd = anchor[2]!;
  const tryPromise = tryPromises[0]!;
  const dispatchError = errors[0]![1]!;
  const g = `globalThis.${SERVER_GUARD_GLOBAL}`;
  const injected =
    `${MARKER}if (${g} && ${g}.wants(${cmd})) ${cmd} = yield* ${tryPromise}({ ` +
    `try: () => ${g}.check(${cmd}), ` +
    `catch: (cause) => new ${dispatchError}({ commandId: ${cmd}.commandId, commandType: ${cmd}.type, cause: String(cause && cause.message || cause) }) });`;
  const at = anchor.index + anchor[0].length;
  const code = source.slice(0, at) + injected + source.slice(at);
  return { ok: true, code, detail: `dispatchWithReceipt(${cmd}) via ${anchor[1]}, ${tryPromise}, ${dispatchError}` };
}
